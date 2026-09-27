// `uac` command line. Every command supports --json (used by the VS Code extension) and --cwd DIR.
// Sessions are addressed by their list number (#n, newest first) or by id.
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, get, run, J, home, open, hasFts } from './db.mjs';
import * as S from './store.mjs';
import * as K from './pack.mjs';

const ROOT = import.meta.url ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') : path.dirname(process.execPath);
const HOSTS = ['claude', 'codex', 'gemini', 'antigravity', 'cursor', 'copilot'];
const USAGE = `Universal Agent Context (UAC)
usage: uac <command> [options] [--json] [--cwd DIR]

  status                         mode, recording, memory counts, next-session choice
  mode off|manual|automatic      off = UAC does nothing · manual = load context, record only on "#uac on" · automatic = load + record + auto-save
  capture on|paused|off          recording for the current session
  sessions [--active]            numbered list (#1 = newest)       session <n|id>   everything stored for one session
  next <n…> | --clear            the next session continues from these sessions (one-shot)
  rm <n|id…> | --empty [--yes]   delete sessions (cascades events, card, memories they created)
  search <q> | get <id…>         search / show memories
  review                         decide low-confidence proposals & conflicts (interactive: y/n/e/s)
  edit <id> | forget <id…>       edit a memory in $EDITOR / hard-delete memories
  import [n|id]                  recover an unrecorded session from its host transcript
  msg "<text>" [--to all|branch:<b>|session:<id>]    msgs    cross-agent notes
  projects | projects merge <from> <into> | projects rm <id>
  view [--port N] [--no-open]    dashboard            export   regenerate .context/PROJECT.md
  install [host] [--dry-run]     no host = detect installed tools (${HOSTS.join(', ')}, VS Code)
  doctor | backup                health check / copy the database to ~/.uac/backups
  hook <host> <event> | mcp      (called by hosts)`;

const ago = K.ago;
async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(q)).trim(); } finally { rl.close(); }
}
const onPath = (cmd) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true }).status === 0;

export async function main(argv) {
  const { values: o, positionals: [cmd, ...args] } = parseArgs({
    args: argv, allowPositionals: true, strict: false,
    options: { json: { type: 'boolean' }, cwd: { type: 'string' }, session: { type: 'string' }, tier: { type: 'string' },
      pack: { type: 'string' }, capture: { type: 'string' }, port: { type: 'string' }, 'no-open': { type: 'boolean' },
      'dry-run': { type: 'boolean' }, active: { type: 'boolean' }, type: { type: 'string' }, status: { type: 'string' },
      ids: { type: 'string' }, name: { type: 'string' }, next: { type: 'boolean' }, clear: { type: 'boolean' },
      empty: { type: 'boolean' }, yes: { type: 'boolean' }, to: { type: 'string' }, sessions: { type: 'string' } },
  });
  const out = (data, text) => console.log(o.json ? JSON.stringify(data, null, 1) : (text ?? (typeof data === 'string' ? data : JSON.stringify(data, null, 1))));
  const cwd = o.cwd || process.cwd();
  const proj = () => S.projectFor(cwd);
  const sess = (p) => {
    const s = o.session ? S.session(S.resolveSessionRefs(p.id, [o.session])[0]) : S.currentSession(p.id);
    if (!s) throw new Error('no UAC session for this project (start one in your agent, or pass --session)');
    return s;
  };
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !o.json;

  switch (cmd) {
    case 'hook': return (await import('./hook.mjs')).main(args[0], args[1]);
    case 'mcp': return (await import('./mcp.mjs')).serve();

    case 'status': {
      const p = proj();
      const s = S.currentSession(p.id);
      const data = { project: { id: p.id, root: p.root, name: p.name, mode: p.mode, branch: p.branch }, session: s ? { id: s.id, capture: s.capture, status: s.status } : null,
        counts: S.counts(p.id), next_sessions: S.nextSessions(p.id), unsaved: S.unsavedSessions(p.id).map(({ session_id, events }) => ({ session_id, events })),
        db: path.join(home(), 'uac.db') };
      return out(data, `UAC · ${p.name} (${p.root}) · branch ${p.branch || '-'}\nmode: ${p.mode || 'not set (asked once in the next session)'}\n` +
        `session: ${s ? `${s.id} recording=${s.capture} ${s.status}` : 'none'}\n` +
        `knowledge: ${data.counts.active} active · ${data.counts.proposed + data.counts.conflict} need a decision · ${data.counts.stale} stale\n` +
        `next session continues from: ${data.next_sessions.length ? data.next_sessions.join(', ') : 'latest session on the same branch'}\ndb: ${data.db}`);
    }
    case 'capture': { const p = proj(); const s = sess(p); S.setCapture(s.id, args[0]); return out({ ok: true, session_id: s.id, capture: args[0] }, `recording=${args[0]} (${s.id})`); }
    case 'mode': { const p = proj(); S.setMode(p.id, args[0]); return out({ ok: true, mode: args[0] }, `mode=${args[0]} for ${p.name}`); }
    case 'choose': { // used by older extension builds
      const p = proj(); const s = sess(p);
      run('UPDATE sessions SET choice = ? WHERE id = ?', J({ tier: o.tier, pack: o.pack, capture: o.capture, sessions: o.sessions?.split(',') }), s.id);
      if (o.capture) S.setCapture(s.id, o.capture);
      return out({ ok: true }, `choice stored for ${s.id}`);
    }
    case 'sessions': {
      const rows = S.listSessions(proj().id, { active: o.active });
      return out(rows, rows.map((r) => `#${String(r.n).padEnd(3)} ${(r.card?.title || r.title || '(untitled)').slice(0, 70).padEnd(70)} [${r.branch || '-'}] ${r.agent}${r.model ? `/${r.model}` : ''} · ${ago(r.started_at)}` +
        `${r.card ? (r.card.quality === 'auto' ? ' · auto card' : ' · card') : ''}${r.unsaved ? ` · ${r.unsaved} unsaved` : ''}${r.capture === 'on' ? ' · REC' : ''}${r.next ? ' · NEXT' : ''}`).join('\n') || '(no sessions)');
    }
    case 'session': {
      const p = proj();
      const id = S.resolveSessionRefs(p.id, [args[0] || '1'])[0];
      const d = id && S.sessionDetail(id);
      if (!d) throw new Error(`no session ${args[0]}`);
      const c = d.card;
      return out(d, [`session ${d.session.id} · ${d.session.agent}${d.session.model ? `/${d.session.model}` : ''} · branch ${d.session.branch || '-'} · recording=${d.session.capture} · ${d.session.status}`,
        `loaded: ${d.loaded ? JSON.stringify(d.loaded) : 'nothing'}`,
        c ? `card: ${c.title}${c.quality === 'auto' ? ' (auto)' : ''}\n  ${[c.working && `working: ${c.working}`, c.broken && `broken: ${c.broken}`, c.next_steps?.length && `next: ${c.next_steps.join('; ')}`, c.note && `note: ${c.note}`].filter(Boolean).join('\n  ')}` : 'card: none yet',
        ...d.memories.map((m) => `memory ${m.id} · ${m.type} · ${m.status} · ${m.title}`),
        `events: ${d.events.length}`, ...d.events.slice(0, 15).map((e) => `  ${e.kind} ${e.tool || ''} ${e.target || e.body || ''}`.slice(0, 160))].join('\n'));
    }
    case 'next': {
      const p = proj();
      if (o.clear) { S.setNextSessions(p.id, []); S.setNextPack(p.id, null); return out({ sessions: [] }, 'next session: latest session on the same branch (default)'); }
      if (o.pack) return out({ pack: S.setNextPack(p.id, o.pack) }, `next session loads pack ${o.pack}`);
      if (!args.length) { const n = S.nextSessions(p.id); return out({ sessions: n }, `next session continues from: ${n.length ? n.join(', ') : 'latest session on the same branch (default)'}`); }
      const ids = S.resolveSessionRefs(p.id, args);
      if (!ids.length) throw new Error(`no sessions match ${args.join(' ')} (see "uac sessions")`);
      S.setNextSessions(p.id, ids);
      return out({ sessions: ids }, `next session continues from: ${ids.join(', ')}`);
    }
    case 'rm': {
      const p = proj();
      if (o.empty) { const n = S.cleanupEmpty(p.id); return out({ deleted: n }, `deleted ${n} empty session(s)`); }
      const ids = S.resolveSessionRefs(p.id, args);
      if (!ids.length) throw new Error('usage: uac rm <n|id…> | --empty');
      const impacts = ids.map((id) => ({ id, ...S.sessionImpact(id) }));
      if (o['dry-run']) return out({ impact: impacts }, impacts.map((i) => `${i.id}: would delete ${i.events} events, ${i.summaries + i.checkpoints} card rows, ${i.memories} memories`).join('\n'));
      if (interactive && !o.yes) {
        for (const i of impacts) console.log(`  ${i.id}: ${i.events} events, ${i.summaries + i.checkpoints} card rows, ${i.memories} memories`);
        if (!/^y(es)?$/i.test(await ask(`Delete ${ids.length} session(s) and everything above? [y/N] `))) return out({ deleted: [] }, 'cancelled');
      }
      const deleted = ids.map((id) => ({ id, ...S.deleteSession(id) }));
      return out({ deleted }, deleted.map((d) => `deleted ${d.id} (${d.events} events, ${d.memories} memories)`).join('\n'));
    }
    case 'search': {
      const p = proj();
      const rows = S.freshness(p, S.search(p.id, args.join(' '), { type: o.type, status: o.status, limit: 200 }))
        .map(({ id, type, title, body, status, score, pinned, muted, anchors, freshness, source_model }) => ({ id, type, title, body, status, score, pinned, muted, anchors, freshness, source_model }));
      const mark = { verified: '✓', changed: '⚠', missing: '✗', unknown: ' ' };
      return out(rows, rows.map((r) => `${mark[r.freshness.state]} ${r.id} · ${r.type} · ${r.status} · ${r.title}`).join('\n') || '(no results)');
    }
    case 'get': { const { callTool } = await import('./mcp.mjs'); return out(await callTool('uac_get', { ids: args })); }
    case 'review': {
      const p = proj();
      const r = S.review(p.id);
      const items = [...r.proposed.map((m) => ({ m, other: null })), ...r.conflicts.map((c) => ({ m: c.memory, other: c.other }))];
      if (!interactive) return out(r, items.map(({ m, other }) => `${other ? 'CONFLICT' : 'proposed'} ${m.id} · ${m.type} · ${m.title}\n    ${m.body}${other ? `\n    vs ${other.id}: ${other.body}` : ''}`).join('\n') || 'nothing needs a decision');
      if (!items.length) return console.log('Nothing needs a decision.');
      for (const { m, other } of items) {
        console.log(`\n[${m.type}] ${m.title}  (${m.id}, confidence ${m.confidence})\n  ${m.body}${m.why ? `\n  why: ${m.why}` : ''}${other ? `\n  CONFLICTS WITH ${other.id}: ${other.body}` : ''}`);
        const a = (await ask('  accept (y) / reject (n) / edit then accept (e) / skip (s)? ')).toLowerCase();
        if (a === 'y') S.resolve(m.id, 'accept', null, 'user-cli');
        else if (a === 'n') S.resolve(m.id, 'reject', null, 'user-cli');
        else if (a === 'e') { await edit(m.id, () => {}); S.resolve(m.id, 'accept', null, 'user-cli'); }
      }
      S.exportProjectMd(p);
      return console.log('Done.');
    }
    case 'accept': case 'reject': { const m = S.resolve(args[0], cmd, null, 'user-cli'); S.exportProjectMd(proj()); return out(m, `${m.id} → ${m.status}`); }
    case 'forget': { for (const id of args) S.deleteMemory(id); S.exportProjectMd(proj()); return out({ ok: true, deleted: args }, `deleted ${args.join(', ')}`); }
    case 'edit': return edit(args[0], out);
    case 'import': {
      const p = proj();
      const id = args[0] ? S.resolveSessionRefs(p.id, args)[0]
        : get(`SELECT id FROM sessions WHERE project_id = ? AND capture IN ('off','ask') AND transcript_path IS NOT NULL ORDER BY started_at DESC LIMIT 1`, p.id)?.id;
      if (!id) throw new Error('no session to import (give its number from "uac sessions")');
      const { importTranscript } = await import('./import.mjs');
      const r = importTranscript(S.session(id));
      K.autoCard(S.session(id));
      return out(r, `imported ${r.events_imported} events into ${id} and built an auto card. In a session, "#uac save" or spawning uac-compressor with session_id=${id} turns it into a full card.`);
    }
    case 'msg': {
      const p = proj();
      const m = S.postMessage(S.currentSession(p.id), p, args.join(' '), o.to || 'all');
      return out(m, `posted to ${m.recipient}: ${m.text}`);
    }
    case 'msgs': {
      const rows = S.listMessages(proj().id);
      return out(rows, rows.map((m) => `${ago(m.created_at)} · ${m.from_agent}${m.from_branch ? ` [${m.from_branch}]` : ''} → ${m.recipient}: ${m.text}`).join('\n') || '(no messages)');
    }
    case 'projects': {
      if (args[0] === 'merge') { S.mergeProjects(args[1], args[2]); return out({ ok: true }, `merged ${args[1]} into ${args[2]}`); }
      if (args[0] === 'rm') {
        if (interactive && !o.yes && !/^y/i.test(await ask(`Delete project ${args[1]} and ALL its sessions and memories? [y/N] `))) return console.log('cancelled');
        S.deleteProject(args[1]); return out({ ok: true }, `deleted ${args[1]}`);
      }
      const rows = S.listProjects();
      return out(rows, rows.map((r) => `${r.id}  ${r.name.padEnd(28)} ${String(r.sessions).padStart(4)} sessions ${String(r.memories).padStart(4)} memories  mode=${r.mode || '-'}  ${r.root}${r.git_remote ? `  (${r.git_remote})` : ''}`).join('\n'));
    }
    case 'packs': {
      const rows = K.listPacks(proj().id);
      return out(rows, rows.map((k) => `${k.id}${k.next ? ' [NEXT]' : ''}  ${k.name}  (${k.item_ids.length} items)`).join('\n') || '(no packs)');
    }
    case 'pack': {
      const ids = (o.ids || '').split(',').map((x) => x.trim()).filter(Boolean);
      if (!ids.length) throw new Error('--ids a,b,c required');
      const k = K.createPack(proj(), null, { ids, name: o.name, next: !!o.next });
      return out(k, `created ${k.id} (${ids.length} items)${k.next ? ', loads in the next session' : ''}`);
    }
    case 'export': { const f = S.exportProjectMd(proj()); return out({ ok: true, file: f }, `wrote ${f}`); }
    case 'backup': {
      const dir = path.join(home(), 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, `uac-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
      open().exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`);
      return out({ ok: true, file: f }, `backup written to ${f}`);
    }
    case 'view': {
      const { startViewer } = await import('./view.mjs');
      const { url } = await startViewer({ port: Number(o.port || 0) });
      out({ url }, `UAC viewer: ${url}`);
      if (!o['no-open'] && !o.json) spawnSync(process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open',
        process.platform === 'win32' ? ['/c', 'start', '', url] : [url], { stdio: 'ignore' });
      return new Promise(() => {}); // keep serving
    }
    case 'install': return install(args[0], o, out);
    case 'doctor': {
      const p = proj();
      open();
      (await import('./db.mjs')).checkpointWal();
      const db = path.join(home(), 'uac.db');
      const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
      const errLog = path.join(home(), 'hook-errors.log');
      const d = { node: process.version, node_ok: Number(process.versions.node.split('.')[0]) > 22 || (process.versions.node.startsWith('22.') && Number(process.versions.node.split('.')[1]) >= 13),
        db, db_bytes: size(db), wal_bytes: size(db + '-wal'), integrity: get('PRAGMA integrity_check').integrity_check, fts5: hasFts,
        project: p.root, branch: p.branch, mode: p.mode, counts: S.counts(p.id), projects: S.listProjects().length,
        hook_errors: fs.existsSync(errLog) ? fs.readFileSync(errLog, 'utf8').trim().split('\n').filter((l) => !/^\s+at /.test(l)).slice(-5) : [] };
      return out(d, Object.entries(d).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n'));
    }
    case undefined: case 'help': case '--help': return console.log(USAGE);
    default: throw new Error(`unknown command "${cmd}"\n${USAGE}`);
  }
}

async function install(host, o, out) {
  const { adapters } = await import('./adapters/index.mjs');
  const { isSea } = await import('node:sea');
  const uacCmd = isSea() ? `"${process.execPath}"` : `node "${path.join(ROOT, 'bin', 'uac.mjs')}"`;
  const one = (h) => adapters[h].install({ root: ROOT, uacCmd, dryRun: !!o['dry-run'] });
  if (host) {
    if (!HOSTS.includes(host)) throw new Error(`host must be one of ${HOSTS.join(', ')}`);
    const r = await one(host);
    return out(r, JSON.stringify(r, null, 1));
  }
  // detect installed tools
  const found = {
    claude: onPath('claude'), gemini: onPath('gemini'), codex: onPath('codex'), copilot: onPath('copilot'),
    cursor: onPath('cursor') || fs.existsSync(path.join(os.homedir(), '.cursor')),
    antigravity: onPath('antigravity') || fs.existsSync(path.join(os.homedir(), '.gemini', 'config')),
  };
  const results = {};
  for (const h of HOSTS) {
    if (!found[h]) { results[h] = 'not found'; continue; }
    try { const r = await one(h); results[h] = { ok: true, files: (r.files || []).map((f) => f.path), commands: (r.commands || []).map((c) => c.cmd || c) }; }
    catch (e) { results[h] = { ok: false, error: e.message }; }
  }
  const vsix = fs.existsSync(path.join(ROOT, '..', 'extension')) && fs.readdirSync(path.join(ROOT, '..', 'extension')).find((f) => f.endsWith('.vsix'));
  if (onPath('code') && vsix) {
    if (o['dry-run']) results.vscode = `would run: code --install-extension ${vsix}`;
    else {
      const r = spawnSync('code', ['--install-extension', path.join(ROOT, '..', 'extension', vsix), '--force'], { encoding: 'utf8', shell: process.platform === 'win32' });
      results.vscode = r.status === 0 ? { ok: true, vsix } : { ok: false, error: (r.stderr || r.stdout).trim() };
    }
  } else results.vscode = onPath('code') ? 'no .vsix built (cd extension && npx @vscode/vsce package)' : 'not found';
  return out(results, Object.entries(results).map(([h, r]) => `${h.padEnd(12)} ${typeof r === 'string' ? r : r.ok ? `installed ${[...(r.files || []), ...(r.commands || []), r.vsix || ''].filter(Boolean).join(', ')}` : `FAILED: ${r.error}`}`).join('\n'));
}

// Edit a memory in the user's editor; applied once on close (no file watching / two-way sync).
function edit(id, out) {
  const m = S.memory(id);
  if (!m) throw new Error(`no memory ${id}`);
  const f = path.join(os.tmpdir(), `uac-${id}.md`);
  fs.writeFileSync(f, `title: ${m.title}\ntype: ${m.type}\nwhy: ${m.why || ''}\nanchors: ${JSON.stringify(m.anchors || [])}\n---\n${m.body}\n`);
  const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
  spawnSync(editor, [f], { stdio: 'inherit', shell: process.platform === 'win32' });
  const txt = fs.readFileSync(f, 'utf8'); fs.unlinkSync(f);
  const [head, ...rest] = txt.split(/\r?\n---\r?\n/);
  const meta = Object.fromEntries(head.split(/\r?\n/).map((l) => l.match(/^(\w+):\s?(.*)$/)).filter(Boolean).map((x) => [x[1], x[2]]));
  const patch = {};
  if (meta.title && meta.title !== m.title) patch.title = meta.title;
  if (meta.type && meta.type !== m.type && S.TYPES.includes(meta.type)) patch.type = meta.type;
  if ((meta.why || '') !== (m.why || '')) patch.why = meta.why;
  try { const a = JSON.parse(meta.anchors || '[]'); if (JSON.stringify(a) !== JSON.stringify(m.anchors || [])) patch.anchors = a; } catch {}
  const body = rest.join('\n---\n').trim();
  if (body && body !== m.body.trim()) patch.body = body;
  if (!Object.keys(patch).length) return out({ ok: true, changed: [] }, 'no changes');
  const u = S.updateMemory(id, patch, { by: 'user-cli', reason: 'uac edit' });
  if (u.project_id) S.exportProjectMd(S.project(u.project_id));
  return out({ ok: true, changed: Object.keys(patch) }, `updated ${id}: ${Object.keys(patch).join(', ')}`);
}
