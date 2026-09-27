// Domain operations over the SQLite store.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, tx, uid, now, J, P, hasFts, open } from './db.mjs';
import { gitInfo, git, defaultBranch, redact, clip, ignored } from './util.mjs';

export const TYPES = ['fact', 'decision', 'constraint', 'lesson', 'requirement', 'preference', 'warning', 'idea', 'task', 'architecture'];
export const AUTO_ACCEPT = ['decision', 'architecture', 'lesson'];
const MAX_PROPOSALS_PER_SESSION = 20;
const PROPOSAL_TTL_DAYS = 7;
const DECAY_EXEMPT = new Set(['decision', 'lesson', 'constraint', 'requirement']);

// ---------- projects / sessions ----------
export function projectFor(cwd) {
  const g = gitInfo(cwd || process.cwd());
  const id = 'prj-' + crypto.createHash('sha1').update(g.root.toLowerCase()).digest('hex').slice(0, 8);
  run(`INSERT INTO projects(id, root, name, git_remote, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET git_remote = COALESCE(excluded.git_remote, git_remote)`,
    id, g.root, path.basename(g.root), g.remote, now());
  return { ...get('SELECT * FROM projects WHERE id = ?', id), branch: g.branch, commit: g.commit };
}
export const project = (id) => get('SELECT * FROM projects WHERE id = ?', id);
export const setMode = (projectId, mode) => run('UPDATE projects SET mode = ? WHERE id = ?', mode, projectId);

export const session = (id) => id && get('SELECT * FROM sessions WHERE id = ?', id);

// One-shot "context for the next session" chosen by the user (viewer / extension / CLI).
export const nextPack = (projectId) => get(`SELECT value FROM settings WHERE scope = ? AND key = 'next_pack'`, projectId)?.value ?? null;
export function setNextPack(projectId, packId) {
  if (packId) run(`INSERT OR REPLACE INTO settings VALUES (?, 'next_pack', ?)`, projectId, packId);
  else run(`DELETE FROM settings WHERE scope = ? AND key = 'next_pack'`, projectId);
  return packId || null;
}

// Everything stored for one session.
export function sessionDetail(id) {
  const s = session(id);
  if (!s) return null;
  const J2 = (r, ...ks) => { for (const k of ks) r[k] = P(r[k], []); return r; };
  return {
    session: s,
    loaded: P(s.loaded, null),
    events: all(`SELECT id, ts, kind, tool, target, body FROM events WHERE session_id = ? AND kind != 'pending' ORDER BY id DESC LIMIT 500`, id),
    summaries: all('SELECT * FROM summaries WHERE session_id = ? ORDER BY created_at DESC', id),
    checkpoints: all('SELECT * FROM checkpoints WHERE session_id = ? ORDER BY ts DESC', id).map((c) => J2(c, 'files', 'next_steps')),
    memories: all('SELECT * FROM memories WHERE source_session = ? ORDER BY created_at', id).map(hydrate),
  };
}

export function ensureSession({ host, session_id, cwd, transcript_path }) {
  const existing = session(session_id);
  if (existing) return { s: existing, created: false };
  const p = projectFor(cwd);
  run(`INSERT INTO sessions(id, project_id, agent, branch, start_commit, capture, transcript_path, started_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    session_id, p.id, host, p.branch, p.commit, p.mode === 'automatic' ? 'on' : 'ask', transcript_path ?? null, now());
  return { s: session(session_id), created: true };
}

// Latest active session for a cwd's project (MCP/CLI calls without explicit session_id).
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
  return all(`SELECT s.id AS session_id, s.agent, s.started_at, COUNT(e.id) AS events FROM sessions s
    JOIN events e ON e.session_id = s.id AND e.id > s.saved_event_id AND e.kind != 'pending'
    WHERE s.project_id = ? AND s.id != ? GROUP BY s.id HAVING events >= 3 ORDER BY s.started_at DESC LIMIT 3`,
    projectId, exceptId ?? '');
}
export const unsavedCount = (s) => get(`SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND id > ? AND kind != 'pending'`, s.id, s.saved_event_id).n;

// ---------- memories ----------
const MEM_JSON = ['files'];
export function hydrate(m) {
  if (!m) return m;
  for (const k of MEM_JSON) m[k] = P(m[k], []);
  m.pinned = !!m.pinned;
  return m;
}
export const memory = (id) => hydrate(get('SELECT * FROM memories WHERE id = ?', id));

export function propose(input, { s, p, via = 'llm' }) {
  const type = TYPES.includes(input.type) ? input.type : 'fact';
  if (s && via === 'llm') {
    const n = get(`SELECT COUNT(*) AS n FROM memories WHERE source_session = ? AND source = 'llm'`, s.id).n;
    if (n >= MAX_PROPOSALS_PER_SESSION) throw new Error(`proposal limit (${MAX_PROPOSALS_PER_SESSION}) reached for this session`);
  }
  const branchScoped = input.scope === 'branch' || (input.scope == null && p.branch && p.branch !== defaultBranch(p.root) && type !== 'preference');
  const scope = input.scope === 'user' || type === 'preference' ? 'user' : branchScoped ? 'branch' : 'project';
  const auto = via === 'user' || (p.mode === 'automatic' && AUTO_ACCEPT.includes(type));
  const status = input.status || (auto ? 'active' : 'proposed');
  const id = uid('m');
  run(`INSERT INTO memories(id, project_id, scope, branch, type, title, body, why, status, importance, confidence, pinned,
       source, source_agent, source_session, source_commit, files, review_when, valid_from, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, scope === 'user' ? null : p.id, scope, scope === 'branch' ? p.branch : null, type,
    clip(redact(input.title), 200), redact(input.body), redact(input.why ?? null), status,
    input.importance ?? 0.5, via === 'user' ? 1 : (input.confidence ?? 0.7), input.pinned ? 1 : 0,
    via, s?.agent ?? null, s?.id ?? null, p.commit ?? null, J(input.files || []), input.review_when ?? null, now(), now(), now());
  run('INSERT INTO memory_versions VALUES (?,?,?,?,?,?,?)', id, 1, input.title, input.body, via, 'created', now());
  return memory(id);
}

export function updateMemory(id, patch, { by = 'user', reason = 'edit' } = {}) {
  const m = memory(id);
  if (!m) throw new Error(`no memory ${id}`);
  const cols = ['title', 'body', 'why', 'type', 'scope', 'importance', 'confidence', 'pinned', 'status', 'review_when', 'files'];
  const sets = [], vals = [];
  for (const c of cols) if (patch[c] !== undefined) {
    sets.push(`${c} = ?`);
    vals.push(c === 'files' ? J(patch[c]) : c === 'pinned' ? (patch[c] ? 1 : 0) : patch[c]);
  }
  if (by === 'user') { sets.push('source = ?', 'confidence = ?'); vals.push('user', 1); }
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

export const relate = (a, b, rel) => run('INSERT OR IGNORE INTO memory_relations VALUES (?,?,?)', a, b, rel);

export function invalidate(id, reason, supersededBy) {
  if (supersededBy) relate(supersededBy, id, 'supersedes');
  return updateMemory(id, { status: 'superseded' }, { by: 'llm', reason: reason || 'invalidated' });
}

export function resolve(id, action, body) {
  const m = memory(id);
  if (!m) throw new Error(`no memory ${id}`);
  if (action === 'reject') return updateMemory(id, { status: 'archived' }, { by: 'user', reason: 'rejected' });
  if (action !== 'accept') throw new Error(`bad action: ${action}`);
  const patch = { status: 'active' };
  if (body) patch.body = body;
  const out = updateMemory(id, patch, { by: body ? 'user' : 'review', reason: 'accepted' });
  // accepting a proposal that supersedes/contradicts others retires them
  for (const r of all(`SELECT b FROM memory_relations WHERE a = ? AND rel IN ('supersedes','contradicts')`, id))
    updateMemory(r.b, { status: 'superseded' }, { by: 'review', reason: `superseded by ${id}` });
  return out;
}

export function expireProposals(projectId) {
  const cutoff = new Date(Date.now() - PROPOSAL_TTL_DAYS * 864e5).toISOString();
  run(`UPDATE memories SET status = 'archived', invalid_at = ? WHERE project_id = ? AND status = 'proposed' AND created_at < ?`, now(), projectId, cutoff);
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

// Recency decay: importance halves every 23 days unless exempt/pinned.
export function decayed(m) {
  if (m.pinned || DECAY_EXEMPT.has(m.type)) return m.importance;
  const days = (Date.now() - Date.parse(m.updated_at)) / 864e5;
  return m.importance * Math.pow(0.5, days / 23);
}

// ---------- git-driven maintenance ----------
export function maintain(p) {
  const key = `maintained:${p.id}`;
  const last = get(`SELECT value FROM settings WHERE scope = 'system' AND key = ?`, key)?.value;
  if (last && Date.now() - Date.parse(last) < 3600e3) return;
  run(`INSERT OR REPLACE INTO settings VALUES ('system', ?, ?)`, key, now());
  expireProposals(p.id);
  // branch promotion: branch-scoped memories become project-scoped once their branch is merged
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
  // staleness: files changed since the commit the memory was based on
  const byCommit = new Map();
  for (const m of all(`SELECT id, source_commit, files FROM memories WHERE project_id = ? AND status = 'active' AND source_commit IS NOT NULL AND files != '[]'`, p.id)) {
    if (!byCommit.has(m.source_commit)) byCommit.set(m.source_commit, []);
    byCommit.get(m.source_commit).push(m);
  }
  for (const [commit, ms] of byCommit) {
    const changed = new Set(git(p.root, 'diff', '--name-only', `${commit}..HEAD`).split('\n').filter(Boolean));
    if (!changed.size) continue;
    for (const m of ms) if (P(m.files, []).some((f) => changed.has(f.replace(/\\/g, '/'))))
      run(`UPDATE memories SET status = 'stale', updated_at = ? WHERE id = ?`, now(), m.id);
  }
}

// ---------- export .context/PROJECT.md (one-way, atomic) ----------
const SECTION = { architecture: 'Architecture', decision: 'Decisions', constraint: 'Constraints', requirement: 'Requirements',
  lesson: 'Lessons', warning: 'Warnings', fact: 'Facts', task: 'Open tasks', idea: 'Ideas (not facts)' };
export function exportProjectMd(p) {
  const rows = all(`SELECT * FROM memories WHERE project_id = ? AND scope = 'project' AND status = 'active' ORDER BY type, importance DESC`, p.id).map(hydrate);
  let out = `<!-- Generated by Universal Agent Context (UAC). Edit via \`uac view\` or \`uac edit\`, not here. -->\n# ${p.name}: project knowledge\n`;
  for (const [type, title] of Object.entries(SECTION)) {
    const ms = rows.filter((m) => m.type === type);
    if (!ms.length) continue;
    out += `\n## ${title}\n`;
    for (const m of ms) {
      out += type === 'decision'
        ? `\n### ${m.title} \`${m.id}\`\n- **Decision:** ${m.body}\n${m.why ? `- **Why:** ${m.why}\n` : ''}- **Status:** accepted${m.source_commit ? ` (at ${m.source_commit})` : ''}\n`
        : `- **${m.title}**: ${m.body.replace(/\n+/g, ' ')}${m.why ? ` _(why: ${m.why})_` : ''} \`${m.id}\`\n`;
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
