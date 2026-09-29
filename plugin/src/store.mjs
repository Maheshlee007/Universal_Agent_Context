// Domain operations over the SQLite store (v0.3: session-centric, remote-keyed projects, anchored memories).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { all, get, run, tx, uid, now, J, P, hasFts, open } from './db.mjs';
import { gitInfo, git, gitRaw, defaultBranch, redact, clip, ignored } from './util.mjs';

export const TYPES = ['fact', 'decision', 'constraint', 'lesson', 'requirement', 'preference', 'warning', 'idea', 'task', 'architecture'];
export const MODES = ['off', 'manual', 'automatic'];
export const AUTO_ACCEPT_CONFIDENCE = 0.7;
const MAX_PROPOSALS_PER_SESSION = 20;
const PROPOSAL_TTL_DAYS = 7;
const DECAY_EXEMPT = new Set(['decision', 'lesson', 'constraint', 'requirement']);

// ---------- projects ----------
// Claude scratchpads / temp dirs are never registered as projects (UAC_ALLOW_SCRATCH=1 for test harnesses).
export const isScratch = (dir) => !process.env.UAC_ALLOW_SCRATCH && /[\\/](Temp|tmp)[\\/]claude[\\/-]/i.test(dir || '');

export function normRemote(url) {
  if (!url) return null;
  return url.trim().replace(/\.git$/, '').replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '').replace(':', '/').toLowerCase();
}

// Identity = git remote when there is one (same repo cloned twice = one project), else the git root, else the folder.
// A non-git subfolder of a registered folder belongs to it. create:false (read-only CLI) never registers a project:
// it returns a transient { id: null } so nothing is written for a folder no agent session ever ran in.
export function projectFor(cwd, { create = true } = {}) {
  const g = gitInfo(cwd || process.cwd());
  const remote = normRemote(g.remote);
  let row = remote && all('SELECT * FROM projects WHERE git_remote IS NOT NULL').find((r) => normRemote(r.git_remote) === remote);
  if (!row) row = get('SELECT * FROM projects WHERE lower(root) = lower(?)', g.root);
  if (!row && !g.git) {
    const norm = (d) => path.resolve(d).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const here = norm(g.root);
    const rows = all('SELECT * FROM projects').filter((r) => r.root);
    // never the home folder, a drive root, or a container of other projects (an agent once run in D:\Projects must not
    // swallow every non-git folder below it)
    const tooBroad = (r) => norm(r) === norm(os.homedir()) || /^[a-z]:$|^$/.test(norm(r))
      || rows.filter((o) => norm(o.root).startsWith(norm(r) + '/')).length >= 2;
    row = rows.filter((r) => here.startsWith(norm(r.root) + '/') && !tooBroad(r.root)).sort((a, b) => b.root.length - a.root.length)[0];
    if (row) return { ...row, branch: null, commit: null };
  }
  if (!row && !create) return { id: null, root: g.root, name: path.basename(g.root), mode: null, branch: g.branch, commit: g.commit, transient: true };
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
    run('UPDATE sessions SET seq = NULL WHERE project_id = ?', from); // renumbered after the target's own sessions
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
    // resumed after it ended (e.g. `claude --resume` days later): it is live again
    if (existing.status === 'ended') run(`UPDATE sessions SET status = CASE WHEN capture = 'paused' THEN 'paused' ELSE 'active' END, ended_at = NULL WHERE id = ?`, session_id);
    return { s: session(session_id), created: false };
  }
  const p = projectFor(cwd);
  // root = the checkout this session runs in (a worktree may differ from the project's registered root)
  run(`INSERT INTO sessions(id, project_id, agent, model, branch, start_commit, capture, transcript_path, started_at, root)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    session_id, p.id, host, model ?? null, p.branch, p.commit,
    p.mode === 'automatic' ? 'on' : p.mode ? 'off' : 'ask', transcript_path ?? null, now(), gitInfo(cwd || process.cwd()).root);
  return { s: session(session_id), created: true };
}

// The project as seen by an existing session. `fresh` (session start/resume/compact): re-read branch/commit from the
// session's own checkout. Otherwise (every prompt/tool/stop): no git calls at all, the row + the session's branch.
export function sessionProject(s, { fresh = false } = {}) {
  const row = project(s.project_id);
  if (fresh) {
    const pr = projectFor(s.root || row.root, { create: false });
    if (pr.id === s.project_id) return pr;
  }
  return { ...row, branch: s.branch, commit: s.start_commit };
}

// Default session for MCP calls without session_id: the most recently ACTIVE one (a phantom from a window reload is newer
// but idle, and must not receive another session's writes).
export function currentSession(projectId) {
  return get(`SELECT * FROM sessions WHERE project_id = ? AND status != 'ended' ORDER BY COALESCE(last_active_at, '') DESC, started_at DESC LIMIT 1`, projectId)
    || get(`SELECT * FROM sessions WHERE project_id = ? ORDER BY COALESCE(last_active_at, started_at) DESC LIMIT 1`, projectId);
}

export function setCapture(sid, state) {
  if (!['on', 'paused', 'off', 'ask'].includes(state)) throw new Error(`bad capture state: ${state}`);
  run(`UPDATE sessions SET capture = ?, status = CASE WHEN status = 'ended' THEN status WHEN ? = 'paused' THEN 'paused' ELSE 'active' END WHERE id = ?`, state, state, sid);
  // prompts typed while capture was 'ask' are held as 'pending': kept on opt-in, deleted on opt-out
  if (state === 'on') {
    run(`UPDATE events SET kind = 'prompt' WHERE session_id = ? AND kind = 'pending'`, sid);
    run(`UPDATE sessions SET title = COALESCE(title, (SELECT substr(body, 1, 60) FROM events WHERE session_id = ? AND kind = 'prompt' ORDER BY id LIMIT 1)) WHERE id = ?`, sid, sid);
  }
  if (state === 'off') run(`DELETE FROM events WHERE session_id = ? AND kind = 'pending'`, sid);
}

export function addEvent(s, kind, { tool, target, body, agent_id } = {}) {
  const root = project(s.project_id)?.root;
  if (ignored(root, target)) { target = '[ignored]'; body = null; }
  run('INSERT INTO events(session_id, ts, kind, tool, target, body, agent_id) VALUES (?,?,?,?,?,?,?)',
    s.id, now(), kind, tool ?? null, clip(redact(target), 300), clip(redact(body), 2000), agent_id ?? null);
}

// Other sessions of this project with ≥3 unsaved events (live in another window, ended, or abandoned without SessionEnd).
export function unsavedSessions(projectId, exceptId) {
  return all(`SELECT s.id AS session_id, s.agent, s.started_at, s.status, s.quality, COUNT(e.id) AS events, MAX(e.ts) AS last_ts FROM sessions s
    JOIN events e ON e.session_id = s.id AND e.id > s.saved_event_id AND e.kind != 'pending'
    WHERE s.project_id = ? AND s.id != ? AND s.rolled_into IS NULL GROUP BY s.id HAVING events >= 3 ORDER BY last_ts DESC LIMIT 5`,
    projectId, exceptId ?? '');
}
export const IDLE_MS = 30 * 60e3; // no event for this long = treated like an ended session (SessionEnd never came)
export const unsavedCount = (s) => get(`SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND id > ? AND kind != 'pending'`, s.id, s.saved_event_id).n;

// Card = latest summary + latest non-superseded checkpoint of a session. A precompact snapshot (deterministic, no LLM)
// never outranks a saved/auto/manual checkpoint; it is the card only when nothing else exists.
// Snapshots (precompact / pause / tail after the last save) are deterministic, no LLM: shown as the card's "tail", never as the card.
const SNAPS = `('precompact', 'pause', 'tail')`;
export function card(sessionId) {
  const sm = get('SELECT * FROM summaries WHERE session_id = ? ORDER BY created_at DESC LIMIT 1', sessionId);
  const snap = get(`SELECT * FROM checkpoints WHERE session_id = ? AND trigger IN ${SNAPS} AND (COALESCE(goal, '') != '' OR files != '[]') ORDER BY ts DESC LIMIT 1`, sessionId);
  const main = get(`SELECT * FROM checkpoints WHERE session_id = ? AND superseded_by IS NULL AND trigger NOT IN ${SNAPS} ORDER BY ts DESC LIMIT 1`, sessionId)
    || get(`SELECT * FROM checkpoints WHERE session_id = ? AND trigger NOT IN ${SNAPS} ORDER BY ts DESC LIMIT 1`, sessionId);
  const cp = main || snap;
  if (!sm && !cp) return null;
  const cardAt = sm?.created_at ?? main?.ts;
  const tail = main && snap && snap.ts > cardAt ? { at: snap.ts, trigger: snap.trigger, goal: snap.goal, note: snap.note, files: P(snap.files, []), broken: snap.broken } : null;
  return {
    summary_id: sm?.id ?? null, checkpoint_id: cp?.id ?? null, title: sm?.title ?? cp?.goal ?? null, body: sm?.body ?? '',
    quality: sm?.quality ?? 'llm', model: sm?.model ?? null, goal: cp?.goal ?? null, working: cp?.working ?? null, broken: cp?.broken ?? null,
    next_steps: P(cp?.next_steps, []), files: P(cp?.files, []), note: cp?.note ?? null, at: sm?.created_at ?? cp?.ts,
    events_n: sm?.events_n ?? null, gaps: cp?.gaps ?? null, tail,
  };
}

// Phantom = a session nobody typed in: hosts start one on every window reload / panel open, and `/resume` switches
// away from it. No prompts/tool activity, events, card, memories or title. Hidden from lists and numbering at once;
// deleted at SessionEnd, else purged once ended or a day old (an idle open window keeps its row: no second start context).
const PHANTOM = `(COALESCE(s.prompts, 0) = 0 AND s.last_active_at IS NULL AND s.title IS NULL
  AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM summaries x WHERE x.session_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM checkpoints c WHERE c.session_id = s.id AND c.trigger NOT IN ${SNAPS})
  AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.source_session = s.id))`;
export const isPhantom = (id) => !!get(`SELECT 1 AS x FROM sessions s WHERE s.id = ? AND ${PHANTOM}`, id);
export function purgePhantoms(projectId, exceptId) {
  const cutoff = new Date(Date.now() - 864e5).toISOString();
  const ids = all(`SELECT s.id FROM sessions s WHERE s.project_id = ? AND s.id != ? AND (s.status = 'ended' OR s.started_at < ?) AND ${PHANTOM}`,
    projectId, exceptId ?? '', cutoff).map((r) => r.id);
  if (ids.length) tx(() => ids.forEach(deleteSessionRows));
  return ids.length;
}

// Stable numbers: a session gets #n (sessions.seq, per project, 1, 2, 3…) once it stops being a phantom, and keeps it
// forever. Assigned lazily in start order, so the numbering is the same in the header, tools, CLI, dashboard, extension.
// Hooks, MCP, CLI and the dashboard all call this: one write transaction + a unique index make it race-free.
function assignSeq(projectId) {
  if (!projectId || !get(`SELECT 1 AS x FROM sessions s WHERE s.project_id = ? AND s.seq IS NULL AND NOT ${PHANTOM} LIMIT 1`, projectId)) return;
  tx(() => {
    const todo = all(`SELECT s.id FROM sessions s WHERE s.project_id = ? AND s.seq IS NULL AND NOT ${PHANTOM} ORDER BY s.started_at, s.rowid`, projectId);
    let n = get('SELECT COALESCE(MAX(seq), 0) AS m FROM sessions WHERE project_id = ?', projectId).m;
    for (const { id } of todo) run('UPDATE sessions SET seq = ? WHERE id = ? AND seq IS NULL', ++n, id);
  });
}
const hasRaw = (p) => { try { return !!p && fs.existsSync(p); } catch { return false; } };

// Newest-first list; #n = the stable seq. Rolled-up and phantom sessions are hidden unless `all`.
export function listSessions(projectId, { limit = 50, active, all: withRolled } = {}) {
  if (!projectId) return [];
  assignSeq(projectId);
  const next = new Set(nextSessions(projectId));
  return all(`SELECT s.*, (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.kind != 'pending') AS events,
      (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.id > s.saved_event_id AND e.kind != 'pending') AS unsaved,
      (SELECT MAX(ts) FROM events e WHERE e.session_id = s.id) AS last_event,
      (SELECT COUNT(*) FROM memories m WHERE m.source_session = s.id) AS memories_created
    FROM sessions s WHERE s.project_id = ? ${active ? "AND s.status != 'ended'" : ''} ${withRolled ? '' : `AND s.rolled_into IS NULL AND NOT ${PHANTOM}`}
    ORDER BY s.started_at DESC, s.rowid DESC LIMIT ?`, projectId, limit)
    .map((s) => {
      const c = card(s.id);
      const phantom = withRolled && isPhantom(s.id);
      const last = [s.last_active_at, s.last_event, s.started_at].filter(Boolean).sort().at(-1);
      return { id: s.id, short: shortId(s.id), n: phantom ? null : s.seq ?? null, phantom, agent: s.agent, model: s.model, branch: s.branch, capture: s.capture, status: s.status,
        live: s.status !== 'ended' && Date.now() - Date.parse(last) < IDLE_MS, last_active: last,
        started_at: s.started_at, ended_at: s.ended_at, title: s.title || c?.title || null, events: s.events, unsaved: s.unsaved,
        memories_created: s.memories_created, card: c, next: next.has(s.id), rolled_into: s.rolled_into ?? null,
        raw: hasRaw(s.transcript_path) || s.events > 0, empty: !s.events && !c && !s.memories_created };
    });
}
// One resolver for every surface (hook controls, MCP, CLI, dashboard): full id, short id (≥6 chars, printed next to every
// #n), or #n / n (the stable seq). Only sessions of this project resolve.
export function resolveSessionRef(projectId, ref) {
  // "#3 1a2b3c4d" (the printed form, copied verbatim) → "#3"
  const r = String(ref ?? '').trim().split(/\s+/)[0].replace(/^#/, '');
  if (!r || !projectId) return null;
  if (get('SELECT id FROM sessions WHERE id = ? AND project_id = ?', r, projectId)) return r;
  if (/^\d{1,5}$/.test(r)) { assignSeq(projectId); return get('SELECT id FROM sessions WHERE project_id = ? AND seq = ?', projectId, Number(r))?.id ?? null; }
  if (r.length >= 6) {
    const m = all(`SELECT id FROM sessions WHERE project_id = ? AND id LIKE ? ESCAPE '\\' LIMIT 2`, projectId, r.replace(/[%_\\]/g, '\\$&') + '%');
    if (m.length === 1) return m[0].id;
  }
  return null;
}
export const resolveSessionRefs = (projectId, refs) => refs.map((r) => resolveSessionRef(projectId, r)).filter(Boolean);
// 8 chars of a UUID; ids like "rollup-a1b2c3" stay whole (8 chars of them would match every rollup)
export const shortId = (id) => (/^[a-z]+-[0-9a-f]{6}$/.test(String(id)) ? String(id) : String(id || '').slice(0, 8));
export const ref = (x) => `#${x.seq ?? x.n ?? '?'} ${shortId(x.id)}`; // how a session is named everywhere
// "unknown session" errors say why and list what would work, so the retry is one call
export function sessionRefError(projectId, r) {
  const list = listSessions(projectId, { limit: 8 });
  return `no session "${r}" in this project. Use its #n, short id or full id: ${list.map((x) => `${ref(x)} "${clip(x.title || x.card?.title || x.agent, 40)}"`).join(' · ') || '(no sessions yet)'}`;
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

export function renameSession(id, title) {
  if (!session(id)) throw new Error(`no session ${id}`);
  if (!title?.trim()) throw new Error('empty title');
  run('UPDATE sessions SET title = ? WHERE id = ?', clip(title.trim(), 120), id);
  return session(id);
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

// ---------- cross-agent messages ----------
export function postMessage(s, p, text, to = 'all') {
  if (!text?.trim()) throw new Error('empty message');
  if (!/^(all|branch:.+|session:.+)$/.test(to)) throw new Error("to must be 'all', 'branch:<name>' or 'session:<id>'");
  if (to.startsWith('session:')) { // #n / short id → the full id the recipient is matched on
    const sid = resolveSessionRef(p.id, to.slice(8));
    if (!sid) throw new Error(sessionRefError(p.id, to.slice(8)));
    to = `session:${sid}`;
  }
  const id = uid('msg');
  run('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)', id, p.id, s?.id ?? null, s?.agent ?? 'user', s?.branch ?? p.branch ?? null, to, clip(redact(text), 2000), now());
  return get('SELECT * FROM messages WHERE id = ?', id);
}
// Who gets a message once: the sessions that were open when it was posted (parallel windows), and, if nobody has read it
// yet, the next session that starts. Later sessions don't see it again (a note to "main" is not a banner forever).
// A message to one session always reaches that session.
export function unreadMessages(s) {
  return all(`SELECT * FROM messages m WHERE m.project_id = ? AND COALESCE(m.from_session, '') != ?
      AND (m.recipient = 'all' OR m.recipient = ? OR m.recipient = ?) AND m.created_at >= ?
      AND (m.recipient = ? OR ? <= m.created_at OR NOT EXISTS (SELECT 1 FROM message_reads r2 WHERE r2.message_id = m.id))
      AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.session_id = ?) ORDER BY m.created_at`,
    s.project_id, s.id, `branch:${s.branch}`, `session:${s.id}`, new Date(Date.now() - 14 * 864e5).toISOString(),
    `session:${s.id}`, s.started_at, s.id);
}
export function deleteMessage(id) {
  run('DELETE FROM message_reads WHERE message_id = ?', id);
  return run('DELETE FROM messages WHERE id = ?', id).changes > 0;
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
  m.hashes = P(m.hashes, null);
  return m;
}
export const memory = (id) => hydrate(get('SELECT * FROM memories WHERE id = ?', id));
// Tools act only on this project's memories (user-scope rows, project_id NULL, are shared on purpose).
export function ownMemory(id, projectId) {
  const m = memory(id);
  if (!m || (m.project_id != null && m.project_id !== projectId)) throw new Error(`no memory ${id} in this project (uac_search lists this project's ids)`);
  return m;
}
// Word-set overlap of title + body: the one similarity used for write-time dedup and the save-time duplicates list.
export const words = (m) => new Set(`${m.title || ''} ${m.body || ''}`.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) || []);
export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}
// An active memory of the same type that already says (almost) the same thing: update it instead of adding another.
// Strict on purpose: a false positive makes the LLM overwrite a DIFFERENT memory. Tasks and ideas are templated ("Add tests
// for login" vs "…for signup") and never deduplicated; titles must overlap too, not just the bodies.
export function nearDuplicate(projectId, { type, title, body, scope }, min = 0.8) {
  const t = TYPES.includes(type) ? type : 'fact';
  if (t === 'task' || t === 'idea') return null;
  const w = words({ title, body }), wt = words({ title });
  let best = null, score = 0;
  for (const m of all(`SELECT id, type, title, body, scope FROM memories WHERE (project_id = ? OR project_id IS NULL) AND status IN ('active','stale','proposed') AND type = ? ORDER BY updated_at DESC LIMIT 300`, projectId, t)) {
    if (scope && m.scope !== scope) continue;
    const j = jaccard(w, words(m));
    if (j > score && jaccard(wt, words({ title: m.title })) >= 0.6) { score = j; best = m; }
  }
  return score >= min ? { ...best, overlap: Math.round(score * 100) / 100 } : null;
}

const anchorFiles = (m) => [...new Set([...(m.files || []), ...(m.anchors || []).map((a) => a.file).filter(Boolean)])];

// Content hash per anchored file at write/verify time. Freshness compares content, not commit counts,
// so committing the very change a memory describes doesn't flag it (CRLF-normalised for autocrlf checkouts).
const hashFile = (root, f) => {
  try { return crypto.createHash('sha1').update(fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n')).digest('hex').slice(0, 12); }
  catch { return null; }
};
function setHashes(id, root) {
  const m = memory(id);
  if (!m || !root) return;
  run('UPDATE memories SET hashes = ? WHERE id = ?', J(Object.fromEntries(anchorFiles(m).map((f) => [f, hashFile(root, f)]))), id);
}
const rootOf = (m) => project(m.project_id)?.root;

// Policy: the compressor is the reviewer. Confident, non-conflicting items are accepted in every mode;
// only conflicts and low-confidence items wait for a human.
export function propose(input, { s, p, via = 'llm', model }) {
  if (input.type && !TYPES.includes(input.type)) throw new Error(`unknown type "${input.type}"; use one of ${TYPES.join(', ')}`);
  const type = input.type || 'fact';
  if (s && via === 'llm') {
    const n = get(`SELECT COUNT(*) AS n FROM memories WHERE source_session = ? AND source = 'llm'`, s.id).n;
    if (n >= MAX_PROPOSALS_PER_SESSION) throw new Error(`proposal limit (${MAX_PROPOSALS_PER_SESSION}) reached for this session`);
  }
  // an explicit scope wins ("in this repo use tabs" is a project preference); defaults: preference → user (all your
  // projects), work on a feature branch → branch, else project
  const feature = p.branch && p.branch !== defaultBranch(p.root);
  let scope = ['user', 'project', 'branch'].includes(input.scope) ? input.scope
    : type === 'preference' ? 'user' : feature ? 'branch' : 'project';
  if (scope === 'branch' && !feature) scope = 'project'; // "branch" knowledge needs a real feature branch to belong to
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
  setHashes(id, p.root);
  return memory(id);
}

export function updateMemory(id, patch, { by = 'user', reason = 'edit' } = {}) {
  const m = memory(id);
  if (!m) throw new Error(`no memory ${id}`);
  const cols = ['title', 'body', 'why', 'type', 'scope', 'importance', 'confidence', 'pinned', 'muted', 'status', 'review_when', 'files', 'anchors'];
  const sets = [], vals = [];
  // 'done' (a finished task) is stored as archived + resolved_by 'done:<who>': every 'not superseded/archived' filter already hides it
  if (patch.status === 'done') { patch = { ...patch, status: 'archived' }; sets.push('resolved_by = ?', 'resolved_at = ?'); vals.push(`done:${by}`, now()); }
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
  if (patch.body !== undefined || patch.files !== undefined || patch.anchors !== undefined) setHashes(id, rootOf(m)); // re-asserted against current code
  return memory(id);
}

// "Still true": bump verification without a new version. Refused while an anchored file is missing: a same-named file
// elsewhere is a different file, and "verified" would hide that the memory points at nothing.
export function verifyMemory(id, p) {
  const m = memory(id);
  if (!m) throw new Error(`no memory ${id}`);
  const gone = (m.anchors || []).filter((a) => a.file && !fs.existsSync(path.join(p.root, a.file)));
  if (gone.length) throw new Error(`${id} NOT verified: ${anchorHints(p.root, gone, { existing: true }).join('; ')}. Fix the anchor if you know where the code moved (uac_update {id, anchors}), else retire it (uac_update {id, status:"superseded", reason}).`);
  const head = git(p.root, 'rev-parse', '--short', 'HEAD') || m.verified_commit;
  run(`UPDATE memories SET last_verified_at = ?, verified_commit = ?, status = CASE WHEN status = 'stale' THEN 'active' ELSE status END WHERE id = ?`, now(), head, id);
  setHashes(id, p.root);
  return memory(id);
}

// Repo files: git ls-files, else a bounded walk (non-git projects), skipping dependency/build/hidden folders.
// ponytail: 5000-file cap for the walk; only run when an anchor is actually missing
function projectFiles(root) {
  const tracked = git(root, 'ls-files', '--cached', '--others', '--exclude-standard').split(/\r?\n/).filter(Boolean);
  if (tracked.length) return tracked.filter((f) => fs.existsSync(path.join(root, f)));
  const out = [], stack = [''];
  while (stack.length && out.length < 5000) {
    const d = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(path.join(root, d), { withFileTypes: true }); } catch {}
    for (const e of ents) {
      if (e.name.startsWith('.') || /^(node_modules|dist|build|out|coverage|target|vendor)$/.test(e.name)) continue;
      const r = d ? `${d}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(r); else out.push(r);
    }
  }
  return out;
}

// Why an anchor won't resolve. Two situations need opposite advice:
// - writing (propose/update): the author typed a wrong path → "did you mean" the file under the project root;
// - an existing memory whose file is gone: same-named files elsewhere are DIFFERENT files (other copies/scaffolds) and
//   must not be used to verify or reopen it.
export function anchorHints(root, anchors = [], { existing = false } = {}) {
  if (!root) return [];
  const out = [];
  let files;
  for (const a of anchors || []) {
    if (!a?.file) continue;
    const f = String(a.file).replace(/\\/g, '/').replace(/^\.\//, '');
    const abs = path.join(root, f);
    if (fs.existsSync(abs)) {
      try { if (a.symbol && !fs.readFileSync(abs, 'utf8').includes(a.symbol)) out.push(`symbol \`${a.symbol}\` is no longer in ${f}${existing ? ' (renamed or removed: check the file, then update or retire the memory)' : ' (quote it exactly as written in the code)'}`); } catch {}
      continue;
    }
    files ??= projectFiles(root);
    const base = f.split('/').pop();
    let cand = files.filter((x) => x !== f && x.endsWith('/' + f));
    if (!cand.length) cand = files.filter((x) => x !== f && x.split('/').pop() === base);
    const list = cand.slice(0, 3).join(', ') + (cand.length > 3 ? ` (+${cand.length - 3})` : '');
    if (existing) out.push(`anchored file ${f} no longer exists${cand.length ? `; ${cand.length} same-named file(s) elsewhere (${list}) are DIFFERENT files: do not verify or reopen this memory from them` : ''}`);
    else if (cand.length === 1) out.push(`anchor ${f} not found (paths are relative to the project root ${root.replace(/\\/g, '/')}); did you mean ${cand[0]}?`);
    else out.push(`anchor ${f} not found (paths are relative to the project root ${root.replace(/\\/g, '/')})${cand.length ? `; ambiguous: ${cand.length} files named ${base} (${list}), give the full path` : ''}`);
  }
  return out;
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
    let state = files.length ? 'verified' : 'unknown', since = 0, reason = null, changed = [];
    for (const a of m.anchors || []) {
      const f = path.join(p.root, a.file);
      if (!fs.existsSync(f)) { state = 'missing'; reason = 'file'; break; }
      if (a.symbol) { try { if (!fs.readFileSync(f, 'utf8').includes(a.symbol)) { state = 'missing'; reason = 'symbol'; break; } } catch {} }
    }
    const base = m.verified_commit || m.source_commit;
    const idx = base ? commits.findIndex((c) => c.h.startsWith(base) || base.startsWith(c.h)) : -1;
    if (idx > 0) since = commits.slice(0, idx).filter((c) => files.some((f) => c.files.has(f))).length;
    if (state !== 'missing' && files.length) {
      if (m.hashes && Object.keys(m.hashes).length) {
        // content comparison: authoritative, also catches uncommitted edits
        changed = files.filter((f) => m.hashes[f] !== undefined && hashFile(p.root, f) !== m.hashes[f]);
        if (changed.length) state = 'changed'; else since = 0;
      } else {
        // legacy memory (no hashes): baseline = the file as first committed after the memory was written
        // (memories are written at session end, before the work is committed), else today's file. Persisted once.
        // ponytail: heuristic for pre-v0.3.1 rows only; new rows hash at write/verify time.
        const hashes = {};
        for (const f of files) {
          const c = git(p.root, 'log', '--reverse', '--format=%H', `--after=${m.updated_at || m.created_at}`, '--', f).split(/\r?\n/)[0];
          const content = c ? gitRaw(p.root, 'show', `${c}:${f}`) : null;
          hashes[f] = content != null ? crypto.createHash('sha1').update(content.replace(/\r\n/g, '\n')).digest('hex').slice(0, 12) : hashFile(p.root, f);
        }
        run('UPDATE memories SET hashes = ? WHERE id = ?', J(hashes), m.id);
        m.hashes = hashes;
        changed = files.filter((f) => hashes[f] !== hashFile(p.root, f));
        if (changed.length) state = 'changed'; else since = 0;
      }
    }
    m.freshness = { state, commits_since: since, reason, changed };
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
// Branch knowledge becomes project knowledge when its branch is merged, also when the branch was deleted after the merge
// (its memories' commits are in the default branch). Branch versions of project memories then replace the originals.
// Runs at every start (cheap when there is no branch knowledge): a merge must show up in the very next session.
export function promoteBranches(p) {
  const branches = all(`SELECT DISTINCT branch FROM memories WHERE project_id = ? AND scope = 'branch' AND branch IS NOT NULL AND status IN ('active','stale','proposed')`, p.id);
  if (!branches.length) return;
  // skip when the branch list (names + tips) is unchanged since the last check: nothing can have been merged meanwhile
  const list = git(p.root, 'branch', '--format=%(refname:short) %(objectname:short)');
  const key = `branches:${p.id}`;
  if (get(`SELECT value FROM settings WHERE scope = 'system' AND key = ?`, key)?.value === list) return;
  run(`INSERT OR REPLACE INTO settings VALUES ('system', ?, ?)`, key, list);
  const def = defaultBranch(p.root);
  if (!def) return;
  const tips = new Map(list.split(/\r?\n/).filter(Boolean).map((l) => l.split(' ')));
  const isAncestor = (c) => gitRaw(p.root, 'merge-base', '--is-ancestor', c, def) !== null;
  for (const { branch } of branches) {
    if (branch === def) continue;
    // merged = the branch's tip moved past where its sessions started (it had work of its own) and is now in the default
    // branch. A branch with no commits of its own is "merged" by git's definition, but nothing of it landed.
    // A deleted branch: its tip is the last HEAD a session on it saw (sessions.end_commit).
    const ss = all(`SELECT start_commit, end_commit FROM sessions WHERE project_id = ? AND branch = ? ORDER BY started_at`, p.id, branch);
    const starts = new Set(ss.map((x) => x.start_commit).filter(Boolean));
    const tip = tips.get(branch) || ss.map((x) => x.end_commit).filter(Boolean).at(-1);
    // ponytail: a squash-merged branch never proves merged (its commits aren't in main); its knowledge stays branch-scoped
    if (!tip || [...starts].some((c) => c.startsWith(tip) || tip.startsWith(c)) || !isAncestor(tip)) continue;
    for (const r of all(`SELECT r.a, r.b FROM memory_relations r JOIN memories m ON m.id = r.a WHERE m.project_id = ? AND m.scope = 'branch' AND m.branch = ? AND r.rel = 'supersedes'`, p.id, branch)) {
      const old = memory(r.b);
      if (old && old.scope === 'project' && ['active', 'stale'].includes(old.status)) updateMemory(r.b, { status: 'superseded' }, { by: 'merge', reason: `replaced by ${r.a} when ${branch} was merged` });
    }
    run(`UPDATE memories SET scope = 'project', branch = NULL, updated_at = ? WHERE project_id = ? AND scope = 'branch' AND branch = ?`, now(), p.id, branch);
  }
}

export function maintain(p) {
  promoteBranches(p);
  const key = `maintained:${p.id}`;
  const last = get(`SELECT value FROM settings WHERE scope = 'system' AND key = ?`, key)?.value;
  if (last && Date.now() - Date.parse(last) < 3600e3) return;
  run(`INSERT OR REPLACE INTO settings VALUES ('system', ?, ?)`, key, now());
  expireProposals(p.id);
  // windows closed without SessionEnd (killed, crashed): end them after 12 h idle; resuming reactivates them
  run(`UPDATE sessions SET status = 'ended', ended_at = COALESCE(last_active_at, started_at) WHERE project_id = ? AND status != 'ended'
      AND COALESCE(last_active_at, started_at) < ? AND COALESCE((SELECT MAX(ts) FROM events e WHERE e.session_id = sessions.id), '') < ?`,
    p.id, new Date(Date.now() - 12 * 3600e3).toISOString(), new Date(Date.now() - 12 * 3600e3).toISOString());
  const mems = all(`SELECT * FROM memories WHERE project_id = ? AND status IN ('active','stale')`, p.id).map(hydrate);
  for (const m of freshness(p, mems)) {
    const bad = m.freshness.state === 'changed' || m.freshness.state === 'missing';
    if (bad && m.status === 'active') run(`UPDATE memories SET status = 'stale', updated_at = ? WHERE id = ?`, now(), m.id);
    if (!bad && m.status === 'stale') run(`UPDATE memories SET status = 'active' WHERE id = ?`, m.id); // code matches again
  }
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
  // the last session cards travel with the repo too (a clone elsewhere, or a lost ~/.uac, still has them)
  const recent = all(`SELECT s.id, s.seq, s.branch, x.title, x.body, x.created_at FROM summaries x JOIN sessions s ON s.id = x.session_id
      WHERE x.project_id = ? AND x.quality = 'llm' AND s.rolled_into IS NULL ORDER BY x.created_at DESC LIMIT 3`, p.id);
  if (recent.length) {
    out += `\n## Recent sessions\n`;
    for (const r of recent) {
      const c = card(r.id);
      out += `\n### #${r.seq ?? '?'} ${shortId(r.id)} · ${r.branch || '-'} · ${r.created_at.slice(0, 10)}: ${r.title}\n${clip(String(r.body || '').replace(/\n{2,}/g, '\n'), 600)}\n`
        + `${c?.next_steps?.length ? `- **Next:** ${c.next_steps.slice(0, 5).join('; ')}\n` : ''}${c?.note ? `- **Note:** ${clip(c.note, 300)}\n` : ''}`;
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
