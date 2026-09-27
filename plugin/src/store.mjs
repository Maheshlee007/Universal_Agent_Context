// Domain operations over the SQLite store (v0.3: session-centric, remote-keyed projects, anchored memories).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, tx, uid, now, J, P, hasFts, open } from './db.mjs';
import { gitInfo, git, defaultBranch, redact, clip, ignored } from './util.mjs';

export const TYPES = ['fact', 'decision', 'constraint', 'lesson', 'requirement', 'preference', 'warning', 'idea', 'task', 'architecture'];
export const MODES = ['off', 'manual', 'automatic'];
export const AUTO_ACCEPT_CONFIDENCE = 0.7;
const MAX_PROPOSALS_PER_SESSION = 20;
const PROPOSAL_TTL_DAYS = 7;
const DECAY_EXEMPT = new Set(['decision', 'lesson', 'constraint', 'requirement']);

// ---------- projects ----------
// Claude scratchpads / temp dirs are never registered as projects.
export const isScratch = (dir) => /[\\/](Temp|tmp)[\\/]claude[\\/-]/i.test(dir || '');

export function normRemote(url) {
  if (!url) return null;
  return url.trim().replace(/\.git$/, '').replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '').replace(':', '/').toLowerCase();
}

// Identity = git remote when there is one (same repo cloned twice = one project), else the folder.
export function projectFor(cwd) {
  const g = gitInfo(cwd || process.cwd());
  const remote = normRemote(g.remote);
  let row = remote && all('SELECT * FROM projects WHERE git_remote IS NOT NULL').find((r) => normRemote(r.git_remote) === remote);
  if (!row) row = get('SELECT * FROM projects WHERE lower(root) = lower(?)', g.root);
  if (row) {
    if (row.root !== g.root || (g.remote && row.git_remote !== g.remote))
      run('UPDATE projects SET root = ?, git_remote = COALESCE(?, git_remote) WHERE id = ?', g.root, g.remote, row.id);
  } else {
    const id = 'prj-' + crypto.createHash('sha1').update(remote || g.root.toLowerCase()).digest('hex').slice(0, 8);
    run('INSERT OR IGNORE INTO projects(id, root, name, git_remote, created_at) VALUES (?,?,?,?,?)', id, g.root, path.basename(g.root), g.remote, now());
    row = { id };
  }
  return { ...get('SELECT * FROM projects WHERE id = ?', row.id), branch: g.branch, commit: g.commit };
}
export const project = (id) => get('SELECT * FROM projects WHERE id = ?', id);
export function setMode(projectId, mode) {
  if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
  run('UPDATE projects SET mode = ? WHERE id = ?', mode, projectId);
}

const PROJECT_TABLES = ['sessions', 'memories', 'checkpoints', 'summaries', 'packs', 'retrievals', 'messages'];
export function listProjects() {
  return all(`SELECT p.id, p.root, p.name, p.mode, p.git_remote,
      (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS sessions,
      (SELECT COUNT(*) FROM memories m WHERE m.project_id = p.id) AS memories
    FROM projects p ORDER BY p.name`);
}
export function mergeProjects(from, into) {
  if (from === into || !project(from) || !project(into)) throw new Error('bad project ids');
  tx(() => {
    for (const t of PROJECT_TABLES) run(`UPDATE ${t} SET project_id = ? WHERE project_id = ?`, into, from);
    run('DELETE FROM settings WHERE scope = ?', from);
    run('DELETE FROM projects WHERE id = ?', from);
  });
}
export function deleteProject(id) {
  tx(() => {
    for (const s of all('SELECT id FROM sessions WHERE project_id = ?', id)) deleteSessionRows(s.id);
    for (const t of PROJECT_TABLES) run(`DELETE FROM ${t} WHERE project_id = ?`, id);
    run('DELETE FROM settings WHERE scope = ?', id);
    run('DELETE FROM projects WHERE id = ?', id);
  });
}

// ---------- sessions ----------
export const session = (id) => id && get('SELECT * FROM sessions WHERE id = ?', id);

export function ensureSession({ host, session_id, cwd, transcript_path, model }) {
  const existing = session(session_id);
  if (existing) {
    if (model && existing.model !== model) run('UPDATE sessions SET model = ? WHERE id = ?', model, session_id);
    return { s: session(session_id), created: false };
  }
  const p = projectFor(cwd);
  run(`INSERT INTO sessions(id, project_id, agent, model, branch, start_commit, capture, transcript_path, started_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    session_id, p.id, host, model ?? null, p.branch, p.commit,
    p.mode === 'automatic' ? 'on' : p.mode ? 'off' : 'ask', transcript_path ?? null, now());
  return { s: session(session_id), created: true };
}

export function currentSession(projectId) {
  return get(`SELECT * FROM sessions WHERE project_id = ? AND status != 'ended' ORDER BY started_at DESC LIMIT 1`, projectId)
    || get(`SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at DESC LIMIT 1`, projectId);
}

export function setCapture(sid, state) {
  if (!['on', 'paused', 'off', 'ask'].includes(state)) throw new Error(`bad capture state: ${state}`);
  run(`UPDATE sessions SET capture = ?, status = CASE WHEN status = 'ended' THEN status WHEN ? = 'paused' THEN 'paused' ELSE 'active' END WHERE id = ?`, state, state, sid);
  // prompts typed while capture was 'ask' are held as 'pending': kept on opt-in, deleted on opt-out
  if (state === 'on') run(`UPDATE events SET kind = 'prompt' WHERE session_id = ? AND kind = 'pending'`, sid);
  if (state === 'off') run(`DELETE FROM events WHERE session_id = ? AND kind = 'pending'`, sid);
}

export function addEvent(s, kind, { tool, target, body, agent_id } = {}) {
  const root = project(s.project_id)?.root;
  if (ignored(root, target)) { target = '[ignored]'; body = null; }
  run('INSERT INTO events(session_id, ts, kind, tool, target, body, agent_id) VALUES (?,?,?,?,?,?,?)',
    s.id, now(), kind, tool ?? null, clip(redact(target), 300), clip(redact(body), 2000), agent_id ?? null);
}

export function unsavedSessions(projectId, exceptId) {
  return all(`SELECT s.id AS session_id, s.agent, s.started_at, s.status, COUNT(e.id) AS events FROM sessions s
    JOIN events e ON e.session_id = s.id AND e.id > s.saved_event_id AND e.kind != 'pending'
    WHERE s.project_id = ? AND s.id != ? AND COALESCE(s.quality, '') != 'llm' GROUP BY s.id HAVING events >= 3 ORDER BY s.started_at DESC LIMIT 3`,
    projectId, exceptId ?? '');
}
export const unsavedCount = (s) => get(`SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND id > ? AND kind != 'pending'`, s.id, s.saved_event_id).n;

// Card = latest summary + latest non-superseded checkpoint of a session.
export function card(sessionId) {
  const sm = get('SELECT * FROM summaries WHERE session_id = ? ORDER BY created_at DESC LIMIT 1', sessionId);
  const cp = get('SELECT * FROM checkpoints WHERE session_id = ? AND superseded_by IS NULL ORDER BY ts DESC LIMIT 1', sessionId)
    || get('SELECT * FROM checkpoints WHERE session_id = ? ORDER BY ts DESC LIMIT 1', sessionId);
  if (!sm && !cp) return null;
  return {
    summary_id: sm?.id ?? null, checkpoint_id: cp?.id ?? null, title: sm?.title ?? cp?.goal ?? null, body: sm?.body ?? '',
    quality: sm?.quality ?? 'llm', model: sm?.model ?? null, goal: cp?.goal ?? null, working: cp?.working ?? null, broken: cp?.broken ?? null,
    next_steps: P(cp?.next_steps, []), files: P(cp?.files, []), note: cp?.note ?? null, at: sm?.created_at ?? cp?.ts,
  };
}

// Numbered newest-first list, the same numbering in CLI, dashboard, extension and `#uac continue <n>`.
export function listSessions(projectId, { limit = 50, active } = {}) {
  const next = new Set(nextSessions(projectId));
  return all(`SELECT s.*, (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.kind != 'pending') AS events,
      (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.id > s.saved_event_id AND e.kind != 'pending') AS unsaved,
      (SELECT COUNT(*) FROM memories m WHERE m.source_session = s.id) AS memories_created
    FROM sessions s WHERE s.project_id = ? ${active ? "AND s.status != 'ended'" : ''} ORDER BY s.started_at DESC, s.rowid DESC LIMIT ?`, projectId, limit)
    .map((s, i) => ({ id: s.id, n: i + 1, agent: s.agent, model: s.model, branch: s.branch, capture: s.capture, status: s.status,
      started_at: s.started_at, ended_at: s.ended_at, title: s.title, events: s.events, unsaved: s.unsaved,
      memories_created: s.memories_created, card: card(s.id), next: next.has(s.id) }));
}
// Accepts ids or 1-based numbers from listSessions.
export function resolveSessionRefs(projectId, refs) {
  const list = all('SELECT id FROM sessions WHERE project_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 200', projectId).map((r) => r.id);
  return refs.map((r) => (/^\d+$/.test(String(r)) && !session(String(r)) ? list[Number(r) - 1] : String(r))).filter((id) => id && session(id));
}

export function sessionDetail(id) {
  const s = session(id);
  if (!s) return null;
  const J2 = (r, ...ks) => { for (const k of ks) r[k] = P(r[k], []); return r; };
  return {
    session: s, loaded: P(s.loaded, null), card: card(id),
    events: all(`SELECT id, ts, kind, tool, target, body FROM events WHERE session_id = ? AND kind != 'pending' ORDER BY id DESC LIMIT 500`, id),
    summaries: all('SELECT * FROM summaries WHERE session_id = ? ORDER BY created_at DESC', id),
    checkpoints: all('SELECT * FROM checkpoints WHERE session_id = ? ORDER BY ts DESC', id).map((c) => J2(c, 'files', 'next_steps')),
    memories: all('SELECT * FROM memories WHERE source_session = ? ORDER BY created_at', id).map(hydrate),
  };
}

export function sessionImpact(id) {
  const n = (sql) => get(sql, id).n;
  return {
    events: n('SELECT COUNT(*) AS n FROM events WHERE session_id = ?'),
    summaries: n('SELECT COUNT(*) AS n FROM summaries WHERE session_id = ?'),
    checkpoints: n('SELECT COUNT(*) AS n FROM checkpoints WHERE session_id = ?'),
    memories: n('SELECT COUNT(*) AS n FROM memories WHERE source_session = ?'),
    retrievals: n('SELECT COUNT(*) AS n FROM retrievals WHERE session_id = ?'),
  };
}
function deleteSessionRows(id) {
  for (const m of all('SELECT id FROM memories WHERE source_session = ?', id)) deleteMemoryRows(m.id);
  for (const t of ['events', 'summaries', 'checkpoints', 'retrievals']) run(`DELETE FROM ${t} WHERE session_id = ?`, id);
  run('DELETE FROM message_reads WHERE session_id = ?', id);
  run('DELETE FROM sessions WHERE id = ?', id);
}
// Cascade: events, card (summaries + checkpoints), retrievals and the memories this session created.
export function deleteSession(id) {
  const s = session(id);
  if (!s) throw new Error(`no session ${id}`);
  const deleted = sessionImpact(id);
  tx(() => deleteSessionRows(id));
  const next = nextSessions(s.project_id).filter((x) => x !== id);
  setNextSessions(s.project_id, next);
  const p = project(s.project_id);
  if (p) try { exportProjectMd(p); } catch {}
  return deleted;
}
// Empty = no events, no card, and not active in the last 30 minutes.
export function cleanupEmpty(projectId) {
  const cutoff = new Date(Date.now() - 30 * 60e3).toISOString();
  const ids = all(`SELECT s.id FROM sessions s WHERE s.project_id = ? AND s.started_at < ?
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM summaries x WHERE x.session_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM checkpoints c WHERE c.session_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.source_session = s.id)`, projectId, cutoff).map((r) => r.id);
  tx(() => ids.forEach(deleteSessionRows));
  return ids.length;
}

// One-shot "continue from these sessions" for the next session start.
export const nextSessions = (projectId) => P(get(`SELECT value FROM settings WHERE scope = ? AND key = 'next_sessions'`, projectId)?.value, []);
export function setNextSessions(projectId, ids) {
  if (ids?.length) run(`INSERT OR REPLACE INTO settings VALUES (?, 'next_sessions', ?)`, projectId, J(ids));
  else run(`DELETE FROM settings WHERE scope = ? AND key = 'next_sessions'`, projectId);
  return ids || [];
}
// Legacy one-shot pack (v0.2), still honoured.
export const nextPack = (projectId) => get(`SELECT value FROM settings WHERE scope = ? AND key = 'next_pack'`, projectId)?.value ?? null;
export function setNextPack(projectId, packId) {
  if (packId) run(`INSERT OR REPLACE INTO settings VALUES (?, 'next_pack', ?)`, projectId, packId);
  else run(`DELETE FROM settings WHERE scope = ? AND key = 'next_pack'`, projectId);
  return packId || null;
}

// ---------- cross-agent messages ----------
export function postMessage(s, p, text, to = 'all') {
  if (!text?.trim()) throw new Error('empty message');
  if (!/^(all|branch:.+|session:.+)$/.test(to)) throw new Error("to must be 'all', 'branch:<name>' or 'session:<id>'");
  const id = uid('msg');
  run('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)', id, p.id, s?.id ?? null, s?.agent ?? 'user', s?.branch ?? p.branch ?? null, to, clip(redact(text), 2000), now());
  return get('SELECT * FROM messages WHERE id = ?', id);
}
export function unreadMessages(s) {
  return all(`SELECT * FROM messages m WHERE m.project_id = ? AND COALESCE(m.from_session, '') != ?
      AND (m.recipient = 'all' OR m.recipient = ? OR m.recipient = ?) AND m.created_at >= ?
      AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.session_id = ?) ORDER BY m.created_at`,
    s.project_id, s.id, `branch:${s.branch}`, `session:${s.id}`, new Date(Date.now() - 14 * 864e5).toISOString(), s.id);
}
export const markRead = (s, msgs) => msgs.forEach((m) => run('INSERT OR IGNORE INTO message_reads VALUES (?,?)', m.id, s.id));
export const listMessages = (projectId) => all(`SELECT m.*, (SELECT COUNT(*) FROM message_reads r WHERE r.message_id = m.id) AS reads
    FROM messages m WHERE m.project_id = ? ORDER BY m.created_at DESC LIMIT 200`, projectId);

// ---------- memories ----------
export function hydrate(m) {
  if (!m) return m;
  m.files = P(m.files, []);
  m.anchors = P(m.anchors, []);
  m.pinned = !!m.pinned;
  m.muted = !!m.muted;
  return m;
}
export const memory = (id) => hydrate(get('SELECT * FROM memories WHERE id = ?', id));

const anchorFiles = (m) => [...new Set([...(m.files || []), ...(m.anchors || []).map((a) => a.file).filter(Boolean)])];

// Policy: the compressor is the reviewer. Confident, non-conflicting items are accepted in every mode;
// only conflicts and low-confidence items wait for a human.
export function propose(input, { s, p, via = 'llm', model }) {
  const type = TYPES.includes(input.type) ? input.type : 'fact';
  if (s && via === 'llm') {
    const n = get(`SELECT COUNT(*) AS n FROM memories WHERE source_session = ? AND source = 'llm'`, s.id).n;
    if (n >= MAX_PROPOSALS_PER_SESSION) throw new Error(`proposal limit (${MAX_PROPOSALS_PER_SESSION}) reached for this session`);
  }
  const branchScoped = input.scope === 'branch' || (input.scope == null && p.branch && p.branch !== defaultBranch(p.root) && type !== 'preference');
  const scope = input.scope === 'user' || type === 'preference' ? 'user' : branchScoped ? 'branch' : 'project';
  const confidence = via === 'user' ? 1 : Number(input.confidence ?? 0.7);
  const auto = via === 'user' || confidence >= AUTO_ACCEPT_CONFIDENCE;
  const status = input.status || (auto ? 'active' : 'proposed');
  const anchors = (input.anchors || []).filter((a) => a && a.file).map((a) => ({ file: String(a.file).replace(/\\/g, '/'), symbol: a.symbol || null, line: a.line ?? null }));
  const files = [...new Set([...(input.files || []), ...anchors.map((a) => a.file)])];
  const id = uid('m');
  run(`INSERT INTO memories(id, project_id, scope, branch, type, title, body, why, status, importance, confidence, pinned,
       source, source_agent, source_session, source_commit, files, review_when, valid_from, created_at, updated_at,
       anchors, source_model, resolved_by, resolved_at, verified_commit, last_verified_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, scope === 'user' ? null : p.id, scope, scope === 'branch' ? p.branch : null, type,
    clip(redact(input.title), 200), redact(input.body), redact(input.why ?? null), status,
    input.importance ?? 0.5, confidence, input.pinned ? 1 : 0,
    via, s?.agent ?? null, s?.id ?? null, p.commit ?? null, J(files), input.review_when ?? null, now(), now(), now(),
    J(anchors), model ?? input.model ?? s?.model ?? null,
    status === 'active' ? (via === 'user' ? 'user' : 'auto-policy') : null, status === 'active' ? now() : null,
    p.commit ?? null, now());
  run('INSERT INTO memory_versions VALUES (?,?,?,?,?,?,?)', id, 1, input.title, input.body, via, 'created', now());
  return memory(id);
}

export function updateMemory(id, patch, { by = 'user', reason = 'edit' } = {}) {
  const m = memory(id);
  if (!m) throw new Error(`no memory ${id}`);
  const cols = ['title', 'body', 'why', 'type', 'scope', 'importance', 'confidence', 'pinned', 'muted', 'status', 'review_when', 'files', 'anchors'];
  const sets = [], vals = [];
  for (const c of cols) if (patch[c] !== undefined) {
    sets.push(`${c} = ?`);
    vals.push(['files', 'anchors'].includes(c) ? J(patch[c]) : patch[c]);
  }
  if (by.startsWith('user') && (patch.title !== undefined || patch.body !== undefined)) { sets.push('source = ?', 'confidence = ?'); vals.push('user', 1); }
  if (patch.status === 'superseded' || patch.status === 'archived') { sets.push('invalid_at = ?'); vals.push(now()); }
  sets.push('updated_at = ?'); vals.push(now());
  tx(() => {
    run(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
    if (patch.title !== undefined || patch.body !== undefined) {
      const v = get('SELECT MAX(version) AS v FROM memory_versions WHERE memory_id = ?', id).v || 0;
      run('INSERT INTO memory_versions VALUES (?,?,?,?,?,?,?)', id, v + 1, patch.title ?? m.title, patch.body ?? m.body, by, reason, now());
    }
  });
  return memory(id);
}

// "Still true": bump verification without a new version.
export function verifyMemory(id, p) {
  const m = memory(id);
  if (!m) throw new Error(`no memory ${id}`);
  const head = git(p.root, 'rev-parse', '--short', 'HEAD') || m.verified_commit;
  run(`UPDATE memories SET last_verified_at = ?, verified_commit = ?, status = CASE WHEN status = 'stale' THEN 'active' ELSE status END WHERE id = ?`, now(), head, id);
  return memory(id);
}

export const relate = (a, b, rel) => run('INSERT OR IGNORE INTO memory_relations VALUES (?,?,?)', a, b, rel);

export function invalidate(id, reason, supersededBy, by = 'llm') {
  if (supersededBy) relate(supersededBy, id, 'supersedes');
  return updateMemory(id, { status: 'superseded' }, { by, reason: reason || 'invalidated' });
}

function deleteMemoryRows(id) {
  run('DELETE FROM memories WHERE id = ?', id);
  run('DELETE FROM memory_versions WHERE memory_id = ?', id);
  run('DELETE FROM memory_relations WHERE a = ? OR b = ?', id, id);
}
export function deleteMemory(id) { const m = memory(id); deleteMemoryRows(id); return m; }

export function resolve(id, action, body, by = 'user-tool') {
  const m = memory(id);
  if (!m) throw new Error(`no memory ${id}`);
  const stamp = () => run('UPDATE memories SET resolved_by = ?, resolved_at = ? WHERE id = ?', by, now(), id);
  if (action === 'reject') { const r = updateMemory(id, { status: 'archived' }, { by, reason: 'rejected' }); stamp(); return memory(id); }
  if (action !== 'accept') throw new Error(`bad action: ${action}`);
  const patch = { status: 'active' };
  if (body) patch.body = body;
  updateMemory(id, patch, { by, reason: 'accepted' });
  stamp();
  for (const r of all(`SELECT b FROM memory_relations WHERE a = ? AND rel IN ('supersedes','contradicts')`, id))
    updateMemory(r.b, { status: 'superseded' }, { by, reason: `superseded by ${id}` });
  return memory(id);
}

export function expireProposals(projectId) {
  const cutoff = new Date(Date.now() - PROPOSAL_TTL_DAYS * 864e5).toISOString();
  run(`UPDATE memories SET status = 'archived', invalid_at = ?, resolved_by = 'ttl-expired', resolved_at = ? WHERE project_id = ? AND status = 'proposed' AND created_at < ?`, now(), now(), projectId, cutoff);
}

export function review(projectId) {
  expireProposals(projectId);
  const proposed = all(`SELECT * FROM memories WHERE (project_id = ? OR project_id IS NULL) AND status = 'proposed' ORDER BY created_at`, projectId).map(hydrate);
  const conflicts = all(`SELECT * FROM memories WHERE project_id = ? AND status = 'conflict'`, projectId).map((m) => {
    const r = get(`SELECT b FROM memory_relations WHERE a = ? AND rel = 'contradicts'`, m.id);
    return { memory: hydrate(m), other: r ? memory(r.b) : null };
  });
  return { proposed, conflicts };
}
export const recentlyAutoAccepted = (projectId) => all(`SELECT * FROM memories WHERE (project_id = ? OR project_id IS NULL)
    AND resolved_by IN ('auto-policy','compressor') AND resolved_at >= ? ORDER BY resolved_at DESC LIMIT 100`,
  projectId, new Date(Date.now() - 7 * 864e5).toISOString()).map(hydrate);

export function counts(projectId) {
  const c = { active: 0, proposed: 0, stale: 0, conflict: 0, superseded: 0, archived: 0, tasks: 0 };
  for (const r of all(`SELECT status, COUNT(*) AS n FROM memories WHERE project_id = ? OR project_id IS NULL GROUP BY status`, projectId)) c[r.status] = r.n;
  c.tasks = get(`SELECT COUNT(*) AS n FROM memories WHERE project_id = ? AND type = 'task' AND status = 'active'`, projectId).n;
  return c;
}

// ---------- freshness: anchors checked against the working tree + commits since verification ----------
export function freshness(p, mems) {
  const withCommit = mems.filter((m) => (m.verified_commit || m.source_commit) && anchorFiles(m).length);
  const commits = [];
  if (withCommit.length) {
    // one git call: commits (newest first) with their files, back far enough for every memory
    const out = git(p.root, 'log', '--max-count=300', '--name-only', '--format=@@%h');
    let cur;
    for (const line of out.split('\n')) {
      if (line.startsWith('@@')) { cur = { h: line.slice(2), files: new Set() }; commits.push(cur); }
      else if (line.trim() && cur) cur.files.add(line.trim());
    }
  }
  for (const m of mems) {
    const files = anchorFiles(m);
    let state = files.length ? 'verified' : 'unknown', since = 0;
    for (const a of m.anchors || []) {
      const f = path.join(p.root, a.file);
      if (!fs.existsSync(f)) { state = 'missing'; break; }
      if (a.symbol) { try { if (!fs.readFileSync(f, 'utf8').includes(a.symbol)) { state = 'missing'; break; } } catch {} }
    }
    const base = m.verified_commit || m.source_commit;
    if (state !== 'missing' && base && files.length) {
      const idx = commits.findIndex((c) => c.h.startsWith(base) || base.startsWith(c.h));
      if (idx === -1) { if (commits.length) state = state === 'verified' ? 'unknown' : state; }
      else {
        since = commits.slice(0, idx).filter((c) => files.some((f) => c.files.has(f))).length;
        if (since > 0) state = 'changed';
      }
    }
    m.freshness = { state, commits_since: since };
  }
  return mems;
}

// ---------- search (BM25 porter + trigram, fused by RRF) ----------
function ftsQuery(q, minLen) {
  const terms = String(q).toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  return terms.filter((t) => t.length >= minLen).map((t) => `"${t}"`).join(' OR ');
}
export function search(projectId, q, { type, status, limit = 20 } = {}) {
  const where = [`(m.project_id = ? OR m.project_id IS NULL)`];
  const params = [projectId];
  if (type) { where.push('m.type = ?'); params.push(type); }
  if (status) { where.push('m.status = ?'); params.push(status); } else where.push(`m.status NOT IN ('superseded','archived')`);
  const w = where.join(' AND ');
  if (!q || !String(q).trim()) {
    return all(`SELECT m.* FROM memories m WHERE ${w} ORDER BY m.pinned DESC, m.updated_at DESC LIMIT ?`, ...params, limit)
      .map((m) => ({ ...hydrate(m), score: 0 }));
  }
  if (!hasFts) {
    const like = `%${q}%`;
    return all(`SELECT m.* FROM memories m WHERE ${w} AND (m.title LIKE ? OR m.body LIKE ?) LIMIT ?`, ...params, like, like, limit)
      .map((m) => ({ ...hydrate(m), score: 1 }));
  }
  const scores = new Map();
  const add = (rows) => rows.forEach((r, i) => scores.set(r.id, (scores.get(r.id) || 0) + 1 / (60 + i)));
  const pq = ftsQuery(q, 1), tq = ftsQuery(q, 3);
  if (pq) add(all(`SELECT m.id FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
      WHERE memories_fts MATCH ? AND ${w} ORDER BY bm25(memories_fts, 5, 1, 2) LIMIT 50`, pq, ...params));
  if (tq) add(all(`SELECT m.id FROM memories_tri f JOIN memories m ON m.rowid = f.rowid
      WHERE memories_tri MATCH ? AND ${w} ORDER BY bm25(memories_tri) LIMIT 50`, tq, ...params));
  return [...scores].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id, score]) => ({ ...memory(id), score }));
}

// Importance halves every 23 days unless exempt/pinned; commits since verification lower it further.
export function decayed(m) {
  let v = m.importance;
  if (!m.pinned && !DECAY_EXEMPT.has(m.type)) v *= Math.pow(0.5, (Date.now() - Date.parse(m.updated_at)) / 864e5 / 23);
  const since = m.freshness?.commits_since || 0;
  return since ? v / (1 + since * 0.25) : v;
}

// ---------- git-driven maintenance (hourly) ----------
export function maintain(p) {
  const key = `maintained:${p.id}`;
  const last = get(`SELECT value FROM settings WHERE scope = 'system' AND key = ?`, key)?.value;
  if (last && Date.now() - Date.parse(last) < 3600e3) return;
  run(`INSERT OR REPLACE INTO settings VALUES ('system', ?, ?)`, key, now());
  expireProposals(p.id);
  const def = defaultBranch(p.root);
  const branches = all(`SELECT DISTINCT branch FROM memories WHERE project_id = ? AND scope = 'branch' AND branch IS NOT NULL`, p.id);
  if (def && branches.length) {
    const merged = new Set(git(p.root, 'branch', '--merged', def, '--format=%(refname:short)').split('\n'));
    const existing = new Set(git(p.root, 'branch', '--format=%(refname:short)').split('\n'));
    for (const { branch } of branches) {
      if (branch === def) continue;
      if (merged.has(branch)) run(`UPDATE memories SET scope = 'project', branch = NULL, updated_at = ? WHERE project_id = ? AND scope = 'branch' AND branch = ?`, now(), p.id, branch);
      else if (!existing.has(branch)) run(`UPDATE memories SET status = 'archived', invalid_at = ? WHERE project_id = ? AND scope = 'branch' AND branch = ?`, now(), p.id, branch);
    }
  }
  const mems = all(`SELECT * FROM memories WHERE project_id = ? AND status = 'active'`, p.id).map(hydrate);
  for (const m of freshness(p, mems))
    if (m.freshness.state === 'changed' || m.freshness.state === 'missing') run(`UPDATE memories SET status = 'stale', updated_at = ? WHERE id = ?`, now(), m.id);
}

// ---------- export .context/PROJECT.md (one-way, atomic) ----------
const SECTION = { architecture: 'Architecture', decision: 'Decisions', constraint: 'Constraints', requirement: 'Requirements',
  lesson: 'Lessons', warning: 'Warnings', fact: 'Facts', task: 'Open tasks', idea: 'Ideas (not facts)' };
export const fmtAnchors = (m) => (m.anchors || []).map((a) => `${a.symbol ? `${a.symbol}@` : ''}${a.file}${a.line ? `:${a.line}` : ''}`).join(', ');
export function exportProjectMd(p) {
  if (isScratch(p.root) || !fs.existsSync(p.root)) return null;
  const rows = all(`SELECT * FROM memories WHERE project_id = ? AND scope = 'project' AND status = 'active' AND muted = 0 ORDER BY type, importance DESC`, p.id).map(hydrate);
  let out = `<!-- Generated by Universal Agent Context (UAC). Edit via \`uac view\` or \`uac edit\`, not here. -->\n# ${p.name}: project knowledge\n`;
  for (const [type, title] of Object.entries(SECTION)) {
    const ms = rows.filter((m) => m.type === type);
    if (!ms.length) continue;
    out += `\n## ${title}\n`;
    for (const m of ms) {
      const anc = fmtAnchors(m);
      out += type === 'decision'
        ? `\n### ${m.title} \`${m.id}\`\n- **Decision:** ${m.body}\n${m.why ? `- **Why:** ${m.why}\n` : ''}${anc ? `- **Code:** \`${anc}\`\n` : ''}- **Status:** accepted${m.source_commit ? ` (at ${m.source_commit})` : ''}\n`
        : `- **${m.title}**: ${m.body.replace(/\n+/g, ' ')}${m.why ? ` _(why: ${m.why})_` : ''}${anc ? ` · \`${anc}\`` : ''} \`${m.id}\`\n`;
    }
  }
  const dir = path.join(p.root, '.context');
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.PROJECT.md.${process.pid}`);
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, path.join(dir, 'PROJECT.md'));
  return path.join(dir, 'PROJECT.md');
}

export { open };
