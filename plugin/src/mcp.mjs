// MCP stdio server. ponytail: hand-rolled JSON-RPC (initialize, tools/list, tools/call, ping) to stay zero-dependency;
// switch to @modelcontextprotocol/sdk if we need resources, prompts or elicitation.
// Every tool description is paid for in tokens by every session's tool list: 13 tools, short descriptions.
import readline from 'node:readline';
import * as S from './store.mjs';
import * as K from './pack.mjs';
import { rawLog } from './import.mjs';
import { VERSION, ROOT } from './util.mjs';
import { run, all } from './db.mjs';

const str = { type: 'string' }, num = { type: 'number' }, arr = { type: 'array', items: { type: 'string' } };
const sid = { session_id: { type: 'string', description: 'This session\'s id (in the UAC header). Pass it; omitted = the most recently active session of this project.' } };
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const anchorsSchema = { type: 'array', description: 'Code anchors, paths relative to the project root: exact symbol as written in the code, file, optional line',
  items: { type: 'object', properties: { file: str, symbol: str, line: num }, required: ['file'] } };
const refs = 'Session refs: #n (stable), short id or full id.';

const TOOLS = [
  ['uac_bootstrap', `Load MORE or DIFFERENT context than the hook injected at start: other sessions' cards, depth "deep", or fresh (knowledge only). ${refs}`,
    obj({ ...sid, sessions: { ...arr, description: 'Sessions to continue from (#n, short id or id)' }, goal: { type: 'string', description: "The user's task, used for ranking" },
      depth: { type: 'string', enum: ['normal', 'deep'] }, fresh: { type: 'boolean', description: 'Project knowledge only, no session state' },
      limit: { type: 'number', description: 'Max knowledge items' }, budget_tokens: { type: 'number', description: 'Token budget (default 2000, deep 6000)' } })],
  ['uac_sessions', `List this project's sessions, one line each: #n, short id, branch, age, live/ended, card, unsaved events, raw log available, title. ${refs}`,
    obj({ limit: num, all: { type: 'boolean', description: 'Include rolled-up and never-used sessions' } })],
  ['uac_get', `Full content by id: memories (m-), summaries (s-), checkpoints (c-), or sessions (their card). raw:true adds a session's raw log (host transcript, else UAC's kept last turns). ${refs}`,
    obj({ ids: arr, raw: { type: 'boolean' } }, ['ids'])],
  ['uac_search', 'Search this project\'s memory (BM25 + trigram): "id · type · status · title — snippet". Empty query lists the most recent.',
    obj({ query: str, type: { type: 'string', enum: S.TYPES }, status: { type: 'string', enum: ['proposed', 'active', 'stale', 'conflict', 'superseded', 'archived'] }, limit: num }, ['query'])],
  ['uac_propose', 'Record a durable memory: decision (with why), constraint, lesson, requirement, architecture, fact, preference (say where it applies), warning, task, idea. Quote identifiers verbatim; anchor code. Refused if a near-duplicate exists (update that one; force:true overrides). Confidence >= 0.7 is accepted automatically.',
    obj({ ...sid, type: { type: 'string', enum: S.TYPES }, title: str, body: str, why: str, files: arr, anchors: anchorsSchema, confidence: num,
      scope: { type: 'string', enum: ['user', 'project', 'branch'], description: 'user = all your projects (default for preferences)' },
      review_when: { type: 'string', description: 'For deferred/YAGNI decisions: what should trigger a revisit' }, force: { type: 'boolean' } }, ['type', 'title', 'body'])],
  ['uac_update', 'Change a memory because the facts changed, or close it: status "done" (finished task), "superseded" (no longer true; superseded_by optional), "archived". Judge a memory only at its anchored path. Needs a reason.',
    obj({ id: str, reason: str, body: str, title: str, anchors: anchorsSchema, type: { type: 'string', enum: S.TYPES },
      status: { type: 'string', enum: ['done', 'superseded', 'active', 'archived'] }, superseded_by: str, confidence: num }, ['id', 'reason'])],
  ['uac_verify', 'Mark memories still true after checking them against the code at their anchored path. Refused while an anchored file is missing.', obj({ ...sid, ids: arr }, ['ids'])],
  ['uac_review', 'Memories that need a human (low-confidence proposals, conflicts). After the user decides, call again with resolve:[{id, action:"accept"|"reject", body?}].',
    obj({ resolve: { type: 'array', items: { type: 'object', properties: { id: str, action: { type: 'string', enum: ['accept', 'reject'] }, body: str }, required: ['id', 'action'] } } })],
  ['uac_message', `Leave a note for other sessions of this project (other windows, tools, branches), delivered once at their next prompt. Without text: read your unread messages. ${refs}`,
    obj({ ...sid, text: str, to: { type: 'string', description: "'all' (default), 'branch:<name>' or 'session:<ref>'" } })],
  ['uac_capture', 'Turn recording of this session on/paused/off, and optionally set the project mode: off, manual (records only when asked), automatic (records and auto-saves).',
    obj({ ...sid, state: { type: 'string', enum: ['on', 'paused', 'off'] }, mode: { type: 'string', enum: ['off', 'manual', 'automatic'] } }, ['state'])],
  ['uac_handoff', 'The next UAC session of this project (any tool or branch) continues from this one. Save first so the card is complete.', obj({ ...sid })],
  ['uac_digest', 'Compressor only (a subagent keeps this out of the main conversation): unsaved events, git diff since the session started, memories to re-check, open tasks, likely duplicates, and how_to_save.',
    obj({ session_id: str, max_chars: num }, ['session_id'])],
  ['uac_save', 'Compressor only: ONE call with summary {title, body} and checkpoint {goal, working, broken, files, next_steps, note, gaps} (both required; an incomplete card is refused and nothing is deleted), plus candidates (op add|update|supersede|conflict|verify|done|noop). Replaces UAC\'s copy of the raw events.',
    obj({ session_id: str, base_event_id: num, upto_event_id: num, model: { type: 'string', description: 'Your model id' }, summary: { type: 'object' }, checkpoint: { type: 'object' }, candidates: { type: 'array', items: { type: 'object' } } }, ['session_id', 'upto_event_id', 'summary', 'checkpoint'])],
];

function ctx(args) {
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.env.UAC_CWD || process.cwd();
  let s = args.session_id ? S.session(args.session_id) : null;
  if (args.session_id && !s) throw new Error(`unknown session_id ${args.session_id} (use the session_id from the UAC header)`);
  const p = S.projectFor(s ? S.project(s.project_id).root : cwd);
  if (!s) s = S.currentSession(p.id);
  // which UAC serves this session's tools: hooks compare it with their own version and say "reload" on a mismatch
  if (s && s.mcp_version !== VERSION) run('UPDATE sessions SET mcp_version = ? WHERE id = ?', VERSION, s.id);
  return { s, p };
}

const index = (ms) => ms.map((m) => `${m.id} · ${m.type} · ${m.status} · ${m.title} — ${String(m.body || '').replace(/\s+/g, ' ').slice(0, 100)}`).join('\n') || '(no results)';

function getById(id, { raw, p } = {}) {
  const t = { m: 'memories', s: 'summaries', c: 'checkpoints' }[id.split('-')[0]];
  const sess = !t ? S.session(S.resolveSessionRef(p.id, id)) : null; // session: #n, short id or id (this project only)
  if (sess) {
    const x = S.listSessions(p.id, { limit: 500, all: true }).find((y) => y.id === sess.id);
    const out = { session: { ref: S.ref(x || sess), id: sess.id, title: sess.title, agent: sess.agent, branch: sess.branch, status: sess.status, started_at: sess.started_at, unsaved: x?.unsaved }, card: S.card(sess.id) };
    if (raw) {
      try { out.raw = rawLog(sess); out.raw_source = 'host transcript'; }
      catch (e) { // the host deleted its transcript: UAC's own unsaved events + the last turns kept at each save
        out.raw = all(`SELECT ts, kind, tool, target, body FROM events WHERE session_id = ? AND kind != 'pending' ORDER BY id`, sess.id);
        out.raw_source = `UAC's kept events (${e.message})`;
      }
    }
    return out;
  }
  if (!t) return { id, error: S.sessionRefError(p.id, id) };
  // every row is scoped to this project (user-scope memories have no project and are shared on purpose)
  const row = t === 'memories' ? S.memory(id) : S.open().prepare(`SELECT * FROM ${t} WHERE id = ?`).get(id);
  if (!row || (row.project_id != null && row.project_id !== p.id)) return { id, error: 'not found in this project' };
  return t === 'memories' ? { ...row, relations: S.open().prepare('SELECT * FROM memory_relations WHERE a = ? OR b = ?').all(id, id) } : row;
}

const handlers = {
  uac_bootstrap: (a, { s, p }) => { const b = K.bootstrap(s, p, a); return `${b.text}\n${b.loaded}`; },
  uac_sessions: (a, { s, p }) => K.sessionsIndex(p, s, a),
  uac_get: (a, { p }) => a.ids.map((id) => getById(String(id), { raw: a.raw, p })),
  uac_search: (a, { p }) => index(S.search(p.id, a.query, a)),
  uac_propose: (a, { s, p }) => {
    const d = !a.force && S.nearDuplicate(p.id, a);
    if (d) return `not saved: near-duplicate of ${d.id} "${d.title}" (overlap ${d.overlap}). Update that one: uac_update {id:"${d.id}", body, reason}. If it really is different, call again with force:true.`;
    const m = S.propose(a, { s, p });
    return [`${m.id} saved as ${m.status} (${m.scope} scope)${m.status === 'proposed' ? ': waits for user review (confidence < 0.7)' : ''}`, ...S.anchorHints(p.root, m.anchors)].join('\n');
  },
  uac_update: (a, { s, p }) => {
    const old = S.ownMemory(a.id, p.id);
    if (a.status === 'superseded') { if (a.superseded_by) S.ownMemory(a.superseded_by, p.id); S.invalidate(a.id, a.reason, a.superseded_by); S.exportProjectMd(p); return `${a.id} → superseded (kept in history, no longer loaded)`; }
    if (a.status === 'done' || a.status === 'archived') { S.updateMemory(a.id, { status: a.status }, { by: 'llm', reason: a.reason }); S.exportProjectMd(p); return `${a.id} → ${a.status} (kept in history, no longer loaded)`; }
    if (!a.body && !a.title && !a.anchors && !a.type && !a.status) throw new Error('nothing to change: give body, title, anchors, type or status');
    if ((a.confidence ?? 0.8) >= S.AUTO_ACCEPT_CONFIDENCE) {
      S.updateMemory(a.id, { body: a.body, title: a.title, anchors: a.anchors, type: a.type, status: a.status }, { by: 'llm', reason: a.reason });
      let note = '';
      try { S.verifyMemory(a.id, p); } catch (e) { note = `\n${e.message}`; }
      S.exportProjectMd(p);
      return [`${a.id} updated (previous version kept in history)${note}`, ...S.anchorHints(p.root, a.anchors || [])].join('\n');
    }
    const m = S.propose({ ...old, type: a.type || old.type, title: a.title || old.title, body: a.body ?? old.body, why: a.reason, anchors: a.anchors || old.anchors, confidence: a.confidence, status: 'proposed' }, { s, p });
    S.relate(m.id, a.id, 'supersedes');
    return `${m.id} proposed to supersede ${a.id} (awaiting review)`;
  },
  uac_verify: (a, { p }) => a.ids.map((id) => { try { S.ownMemory(id, p.id); return `${S.verifyMemory(id, p).id} verified`; } catch (e) { return e.message; } }).join('\n'),
  uac_review: (a, { p }) => {
    if (!a.resolve?.length) return S.review(p.id);
    const out = a.resolve.map((r) => { try { S.ownMemory(r.id, p.id); return `${S.resolve(r.id, r.action, r.body, 'user-tool').id} → ${r.action}ed`; } catch (e) { return `${r.id}: ${e.message}`; } });
    S.exportProjectMd(p);
    return out.join('\n');
  },
  uac_message: (a, { s, p }) => {
    if (!a.text?.trim()) { if (!s) return 'no session'; const m = S.unreadMessages(s); S.markRead(s, m); return m.length ? m : 'no unread messages'; }
    return S.postMessage(s, p, a.text, a.to || 'all');
  },
  uac_capture: (a, { s, p }) => {
    if (a.mode) S.setMode(p.id, a.mode);
    if (!s) return 'No session found for this project yet; mode saved.';
    S.setCapture(s.id, a.state);
    return `capture=${a.state}${a.mode ? ` mode=${a.mode}` : ''} for session ${s.id}`;
  },
  uac_handoff: (a, { s, p }) => K.handoff(s, p),
  uac_digest: (a, { s }) => K.digest(s, a.max_chars),
  uac_save: (a, { s, p }) => K.save(s, p, a),
};

export async function callTool(name, args = {}) {
  const h = handlers[name];
  if (!h) throw new Error(`unknown tool ${name}`);
  const c = ctx(args);
  if (!c.s && !['uac_search', 'uac_get', 'uac_review', 'uac_capture', 'uac_verify', 'uac_message', 'uac_sessions'].includes(name))
    throw new Error('no UAC session for this project yet (hooks not installed?). Run `uac install`.');
  return h(args, c);
}

// The other direction of the version check: this server vs the hooks of the session it serves. Hooks before 0.5 stamp
// no version at all, so an active session without a stamp was served by older hooks.
let skewWarned = false;
function skew(args) {
  if (skewWarned) return '';
  try {
    const { s } = ctx(args);
    if (!s || (s.prompts || 0) + (s.last_active_at ? 1 : 0) === 0) return '';
    const hv = s.hook_version;
    if (hv === VERSION) return '';
    skewWarned = true;
    return `[UAC warning] this MCP server runs ${VERSION} (${ROOT}) but this session's hooks run ${hv || 'an older version (before 0.5)'}. Tell the user: /reload-plugins or restart the session.\n\n`;
  } catch { return ''; }
}

export function serve() {
  const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    const { id, method, params = {} } = msg;
    if (id === undefined) return; // notification
    try {
      let result;
      if (method === 'initialize') result = { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'uac', version: VERSION } };
      else if (method === 'ping') result = {};
      else if (method === 'tools/list') result = { tools: TOOLS.map(([name, description, inputSchema]) => ({ name, description, inputSchema })) };
      else if (method === 'tools/call') {
        try {
          const r = await callTool(params.name, params.arguments || {});
          // compact JSON: indentation and nulls are pure token cost for the reader
          result = { content: [{ type: 'text', text: skew(params.arguments || {}) + (typeof r === 'string' ? r : JSON.stringify(r, (k, v) => (v === null ? undefined : v))) }] };
        } catch (e) { result = { content: [{ type: 'text', text: `UAC error: ${e.message}` }], isError: true }; }
      } else return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
      send({ jsonrpc: '2.0', id, result });
    } catch (e) { send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } }); }
  });
}
export { ROOT };
