// End-to-end: hooks → capture → compressor save → review → bootstrap → git staleness/promotion → viewer API → MCP stdio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'uac.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uac-test-'));
process.env.UAC_HOME = path.join(tmp, 'home');
const repo = path.join(tmp, 'repo');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
fs.writeFileSync(path.join(repo, 'src', 'auth.js'), 'export const auth = 1;\n');
g('add', '.'); g('commit', '-qm', 'init');

const hook = (event, input) => {
  const r = spawnSync(process.execPath, [BIN, 'hook', 'claude', event], { input: JSON.stringify({ cwd: repo, session_id: 'sess-1', ...input }), encoding: 'utf8', env: process.env });
  assert.equal(r.stderr, '', `hook stderr: ${r.stderr}`);
  return r.stdout ? JSON.parse(r.stdout) : null;
};
const cli = (...a) => JSON.parse(spawnSync(process.execPath, [BIN, ...a, '--json', '--cwd', repo], { encoding: 'utf8', env: process.env }).stdout);

const { callTool } = await import('../src/mcp.mjs');
const S = await import('../src/store.mjs');
const { redact, ignored } = await import('../src/util.mjs');
process.env.UAC_CWD = repo;

test('redaction and ignore globs', () => {
  const r = redact('key sk-ant-abcdefghijklmnopqrstuvwxyz123 and postgres://bob:hunter2@db:5432 password=supersecret <private>x</private> mail a@b.com');
  assert.ok(!/abcdefghij|hunter2|supersecret|a@b\.com/.test(r), r);
  assert.match(r, /postgres:\/\/bob:\[REDACTED\]@db/);
  assert.match(r, /\[PRIVATE\]/);
  assert.ok(ignored(repo, '.env.local'));
  assert.ok(ignored(repo, 'config/secrets/x.json'));
  assert.ok(!ignored(repo, 'src/auth.js'));
});

test('session start menu asks for capture + mode, hook stdout is clean JSON', () => {
  const out = hook('SessionStart', { source: 'startup' });
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /session_id=sess-1/);
  assert.match(ctx, /Capture this session/);
  assert.match(ctx, /UAC mode for this project/);
});

test('capture is off until the user opts in; inline controls work', () => {
  hook('UserPromptSubmit', { prompt: 'first task prompt held while asking' });
  assert.equal(cli('status').counts.active, 0);
  return callTool('uac_capture', { session_id: 'sess-1', state: 'on', mode: 'automatic' }).then(() => {
    hook('UserPromptSubmit', { prompt: 'Add refresh token rotation to src/auth.js' });
    hook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'src/auth.js' }, tool_response: 'export const auth = 1;' });
    hook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: '.env' }, tool_response: 'API_KEY=zzz' });
    hook('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'TypeError: x is undefined' });
    hook('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: 'src/auth.js' }, tool_response: 'ok', agent_id: 'sub-1' }); // subagent internals skipped
    hook('PostToolUse', { tool_name: 'mcp__uac__uac_search', tool_input: {}, tool_response: 'x' }); // own tools skipped
    const p = hook('UserPromptSubmit', { prompt: '#uac pause please' });
    assert.match(p.hookSpecificOutput.additionalContext, /paused/);
    hook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'src/secret-while-paused.js' }, tool_response: 'x' });
    hook('UserPromptSubmit', { prompt: '#uac resume' });
    const d = callTool('uac_digest', { session_id: 'sess-1' });
    return d.then((dg) => {
      assert.match(dg.events, /USER: Add refresh token rotation/);
      assert.match(dg.events, /USER: first task prompt held/); // pending prompt promoted on opt-in
      assert.match(dg.events, /FAILED Bash npm test/);
      assert.match(dg.events, /\[ignored\]/);
      assert.doesNotMatch(dg.events, /zzz|secret-while-paused|mcp__uac/);
      assert.equal(dg.events.match(/tool Edit/g), null);
    });
  });
});

test('automatic mode: Stop blocks once past threshold, never when stop_hook_active', async () => {
  for (let i = 0; i < 40; i++) S.addEvent(S.session('sess-1'), 'tool', { tool: 'Read', target: `src/f${i}.js` });
  const out = hook('Stop', { last_assistant_message: 'Rotation implemented; 1 test failing.' });
  assert.equal(out.decision, 'block');
  assert.match((await callTool('uac_digest', { session_id: 'sess-1' })).events, /ASSISTANT: Rotation implemented/);
  assert.match(out.reason, /uac-compressor/);
  assert.equal(hook('Stop', { stop_hook_active: true }), null);
});

let decisionId;
test('compressor save → auto-accept decisions, proposals for the rest, export PROJECT.md', async () => {
  const dg = await callTool('uac_digest', { session_id: 'sess-1' });
  const r = await callTool('uac_save', {
    session_id: 'sess-1', upto_event_id: dg.upto_event_id,
    summary: { title: 'Refresh token rotation', body: 'Added rotation; tests failing on undefined x.' },
    checkpoint: { goal: 'refresh rotation', working: 'rotation', broken: 'npm test', files: ['src/auth.js'], next_steps: ['fix test'], note: 'check x init' },
    candidates: [
      { op: 'add', type: 'decision', title: 'Refresh tokens are stored hashed', body: 'Store only SHA-256 of refresh tokens.', why: 'DB leak must not expose tokens', files: ['src/auth.js'] },
      { op: 'add', type: 'constraint', title: 'Never log tokens', body: 'Token values must not appear in logs.', files: ['src/auth.js'] },
      { op: 'noop', type: 'fact', title: 'x', body: 'x' },
    ],
  });
  assert.equal(r.added, 2); assert.equal(r.skipped, 1); assert.deepEqual(r.errors, []);
  const act = S.search(cli('status').project.id, 'hashed refresh', {});
  decisionId = act[0].id;
  assert.equal(act[0].status, 'active');
  const rv = await callTool('uac_review', {});
  assert.equal(rv.proposed.length, 1);
  assert.equal(rv.proposed[0].type, 'constraint');
  assert.match(fs.readFileSync(path.join(repo, '.context', 'PROJECT.md'), 'utf8'), /Refresh tokens are stored hashed/);
  assert.equal(cli('status').unsaved.length, 0);
});

test('review accept, trigram search, bootstrap budget + why', async () => {
  const rv = await callTool('uac_review', {});
  await callTool('uac_resolve', { id: rv.proposed[0].id, action: 'accept' });
  assert.match(await callTool('uac_search', { query: 'hashe' }), /stored hashed/); // trigram substring
  const text = await callTool('uac_bootstrap', { session_id: 'sess-1', tier: 'minimal', goal: 'token logging' });
  assert.match(text, /Must not violate[\s\S]*Never log tokens/);
  assert.match(text, /Where we left off/);
  assert.ok(text.length / 4 < 1300, `pack too big: ${text.length}`);
  const w = await callTool('uac_why', { id: decisionId });
  assert.ok(w.reasons.length);
  const fork = await callTool('uac_bootstrap', { session_id: 'sess-1', tier: 'fork' });
  assert.doesNotMatch(fork, /Where we left off/);
});

test('manual update creates superseding proposal; accept retires the old one', async () => {
  await callTool('uac_capture', { session_id: 'sess-1', state: 'on', mode: 'manual' });
  const msg = await callTool('uac_update', { id: decisionId, body: 'Store Argon2id hash of refresh tokens.', reason: 'SHA-256 too fast' });
  const newId = msg.split(' ')[0];
  assert.equal(S.memory(decisionId).status, 'active');
  await callTool('uac_resolve', { id: newId, action: 'accept' });
  assert.equal(S.memory(decisionId).status, 'superseded');
  decisionId = newId;
});

test('git: files changed since source_commit → stale; branch memories promoted on merge', () => {
  fs.appendFileSync(path.join(repo, 'src', 'auth.js'), 'export const rotate = 2;\n');
  g('commit', '-qam', 'change auth');
  g('checkout', '-qb', 'feature/x');
  const p = S.projectFor(repo);
  const m = S.propose({ type: 'fact', title: 'Feature X uses flag', body: 'flag FX' }, { s: S.session('sess-1'), p, via: 'user' });
  assert.equal(m.scope, 'branch');
  g('checkout', '-q', 'main'); g('merge', '-q', 'feature/x');
  S.open().prepare("DELETE FROM settings WHERE scope='system'").run(); // bypass hourly throttle
  S.maintain(S.projectFor(repo));
  assert.equal(S.memory(m.id).scope, 'project');
  assert.equal(S.memory(decisionId).status, 'stale');
});

test('viewer API: token required, list/edit/delete', async () => {
  const { startViewer } = await import('../src/view.mjs');
  const { server, url } = await startViewer({ port: 0, token: 'tok' });
  const base = new URL(url).origin;
  const pid = cli('status').project.id;
  assert.equal((await fetch(`${base}/api/projects`)).status, 401);
  const H = { 'x-uac-token': 'tok', 'content-type': 'application/json' };
  const tmpMem = S.propose({ type: 'fact', title: 'Throwaway', body: 'to edit and delete' }, { s: S.session('sess-1'), p: S.projectFor(repo), via: 'user' });
  const mems = (await (await fetch(`${base}/api/memories?project=${pid}`, { headers: H })).json()).filter((m) => m.id === tmpMem.id);
  assert.equal(mems.length, 1);
  const ed = await (await fetch(`${base}/api/memories/${mems[0].id}`, { method: 'PUT', headers: H, body: JSON.stringify({ title: 'Edited title' }) })).json();
  assert.equal(ed.title, 'Edited title'); assert.equal(ed.source, 'user');
  const full = await (await fetch(`${base}/api/memories/${mems[0].id}`, { headers: H })).json();
  assert.ok(full.versions.length >= 2);
  assert.equal((await fetch(`${base}/api/memories/${mems[0].id}`, { method: 'DELETE', headers: H })).status, 200);
  const h = await (await fetch(`${base}/api/health?project=${pid}`, { headers: H })).json();
  assert.ok(h.sessions >= 1);
  assert.match(await (await fetch(`${base}/`)).text(), /<html/i);
  server.close();
});

test('MCP stdio protocol: initialize, tools/list, tools/call', async () => {
  const child = spawn(process.execPath, [BIN, 'mcp'], { cwd: repo, env: process.env });
  let buf = '';
  const replies = [];
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { replies.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'uac_search', arguments: { query: 'tokens' } } });
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  for (let i = 0; i < 50 && replies.length < 4; i++) await new Promise((r) => setTimeout(r, 100));
  child.kill();
  const by = Object.fromEntries(replies.map((r) => [r.id, r]));
  assert.equal(by[1].result.serverInfo.name, 'uac');
  assert.equal(by[2].result.tools.length, 16);
  assert.match(by[3].result.content[0].text, /tokens/i);
  assert.equal(by[4].result.isError, true);
});

test('compact start re-injects the loaded pack + precompact snapshot', () => {
  hook('PreCompact', { trigger: 'auto' });
  const out = hook('SessionStart', { source: 'compact' });
  assert.match(out.hookSpecificOutput.additionalContext, /compacted[\s\S]*UAC context pack[\s\S]*Pre-compaction snapshot/);
});

test('user chooses the next session context (dashboard/CLI), one-shot; per-session detail', async () => {
  const { startViewer } = await import('../src/view.mjs');
  const { server, url } = await startViewer({ port: 0, token: 'tok2' });
  const base = new URL(url).origin, pid = cli('status').project.id;
  const H = { 'x-uac-token': 'tok2', 'content-type': 'application/json' };
  const summary = S.open().prepare("SELECT id FROM summaries LIMIT 1").get().id;
  const mem = S.search(pid, 'Never log tokens')[0].id;
  const k = await (await fetch(`${base}/api/packs?project=${pid}`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'only logging rule', ids: [mem, summary], next: true }) })).json();
  assert.equal(k.next, true);
  assert.equal((await (await fetch(`${base}/api/next?project=${pid}`, { headers: H })).json()).pack, k.id);
  const menuOut = hook('SessionStart', { session_id: 'sess-4', source: 'startup' }).hookSpecificOutput.additionalContext;
  assert.match(menuOut, /pre-selected pack/);
  const text = await callTool('uac_bootstrap', { session_id: 'sess-4' }); // no tier given → uses the user's choice
  assert.match(text, new RegExp(`pack ${k.id}`));
  assert.match(text, /Never log tokens/);
  assert.match(text, new RegExp(summary));
  assert.equal(cli('next').pack, null, 'one-shot: cleared after loading');
  const d = await (await fetch(`${base}/api/sessions/sess-1`, { headers: H })).json();
  assert.ok(d.events.length > 10 && d.summaries.length === 1 && d.checkpoints.length >= 1 && d.memories.length >= 2);
  assert.equal(d.events.some((e) => e.kind === 'pending'), false);
  assert.equal(cli('session', 'sess-4').loaded.pack, k.id);
  assert.equal((await fetch(`${base}/api/packs/${k.id}`, { method: 'DELETE', headers: H })).status, 200);
  server.close();
});

test('opt-out deletes pending prompts', async () => {
  hook('SessionStart', { session_id: 'sess-3', source: 'startup' });
  hook('UserPromptSubmit', { session_id: 'sess-3', prompt: 'private first prompt' });
  await callTool('uac_capture', { session_id: 'sess-3', state: 'off' });
  assert.equal(S.open().prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = 'sess-3'").get().n, 0);
});

test('handoff pack loads in a second (parallel) session', async () => {
  const h = await callTool('uac_handoff', { session_id: 'sess-1', name: 'auth work' });
  hook('SessionStart', { session_id: 'sess-2', source: 'startup' });
  const text = await callTool('uac_bootstrap', { session_id: 'sess-2', pack: h.pack });
  assert.match(text, new RegExp(`pack ${h.pack}`));
  assert.match(text, /Never log tokens/);
});
