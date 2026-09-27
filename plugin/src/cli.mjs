// `uac` command line. Every command supports --json for machine-readable output (used by the VS Code extension).
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, run, J, home } from './db.mjs';
import * as S from './store.mjs';
import * as K from './pack.mjs';

const ROOT = import.meta.url ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') : path.dirname(process.execPath);
const HOSTS = ['claude', 'codex', 'gemini', 'antigravity', 'cursor', 'copilot'];
const USAGE = `Universal Agent Context (UAC)
usage: uac <command> [options] [--json] [--cwd DIR]
  status                       project, session, memory counts
  capture <on|paused|off>      set capture for the current (or --session) session
  mode <manual|automatic>      set project mode
  choose --tier T [--pack P] [--capture on|off]   pre-select start-of-session context (VS Code extension)
  sessions [--active]          list sessions            session <id>   everything stored for one session
  packs | pack --ids a,b [--name N] [--next]           list / create context packs
  next [--pack P | --clear]    choose the context the NEXT session loads (one-shot)
  search <query>               search memories          get <id...>   show items
  review                       list proposals/conflicts accept|reject <id>
  edit <id>                    edit a memory in $EDITOR   forget <id>   hard-delete a memory
  export                       regenerate .context/PROJECT.md
  view [--port N] [--no-open]  local web viewer
  install <${HOSTS.join('|')}> [--dry-run]
  doctor                       health check
  hook <host> <event>          (called by hosts)        mcp   (MCP stdio server)`;

export async function main(argv) {
  const { values: o, positionals: [cmd, ...args] } = parseArgs({
    args: argv, allowPositionals: true, strict: false,
    options: { json: { type: 'boolean' }, cwd: { type: 'string' }, session: { type: 'string' }, tier: { type: 'string' },
      pack: { type: 'string' }, capture: { type: 'string' }, port: { type: 'string' }, 'no-open': { type: 'boolean' },
      'dry-run': { type: 'boolean' }, active: { type: 'boolean' }, type: { type: 'string' }, status: { type: 'string' },
      ids: { type: 'string' }, name: { type: 'string' }, next: { type: 'boolean' }, clear: { type: 'boolean' } },
  });
  const out = (data, text) => console.log(o.json ? JSON.stringify(data, null, 1) : (text ?? (typeof data === 'string' ? data : JSON.stringify(data, null, 1))));
  const cwd = o.cwd || process.cwd();
  const proj = () => S.projectFor(cwd);
  const sess = (p) => {
    const s = o.session ? S.session(o.session) : S.currentSession(p.id);
    if (!s) throw new Error('no UAC session for this project (start one in your agent, or pass --session)');
    return s;
  };

  switch (cmd) {
    case 'hook': return (await import('./hook.mjs')).main(args[0], args[1]);
    case 'mcp': return (await import('./mcp.mjs')).serve();

    case 'status': {
      const p = proj();
      const s = S.currentSession(p.id);
      const data = { project: { id: p.id, root: p.root, name: p.name, mode: p.mode }, session: s ? { id: s.id, capture: s.capture, status: s.status } : null,
        counts: S.counts(p.id), unsaved: S.unsavedSessions(p.id).map(({ session_id, events }) => ({ session_id, events })) };
      return out(data, `UAC · ${p.name} (${p.root})\nmode: ${p.mode || 'unset'}\nsession: ${s ? `${s.id} capture=${s.capture} ${s.status}` : 'none'}\n` +
        `memories: ${Object.entries(data.counts).map(([k, v]) => `${k}=${v}`).join(' ')}` + (data.unsaved.length ? `\nunsaved: ${data.unsaved.map((u) => `${u.session_id}(${u.events})`).join(', ')}` : ''));
    }
    case 'capture': { const p = proj(); const s = sess(p); S.setCapture(s.id, args[0]); return out({ ok: true, session_id: s.id, capture: args[0] }, `capture=${args[0]} (${s.id})`); }
    case 'mode': {
      if (!['manual', 'automatic'].includes(args[0])) throw new Error('mode must be manual or automatic');
      const p = proj(); S.setMode(p.id, args[0]); return out({ ok: true, mode: args[0] }, `mode=${args[0]} for ${p.name}`);
    }
    case 'choose': {
      const p = proj(); const s = sess(p);
      if (o.tier && K.TIERS[o.tier] === undefined) throw new Error(`tier must be one of ${Object.keys(K.TIERS).join(', ')}`);
      run('UPDATE sessions SET choice = ? WHERE id = ?', J({ tier: o.tier, pack: o.pack, capture: o.capture }), s.id);
      if (o.capture) S.setCapture(s.id, o.capture);
      return out({ ok: true }, `choice stored for ${s.id}`);
    }
    case 'sessions': {
      const p = proj();
      const rows = all(`SELECT s.id, s.agent, s.capture, s.status, s.started_at, s.title,
          (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.id > s.saved_event_id) AS unsaved
        FROM sessions s WHERE s.project_id = ? ${o.active ? "AND s.status != 'ended'" : ''} ORDER BY s.started_at DESC LIMIT 50`, p.id);
      return out(rows, rows.map((r) => `${r.id}  ${r.agent}  ${r.capture}/${r.status}  ${r.started_at}  unsaved=${r.unsaved}  ${r.title || ''}`).join('\n') || '(none)');
    }
    case 'search': {
      const rows = S.search(proj().id, args.join(' '), { type: o.type, status: o.status, limit: 50 }).map(({ id, type, title, status, score }) => ({ id, type, title, status, score }));
      return out(rows, rows.map((r) => `${r.id} · ${r.type} · ${r.status} · ${r.title}`).join('\n') || '(no results)');
    }
    case 'get': return out(await Promise.all(args.map(async (id) => (await import('./mcp.mjs')).callTool('uac_get', { ids: [id] }).then((r) => r[0]))));
    case 'review': {
      const r = S.review(proj().id);
      return out(r, [...r.proposed.map((m) => `proposed ${m.id} · ${m.type} · ${m.title}\n    ${m.body}`),
        ...r.conflicts.map((c) => `CONFLICT ${c.memory.id} "${c.memory.title}" vs ${c.other?.id} "${c.other?.title}"`)].join('\n') || 'nothing to review');
    }
    case 'accept': case 'reject': {
      const m = S.resolve(args[0], cmd); S.exportProjectMd(proj()); return out(m, `${m.id} → ${m.status}`);
    }
    case 'forget': {
      for (const id of args) { run('DELETE FROM memories WHERE id = ?', id); run('DELETE FROM memory_versions WHERE memory_id = ?', id); run('DELETE FROM memory_relations WHERE a = ? OR b = ?', id, id); }
      S.exportProjectMd(proj());
      return out({ ok: true, deleted: args }, `deleted ${args.join(', ')}`);
    }
    case 'packs': {
      const rows = K.listPacks(proj().id);
      return out(rows, rows.map((k) => `${k.id}${k.next ? ' [NEXT SESSION]' : ''}  ${k.name}  (${k.item_ids.length} items)`).join('\n') || '(no packs)');
    }
    case 'pack': {
      const ids = (o.ids || '').split(',').map((x) => x.trim()).filter(Boolean);
      if (!ids.length) throw new Error('--ids a,b,c required');
      const k = K.createPack(proj(), null, { ids, name: o.name, next: !!o.next });
      return out(k, `created ${k.id} (${ids.length} items)${k.next ? ', loads in the next session' : ''}`);
    }
    case 'next': {
      const p = proj();
      if (o.clear) return out({ pack: S.setNextPack(p.id, null) }, 'next session: default (ask at start)');
      if (o.pack) return out({ pack: S.setNextPack(p.id, o.pack) }, `next session loads pack ${o.pack}`);
      return out({ pack: S.nextPack(p.id) }, `next session: ${S.nextPack(p.id) || 'default (ask at start)'}`);
    }
    case 'session': {
      const d = S.sessionDetail(args[0]);
      if (!d) throw new Error(`no session ${args[0]}`);
      return out(d, [`session ${d.session.id} · ${d.session.agent} · capture=${d.session.capture} · ${d.session.status}`,
        `loaded: ${d.loaded ? JSON.stringify(d.loaded) : 'nothing'}`,
        ...d.summaries.map((x) => `summary ${x.id}: ${x.title}`),
        ...d.checkpoints.map((c) => `checkpoint ${c.id} (${c.trigger}): ${c.goal || ''}`),
        ...d.memories.map((m) => `memory ${m.id} · ${m.type} · ${m.status} · ${m.title}`),
        `events: ${d.events.length} (latest first)`, ...d.events.slice(0, 20).map((e) => `  ${e.kind} ${e.tool || ''} ${e.target || e.body || ''}`.slice(0, 160))].join('\n'));
    }
    case 'edit': return edit(args[0], out);
    case 'export': { const f = S.exportProjectMd(proj()); return out({ ok: true, file: f }, `wrote ${f}`); }
    case 'view': {
      const { startViewer } = await import('./view.mjs');
      const { url } = await startViewer({ port: Number(o.port || 0) });
      out({ url }, `UAC viewer: ${url}`);
      if (!o['no-open'] && !o.json) spawnSync(process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open',
        process.platform === 'win32' ? ['/c', 'start', '', url] : [url], { stdio: 'ignore' });
      return new Promise(() => {}); // keep serving
    }
    case 'install': {
      if (!HOSTS.includes(args[0])) throw new Error(`host must be one of ${HOSTS.join(', ')}`);
      const { adapters } = await import('./adapters/index.mjs');
      const { isSea } = await import('node:sea');
      // in the single-executable build the exe itself is the command; otherwise node + bin/uac.mjs
      const uacCmd = isSea() ? `"${process.execPath}"` : `node "${path.join(ROOT, 'bin', 'uac.mjs')}"`;
      const r = await adapters[args[0]].install({ root: ROOT, uacCmd, dryRun: !!o['dry-run'] });
      return out(r, JSON.stringify(r, null, 1));
    }
    case 'doctor': {
      const p = proj();
      const { hasFts } = await import('./db.mjs');
      const errLog = path.join(home(), 'hook-errors.log');
      const d = { node: process.version, db: path.join(home(), 'uac.db'), fts5: hasFts, project: p.root, mode: p.mode, counts: S.counts(p.id),
        hook_errors: fs.existsSync(errLog) ? fs.readFileSync(errLog, 'utf8').trim().split('\n').slice(-5) : [] };
      return out(d, Object.entries(d).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n'));
    }
    case undefined: case 'help': case '--help': return console.log(USAGE);
    default: throw new Error(`unknown command "${cmd}"\n${USAGE}`);
  }
}

// Edit a memory in the user's editor; applied once on close (no file watching / two-way sync).
function edit(id, out) {
  const m = S.memory(id);
  if (!m) throw new Error(`no memory ${id}`);
  const f = path.join(os.tmpdir(), `uac-${id}.md`);
  fs.writeFileSync(f, `title: ${m.title}\ntype: ${m.type}\nwhy: ${m.why || ''}\n---\n${m.body}\n`);
  const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
  spawnSync(editor, [f], { stdio: 'inherit', shell: process.platform === 'win32' });
  const txt = fs.readFileSync(f, 'utf8'); fs.unlinkSync(f);
  const [head, ...rest] = txt.split(/\r?\n---\r?\n/);
  const meta = Object.fromEntries(head.split(/\r?\n/).map((l) => l.match(/^(\w+):\s?(.*)$/)).filter(Boolean).map((x) => [x[1], x[2]]));
  const patch = {};
  if (meta.title && meta.title !== m.title) patch.title = meta.title;
  if (meta.type && meta.type !== m.type && S.TYPES.includes(meta.type)) patch.type = meta.type;
  if ((meta.why || '') !== (m.why || '')) patch.why = meta.why;
  const body = rest.join('\n---\n').trim();
  if (body && body !== m.body.trim()) patch.body = body;
  if (!Object.keys(patch).length) return out({ ok: true, changed: [] }, 'no changes');
  const u = S.updateMemory(id, patch, { by: 'user', reason: 'uac edit' });
  if (u.project_id) S.exportProjectMd(S.project(u.project_id));
  return out({ ok: true, changed: Object.keys(patch) }, `updated ${id}: ${Object.keys(patch).join(', ')}`);
}
