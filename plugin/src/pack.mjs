// Start context (injected by the hook), session-centric bootstrap, digest/save for the compressor,
// deterministic auto cards, checkpoints, handoff, packs.
import { all, get, run, tx, uid, now, J, P, checkpointWal } from './db.mjs';
import * as S from './store.mjs';
import { changedFiles, tokens, clip, git } from './util.mjs';

// Internal budgets (tokens). Users pick sessions, not sizes; `deep` is for explicit "load more" requests.
export const BUDGET = { normal: 2000, deep: 6000 };
export const TIERS = { minimal: 1000, relevant: 2000, deep: 6000, fork: 2000, none: 0 }; // v0.2 names, still accepted
export const STOP_THRESHOLD = 40;
const START_MAX = 9000; // hook output cap is 10K chars
const NEAR_EMPTY_TOKENS = 150;

export const ago = (iso) => {
  if (!iso) return '';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const MARK = { verified: '✓', changed: '⚠', missing: '✗', unknown: '' };
const fresh = (m) => {
  const f = m.freshness || {};
  if (f.state === 'changed') return `⚠ file changed since verified${f.commits_since ? ` (${f.commits_since} commit${f.commits_since === 1 ? '' : 's'})` : ' (uncommitted)'}, verify`;
  if (f.state === 'missing') return '✗ anchored file/symbol not found, verify';
  return MARK[f.state] || '';
};

export const latestCheckpoint = (projectId, sessionId) => sessionId
  ? get('SELECT * FROM checkpoints WHERE session_id = ? ORDER BY ts DESC LIMIT 1', sessionId)
  : get('SELECT * FROM checkpoints WHERE project_id = ? AND superseded_by IS NULL ORDER BY ts DESC LIMIT 1', projectId);

function fmtCard(c, meta) {
  const L = [`### ${meta}`];
  if (c.title) L.push(`**${c.title}**${c.quality === 'auto' ? ' _(auto card, no LLM summary yet)_' : ''}`);
  if (c.body) L.push(clip(c.body.replace(/\n{2,}/g, '\n'), 700));
  if (c.working) L.push(`Working: ${clip(c.working, 300)}`);
  if (c.broken) L.push(`Broken/open: ${clip(c.broken, 300)}`);
  if (c.next_steps?.length) L.push(`Next: ${c.next_steps.slice(0, 6).join('; ')}`);
  if (c.files?.length) L.push(`Files: ${c.files.slice(0, 12).join(', ')}`);
  if (c.note) L.push(`Note for next dev: ${clip(c.note, 300)}`);
  return L.join('\n');
}
// Human label for a session in lists: its card/title, else what little we know, always with age.
export const sessionLabel = (x, n = 50) =>
  `${clip(x.card?.title || x.title || `${x.agent} session, ${x.events} event${x.events === 1 ? '' : 's'}, no card`, n)} (${ago(x.started_at)})`;
const cardMeta = (s, n) => `${n ? `#${n} · ` : ''}${s.branch || 'no-branch'} · ${s.agent}${s.model ? ` (${s.model})` : ''} · ${ago(s.started_at)}`;

// ---------- bootstrap: project knowledge + chosen session cards + other branches + messages ----------
export function bootstrap(s, p, opts = {}) {
  let { sessions = [], packs = [], goal = '', depth, fresh: freshStart = false, record = true, tier, pack } = opts;
  // v0.2 compatibility
  if (tier === 'fork') freshStart = true;
  if (tier === 'deep') depth = 'deep';
  if (tier === 'none') return { text: '[UAC] No context loaded.', ids: [], tokens: 0 };
  if (pack) packs = [...packs, pack];
  // choices made outside the chat (dashboard / extension / CLI): one-shot
  const choice = P(s?.choice, null);
  if (choice && s) {
    run('UPDATE sessions SET choice = NULL WHERE id = ?', s.id);
    if (choice.capture) S.setCapture(s.id, choice.capture);
    if (choice.tier === 'fork') freshStart = true;
    if (choice.pack) packs.push(choice.pack);
    if (choice.sessions) sessions = [...sessions, ...choice.sessions];
  }
  if (record && !sessions.length && !freshStart) {
    const next = S.nextSessions(p.id);
    if (next.length) { sessions = next; S.setNextSessions(p.id, []); }
    const np = S.nextPack(p.id);
    if (np) { packs.push(np); S.setNextPack(p.id, null); }
  }
  sessions = S.resolveSessionRefs(p.id, sessions);
  const budget = opts.budget_tokens || BUDGET[depth === 'deep' ? 'deep' : 'normal'];
  const packRows = packs.map((id) => get('SELECT * FROM packs WHERE id = ?', id)).filter(Boolean);
  const packIds = new Set(packRows.flatMap((k) => P(k.item_ids, [])));
  for (const id of packIds) if (id.startsWith('c-') || id.startsWith('s-')) {
    const sid = get(`SELECT session_id FROM ${id.startsWith('c-') ? 'checkpoints' : 'summaries'} WHERE id = ?`, id)?.session_id;
    if (sid && !sessions.includes(sid)) sessions.push(sid);
  }
  goal = goal || packRows[0]?.goal || '';
  const numbered = S.listSessions(p.id, { limit: 200 });
  const numOf = (id) => numbered.find((x) => x.id === id)?.n;

  // 1. session cards: chosen ones, else the latest card on this branch (not in a fresh start)
  let cardSessions = sessions;
  let defaulted = false;
  if (!cardSessions.length && !freshStart) {
    const latest = numbered.find((x) => x.id !== s?.id && x.card && (x.branch === p.branch || !p.branch));
    if (latest) { cardSessions = [latest.id]; defaulted = true; }
  }
  const cards = cardSessions.map((id) => ({ s: S.session(id), c: S.card(id) })).filter((x) => x.s && x.c);

  // 2. knowledge
  const hits = new Map(goal ? S.search(p.id, goal, { limit: 60 }).map((m, i) => [m.id, 1 - i / 60]) : []);
  const changed = changedFiles(p.root).map((f) => f.replace(/\\/g, '/'));
  const mems = S.freshness(p, all(`SELECT * FROM memories WHERE (project_id = ? OR project_id IS NULL) AND status IN ('active','stale')
      AND muted = 0 AND type != 'idea' AND (scope != 'branch' OR branch = ?)`, p.id, freshStart ? '__none__' : p.branch ?? '').map(S.hydrate));
  const items = mems.map((m) => {
    const reasons = [];
    let score = 0;
    if (packIds.has(m.id)) { score += 10; reasons.push('in pack'); }
    if (hits.has(m.id)) { score += hits.get(m.id); reasons.push('matches goal'); }
    const files = [...m.files, ...m.anchors.map((a) => a.file)];
    const overlap = files.filter((f) => changed.some((c) => c.endsWith(f) || f.endsWith(c)));
    if (overlap.length) { score += 0.8; reasons.push(`touches changed files: ${overlap.slice(0, 3).join(', ')}`); }
    if (m.scope === 'branch') { score += 0.5; reasons.push(`branch ${m.branch}`); }
    const imp = S.decayed(m);
    score += 0.4 * imp + 0.3 * m.confidence;
    if (m.pinned) { score += 0.6; reasons.push('pinned'); }
    if (m.status === 'stale' || m.freshness.state === 'missing') { score -= 0.8; reasons.push('stale'); }
    const anc = S.fmtAnchors(m);
    const f = fresh(m);
    const text = `- **${m.title}**: ${m.body.replace(/\n+/g, ' ')}${m.why ? ` (why: ${m.why})` : ''}${anc ? ` · \`${anc}\`` : ''}${f ? ` ${f}` : ''}${m.source_model ? ` _(by ${m.source_model})_` : ''} \`${m.id}\``;
    return { id: m.id, kind: m.type, score, reasons, text };
  });
  const must = items.filter((i) => ['requirement', 'constraint'].includes(i.kind)).sort((a, b) => b.score - a.score);
  const know = items.filter((i) => !['requirement', 'constraint'].includes(i.kind)).sort((a, b) => b.score - a.score);

  // 3. other active branches (parallel work awareness)
  const others = p.branch ? all(`SELECT s.branch, MAX(s.started_at) AS at FROM sessions s WHERE s.project_id = ? AND s.branch IS NOT NULL
      AND s.branch != ? AND s.started_at >= ? GROUP BY s.branch ORDER BY at DESC LIMIT 5`, p.id, p.branch, new Date(Date.now() - 14 * 864e5).toISOString())
    .map((b) => {
      const latest = numbered.find((x) => x.branch === b.branch);
      const c = latest?.card;
      return `- \`${b.branch}\`: ${c?.title ? `"${clip(c.title, 90)}"` : latest?.title ? `"${clip(latest.title, 90)}"` : '(no card yet)'} · ${latest?.agent || ''} · ${ago(b.at)}${c?.files?.length ? ` · files: ${c.files.slice(0, 5).join(', ')}` : ''}`;
    }) : [];

  // 4. messages for this session/branch
  const msgs = s && record ? S.unreadMessages(s) : [];

  // assemble within budget: cards ≤45%, must-not-violate ≤15%, then knowledge
  const chosen = [];
  let used = 0;
  const take = (text, cap) => { const t = tokens(text); if (used + t > cap) return false; used += t; return true; };
  const cardTexts = [];
  for (const { s: cs, c } of cards) {
    const t = fmtCard(c, cardMeta(cs, numOf(cs.id)));
    if (take(t, budget * 0.45) || !cardTexts.length) { cardTexts.push(t); chosen.push(c.checkpoint_id || c.summary_id); }
  }
  const mustTexts = [], knowTexts = [];
  for (const i of must) if (take(i.text, used + budget * 0.15)) { mustTexts.push(i); chosen.push(i.id); }
  for (const i of know) if (take(i.text, budget)) { knowTexts.push(i); chosen.push(i.id); }

  const mode = p.mode || 'first run';
  const rec = s ? (S.session(s.id)?.capture === 'on' ? 'recording ON' : 'not recording') : '';
  let out = `# UAC · ${p.name} · branch \`${p.branch || '-'}\` · mode ${mode} · ${rec}\n` +
    `Memory = claims to verify, not facts: ✓ checked against code · ⚠ file changed since · ✗ not found. After checking an item call uac_verify.\n`;
  const knowledgeTokens = [...mustTexts, ...knowTexts].reduce((a, i) => a + tokens(i.text), 0);
  if (!cards.length && knowledgeTokens < NEAR_EMPTY_TOKENS)
    out += `\n> UAC knows almost nothing about this project yet. To build project knowledge, run the uac-init-knowledge skill ("survey this codebase for UAC") or /universal-agent-context:uac init.\n`;
  if (cardTexts.length) out += `\n## Continuing from${defaulted ? ' (latest session on this branch)' : ''}\n${cardTexts.join('\n\n')}\n`;
  if (mustTexts.length) out += `\n## Must not violate\n${mustTexts.map((i) => i.text).join('\n')}\n`;
  if (knowTexts.length) out += `\n## Project knowledge\n${knowTexts.map((i) => i.text).join('\n')}\n`;
  const omitted = items.length - mustTexts.length - knowTexts.length;
  if (omitted > 0) out += `_${omitted} more memories not shown: uac_search / uac_get, or "#uac deep"._\n`;
  if (others.length) out += `\n## Other active branches (parallel work)\n${others.join('\n')}\n`;
  if (msgs.length) {
    out += `\n## Messages for you\n${msgs.map((m) => `- from ${m.from_agent}${m.from_branch ? ` on \`${m.from_branch}\`` : ''} (${ago(m.created_at)}): ${m.text}`).join('\n')}\n`;
    S.markRead(s, msgs);
  }
  if (record && s) {
    const loadedCheckpoints = cards.map((x) => x.c.checkpoint_id).filter(Boolean);
    run('INSERT INTO retrievals(session_id, project_id, goal, item_ids, reasons, tokens, ts) VALUES (?,?,?,?,?,?,?)',
      s.id, p.id, goal, J(chosen), J(Object.fromEntries(items.filter((i) => chosen.includes(i.id)).map((i) => [i.id, i.reasons]))), used, now());
    run('UPDATE sessions SET loaded = ? WHERE id = ?', J({ sessions: cards.map((x) => x.s.id), checkpoints: loadedCheckpoints, packs, goal, depth, fresh: freshStart }), s.id);
  }
  return { text: out, ids: chosen, tokens: used, cards: cards.length, knowledge: mustTexts.length + knowTexts.length };
}

// ---------- start context injected by the hook (no questions unless first run) ----------
export function startContext(s, p, { source } = {}) {
  S.maintain(p);
  if (p.mode === 'off') return `[UAC is off for "${p.name}". Type "#uac on" to record this session, or run "uac mode manual" to load context again.]`;
  // unsaved sessions that ended without an LLM save get a deterministic card now, so nothing is lost
  const unsaved = S.unsavedSessions(p.id, s.id).filter((u) => u.status === 'ended' || Date.now() - Date.parse(u.started_at) > 6 * 3600e3);
  for (const u of unsaved) autoCard(S.session(u.session_id));
  let text;
  if (source === 'compact' && s.loaded) {
    const l = P(s.loaded, {});
    text = `[UAC] Context was compacted; re-loaded below.\n\n` + bootstrap(s, p, { sessions: l.sessions, packs: l.packs, goal: l.goal, depth: l.depth, fresh: l.fresh, record: false }).text;
    const snap = get(`SELECT * FROM checkpoints WHERE session_id = ? AND trigger = 'precompact' ORDER BY ts DESC LIMIT 1`, s.id);
    if (snap) text += `\n## Pre-compaction snapshot\n${fmtCard({ title: snap.goal, broken: snap.broken, files: P(snap.files, []), next_steps: P(snap.next_steps, []), note: snap.note }, 'this session')}`;
  } else {
    text = bootstrap(s, p, {}).text;
  }
  const L = [];
  // only sessions worth continuing from (a card or some recorded events)
  const recent = S.listSessions(p.id, { limit: 20 }).filter((x) => x.id !== s.id && (x.card || x.events)).slice(0, 5);
  if (recent.length) L.push(`Sessions (for "#uac continue <n>"): ${recent.map((x) => `#${x.n} ${sessionLabel(x)} [${x.branch || '-'}]`).join(' · ')}`);
  if (unsaved.length && p.mode === 'automatic')
    L.push(`Session ${unsaved[0].session_id} ended without an LLM save (auto card made). When convenient (not before answering the user), spawn the uac-compressor subagent with "session_id=${unsaved[0].session_id}" to refine it.`);
  const uncaptured = get(`SELECT COUNT(*) AS n FROM sessions WHERE project_id = ? AND id != ? AND capture IN ('off','ask') AND transcript_path IS NOT NULL
      AND started_at >= ? AND NOT EXISTS (SELECT 1 FROM summaries x WHERE x.session_id = sessions.id)`, p.id, s.id, new Date(Date.now() - 3 * 864e5).toISOString()).n;
  if (uncaptured && p.mode) L.push(`${uncaptured} recent session(s) ran without recording; "uac import <n>" can recover one from its transcript.`);
  if (!p.mode) L.push(`UAC first run in this project. Ask the user ONCE (AskUserQuestion if available): should UAC be "automatic" (load context + record + auto-save), "manual" (load context, record only after #uac on) or "off"? Then call uac_capture {session_id: "${s.id}", mode, state: "on" for automatic else "off"}. Until then nothing is recorded.`);
  else if (p.mode === 'manual' && S.session(s.id).capture !== 'on') L.push('Recording is off (manual mode). The user can type "#uac on".');
  L.push(`Controls (typed by the user anywhere in a message): #uac on | off | save | fresh | continue <n> | deep | msg <text>. Save = spawn uac-compressor (session_id=${s.id}).`);
  return clip(`${text}\n${L.join('\n')}`, START_MAX);
}

export function why(projectId, id) {
  const r = all('SELECT * FROM retrievals WHERE project_id = ? ORDER BY id DESC LIMIT 20', projectId)
    .find((x) => P(x.item_ids, []).includes(id));
  return r ? { id, goal: r.goal, reasons: P(r.reasons, {})[id] || [], ts: r.ts } : { id, reasons: ['not in any recent pack'] };
}

// ---------- digest / save (uac-compressor subagent) ----------
function diffSince(p, commit) {
  if (!commit) return { stat: '', files: [] };
  const stat = git(p.root, 'diff', '--stat', commit);
  const files = git(p.root, 'diff', '--name-only', commit).split('\n').filter(Boolean);
  const untracked = git(p.root, 'ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean).slice(0, 30);
  return { stat: clip([stat, untracked.length ? `untracked: ${untracked.join(', ')}` : ''].filter(Boolean).join('\n'), 3000), files: [...files, ...untracked] };
}

export function digest(s, maxChars = 60000) {
  const p = S.projectFor(S.project(s.project_id).root);
  const evs = all(`SELECT * FROM events WHERE session_id = ? AND id > ? AND kind != 'pending' ORDER BY id`, s.id, s.saved_event_id);
  const lines = [];
  let prev = '';
  for (const e of evs) {
    const key = `${e.kind}|${e.tool}|${e.target}`;
    if (key === prev && e.kind === 'tool') continue;
    prev = key;
    if (e.kind === 'prompt') lines.push(`USER: ${e.body}`);
    else if (e.kind === 'tool') lines.push(`  tool ${e.tool}${e.target ? ` ${e.target}` : ''}`);
    else if (e.kind === 'tool_fail') lines.push(`  FAILED ${e.tool} ${e.target || ''}: ${clip(e.body, 400)}`);
    else if (e.kind === 'subagent') lines.push(`  subagent result: ${clip(e.body, 600)}`);
    else if (e.kind === 'assistant') lines.push(`ASSISTANT: ${clip(e.body, 800)}`);
    else lines.push(`  ${e.kind}: ${clip(e.body, 300)}`);
  }
  let text = lines.join('\n');
  // ponytail: keeps head + tail when over budget; map-reduce chunking if sessions routinely exceed it
  if (text.length > maxChars) text = text.slice(0, maxChars * 0.3) + '\n  …[middle omitted]…\n' + text.slice(-maxChars * 0.7);
  const goal = evs.find((e) => e.kind === 'prompt')?.body || '';
  const d = diffSince(p, s.start_commit);
  const touched = new Set([...d.files, ...evs.map((e) => e.target).filter(Boolean)].map((f) => String(f).replace(/\\/g, '/')));
  const recheck = all(`SELECT * FROM memories WHERE project_id = ? AND status IN ('active','stale')`, s.project_id).map(S.hydrate)
    .filter((m) => [...m.files, ...m.anchors.map((a) => a.file)].some((f) => [...touched].some((t) => t.endsWith(f) || f.endsWith(t))))
    .slice(0, 20).map(({ id, type, title, body, anchors, files }) => ({ id, type, title, body, anchors, files }));
  const existing = all(`SELECT id, type, title FROM memories WHERE (project_id = ? OR project_id IS NULL) AND status IN ('active','proposed','stale')
      ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT 80`, s.project_id);
  return { session_id: s.id, branch: s.branch, goal: clip(goal, 500), upto_event_id: evs.at(-1)?.id ?? s.saved_event_id,
    events: text, diff_stat: d.stat, recheck, existing };
}

export function addCheckpoint(s, c, trigger = 'manual') {
  const id = uid('c');
  run(`INSERT INTO checkpoints(id, session_id, project_id, ts, trigger, goal, working, broken, files, next_steps, note) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id, s.id, s.project_id, now(), trigger, clip(c.goal, 500), clip(c.working, 1500), clip(c.broken, 1500), J(c.files || []), J(c.next_steps || []), clip(c.note, 800));
  return id;
}

export function save(s, p, { upto_event_id, summary, checkpoint, candidates = [], model }) {
  const res = { summary: null, checkpoint: null, added: 0, updated: 0, verified: 0, conflicts: 0, pending_review: 0, skipped: 0, events_removed: 0, errors: [] };
  const upto = upto_event_id ?? get('SELECT MAX(id) AS m FROM events WHERE session_id = ?', s.id).m ?? s.saved_event_id;
  const raw = get(`SELECT COALESCE(SUM(LENGTH(COALESCE(body,'')) + LENGTH(COALESCE(target,''))), 0) AS n FROM events WHERE session_id = ? AND id > ? AND id <= ?`,
    s.id, s.saved_event_id, upto).n;
  // an LLM save replaces this session's auto card
  run(`DELETE FROM summaries WHERE session_id = ? AND quality = 'auto'`, s.id);
  run(`DELETE FROM checkpoints WHERE session_id = ? AND trigger = 'auto'`, s.id);
  if (summary?.title) {
    res.summary = uid('s');
    run('INSERT INTO summaries(id, session_id, project_id, title, body, raw_chars, created_at, quality, model) VALUES (?,?,?,?,?,?,?,?,?)',
      res.summary, s.id, p.id, clip(summary.title, 200), summary.body || '', raw, now(), 'llm', model ?? null);
    run('UPDATE sessions SET title = ? WHERE id = ?', clip(summary.title, 120), s.id);
  }
  if (checkpoint) {
    res.checkpoint = addCheckpoint(s, checkpoint, 'save');
    // consolidation: this card supersedes older checkpoints of this session and the ones it loaded on the same branch
    const loaded = P(s.loaded, {}).checkpoints || [];
    run(`UPDATE checkpoints SET superseded_by = ? WHERE id != ? AND superseded_by IS NULL AND (session_id = ?
         OR (id IN (SELECT value FROM json_each(?)) AND session_id IN (SELECT id FROM sessions WHERE branch IS ?)))`,
      res.checkpoint, res.checkpoint, s.id, J(loaded), s.branch);
  }
  for (const c of candidates) {
    try {
      const op = c.op || 'add';
      if (op === 'noop') { res.skipped++; continue; }
      if (op === 'verify' && c.id) { S.verifyMemory(c.id, p); res.verified++; continue; }
      if (op === 'update' && c.id && (c.confidence ?? 0.7) >= S.AUTO_ACCEPT_CONFIDENCE) {
        S.updateMemory(c.id, { body: c.body, title: c.title, why: c.why, files: c.files, anchors: c.anchors, status: 'active' }, { by: 'compressor', reason: c.why || 'updated by compressor' });
        S.verifyMemory(c.id, p);
        run(`UPDATE memories SET resolved_by = 'compressor', resolved_at = ?, source_model = COALESCE(?, source_model) WHERE id = ?`, now(), model ?? null, c.id);
        res.updated++; continue;
      }
      if (op === 'conflict' && c.id) {
        const m = S.propose({ ...c, status: 'conflict' }, { s, p, model });
        S.relate(m.id, c.id, 'contradicts'); res.conflicts++; continue;
      }
      const m = S.propose(c, { s, p, model });
      if ((op === 'update' || op === 'supersede') && c.id) {
        S.relate(m.id, c.id, 'supersedes');
        if (m.status === 'active') S.updateMemory(c.id, { status: 'superseded' }, { by: 'compressor', reason: `superseded by ${m.id}` });
      }
      if (m.status === 'proposed') res.pending_review++; else res.added++;
    } catch (e) { res.errors.push(`${c.title || c.id}: ${e.message}`); }
  }
  // the card replaces the raw events: nothing to compress again
  res.events_removed = run(`DELETE FROM events WHERE session_id = ? AND id <= ?`, s.id, upto).changes;
  run(`UPDATE sessions SET saved_event_id = MAX(saved_event_id, ?), quality = 'llm' WHERE id = ?`, upto, s.id); // the card records the compressor's model; the session keeps its own
  try { res.exported = S.exportProjectMd(p); } catch (e) { res.errors.push(`export: ${e.message}`); }
  checkpointWal();
  return res;
}

// Deterministic card from events + git (no LLM). Events are kept so an LLM save can refine it later.
export function autoCard(s) {
  if (!s) return null;
  const p = S.project(s.project_id);
  const evs = all(`SELECT * FROM events WHERE session_id = ? AND kind != 'pending' ORDER BY id`, s.id);
  if (!evs.length) return null;
  const prompts = evs.filter((e) => e.kind === 'prompt');
  const files = [...new Set(evs.filter((e) => e.kind === 'tool' && e.target && /[\\/]|\.\w{1,5}$/.test(e.target) && !/\s/.test(e.target)).map((e) => e.target))];
  const d = p && s.start_commit ? diffSince(p, s.start_commit) : { stat: '', files: [] };
  const allFiles = [...new Set([...d.files, ...files])].slice(0, 20);
  const fails = evs.filter((e) => e.kind === 'tool_fail').slice(-3);
  const last = evs.filter((e) => e.kind === 'assistant').at(-1)?.body;
  const goal = prompts[0]?.body || s.title || '';
  const title = clip(`${clip(goal.replace(/\s+/g, ' '), 70)}${allFiles.length ? ` (${allFiles.slice(0, 2).map((f) => f.split(/[\\/]/).pop()).join(', ')})` : ''}`, 120);
  run(`DELETE FROM summaries WHERE session_id = ? AND quality = 'auto'`, s.id);
  run(`DELETE FROM checkpoints WHERE session_id = ? AND trigger = 'auto'`, s.id);
  run('INSERT INTO summaries(id, session_id, project_id, title, body, raw_chars, created_at, quality) VALUES (?,?,?,?,?,?,?,?)',
    uid('s'), s.id, s.project_id, title, `Auto card (no LLM): ${prompts.length} prompt(s), ${evs.length - prompts.length} other events.${d.stat ? `\nDiff since start:\n${clip(d.stat, 600)}` : ''}`,
    0, now(), 'auto');
  addCheckpoint(s, { goal: clip(goal, 300), working: '', broken: fails.map((f) => `${f.tool} ${f.target || ''}`).join('; '),
    files: allFiles, next_steps: [], note: clip(last || prompts.at(-1)?.body, 400) }, 'auto');
  run(`UPDATE sessions SET title = COALESCE(title, ?), quality = COALESCE(quality, 'auto') WHERE id = ?`, title, s.id);
  return title;
}

// Deterministic ≤2KB tiered snapshot before compaction (no LLM).
export function precompactSnapshot(s) {
  const prompts = all(`SELECT body FROM events WHERE session_id = ? AND kind = 'prompt' ORDER BY id`, s.id);
  const files = [...new Set(all(`SELECT target FROM events WHERE session_id = ? AND kind = 'tool' AND target IS NOT NULL ORDER BY id DESC LIMIT 80`, s.id)
    .map((r) => r.target).filter((t) => /[\\/]|\.\w{1,5}$/.test(t) && !/\s/.test(t)))].slice(0, 15);
  const fails = all(`SELECT tool, target FROM events WHERE session_id = ? AND kind = 'tool_fail' ORDER BY id DESC LIMIT 3`, s.id);
  const c = { goal: clip(prompts[0]?.body, 300), files, note: clip(prompts.at(-1)?.body, 400),
    broken: fails.map((f) => `${f.tool} ${f.target || ''}`).join('; '), working: '', next_steps: [] };
  while (JSON.stringify(c).length > 2000 && c.files.length) c.files.pop();
  if (JSON.stringify(c).length > 2000) c.broken = '';
  return addCheckpoint(s, c, 'precompact');
}

// "Continue this work elsewhere": the next session (any agent/branch) continues from this one.
export function handoff(s, p) {
  const next = [...new Set([s.id, ...S.nextSessions(p.id)])];
  S.setNextSessions(p.id, next);
  const n = S.listSessions(p.id, { limit: 200 }).find((x) => x.id === s.id)?.n;
  return { next_sessions: next, how: `The next UAC session in this project continues from this one automatically. In an already-open session type "#uac continue ${n}". Save first (uac-compressor) so the card is complete.` };
}

export function createPack(p, s, { name, ids = [], goal, budget_tokens, next }) {
  const id = uid('p');
  run('INSERT INTO packs VALUES (?,?,?,?,?,?,?,?)', id, p.id, name || id, goal || '', budget_tokens || BUDGET.normal, J(ids), s?.id ?? null, now());
  if (next) S.setNextPack(p.id, id);
  return { ...get('SELECT * FROM packs WHERE id = ?', id), item_ids: ids, next: !!next };
}

export const listPacks = (projectId) => {
  const next = S.nextPack(projectId);
  return all('SELECT * FROM packs WHERE project_id = ? ORDER BY created_at DESC', projectId)
    .map((k) => ({ ...k, item_ids: P(k.item_ids, []), next: k.id === next }));
};

export function timeline(p, s, { before = 3, after = 3 } = {}) {
  const sessions = all('SELECT id, agent, branch, started_at, title FROM sessions WHERE project_id = ? ORDER BY started_at', p.id);
  const i = Math.max(0, sessions.findIndex((x) => x.id === s?.id));
  return sessions.slice(Math.max(0, i - before), i + after + 1).map((x) => ({ ...x, card: S.card(x.id) }));
}
