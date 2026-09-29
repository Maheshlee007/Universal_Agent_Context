// End-to-end (v0.3): hooks → capture → compressor save → knowledge → session cards → branches → messages → deletes → dashboard API → MCP stdio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'plugin', 'bin', 'uac.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uac-test-'));
process.env.UAC_HOME = path.join(tmp, 'home');
const repo = path.join(tmp, 'repo');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
fs.writeFileSync(path.join(repo, 'src', 'auth.js'), 'export function rotateRefreshToken() {}\nexport const auth = 1;\n');
g('add', '.'); g('commit', '-qm', 'init');

const hook = (event, input) => {
  const r = spawnSync(process.execPath, [BIN, 'hook', 'claude', event], { input: JSON.stringify({ cwd: repo, session_id: 'sess-1', ...input }), encoding: 'utf8', env: process.env });
  assert.equal(r.stderr, '', `hook stderr: ${r.stderr}`);
  return r.stdout ? JSON.parse(r.stdout) : null;
};
const ctxOf = (out) => out?.hookSpecificOutput?.additionalContext || '';
const cli = (...a) => JSON.parse(spawnSync(process.execPath, [BIN, ...a, '--json', '--cwd', repo], { encoding: 'utf8', env: process.env }).stdout);

const { callTool } = await import('../plugin/src/mcp.mjs');
const S = await import('../plugin/src/store.mjs');
const K = await import('../plugin/src/pack.mjs');
const { redact, ignored } = await import('../plugin/src/util.mjs');
process.env.UAC_CWD = repo;
const pid = () => S.projectFor(repo).id;

test('redaction and ignore globs', () => {
  const r = redact('key sk-ant-abcdefghijklmnopqrstuvwxyz123 and postgres://bob:hunter2@db:5432 password=supersecret <private>x</private> mail a@b.com');
  assert.ok(!/abcdefghij|hunter2|supersecret|a@b\.com/.test(r), r);
  assert.match(r, /postgres:\/\/bob:\[REDACTED\]@db/);
  assert.ok(ignored(repo, '.env.local') && ignored(repo, 'config/secrets/x.json') && !ignored(repo, 'src/auth.js'));
  for (const code of ['verifyToken(token: string): string | null', 'secret: env.JWT_SECRET', 'const token = getToken()'])
    assert.equal(redact(code), code, 'code is not a secret');
});

test('first run: context injected, ONE mode question, nothing recorded until opt-in; near-empty warning', () => {
  const c = ctxOf(hook('SessionStart', { source: 'startup', model: 'claude-opus-5-5' }));
  assert.match(c, /UAC first run in this project. Ask the user ONCE/);
  assert.doesNotMatch(c, /Minimal|Relevant|Deep ~/);
  assert.match(c, /knows almost nothing about this project/);
  assert.equal(S.session('sess-1').model, 'claude-opus-5-5');
});

test('capture: pending prompt promoted on opt-in; subagent/own tools/ignored files handled; inline pause/resume', async () => {
  hook('UserPromptSubmit', { prompt: 'Add refresh token rotation to src/auth.js' });
  await callTool('uac_capture', { session_id: 'sess-1', state: 'on', mode: 'automatic' });
  hook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'src/auth.js' }, tool_response: 'x' });
  hook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: '.env' }, tool_response: 'API_KEY=zzz' });
  hook('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'TypeError: x is undefined' });
  hook('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: 'src/auth.js' }, tool_response: 'ok', agent_id: 'sub-1' });
  hook('PostToolUse', { tool_name: 'mcp__uac__uac_search', tool_input: {}, tool_response: 'x' });
  assert.match(ctxOf(hook('UserPromptSubmit', { prompt: '#uac pause please' })), /paused/);
  hook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'src/secret-while-paused.js' }, tool_response: 'x' });
  hook('UserPromptSubmit', { prompt: '#uac resume' });
  // quoted/indented text (docs, pasted reports) must not trigger controls
  assert.doesNotMatch(ctxOf(hook('UserPromptSubmit', { prompt: 'the README says:\n  type #uac off to stop, or `#uac save <n>`' })), /Recording off|Save requested|No session/);
  assert.equal(S.session('sess-1').capture, 'on');
  const dg = await callTool('uac_digest', { session_id: 'sess-1' });
  assert.match(dg.events, /USER: Add refresh token rotation/);
  assert.match(dg.events, /FAILED Bash npm test/);
  assert.match(dg.events, /\[ignored\]/);
  assert.doesNotMatch(dg.events, /zzz|secret-while-paused|mcp__uac|tool Edit/);
});

test('automatic: Stop blocks past threshold (never when stop_hook_active); records final assistant message', async () => {
  for (let i = 0; i < 40; i++) S.addEvent(S.session('sess-1'), 'tool', { tool: 'Read', target: `src/f${i}.js` });
  const out = hook('Stop', { last_assistant_message: 'Rotation implemented; 1 test failing.' });
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /uac-compressor/);
  assert.equal(hook('Stop', { stop_hook_active: true }), null);
  assert.match((await callTool('uac_digest', { session_id: 'sess-1' })).events, /ASSISTANT: Rotation implemented/);
});

let decisionId;
test('save: confident items auto-accepted, low-confidence waits; anchors; events replaced by the card; diff covers unrecorded edits', async () => {
  fs.appendFileSync(path.join(repo, 'src', 'auth.js'), '// edited by a background agent\n'); // not seen by hooks
  const dg = await callTool('uac_digest', { session_id: 'sess-1' });
  assert.match(dg.diff_stat, /src\/auth\.js/);
  const r = await callTool('uac_save', {
    session_id: 'sess-1', upto_event_id: dg.upto_event_id, model: 'claude-haiku-4-5',
    summary: { title: 'Add refresh token rotation in src/auth.js (hashed storage)', body: 'Rotation added; npm test fails on undefined x.' },
    checkpoint: { goal: 'refresh rotation', working: 'rotation', broken: 'npm test', files: ['src/auth.js'], next_steps: ['fix test'], note: 'check x init' },
    candidates: [
      { op: 'add', type: 'decision', title: 'Refresh tokens are stored hashed', body: 'rotateRefreshToken stores only the SHA-256 of refresh tokens.', why: 'DB leak must not expose tokens',
        anchors: [{ file: 'src/auth.js', symbol: 'rotateRefreshToken', line: 1 }], confidence: 0.9 },
      { op: 'add', type: 'constraint', title: 'Never log tokens', body: 'Token values must not appear in logs.', files: ['src/auth.js'], confidence: 0.9 },
      { op: 'add', type: 'fact', title: 'Maybe uses Redis later', body: 'unclear', confidence: 0.4 },
      { op: 'noop', type: 'fact', title: 'x', body: 'x' },
    ],
  });
  assert.equal(r.added, 2); assert.equal(r.pending_review, 1); assert.equal(r.skipped, 1); assert.deepEqual(r.errors, []);
  assert.ok(r.events_removed > 40, 'raw events replaced by the card');
  decisionId = S.search(pid(), 'hashed refresh')[0].id;
  const d = S.memory(decisionId);
  assert.equal(d.status, 'active'); assert.equal(d.resolved_by, 'auto-policy'); assert.equal(d.source_model, 'claude-haiku-4-5');
  assert.equal(d.anchors[0].symbol, 'rotateRefreshToken');
  assert.equal((await callTool('uac_review', {})).proposed.length, 1);
  assert.match(fs.readFileSync(path.join(repo, '.context', 'PROJECT.md'), 'utf8'), /rotateRefreshToken@src\/auth\.js:1/);
  assert.equal(S.card('sess-1').title, 'Add refresh token rotation in src/auth.js (hashed storage)');
});

test('next session: auto-loads knowledge + latest card on the branch, no questions; anchors show freshness', () => {
  const c = ctxOf(hook('SessionStart', { session_id: 'sess-2', source: 'startup' }));
  assert.match(c, /Continuing from \(most recent session on this branch\)[\s\S]*Add refresh token rotation/);
  assert.match(c, /Loaded ~\d+ tok: card #\d+ \S+ \+ \d+\/\d+ knowledge items\. (Nothing else stored|Not loaded)/, 'one line says what was and was not loaded');
  assert.match(c, /Must not violate[\s\S]*Never log tokens/);
  assert.match(c, /rotateRefreshToken@src\/auth\.js:1/);
  assert.doesNotMatch(c, /Ask the user/);
  assert.match(c, /#uac continue <n>/);
  assert.equal(S.session('sess-2').capture, 'on', 'automatic mode records by default');
});

test('anchors: renamed symbol → ✗, verify tool, commits since → ⚠', async () => {
  fs.writeFileSync(path.join(repo, 'src', 'auth.js'), 'export function rotateToken() {}\n');
  let [m] = S.freshness(S.projectFor(repo), [S.memory(decisionId)]);
  assert.equal(m.freshness.state, 'missing');
  fs.writeFileSync(path.join(repo, 'src', 'auth.js'), 'export function rotateRefreshToken() {}\n// v2\n');
  g('commit', '-qam', 'touch auth'); g('commit', '-q', '--allow-empty', '-m', 'noop');
  [m] = S.freshness(S.projectFor(repo), [S.memory(decisionId)]);
  assert.equal(m.freshness.state, 'changed'); assert.equal(m.freshness.commits_since, 1);
  await callTool('uac_verify', { ids: [decisionId] });
  [m] = S.freshness(S.projectFor(repo), [S.memory(decisionId)]);
  assert.equal(m.freshness.state, 'verified');
});

test('freshness compares content: committing the verified content is not a change', async () => {
  fs.writeFileSync(path.join(repo, 'src', 'auth.js'), 'export function rotateRefreshToken() {}\n// v3 uncommitted\n');
  let [m] = S.freshness(S.projectFor(repo), [S.memory(decisionId)]);
  assert.equal(m.freshness.state, 'changed', 'uncommitted edit detected');
  await callTool('uac_verify', { ids: [decisionId] }); // agent checked the new code
  g('commit', '-qam', 'commit what was verified');
  [m] = S.freshness(S.projectFor(repo), [S.memory(decisionId)]);
  assert.equal(m.freshness.state, 'verified');
});

test('start context re-delivered on first prompt if SessionStart never completed (host timeout)', () => {
  hook('SessionStart', { session_id: 'sess-slow', source: 'startup' });
  S.open().prepare("UPDATE sessions SET ctx_at = NULL WHERE id = 'sess-slow'").run(); // simulate a killed hook
  assert.match(ctxOf(hook('UserPromptSubmit', { session_id: 'sess-slow', prompt: 'hi' })), /# UAC ·/);
  assert.doesNotMatch(ctxOf(hook('UserPromptSubmit', { session_id: 'sess-slow', prompt: 'again' })), /# UAC ·/, 'only once');
  cli('rm', 'sess-slow', '--yes');
});

test('digest recheck lists memories whose anchored files this session changed', async () => {
  S.addEvent(S.session('sess-2'), 'tool', { tool: 'Edit', target: 'src/auth.js' });
  S.addEvent(S.session('sess-2'), 'prompt', { body: 'tweak auth' });
  S.addEvent(S.session('sess-2'), 'tool', { tool: 'Read', target: 'README.md' });
  const dg = await callTool('uac_digest', { session_id: 'sess-2' });
  assert.ok(dg.recheck.some((x) => x.id === decisionId));
});

test('branches: other active branch shown; messages delivered once cross-session', async () => {
  g('checkout', '-qb', 'feature/ui');
  hook('SessionStart', { session_id: 'sess-ui', source: 'startup' });
  S.addEvent(S.session('sess-ui'), 'prompt', { body: 'Build the dashboard page' });
  S.addEvent(S.session('sess-ui'), 'tool', { tool: 'Write', target: 'src/dash.js' });
  S.addEvent(S.session('sess-ui'), 'tool', { tool: 'Write', target: 'src/dash.css' });
  K.autoCard(S.session('sess-ui'));
  await callTool('uac_message', { session_id: 'sess-ui', text: 'I renamed getUser to fetchUser', to: 'branch:main' });
  g('checkout', '-q', 'main');
  const c = ctxOf(hook('SessionStart', { session_id: 'sess-5', source: 'startup' }));
  assert.match(c, /Other active branches[\s\S]*feature\/ui[\s\S]*Build the dashboard page/);
  assert.match(c, /Messages for you[\s\S]*fetchUser/);
  const again = ctxOf(hook('UserPromptSubmit', { session_id: 'sess-5', prompt: 'hello' }));
  assert.doesNotMatch(again, /fetchUser/, 'delivered once');
  g('checkout', '-q', 'feature/ui'); g('commit', '-q', '--allow-empty', '-m', 'ui work'); g('checkout', '-q', 'main');
  g('commit', '-q', '--allow-empty', '-m', 'main moved'); g('merge', '-q', '--no-ff', 'feature/ui', '-m', 'merge ui');
  const afterMerge = K.bootstrap(S.session('sess-5'), S.projectFor(repo), { record: false }).text;
  assert.doesNotMatch(afterMerge, /Other active branches[\s\S]*`feature\/ui`/, 'a branch merged here is no longer parallel work');
});

test('#uac continue <n> loads chosen sessions; multi-session bootstrap merges; fresh = knowledge only', async () => {
  const list = S.listSessions(pid());
  const n1 = list.find((x) => x.id === 'sess-1').n, nui = list.find((x) => x.id === 'sess-ui').n;
  const c = ctxOf(hook('UserPromptSubmit', { session_id: 'sess-5', prompt: `#uac continue ${n1} ${nui}` }));
  assert.match(c, /Continuing from session\(s\)[\s\S]*Add refresh token rotation[\s\S]*Build the dashboard page/);
  const fresh = await callTool('uac_bootstrap', { session_id: 'sess-5', fresh: true });
  assert.doesNotMatch(fresh, /Continuing from/);
  assert.match(fresh, /Never log tokens/);
});

test('dashboard/CLI "continue from" choice is one-shot for the next session', () => {
  const n = S.listSessions(pid()).find((x) => x.id === 'sess-ui').n;
  assert.deepEqual(cli('next', String(n)).sessions, ['sess-ui']);
  const c = ctxOf(hook('SessionStart', { session_id: 'sess-6', source: 'startup' }));
  assert.match(c, /## Continuing from\n[\s\S]*Build the dashboard page/);
  assert.deepEqual(cli('next').sessions, ['sess-ui'], 'kept until a real prompt (a window-reload phantom must not eat it)');
  hook('UserPromptSubmit', { session_id: 'sess-6', prompt: 'continue the ui work' });
  assert.deepEqual(cli('next').sessions, [], 'cleared by the first real prompt');
});

test('save consolidates: loaded checkpoints on the same branch are superseded', async () => {
  S.addEvent(S.session('sess-6'), 'prompt', { body: 'continue ui' });
  const loaded = JSON.parse(S.session('sess-6').loaded).checkpoints;
  assert.ok(loaded.length);
  await callTool('uac_save', { session_id: 'sess-6', upto_event_id: 1e9, summary: { title: 'Continue UI work' }, checkpoint: { goal: 'ui', note: 'n' }, candidates: [] });
  // sess-ui ran on feature/ui, sess-6 on main → different branch → not superseded
  assert.equal(S.open().prepare('SELECT superseded_by FROM checkpoints WHERE id = ?').get(loaded[0]).superseded_by, null);
  S.open().prepare("UPDATE sessions SET branch = 'main' WHERE id = 'sess-ui'").run();
  S.open().prepare("UPDATE sessions SET loaded = ? WHERE id = 'sess-6'").run(JSON.stringify({ checkpoints: loaded }));
  S.addEvent(S.session('sess-6'), 'prompt', { body: 'more' });
  await callTool('uac_save', { session_id: 'sess-6', upto_event_id: 1e9, summary: { title: 'Continue UI work 2' }, checkpoint: { goal: 'ui2', note: 'n' }, candidates: [] });
  assert.ok(S.open().prepare('SELECT superseded_by FROM checkpoints WHERE id = ?').get(loaded[0]).superseded_by);
});

test('sessions are auto-named from the first prompt; #uac name renames; empty flag', () => {
  hook('SessionStart', { session_id: 'sess-nm', source: 'startup' });
  hook('UserPromptSubmit', { session_id: 'sess-nm', prompt: 'Add pagination to the users list\nmore details' });
  assert.equal(S.session('sess-nm').title, 'Add pagination to the users list');
  assert.match(ctxOf(hook('UserPromptSubmit', { session_id: 'sess-nm', prompt: '#uac name Users pagination' })), /named/);
  assert.equal(S.session('sess-nm').title, 'Users pagination');
  hook('UserPromptSubmit', { session_id: 'sess-nm', prompt: 'uac: name Users pagination v2' }); // alias for Claude Code, where a leading "#" is intercepted
  assert.equal(S.session('sess-nm').title, 'Users pagination v2');
  hook('UserPromptSubmit', { session_id: 'sess-nm', prompt: '#uac name Users pagination' });
  hook('SessionStart', { session_id: 'sess-empty', source: 'startup' });
  // never typed in = phantom (window reload): hidden and unnumbered, visible with all:true
  assert.equal(S.listSessions(pid()).find((x) => x.id === 'sess-empty'), undefined);
  const ph = S.listSessions(pid(), { all: true }).find((x) => x.id === 'sess-empty');
  assert.ok(ph.phantom && ph.empty && ph.n === null);
  assert.equal(S.listSessions(pid()).find((x) => x.id === 'sess-nm').empty, false);
});

test('v0.4: host-injected prompts, phantom purge, snapshot never outranks the saved card, done tasks, save guard', async () => {
  hook('SessionStart', { session_id: 'sess-v4', source: 'startup' });
  hook('UserPromptSubmit', { session_id: 'sess-v4', prompt: '<system-reminder>ide</system-reminder>\nFix the login redirect' });
  hook('UserPromptSubmit', { session_id: 'sess-v4', prompt: '<task-notification>\n<result>x</result>\nuac: name hijacked\n</task-notification>' });
  assert.equal(S.session('sess-v4').title, 'Fix the login redirect');
  assert.equal(S.session('sess-v4').prompts, 1);
  hook('SubagentStop', { session_id: 'sess-v4', last_assistant_message: '<analysis>a</analysis>\n<summary>s</summary>' });
  assert.equal(S.open().prepare(`SELECT COUNT(*) AS n FROM events WHERE session_id = 'sess-v4' AND kind = 'subagent'`).get().n, 0);
  const t = S.propose({ type: 'task', title: 'Fix login redirect', body: 'done when /login redirects', confidence: 0.9 }, { s: S.session('sess-v4'), p: S.projectFor(repo) });
  const d = await callTool('uac_digest', { session_id: 'sess-v4' });
  assert.ok(d.how_to_save && d.open_tasks.some((x) => x.id === t.id));
  const args = { session_id: 'sess-v4', base_event_id: d.base_event_id, upto_event_id: d.upto_event_id, summary: { title: 'Fix login redirect' }, checkpoint: { goal: 'g', working: 'saved state', note: 'n', gaps: 'g1' }, candidates: [{ op: 'done', id: t.id }] };
  assert.equal((await callTool('uac_save', args)).done, 1);
  assert.ok((await callTool('uac_save', args)).skipped_reason, 'second save of the same digest refused');
  assert.equal(S.memory(t.id).resolved_by, 'done:compressor');
  hook('UserPromptSubmit', { session_id: 'sess-v4', prompt: 'one more thing' });
  hook('PreCompact', { session_id: 'sess-v4', trigger: 'auto' });
  const c = S.card('sess-v4');
  assert.equal(c.working, 'saved state');
  assert.match(c.tail.goal, /one more thing/);
  hook('SessionStart', { session_id: 'sess-ph', source: 'startup' });
  hook('SessionEnd', { session_id: 'sess-ph', reason: 'other' });
  assert.equal(S.session('sess-ph'), undefined, 'phantom deleted at SessionEnd');
  assert.match(K.saveInstruction('x', 'claude'), /universal-agent-context:uac-compressor[\s\S]*haiku/);
});

test('merge sessions into one: rows move, one combined card on next save', async () => {
  const s = S.session('sess-nm');
  S.addEvent(S.session('sess-nm'), 'tool', { tool: 'Edit', target: 'src/users.js' });
  K.autoCard(S.session('sess-nm'));
  const list = S.listSessions(pid());
  const n = (id) => String(list.find((x) => x.id === id).n);
  const r = cli('merge', n('sess-nm'), '--into', n('sess-ui'));
  assert.deepEqual(r.merged, ['sess-nm']);
  assert.equal(S.session('sess-nm'), undefined);
  const dg = await callTool('uac_digest', { session_id: 'sess-ui' });
  assert.match(dg.events, /PREVIOUS SESSION CARD[\s\S]*Users pagination/);
});

test('rollup: many sessions → one new card; sources hidden but kept; #uac save <n> targets it', async () => {
  const before = S.listSessions(pid()).filter((x) => x.card).length;
  const r = cli('rollup', '--all');
  assert.ok(r.sources.length >= 2 && r.session_id.startsWith('rollup-'));
  const visible = S.listSessions(pid());
  assert.ok(visible.every((x) => !r.sources.includes(x.id)), 'sources hidden');
  assert.equal(S.listSessions(pid(), { all: true }).filter((x) => r.sources.includes(x.id)).length, r.sources.length, 'sources kept');
  assert.ok(visible.find((x) => x.id === r.session_id).card, 'rollup has an auto card');
  const c = ctxOf(hook('UserPromptSubmit', { session_id: 'sess-2', prompt: `#uac save ${r.n}` }));
  assert.match(c, new RegExp(`session_id=${r.session_id}`));
  const dg = await callTool('uac_digest', { session_id: r.session_id });
  assert.ok((dg.events.match(/PREVIOUS SESSION CARD/g) || []).length === r.sources.length && before >= 2);
});

test('resume of a long session shows the token-cost tip', () => {
  const tp = path.join(tmp, 'long.jsonl');
  fs.writeFileSync(tp, 'x'.repeat(400000));
  hook('SessionStart', { session_id: 'sess-long', source: 'startup', transcript_path: tp });
  assert.match(ctxOf(hook('SessionStart', { session_id: 'sess-long', source: 'resume', transcript_path: tp })), /resuming reloaded this whole conversation \(~\d+K tokens/);
  cli('rm', 'sess-long', '--yes');
});

test('continuing the SAME session: resume reactivates it, reports unsaved work, next save gets previous_card to update one card', async () => {
  hook('SessionStart', { session_id: 'sess-cont', source: 'startup' });
  hook('UserPromptSubmit', { session_id: 'sess-cont', prompt: 'Build CSV export' });
  await callTool('uac_save', { session_id: 'sess-cont', upto_event_id: 1e9, summary: { title: 'Build CSV export (part 1)' }, checkpoint: { goal: 'csv', next_steps: ['add headers'], note: 'n' }, candidates: [] });
  hook('SessionEnd', { session_id: 'sess-cont', reason: 'prompt_input_exit' });
  assert.equal(S.session('sess-cont').status, 'ended');
  const c = ctxOf(hook('SessionStart', { session_id: 'sess-cont', source: 'resume' }));
  assert.equal(S.session('sess-cont').status, 'active', 'resumed session is live again');
  assert.match(c, /saved before \("Build CSV export \(part 1\)"\)[\s\S]*UPDATES that same card/);
  hook('UserPromptSubmit', { session_id: 'sess-cont', prompt: 'now add headers' });
  hook('PostToolUse', { session_id: 'sess-cont', tool_name: 'Edit', tool_input: { file_path: 'src/csv.js' }, tool_response: 'ok' });
  hook('PostToolUse', { session_id: 'sess-cont', tool_name: 'Edit', tool_input: { file_path: 'src/csv2.js' }, tool_response: 'ok' });
  const c2 = ctxOf(hook('SessionStart', { session_id: 'sess-cont', source: 'resume' }));
  assert.match(c2, /3 unsaved event\(s\) since/);
  const dg = await callTool('uac_digest', { session_id: 'sess-cont' });
  assert.equal(dg.previous_card.title, 'Build CSV export (part 1)');
  assert.match(dg.instructions, /ONE updated card for the whole session/);
  await callTool('uac_save', { session_id: 'sess-cont', upto_event_id: dg.upto_event_id, summary: { title: 'Build CSV export with headers' }, checkpoint: { goal: 'csv', note: 'done' }, candidates: [] });
  assert.equal(S.card('sess-cont').title, 'Build CSV export with headers');
  assert.equal(S.listSessions(pid()).filter((x) => x.id === 'sess-cont').length, 1, 'still one session');
});

test('SessionEnd without a save builds an auto card; nothing is lost', () => {
  hook('SessionStart', { session_id: 'sess-7', source: 'startup' });
  hook('UserPromptSubmit', { session_id: 'sess-7', prompt: 'Fix the login redirect bug' });
  hook('PostToolUse', { session_id: 'sess-7', tool_name: 'Edit', tool_input: { file_path: 'src/login.js' }, tool_response: 'ok' });
  hook('PostToolUse', { session_id: 'sess-7', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: 'ok' });
  hook('SessionEnd', { session_id: 'sess-7', reason: 'prompt_input_exit' });
  const c = S.card('sess-7');
  assert.equal(c.quality, 'auto');
  assert.match(c.title, /Fix the login redirect bug/);
});

test('import recovers an unrecorded session from its Claude transcript', () => {
  const tp = path.join(tmp, 'transcript.jsonl');
  fs.writeFileSync(tp, [
    { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'Refactor the payment module' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/pay.js' } }, { type: 'text', text: 'I extracted chargeCard into its own module so retries are isolated.' }] } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [] } },
  ].map((x) => JSON.stringify(x)).join('\n'));
  hook('SessionStart', { session_id: 'sess-off', source: 'startup', transcript_path: tp });
  S.setCapture('sess-off', 'off');
  const r = cli('import', 'sess-off');
  assert.equal(r.events_imported, 3);
  assert.match(S.card('sess-off').title, /Refactor the payment module/);
});

test('delete session cascades (events, card, memories it created); cleanup empty; impact counts', async () => {
  await callTool('uac_propose', { session_id: 'sess-7', type: 'lesson', title: 'Login redirect needs absolute URL', body: 'x', confidence: 0.9 });
  const imp = cli('rm', 'sess-7', '--yes');
  assert.equal(imp.deleted[0].memories, 1);
  assert.equal(S.session('sess-7'), undefined);
  assert.equal(S.open().prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = 'sess-7'").get().n, 0);
  assert.equal(S.search(pid(), 'Login redirect absolute').length, 0);
  S.open().prepare("INSERT INTO sessions(id, project_id, agent, started_at) VALUES ('empty-1', ?, 'claude', '2020-01-01')").run(pid());
  assert.equal(cli('rm', '--empty').deleted, 1);
});

test('projects: same git remote = one project; temp scratch dirs never registered; merge', () => {
  g('remote', 'add', 'origin', 'https://github.com/acme/app.git');
  const a = S.projectFor(repo).id;
  const clone = path.join(tmp, 'clone');
  spawnSync('git', ['clone', '-q', repo, clone]);
  spawnSync('git', ['remote', 'set-url', 'origin', 'git@github.com:acme/app.git'], { cwd: clone });
  assert.equal(S.projectFor(clone).id, a, 'same remote (https vs ssh) = same project');
  S.projectFor(repo); // switch root back
  const scratch = path.join(tmp, 'Temp', 'claude', 'x');
  fs.mkdirSync(scratch, { recursive: true });
  const before = S.listProjects().length;
  const r = spawnSync(process.execPath, [BIN, 'hook', 'claude', 'SessionStart'], { input: JSON.stringify({ cwd: scratch, session_id: 'scr', source: 'startup' }), encoding: 'utf8', env: process.env });
  assert.match(r.stdout, /off here: .* is a temp\/scratch folder/); assert.equal(S.listProjects().length, before); // said once, nothing registered
  const other = path.join(tmp, 'other'); fs.mkdirSync(other);
  const o = S.projectFor(other).id;
  S.mergeProjects(o, a);
  assert.equal(S.project(o), undefined);
});

test('mode off: one line, nothing recorded, no questions', () => {
  cli('mode', 'off');
  const c = ctxOf(hook('SessionStart', { session_id: 'sess-off2', source: 'startup' }));
  assert.match(c, /^\[UAC is off/);
  hook('UserPromptSubmit', { session_id: 'sess-off2', prompt: 'do stuff' });
  assert.equal(S.open().prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = 'sess-off2'").get().n, 0);
  cli('mode', 'automatic');
});

test('dashboard API: token, sessions with cards, cascade delete, next, verify, mute, messages, cleanup', async (t) => {
  const { startViewer } = await import('../plugin/src/view.mjs');
  const { server, url } = await startViewer({ port: 0, token: 'tok' });
  t.after(() => server.close()); // a failed assertion must not leave the server keeping the test process alive
  const base = new URL(url).origin, P2 = pid();
  const H = { 'x-uac-token': 'tok', 'content-type': 'application/json' };
  const j = async (p, m = 'GET', b) => (await fetch(base + p, { method: m, headers: H, body: b && JSON.stringify(b) })).json();
  assert.equal((await fetch(`${base}/api/projects`)).status, 401);
  const sessions = await j(`/api/sessions?project=${P2}`);
  const s1 = sessions.find((x) => x.card && x.n); // earlier rollup test hid sess-1 inside a rollup; any visible carded session works
  assert.ok(s1.n >= 1 && s1.card.title);
  assert.deepEqual((await j(`/api/next?project=${P2}`, 'PUT', { sessions: [String(s1.n)] })).sessions, [s1.id]);
  assert.ok((await j(`/api/sessions?project=${P2}&all=1`)).some((x) => x.rolled_into && x.n > 0), 'rolled-up sessions listed with all=1, keeping their stable #n');
  const mem = (await j(`/api/memories?project=${P2}`)).find((m) => m.id === decisionId);
  assert.ok(mem.freshness);
  assert.equal((await j(`/api/memories/${decisionId}/verify`, 'POST')).id, decisionId);
  assert.equal((await j(`/api/memories/${decisionId}`, 'PUT', { muted: true })).muted, true);
  assert.doesNotMatch(K.bootstrap(S.session('sess-5'), S.projectFor(repo), { record: false }).text, /stored hashed|Argon/);
  await j(`/api/memories/${decisionId}`, 'PUT', { muted: false });
  assert.ok((await j(`/api/memories?project=${P2}&auto=1`)).length >= 1);
  const msg = await j(`/api/messages?project=${P2}`, 'POST', { text: 'from dashboard', to: 'all' });
  assert.equal(msg.text, 'from dashboard');
  const imp = await j('/api/sessions/sess-5/impact');
  const del = await j('/api/sessions/sess-5', 'DELETE');
  assert.deepEqual(del.deleted, imp);
  assert.equal(S.session('sess-5'), undefined);
  assert.equal(typeof (await j(`/api/sessions/cleanup?project=${P2}`, 'POST', { empty: true })).deleted, 'number');
  assert.match((await j(`/api/health?project=${P2}`)).db, /uac\.db$/);
  assert.match(await (await fetch(`${base}/`)).text(), /<html/i);
  server.close();
});

test('MCP stdio protocol: initialize, tools/list (13 tools), tools/call, errors', async () => {
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
  assert.equal(by[2].result.tools.length, 13);
  assert.match(by[3].result.content[0].text, /tokens/i);
  assert.equal(by[4].result.isError, true);
});

test('compact start re-injects the loaded context + precompact snapshot', () => {
  hook('SessionStart', { session_id: 'sess-8', source: 'startup' });
  hook('UserPromptSubmit', { session_id: 'sess-8', prompt: 'work on auth' });
  hook('PreCompact', { session_id: 'sess-8', trigger: 'auto' });
  const c = ctxOf(hook('SessionStart', { session_id: 'sess-8', source: 'compact' }));
  assert.match(c, /compacted[\s\S]*# UAC ·[\s\S]*Pre-compaction snapshot/);
});

test('handoff marks this session as the next session context', async () => {
  const h = await callTool('uac_handoff', { session_id: 'sess-1' });
  assert.ok(h.next_sessions.includes('sess-1'));
  const c = ctxOf(hook('SessionStart', { session_id: 'sess-9', source: 'startup' }));
  assert.match(c, /## Continuing from\n[\s\S]*Add refresh token rotation/);
});

test('doctor reports db path, integrity, fts5', () => {
  const d = cli('doctor');
  assert.equal(d.integrity, 'ok'); assert.equal(d.fts5, true); assert.match(d.db, /uac\.db$/);
});

test('v0.5: stable #n + refs, save validation, project scoping, non-git subfolders, messages once, branch versions', async () => {
  // stable numbers: a new session never shifts the others; "#n", "n", short id and id resolve alike
  const before = Object.fromEntries(S.listSessions(pid()).map((x) => [x.id, x.n]));
  hook('SessionStart', { session_id: 'sess-v5', source: 'startup' });
  hook('UserPromptSubmit', { session_id: 'sess-v5', prompt: 'Refactor the login form' });
  const after = S.listSessions(pid());
  for (const x of after) if (before[x.id]) assert.equal(x.n, before[x.id], `#n of ${x.id} moved`);
  const me = after.find((x) => x.id === 'sess-v5');
  for (const r of [`#${me.n}`, String(me.n), me.short, 'sess-v5']) assert.equal(S.resolveSessionRef(pid(), r), 'sess-v5', r);
  const bad = await callTool('uac_get', { ids: ['#999'] });
  assert.match(bad[0].error, /no session "#999"[\s\S]*#\d+ \S+ "/, 'the error lists valid refs');
  assert.match(await callTool('uac_sessions', { session_id: 'sess-v5' }), new RegExp(`#${me.n} ${me.short} · .* · this session,`));

  // an incomplete card is refused and deletes nothing
  for (let i = 0; i < 3; i++) hook('PostToolUse', { session_id: 'sess-v5', tool_name: 'Edit', tool_input: { file_path: 'src/auth.js' }, tool_response: 'e' });
  const n0 = S.unsavedCount(S.session('sess-v5'));
  await assert.rejects(callTool('uac_save', { session_id: 'sess-v5', upto_event_id: 1e9, summary: 'did stuff', checkpoint: 'next: tests' }), /refused, nothing written or deleted/);
  assert.equal(S.unsavedCount(S.session('sess-v5')), n0);

  // near-duplicates are refused with the id to update; another project's memory is out of reach
  const orig = await callTool('uac_propose', { session_id: 'sess-v5', type: 'fact', title: 'Login form posts to /api/login with JSON', body: 'The login form posts JSON to /api/login', confidence: 0.9 });
  const origId = orig.match(/m-[0-9a-f]+/)[0];
  assert.match(await callTool('uac_propose', { session_id: 'sess-v5', type: 'fact', title: 'Login form posts to /api/login with JSON', body: 'The login form posts JSON to the /api/login endpoint', confidence: 0.9 }), new RegExp(`possible duplicate of ${origId}`));
  // templated tasks are different work, never "duplicates"
  await callTool('uac_propose', { session_id: 'sess-v5', type: 'task', title: 'Add tests for login', body: 'Write unit tests for the login form validation', confidence: 0.9 });
  assert.match(await callTool('uac_propose', { session_id: 'sess-v5', type: 'task', title: 'Add tests for signup', body: 'Write unit tests for the signup form validation', confidence: 0.9 }), /saved as active/);
  const other = path.join(tmp, 'other-v5'); fs.mkdirSync(other);
  const po = S.projectFor(other);
  const foreign = S.propose({ type: 'decision', title: 'Other project secret decision', body: 'x', why: 'y', confidence: 0.9 }, { p: po });
  assert.match((await callTool('uac_get', { ids: [foreign.id] }))[0].error, /not found in this project/);
  await assert.rejects(callTool('uac_update', { session_id: 'sess-v5', id: foreign.id, body: 'overwritten', reason: 'r' }), /no memory .* in this project/);
  assert.equal(S.memory(foreign.id).body, 'x');

  // non-git: a subfolder of a registered folder is the same project; read-only CLI commands register nothing
  const plain = path.join(tmp, 'plain-v5'); fs.mkdirSync(path.join(plain, 'sub', 'dir'), { recursive: true });
  const pp = S.projectFor(plain);
  assert.equal(S.projectFor(path.join(plain, 'sub', 'dir')).id, pp.id);
  const loose = path.join(tmp, 'loose-v5'); fs.mkdirSync(loose);
  const nProj = S.listProjects().length;
  spawnSync(process.execPath, [BIN, 'status', '--cwd', loose], { encoding: 'utf8', env: process.env });
  spawnSync(process.execPath, [BIN, 'doctor', '--cwd', loose], { encoding: 'utf8', env: process.env });
  assert.equal(S.listProjects().length, nProj, 'status/doctor must not register a project');

  // a message to a branch reaches the sessions open at the time (or the next one), not every later session
  S.postMessage(S.session('sess-v5'), S.projectFor(repo), 'API contract changed: POST /api/login returns {token}', 'branch:main');
  hook('SessionStart', { session_id: 'sess-v5b', source: 'startup' });
  hook('UserPromptSubmit', { session_id: 'sess-v5b', prompt: 'go' });
  const got = (sid) => S.open().prepare(`SELECT COUNT(*) AS n FROM message_reads r JOIN messages m ON m.id = r.message_id WHERE r.session_id = ? AND m.text LIKE 'API contract changed%'`).get(sid).n;
  assert.equal(got('sess-v5b'), 1, 'the next session gets it');
  hook('SessionStart', { session_id: 'sess-v5c', source: 'startup' });
  hook('UserPromptSubmit', { session_id: 'sess-v5c', prompt: 'another task' });
  assert.equal(got('sess-v5c'), 0, 'a later session does not get it again');

  // on a feature branch, updating project knowledge writes a branch version; the default branch keeps the original
  g('checkout', '-q', '-b', 'feature/v5');
  hook('SessionStart', { session_id: 'sess-br', source: 'startup' });
  hook('UserPromptSubmit', { session_id: 'sess-br', prompt: 'Change the login endpoint' });
  for (let i = 0; i < 3; i++) hook('PostToolUse', { session_id: 'sess-br', tool_name: 'Edit', tool_input: { file_path: 'src/auth.js' }, tool_response: 'e' });
  const d = await callTool('uac_digest', { session_id: 'sess-br' });
  const r = await callTool('uac_save', { session_id: 'sess-br', base_event_id: d.base_event_id, upto_event_id: d.upto_event_id,
    summary: { title: 'Move login to /api/v2/login', body: 'b' }, checkpoint: { goal: 'g', note: 'n' },
    candidates: [{ op: 'update', id: origId, body: 'The login form posts JSON to /api/v2/login', confidence: 0.9 }] });
  assert.match(r.warnings.join(' '), /replaces it when the branch is merged/);
  assert.equal(S.memory(origId).body, 'The login form posts JSON to /api/login', 'project memory untouched on the branch');
  g('checkout', '-q', 'main');
});

test('large session digest keeps every user request (tool noise dropped first)', () => {
  S.ensureSession({ host: 'claude', session_id: 'sess-big', cwd: repo });
  for (let i = 0; i < 300; i++) {
    S.addEvent(S.session('sess-big'), 'prompt', { body: `request number ${i} please` });
    S.addEvent(S.session('sess-big'), 'tool', { tool: 'Read', target: `src/f${i}.js` });
    S.addEvent(S.session('sess-big'), 'assistant', { body: 'x'.repeat(700) });
  }
  const d = K.digest(S.session('sess-big'), 60000);
  assert.ok(d.events.length < 64000, `digest bounded: ${d.events.length}`);
  for (const i of [0, 150, 299]) assert.match(d.events, new RegExp(`request number ${i} please`));
  assert.doesNotMatch(d.events, /tool Read src\/f150\.js/);
});
