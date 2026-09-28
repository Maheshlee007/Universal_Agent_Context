// MCP stdio server. ponytail: hand-rolled JSON-RPC (initialize, tools/list, tools/call, ping) to stay zero-dependency;
// switch to @modelcontextprotocol/sdk if we need resources, prompts or elicitation.
import readline from 'node:readline';
import * as S from './store.mjs';
import * as K from './pack.mjs';
import { rawLog } from './import.mjs';

const VERSION = '0.4.0';
const str = { type: 'string' }, num = { type: 'number' }, arr = { type: 'array', items: { type: 'string' } };
const sid = { session_id: { type: 'string', description: 'UAC session id (shown in the UAC start context). Omit to use the latest active session of this project.' } };
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const anchorsSchema = { type: 'array', description: 'Code anchors: exact symbol names as written in the code (greppable), file path, optional line',
  items: { type: 'object', properties: { file: str, symbol: str, line: num }, required: ['file'] } };

const TOOLS = [
  ['uac_bootstrap', 'Load project knowledge plus chosen session cards (merged, ranked, deduplicated). The hook already injects this at session start; call it only to load MORE or DIFFERENT context: other sessions, depth deep, or fresh (knowledge only).',
    obj({ ...sid, sessions: { type: 'array', items: str, description: 'Session ids or numbers (#n from the UAC session list) to continue from' }, packs: arr,
      goal: { type: 'string', description: "The user's task, used for ranking" }, depth: { type: 'string', enum: ['normal', 'deep'] }, fresh: { type: 'boolean', description: 'Project knowledge only, no session state' },
      limit: { type: 'number', description: 'Max knowledge items (default: as many as fit the token budget)' }, budget_tokens: { type: 'number', description: 'Token budget (default 2000, deep 6000)' } })],
  ['uac_capture', 'Turn recording of this session on/paused/off, and optionally set the project mode: off (UAC does nothing), manual (loads context, records only when asked), automatic (loads, records, auto-saves).',
    obj({ ...sid, state: { type: 'string', enum: ['on', 'paused', 'off'] }, mode: { type: 'string', enum: ['off', 'manual', 'automatic'] } }, ['state'])],
  ['uac_checkpoint', 'Write a resumable checkpoint of the current work: goal, what works, what is broken, files, next steps, and a note for the next developer.',
    obj({ ...sid, goal: str, working: str, broken: str, files: arr, next_steps: arr, note: { type: 'string', description: "What I'd tell the next dev" } }, ['goal', 'note'])],
  ['uac_search', 'Search project memory (BM25 + trigram). Returns a compact index "id · type · status · title". Use uac_get for full content. Empty query lists the most recent.',
    obj({ query: str, type: { type: 'string', enum: S.TYPES }, status: { type: 'string', enum: ['proposed', 'active', 'stale', 'conflict', 'superseded', 'archived'] }, limit: num }, ['query'])],
  ['uac_get', 'Get full content of memories (m-), summaries (s-), checkpoints (c-), packs (p-) or sessions (session id or #n: the card). With raw:true a session also returns its raw log from the host transcript (what the card left out).',
    obj({ ids: arr, raw: { type: 'boolean' } }, ['ids'])],
  ['uac_timeline', 'Sessions around a session, with their cards (what happened before/after).', obj({ ...sid, before: num, after: num })],
  ['uac_why', 'Explain why an item was included in the last context pack.', obj({ id: str }, ['id'])],
  ['uac_verify', 'Mark memories as still true after you checked them against the code (bumps verification, clears stale; no new version).', obj({ ...sid, ids: arr }, ['ids'])],
  ['uac_propose', 'Record a durable memory. Types: decision (with why), constraint, lesson, requirement, architecture, fact, preference, warning, task, idea (ideas are never facts). Quote identifiers verbatim and add anchors. Confidence >= 0.7 is accepted automatically; lower waits for the user. No tool noise, no secrets.',
    obj({ ...sid, type: { type: 'string', enum: S.TYPES }, title: str, body: str, why: str, files: arr, anchors: anchorsSchema, confidence: num,
      scope: { type: 'string', enum: ['user', 'project', 'branch'] }, review_when: { type: 'string', description: 'For deferred/YAGNI decisions: the condition that should trigger a revisit' } }, ['type', 'title', 'body'])],
  ['uac_update', 'Change an existing memory because the facts changed, or close it: status "done" for a finished task (kept in history, no longer loaded). Needs a reason. Applied directly (with a version) when confident, otherwise proposed for review.',
    obj({ id: str, body: str, title: str, reason: str, evidence: str, anchors: anchorsSchema, confidence: num, type: { type: 'string', enum: S.TYPES },
      status: { type: 'string', enum: ['done', 'active', 'archived'] } }, ['id', 'reason'])],
  ['uac_invalidate', 'Retire a memory that is no longer true (kept in history, not deleted).', obj({ id: str, reason: str, superseded_by: str }, ['id', 'reason'])],
  ['uac_review', 'List memories that need a human decision (low-confidence proposals and conflicts). Walk the user through them, then call uac_resolve.', obj({})],
  ['uac_resolve', 'Accept or reject a proposed/conflicting memory after the user decided. Optionally accept with an edited body.', obj({ id: str, action: { type: 'string', enum: ['accept', 'reject'] }, body: str }, ['id', 'action'])],
  ['uac_handoff', 'Continue this work elsewhere: the next UAC session of this project (any agent/branch) continues from this session. Save first so the card is complete.', obj({ ...sid })],
  ['uac_message', 'Post a note to other sessions of this project, also in other tools (Codex, Gemini...) and on other branches, e.g. "I changed the signature of computeRowPlan". Delivered once at their next prompt.',
    obj({ ...sid, text: str, to: { type: 'string', description: "'all' (default), 'branch:<name>' or 'session:<id>'" } }, ['text'])],
  ['uac_messages', 'Read unread messages for this session (marks them read).', obj({ ...sid })],
  ['uac_pack', 'Advanced: create or list named packs of memory/summary/checkpoint ids.', obj({ action: { type: 'string', enum: ['create', 'list'] }, name: str, ids: arr, goal: str, next: { type: 'boolean' } }, ['action'])],
  ['uac_digest', 'For the uac-compressor subagent: unsaved redacted events, git diff since the session started (covers subagent edits), memories to re-check because their files changed, and an index of existing memories.',
    obj({ session_id: str, max_chars: num }, ['session_id'])],
  ['uac_save', 'For the uac-compressor subagent (or whoever follows uac_digest how_to_save): save summary, checkpoint and reconciled candidates (op add|update|supersede|conflict|verify|done|noop, with anchors) for events up to upto_event_id. Replaces UAC\'s copy of the raw events (the host transcript keeps the original).',
    obj({ session_id: str, base_event_id: num, upto_event_id: num, model: { type: 'string', description: 'Your model id' }, summary: { type: 'object' }, checkpoint: { type: 'object' }, candidates: { type: 'array', items: { type: 'object' } } }, ['session_id', 'upto_event_id'])],
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

function getById(id, { raw, p } = {}) {
  const t = { m: 'memories', s: 'summaries', c: 'checkpoints', p: 'packs' }[id.split('-')[0]];
  const sess = !t || /^\d+$/.test(id) ? S.session(S.resolveSessionRefs(p.id, [id])[0]) : null;
  if (sess && sess.project_id === p.id) { // sessions only from this project
    const out = { session: { id: sess.id, title: sess.title, agent: sess.agent, branch: sess.branch, started_at: sess.started_at }, card: S.card(sess.id) };
    if (raw) try { out.raw = rawLog(sess); } catch (e) { out.raw_error = e.message; }
    return out;
  }
  if (!t) return { id, error: 'unknown id' };
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
  uac_get: (a, { p }) => a.ids.map((id) => getById(String(id), { raw: a.raw, p })),
  uac_timeline: (a, { s, p }) => K.timeline(p, s, a),
  uac_why: (a, { p }) => K.why(p.id, a.id),
  uac_verify: (a, { p }) => a.ids.map((id) => { const m = S.verifyMemory(id, p); return [`${m.id} verified`, ...S.anchorHints(p.root, m.anchors)].join('; '); }).join('\n'),
  uac_propose: (a, { s, p }) => {
    const m = S.propose(a, { s, p });
    return [`${m.id} saved as ${m.status} (${m.scope} scope)${m.status === 'proposed' ? ': waits for user review (confidence < 0.7)' : ''}`, ...S.anchorHints(p.root, m.anchors)].join('\n');
  },
  uac_update: (a, { s, p }) => {
    const old = S.memory(a.id);
    if (!old) throw new Error(`no memory ${a.id}`);
    if (a.status === 'done' || a.status === 'archived') { S.updateMemory(a.id, { status: a.status }, { by: 'llm', reason: a.reason }); return `${a.id} → ${a.status} (kept in history, no longer loaded)`; }
    if (!a.body && !a.title && !a.anchors && !a.type && !a.status) throw new Error('nothing to change: give body, title, anchors, type or status');
    if ((a.confidence ?? 0.8) >= S.AUTO_ACCEPT_CONFIDENCE) {
      S.updateMemory(a.id, { body: a.body, title: a.title, anchors: a.anchors, type: a.type, status: a.status }, { by: 'llm', reason: a.reason });
      S.verifyMemory(a.id, p);
      return [`${a.id} updated (previous version kept in history)`, ...S.anchorHints(p.root, S.memory(a.id).anchors)].join('\n');
    }
    const m = S.propose({ ...old, type: a.type || old.type, title: a.title || old.title, body: a.body ?? old.body, why: a.reason, anchors: a.anchors || old.anchors, confidence: a.confidence, status: 'proposed' }, { s, p });
    S.relate(m.id, a.id, 'supersedes');
    return `${m.id} proposed to supersede ${a.id} (awaiting review)`;
  },
  uac_invalidate: (a) => { S.invalidate(a.id, a.reason, a.superseded_by); return `${a.id} superseded`; },
  uac_review: (a, { p }) => S.review(p.id),
  uac_resolve: (a, { p }) => { const m = S.resolve(a.id, a.action, a.body, 'user-tool'); S.exportProjectMd(p); return `${m.id} → ${m.status}`; },
  uac_pack: (a, { s, p }) => (a.action === 'create' ? K.createPack(p, s, a) : K.listPacks(p.id)),
  uac_handoff: (a, { s, p }) => K.handoff(s, p),
  uac_message: (a, { s, p }) => S.postMessage(s, p, a.text, a.to || 'all'),
  uac_messages: (a, { s }) => { const m = S.unreadMessages(s); S.markRead(s, m); return m.length ? m : 'no unread messages'; },
  uac_digest: (a, { s }) => K.digest(s, a.max_chars),
  uac_save: (a, { s, p }) => K.save(s, p, a),
};

export async function callTool(name, args = {}) {
  const h = handlers[name];
  if (!h) throw new Error(`unknown tool ${name}`);
  const c = ctx(args);
  if (!c.s && !['uac_search', 'uac_get', 'uac_why', 'uac_review', 'uac_resolve', 'uac_pack', 'uac_capture', 'uac_verify', 'uac_message'].includes(name))
    throw new Error('no UAC session for this project yet (hooks not installed?). Run `uac install`.');
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
