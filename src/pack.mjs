// Menu, context packs (bootstrap), digest/save for the compressor subagent, checkpoints, handoff.
import { all, get, run, tx, uid, now, J, P } from './db.mjs';
import * as S from './store.mjs';
import { changedFiles, tokens, clip } from './util.mjs';

export const TIERS = { minimal: 1000, relevant: 4000, deep: 10000, fork: 4000, none: 0 };
const BUCKETS = [
  ['Where we left off', ['@checkpoint'], 0.20],
  ['Must not violate', ['requirement', 'constraint'], 0.15],
  ['Decisions', ['decision'], 0.20],
  ['Architecture & facts', ['architecture', 'fact', 'preference'], 0.15],
  ['Lessons & warnings', ['lesson', 'warning'], 0.15],
  ['Open tasks', ['task'], 0.05],
  ['Recent sessions', ['@summary'], 0.10],
];
const MENU_MAX = 6000;
export const STOP_THRESHOLD = 40;

const ago = (iso) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

export const latestCheckpoint = (projectId, sessionId) => sessionId
  ? get('SELECT * FROM checkpoints WHERE session_id = ? ORDER BY ts DESC LIMIT 1', sessionId)
  : get('SELECT * FROM checkpoints WHERE project_id = ? ORDER BY ts DESC LIMIT 1', projectId);

function fmtCheckpoint(c) {
  if (!c) return '';
  const next = P(c.next_steps, []), files = P(c.files, []);
  return [c.goal && `Goal: ${c.goal}`, c.working && `Working: ${c.working}`, c.broken && `Broken/open: ${c.broken}`,
    next.length && `Next: ${next.join('; ')}`, files.length && `Files: ${files.slice(0, 12).join(', ')}`,
    c.note && `Note for next dev: ${c.note}`].filter(Boolean).join('\n');
}

// ---------- SessionStart menu ----------
export function menu(s, p, { source } = {}) {
  S.maintain(p);
  const c = S.counts(p.id);
  const unsaved = S.unsavedSessions(p.id, s.id);
  const sessions = all(`SELECT id, agent, started_at, title FROM sessions WHERE project_id = ? AND id != ? ORDER BY started_at DESC LIMIT 5`, p.id, s.id);
  const packs = all(`SELECT id, name, goal FROM packs WHERE project_id = ? ORDER BY created_at DESC LIMIT 5`, p.id);
  const cp = latestCheckpoint(p.id);
  const empty = !c.active && !c.proposed && !sessions.length;
  const L = [];
  L.push(`[UAC · Universal Agent Context] project "${p.name}" · session_id=${s.id} · mode=${p.mode || 'unset'} · capture=${s.capture}`);
  if (unsaved.length) {
    const u = unsaved[0];
    L.push(p.mode === 'automatic'
      ? `Unsaved previous session ${u.session_id} (${u.events} events, ${u.agent}). FIRST spawn the uac-compressor subagent with session_id=${u.session_id} to save it.`
      : `Unsaved previous session ${u.session_id} (${u.events} events, ${u.agent}). Ask the user whether to save it (if yes: spawn uac-compressor with session_id=${u.session_id}).`);
  }
  if (empty) {
    L.push('No stored context for this project yet.');
  } else {
    if (cp) L.push(`Last checkpoint (${ago(cp.ts)}):\n${clip(fmtCheckpoint(cp), 900)}`);
    L.push(`Memory: ${c.active} active · ${c.proposed} proposed (awaiting review) · ${c.stale} stale · ${c.conflict} conflicts · ${c.tasks} open tasks`);
    if (sessions.length) L.push('Recent sessions:\n' + sessions.map((x) => `- ${x.id.slice(0, 12)} · ${x.agent} · ${ago(x.started_at)}${x.title ? ` · ${x.title}` : ''}`).join('\n'));
    if (packs.length) L.push('Packs: ' + packs.map((k) => `${k.id} "${k.name}"`).join(', '));
  }
  const nextId = S.nextPack(p.id);
  const nextRow = nextId && get('SELECT id, name FROM packs WHERE id = ?', nextId);
  if (nextRow) L.push(`The user pre-selected pack ${nextRow.id} "${nextRow.name}" for this session: uac_bootstrap loads it automatically (no need to ask which context).`);
  const q = [];
  if (!empty && !nextRow) q.push('(1) Load context: Minimal ~1k / Relevant ~4k / Deep ~10k tokens / Fork (project knowledge only, no session state) / None' + (packs.length ? ' / a pack' : ''));
  q.push(`(${q.length + 1}) Capture this session? on / off`);
  if (!p.mode) q.push(`(${q.length + 1}) UAC mode for this project: manual (save only on request, review everything) / automatic (auto-save, auto-accept decisions/architecture/lessons)`);
  L.push(`Before starting work, ask the user (use AskUserQuestion if available, in one prompt):\n${q.join('\n')}\n` +
    `Then call the uac MCP tools: uac_capture {session_id, state${p.mode ? '' : ', mode'}}` + (empty ? '' : ` and uac_bootstrap {session_id, tier, goal: <user's task>}`) +
    `. If the user already chose in the VS Code UAC panel, uac_bootstrap returns that choice, so skip asking. If the user's first message is urgent, answer it first and ask afterwards. Inline controls: #uac pause | #uac resume | #uac off | #uac save.`);
  if (c.proposed || c.conflict) L.push(`${c.proposed + c.conflict} items await review: offer /uac review.`);
  let text = L.join('\n\n');
  if (source === 'compact' && s.loaded) {
    const loaded = P(s.loaded, {});
    text = `[UAC] Context was compacted. Re-loaded pack below. session_id=${s.id} capture=${s.capture}\n\n` +
      bootstrap(s, p, { tier: loaded.tier || 'relevant', pack: loaded.pack, goal: loaded.goal, record: false }).text;
    const snap = get(`SELECT * FROM checkpoints WHERE session_id = ? AND trigger = 'precompact' ORDER BY ts DESC LIMIT 1`, s.id);
    if (snap) text = `${text}\n\n## Pre-compaction snapshot\n${fmtCheckpoint(snap)}`;
  }
  return clip(text, MENU_MAX);
}

// ---------- bootstrap: ranked, budgeted context pack ----------
export function bootstrap(s, p, { tier, budget_tokens, goal, pack, record = true } = {}) {
  const choice = P(s?.choice, null);
  if (!tier && choice?.tier) tier = choice.tier;
  if (!pack && choice?.pack) pack = choice.pack;
  if (choice && s) run('UPDATE sessions SET choice = NULL WHERE id = ?', s.id);
  if (choice?.capture && s) S.setCapture(s.id, choice.capture);
  // user pre-selected a pack for the next session (one-shot)
  const next = record && !pack ? S.nextPack(p.id) : null;
  if (next && get('SELECT 1 FROM packs WHERE id = ?', next)) { pack = next; S.setNextPack(p.id, null); }
  tier = TIERS[tier] !== undefined ? tier : 'relevant';
  if (tier === 'none' && !pack) return { text: '[UAC] No context loaded (tier=none).', ids: [], tier };
  const packRow = pack ? get('SELECT * FROM packs WHERE id = ?', pack) : null;
  const budget = budget_tokens || packRow?.budget_tokens || TIERS[tier] || TIERS.relevant;
  const fork = tier === 'fork';
  const pinnedIds = new Set(P(packRow?.item_ids, []));
  goal = goal || packRow?.goal || '';

  const hits = new Map(goal ? S.search(p.id, goal, { limit: 60 }).map((m, i) => [m.id, 1 - i / 60]) : []);
  const changed = changedFiles(p.root).map((f) => f.replace(/\\/g, '/'));
  const mems = all(`SELECT * FROM memories WHERE (project_id = ? OR project_id IS NULL) AND status IN ('active','stale')
      AND type != 'idea' AND (scope != 'branch' OR branch = ?)`, p.id, fork ? '__none__' : p.branch ?? '').map(S.hydrate);
  for (const id of pinnedIds) if (!mems.some((m) => m.id === id)) { const m = S.memory(id); if (m) mems.push(m); }

  const items = mems.map((m) => {
    const reasons = [];
    let score = 0;
    if (pinnedIds.has(m.id)) { score += 10; reasons.push('in pack'); }
    if (hits.has(m.id)) { score += hits.get(m.id); reasons.push('matches goal'); }
    const overlap = m.files.filter((f) => changed.some((c) => c.endsWith(f.replace(/\\/g, '/')) || f.endsWith(c)));
    if (overlap.length) { score += 0.8; reasons.push(`touches changed files: ${overlap.slice(0, 3).join(', ')}`); }
    if (m.scope === 'branch') { score += 0.5; reasons.push(`branch ${m.branch}`); }
    const imp = S.decayed(m);
    score += 0.4 * imp + 0.3 * m.confidence;
    if (m.pinned) { score += 0.5; reasons.push('pinned'); }
    if (m.status === 'stale') { score -= 1; reasons.push('STALE: files changed since recorded'); }
    if (['requirement', 'constraint'].includes(m.type) && overlap.length) score += 1;
    reasons.push(`importance ${imp.toFixed(2)}, confidence ${m.confidence}`);
    const text = `- ${m.status === 'stale' ? '⚠ STALE ' : ''}**${m.title}**: ${m.body.replace(/\n+/g, ' ')}${m.why ? ` (why: ${m.why})` : ''} \`${m.id}\``;
    return { id: m.id, kind: m.type, score, reasons, text };
  });
  // summaries/checkpoints: recent ones (not in fork), plus any the user put in the pack
  const cps = fork ? [] : [latestCheckpoint(p.id)].filter(Boolean);
  const sums = fork ? [] : all(`SELECT * FROM summaries WHERE project_id = ? ORDER BY created_at DESC LIMIT 5`, p.id);
  for (const id of pinnedIds) {
    if (id.startsWith('c-') && !cps.some((c) => c.id === id)) { const c = get('SELECT * FROM checkpoints WHERE id = ?', id); if (c) cps.push(c); }
    if (id.startsWith('s-') && !sums.some((x) => x.id === id)) { const x = get('SELECT * FROM summaries WHERE id = ?', id); if (x) sums.push(x); }
  }
  for (const [i, cp] of cps.entries())
    items.push({ id: cp.id, kind: '@checkpoint', score: (pinnedIds.has(cp.id) ? 10 : 0) + (i ? 1 : 5), reasons: [pinnedIds.has(cp.id) ? 'in pack' : 'latest checkpoint'], text: fmtCheckpoint(cp) });
  for (const [i, sm] of sums.entries())
    items.push({ id: sm.id, kind: '@summary', score: 1 - i * 0.1 + (pinnedIds.has(sm.id) ? 10 : 0), reasons: [pinnedIds.has(sm.id) ? 'in pack' : 'recent session'],
      text: `- ${ago(sm.created_at)} **${sm.title}**: ${clip(sm.body.replace(/\n+/g, ' '), 400)} \`${sm.id}\`` });

  // pass 1: fill each bucket to its share; pass 2: spend leftovers by score
  const chosen = new Set();
  let used = 0;
  const sorted = [...items].sort((a, b) => b.score - a.score);
  for (const [, kinds, share] of BUCKETS) {
    let b = 0;
    for (const it of sorted) if (kinds.includes(it.kind) && !chosen.has(it)) {
      const t = tokens(it.text);
      if (b + t > share * budget || used + t > budget) continue;
      chosen.add(it); b += t; used += t;
    }
  }
  for (const it of sorted) if (!chosen.has(it) && used + tokens(it.text) <= budget) { chosen.add(it); used += tokens(it.text); }

  let out = `# UAC context pack: ${p.name} (tier ${tier}${packRow ? `, pack ${packRow.id}` : ''}, ~${used} tokens)\n` +
    `Memory can be stale: verify critical facts against the code. More: uac_search → uac_get <ids>. Why an item is here: uac_why <id>.\n`;
  for (const [title, kinds] of BUCKETS) {
    const its = sorted.filter((it) => chosen.has(it) && kinds.includes(it.kind));
    if (its.length) out += `\n## ${title}\n${its.map((i) => i.text).join('\n')}\n`;
  }
  const omitted = items.length - chosen.size;
  if (omitted > 0) out += `\n_${omitted} more items not shown (budget). Use uac_search._\n`;
  const ids = [...chosen].map((i) => i.id);
  if (record && s) {
    run('INSERT INTO retrievals(session_id, project_id, goal, item_ids, reasons, tokens, ts) VALUES (?,?,?,?,?,?,?)',
      s.id, p.id, goal, J(ids), J(Object.fromEntries([...chosen].map((i) => [i.id, i.reasons]))), used, now());
    run('UPDATE sessions SET loaded = ?, title = COALESCE(title, ?) WHERE id = ?', J({ tier, pack, goal }), goal ? clip(goal, 80) : null, s.id);
  }
  return { text: out, ids, tier, tokens: used };
}

export function why(projectId, id) {
  const r = all('SELECT * FROM retrievals WHERE project_id = ? ORDER BY id DESC LIMIT 20', projectId)
    .find((x) => P(x.item_ids, []).includes(id));
  return r ? { id, goal: r.goal, reasons: P(r.reasons, {})[id] || [], ts: r.ts } : { id, reasons: ['not in any recent pack'] };
}

// ---------- digest / save (uac-compressor subagent) ----------
export function digest(s, maxChars = 60000) {
  const evs = all(`SELECT * FROM events WHERE session_id = ? AND id > ? AND kind != 'pending' ORDER BY id`, s.id, s.saved_event_id);
  const lines = [];
  let prev = '';
  for (const e of evs) {
    const key = `${e.kind}|${e.tool}|${e.target}`;
    if (key === prev && e.kind === 'tool') continue; // collapse repeated identical tool calls
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
  const existing = all(`SELECT id, type, title FROM memories WHERE (project_id = ? OR project_id IS NULL) AND status IN ('active','proposed','stale')
      ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT 80`, s.project_id);
  return { session_id: s.id, goal: clip(goal, 500), upto_event_id: evs.at(-1)?.id ?? s.saved_event_id, events: text, existing };
}

export function addCheckpoint(s, c, trigger = 'manual') {
  const id = uid('c');
  run(`INSERT INTO checkpoints VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, s.id, s.project_id, now(), trigger,
    clip(c.goal, 500), clip(c.working, 1500), clip(c.broken, 1500), J(c.files || []), J(c.next_steps || []), clip(c.note, 800));
  return id;
}

export function save(s, p, { upto_event_id, summary, checkpoint, candidates = [] }) {
  const res = { summary: null, checkpoint: null, added: 0, updated: 0, conflicts: 0, skipped: 0, errors: [] };
  const raw = get(`SELECT COALESCE(SUM(LENGTH(COALESCE(body,'')) + LENGTH(COALESCE(target,''))), 0) AS n FROM events WHERE session_id = ? AND id > ? AND id <= ?`,
    s.id, s.saved_event_id, upto_event_id ?? 1e15).n;
  if (summary?.title) {
    res.summary = uid('s');
    run('INSERT INTO summaries VALUES (?,?,?,?,?,?,?)', res.summary, s.id, p.id, clip(summary.title, 200), summary.body || '', raw, now());
    run('UPDATE sessions SET title = ? WHERE id = ?', clip(summary.title, 80), s.id);
  }
  if (checkpoint) res.checkpoint = addCheckpoint(s, checkpoint, 'save');
  for (const c of candidates) {
    try {
      const op = c.op || 'add';
      if (op === 'noop') { res.skipped++; continue; }
      if (op === 'update' && c.id && p.mode === 'automatic') {
        S.updateMemory(c.id, { body: c.body, title: c.title, why: c.why, files: c.files }, { by: 'llm', reason: c.why || 'updated by compressor' });
        res.updated++; continue;
      }
      if (op === 'conflict' && c.id) {
        const m = S.propose({ ...c, status: 'conflict' }, { s, p });
        S.relate(m.id, c.id, 'contradicts'); res.conflicts++; continue;
      }
      const m = S.propose(c, { s, p });
      if ((op === 'update' || op === 'supersede') && c.id) {
        S.relate(m.id, c.id, 'supersedes');
        if (m.status === 'active') S.updateMemory(c.id, { status: 'superseded' }, { by: 'llm', reason: `superseded by ${m.id}` });
      }
      res.added++;
    } catch (e) { res.errors.push(`${c.title}: ${e.message}`); }
  }
  if (upto_event_id != null) run('UPDATE sessions SET saved_event_id = MAX(saved_event_id, ?) WHERE id = ?', upto_event_id, s.id);
  try { res.exported = S.exportProjectMd(p); } catch (e) { res.errors.push(`export: ${e.message}`); }
  return res;
}

// Deterministic ≤2KB tiered snapshot before compaction (no LLM).
export function precompactSnapshot(s) {
  const prompts = all(`SELECT body FROM events WHERE session_id = ? AND kind = 'prompt' ORDER BY id`, s.id);
  const files = [...new Set(all(`SELECT target FROM events WHERE session_id = ? AND kind = 'tool' AND target IS NOT NULL ORDER BY id DESC LIMIT 80`, s.id)
    .map((r) => r.target).filter((t) => /[\\/]|\.\w{1,5}$/.test(t) && !/\s/.test(t)))].slice(0, 15);
  const fails = all(`SELECT tool, target FROM events WHERE session_id = ? AND kind = 'tool_fail' ORDER BY id DESC LIMIT 3`, s.id);
  const c = { goal: clip(prompts[0]?.body, 300), files, note: clip(prompts.at(-1)?.body, 400),
    broken: fails.map((f) => `${f.tool} ${f.target || ''}`).join('; '), working: '', next_steps: [] };
  // tiers: goal+last prompt > files > failures; drop lowest first
  while (JSON.stringify(c).length > 2000 && c.files.length) c.files.pop();
  if (JSON.stringify(c).length > 2000) c.broken = '';
  return addCheckpoint(s, c, 'precompact');
}

export function handoff(s, p, name) {
  const top = bootstrap(s, p, { tier: 'deep', record: false });
  const id = uid('p');
  run('INSERT INTO packs VALUES (?,?,?,?,?,?,?,?)', id, p.id, name || `handoff from ${s.id.slice(0, 8)}`,
    s.title || '', TIERS.relevant, J(top.ids), s.id, now());
  return { pack: id, how: `In the other session: uac_bootstrap {pack: "${id}"}, or CLI: uac choose --tier relevant --pack ${id}` };
}

export function createPack(p, s, { name, ids = [], goal, budget_tokens, next }) {
  const id = uid('p');
  run('INSERT INTO packs VALUES (?,?,?,?,?,?,?,?)', id, p.id, name || id, goal || '', budget_tokens || TIERS.relevant, J(ids), s?.id ?? null, now());
  if (next) S.setNextPack(p.id, id);
  return { ...get('SELECT * FROM packs WHERE id = ?', id), item_ids: ids, next: !!next };
}

export const listPacks = (projectId) => {
  const next = S.nextPack(projectId);
  return all('SELECT * FROM packs WHERE project_id = ? ORDER BY created_at DESC', projectId)
    .map((k) => ({ ...k, item_ids: P(k.item_ids, []), next: k.id === next }));
};

export function timeline(p, s, { before = 3, after = 3 } = {}) {
  const sessions = all('SELECT id, agent, started_at, title FROM sessions WHERE project_id = ? ORDER BY started_at', p.id);
  const i = Math.max(0, sessions.findIndex((x) => x.id === s?.id));
  return sessions.slice(Math.max(0, i - before), i + after + 1).map((x) => ({
    ...x,
    summary: get('SELECT id, title, body FROM summaries WHERE session_id = ? ORDER BY created_at DESC LIMIT 1', x.id) || null,
    checkpoint: get('SELECT id, goal, next_steps, note FROM checkpoints WHERE session_id = ? ORDER BY ts DESC LIMIT 1', x.id) || null,
  }));
}
