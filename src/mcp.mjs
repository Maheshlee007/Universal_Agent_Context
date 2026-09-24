// MCP stdio server. ponytail: hand-rolled JSON-RPC (initialize, tools/list, tools/call, ping) to stay zero-dependency;
// switch to @modelcontextprotocol/sdk if we need resources, prompts or elicitation.
import readline from 'node:readline';
import * as S from './store.mjs';
import * as K from './pack.mjs';

const VERSION = '0.1.0';
const str = { type: 'string' }, num = { type: 'number' }, arr = { type: 'array', items: { type: 'string' } };
const sid = { session_id: { type: 'string', description: 'UAC session id from the SessionStart menu. Omit to use the latest active session of this project.' } };
const obj = (properties, required = []) => ({ type: 'object', properties, required });

const TOOLS = [
  ['uac_bootstrap', 'Load a ranked, token-budgeted context pack for this project: last checkpoint, must-not-violate requirements, decisions, architecture, lessons, open tasks, recent sessions. Call once at session start after asking the user which tier.',
    obj({ ...sid, tier: { type: 'string', enum: Object.keys(K.TIERS), description: 'minimal ~1k, relevant ~4k, deep ~10k, fork = project knowledge only (no session state), none' }, budget_tokens: num, goal: { type: 'string', description: "The user's task, used for ranking" }, pack: { type: 'string', description: 'Pack id (p-xxxxxx) to load' } })],
  ['uac_capture', 'Set whether this session is recorded (on/paused/off), and optionally the project mode (manual/automatic).',
    obj({ ...sid, state: { type: 'string', enum: ['on', 'paused', 'off'] }, mode: { type: 'string', enum: ['manual', 'automatic'] } }, ['state'])],
  ['uac_checkpoint', 'Write a resumable checkpoint of the current work: goal, what works, what is broken, files, next steps, and a note for the next developer.',
    obj({ ...sid, goal: str, working: str, broken: str, files: arr, next_steps: arr, note: { type: 'string', description: "What I'd tell the next dev" } }, ['goal', 'note'])],
  ['uac_search', 'Search project memory (BM25 + trigram). Returns a compact index "id · type · status · title". Use uac_get for full content. Empty query lists the most recent.',
    obj({ query: str, type: { type: 'string', enum: S.TYPES }, status: { type: 'string', enum: ['proposed', 'active', 'stale', 'conflict', 'superseded', 'archived'] }, limit: num }, ['query'])],
  ['uac_get', 'Get full content of memories (m-), summaries (s-), checkpoints (c-) or packs (p-) by id.', obj({ ids: arr }, ['ids'])],
  ['uac_timeline', 'Sessions around a session, with their summaries and checkpoints (what happened before/after).', obj({ ...sid, before: num, after: num })],
  ['uac_why', 'Explain why an item was included in the last context pack.', obj({ id: str }, ['id'])],
  ['uac_propose', 'Propose a durable memory. Types: decision (with why), constraint, lesson, requirement, architecture, fact, preference, warning, task, idea (ideas are never facts). Do not store tool noise or secrets. In manual mode it waits for user review.',
    obj({ ...sid, type: { type: 'string', enum: S.TYPES }, title: str, body: str, why: str, files: arr, confidence: num, scope: { type: 'string', enum: ['user', 'project', 'branch'] }, review_when: { type: 'string', description: 'For deferred/YAGNI decisions: the condition that should trigger a revisit' } }, ['type', 'title', 'body'])],
  ['uac_update', 'Change an existing memory because the facts changed. Needs a reason. Manual mode creates a superseding proposal; automatic mode applies it with a version.',
    obj({ id: str, body: str, title: str, reason: str, evidence: str }, ['id', 'body', 'reason'])],
  ['uac_invalidate', 'Retire a memory that is no longer true (kept in history, not deleted).', obj({ id: str, reason: str, superseded_by: str }, ['id', 'reason'])],
  ['uac_review', 'List memories awaiting user review (proposed) and conflicts. Walk the user through them, then call uac_resolve.', obj({})],
  ['uac_resolve', 'Accept or reject a proposed/conflicting memory after the user decided. Optionally accept with an edited body.', obj({ id: str, action: { type: 'string', enum: ['accept', 'reject'] }, body: str }, ['id', 'action'])],
  ['uac_pack', 'Create or list named context packs (bundles of memory ids) for reuse by other sessions.', obj({ action: { type: 'string', enum: ['create', 'list'] }, name: str, ids: arr, goal: str, budget_tokens: num }, ['action'])],
  ['uac_handoff', 'Create a pack from this session (checkpoint + top memories) for a parallel or next session. Returns the pack id and how to load it.', obj({ ...sid, name: str })],
  ['uac_digest', 'For the uac-compressor subagent: the unsaved, redacted, pre-filtered events of a session plus an index of existing memories to reconcile against.', obj({ session_id: str, max_chars: num }, ['session_id'])],
  ['uac_save', 'For the uac-compressor subagent: save summary, checkpoint and reconciled memory candidates (op add|update|supersede|conflict|noop) for events up to upto_event_id.',
    obj({ session_id: str, upto_event_id: num, summary: { type: 'object' }, checkpoint: { type: 'object' }, candidates: { type: 'array', items: { type: 'object' } } }, ['session_id', 'upto_event_id'])],
];

function ctx(args) {
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.env.UAC_CWD || process.cwd();
  let s = args.session_id ? S.session(args.session_id) : null;
  if (args.session_id && !s) throw new Error(`unknown session_id ${args.session_id}`);
  const p = S.projectFor(s ? S.project(s.project_id).root : cwd);
  if (!s) s = S.currentSession(p.id);
  return { s, p };
}

const index = (ms) => ms.map((m) => `${m.id} · ${m.type} · ${m.status} · ${m.title}`).join('\n') || '(no results)';

function getById(id) {
  const t = { m: 'memories', s: 'summaries', c: 'checkpoints', p: 'packs' }[id.split('-')[0]];
  if (!t) return { id, error: 'unknown id prefix' };
  if (t === 'memories') {
    const m = S.memory(id);
    return m && { ...m, relations: S.open().prepare('SELECT * FROM memory_relations WHERE a = ? OR b = ?').all(id, id) };
  }
  return S.open().prepare(`SELECT * FROM ${t} WHERE id = ?`).get(id) || { id, error: 'not found' };
}

const handlers = {
  uac_bootstrap: (a, { s, p }) => K.bootstrap(s, p, a).text,
  uac_capture: (a, { s, p }) => {
    if (a.mode) S.setMode(p.id, a.mode);
    if (!s) return 'No session found for this project yet; mode saved.';
    S.setCapture(s.id, a.state);
    return `capture=${a.state}${a.mode ? ` mode=${a.mode}` : ''} for session ${s.id}`;
  },
  uac_checkpoint: (a, { s }) => `checkpoint ${K.addCheckpoint(s, a, 'manual')} saved`,
  uac_search: (a, { p }) => index(S.search(p.id, a.query, a)),
  uac_get: (a) => a.ids.map(getById),
  uac_timeline: (a, { s, p }) => K.timeline(p, s, a),
  uac_why: (a, { p }) => K.why(p.id, a.id),
  uac_propose: (a, { s, p }) => { const m = S.propose(a, { s, p }); return `${m.id} saved as ${m.status} (${m.scope} scope)`; },
  uac_update: (a, { s, p }) => {
    if (p.mode === 'automatic') return S.updateMemory(a.id, { body: a.body, title: a.title }, { by: 'llm', reason: a.reason });
    const old = S.memory(a.id);
    if (!old) throw new Error(`no memory ${a.id}`);
    const m = S.propose({ ...old, title: a.title || old.title, body: a.body, why: a.reason, status: 'proposed' }, { s, p });
    S.relate(m.id, a.id, 'supersedes');
    return `${m.id} proposed to supersede ${a.id} (awaiting review)`;
  },
  uac_invalidate: (a) => { S.invalidate(a.id, a.reason, a.superseded_by); return `${a.id} superseded`; },
  uac_review: (a, { p }) => S.review(p.id),
  uac_resolve: (a, { p }) => { const m = S.resolve(a.id, a.action, a.body); S.exportProjectMd(p); return `${m.id} → ${m.status}`; },
  uac_pack: (a, { s, p }) => a.action === 'create' ? K.createPack(p, s, a)
    : S.open().prepare('SELECT id, name, goal, budget_tokens, created_at FROM packs WHERE project_id = ? ORDER BY created_at DESC').all(p.id),
  uac_handoff: (a, { s, p }) => K.handoff(s, p, a.name),
  uac_digest: (a, { s }) => K.digest(s, a.max_chars),
  uac_save: (a, { s, p }) => K.save(s, p, a),
};

export async function callTool(name, args = {}) {
  const h = handlers[name];
  if (!h) throw new Error(`unknown tool ${name}`);
  const c = ctx(args);
  if (!c.s && !['uac_search', 'uac_get', 'uac_why', 'uac_review', 'uac_resolve', 'uac_pack', 'uac_capture'].includes(name))
    throw new Error('no UAC session for this project yet (hooks not installed?). Run `uac install claude`.');
  return h(args, c);
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
          result = { content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r, null, 1) }] };
        } catch (e) { result = { content: [{ type: 'text', text: `UAC error: ${e.message}` }], isError: true }; }
      } else return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
      send({ jsonrpc: '2.0', id, result });
    } catch (e) { send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } }); }
  });
}
