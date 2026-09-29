// Start context (injected by the hook), session-centric bootstrap, digest/save for the compressor,
// deterministic auto cards and snapshots, merge/rollup, handoff.
import fs from 'node:fs';
import { all, get, run, tx, uid, now, J, P, checkpointWal } from './db.mjs';
import * as S from './store.mjs';
import { changedFiles, tokens, clip, git, defaultBranch, VERSION, semverCmp, claudeInstalled } from './util.mjs';

// Internal budgets (tokens). Users pick sessions, not sizes; `deep` is for explicit "load more" requests.
export const BUDGET = { normal: 2000, deep: 6000 };
export const STOP_THRESHOLD = 40;
const START_MAX = 9000; // hook output cap is 10K chars
const NEAR_EMPTY_TOKENS = 150;
const START_BUDGET = Math.floor((START_MAX - 2600) / 4); // tokens for cards + knowledge so the injected text fits the hook's 10K cap

// The plugin's agent is namespaced. A bare "uac-compressor" is not found and Claude falls back to a general-purpose agent
// on the default model without the compressor's instructions. The uac tools are usually DEFERRED in the subagent: the
// prompt carries the literal ToolSearch step, because a model that doesn't load them first "can't find" them and gives up.
export const COMPRESSOR = 'universal-agent-context:uac-compressor';
const TOOL_SELECT = 'select:mcp__plugin_universal-agent-context_uac__uac_digest,mcp__plugin_universal-agent-context_uac__uac_save';
export const compressorPrompt = (sid) => `session_id=${sid}. Step 0: ToolSearch "${TOOL_SELECT}" (if nothing is found: ToolSearch "uac_digest"). Step 1: uac_digest({session_id:"${sid}"}). Step 2: one uac_save as its how_to_save says. Reply with one line starting "UAC saved:".`;
// SubagentStop sends a compressor that stopped without "UAC saved:" back once, with the steps it most likely skipped
export const COMPRESSOR_RETRY = `You have not saved yet. Step 0: ToolSearch "${TOOL_SELECT}" (if nothing is found: ToolSearch "uac_digest"); the tools exist even if you did not see them. Step 1: uac_digest with the session_id from your task. Step 2: one uac_save as its how_to_save says (git is not needed). Then reply with one line starting "UAC saved:".`;
export const saveInstruction = (sid, host = 'claude') => host === 'claude'
  ? `[UAC] Save requested. Spawn a subagent (Agent tool, foreground): subagent_type "${COMPRESSOR}" (or "uac-compressor" if that is how it is listed), model "haiku", prompt "${compressorPrompt(sid)}" (a subagent keeps the digest out of this conversation). Its reply must start with "UAC saved:"; if it doesn't, or the agent/model is unavailable, call uac_digest({session_id:"${sid}"}) yourself and follow how_to_save. Then continue.`
  : `[UAC] Save requested: call uac_digest({session_id:"${sid}"}) and follow its how_to_save (one uac_save call), in a subagent if you have one. Then continue.`;

export const ago = (iso) => {
  if (!iso) return '';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const base = (f) => String(f).split(/[\\/]/).pop();
// freshness mark as the reader needs it: what to open (⚠), and why ✗ (a gone file's look-alikes are not evidence)
function fresh(m, root) {
  const f = m.freshness || {};
  if (f.state === 'changed') return `⚠ changed since verified${f.changed?.length ? `: ${f.changed.slice(0, 3).map(base).join(', ')}` : ''}${f.commits_since ? ` (${f.commits_since} commit${f.commits_since === 1 ? '' : 's'})` : ' (uncommitted)'}, check it`;
  if (f.state === 'missing') {
    if (f.reason === 'symbol') return '✗ anchored symbol no longer in its file: check it, then update or retire';
    const h = S.anchorHints(root, m.anchors, { existing: true }).find((x) => /same-named/.test(x));
    return `✗ anchored file gone${h ? `; ${h.replace(/^anchored file \S+ no longer exists; /, '')}` : ''}`;
  }
  return f.state === 'verified' ? '✓' : '(no anchor)';
}

function fmtCard(c, meta, { commits } = {}) {
  const L = [`### ${meta}`];
  if (c.title) L.push(`**${c.title}**${c.quality === 'auto' ? ' _(auto card from recorded events, no LLM summary yet)_' : c.events_n ? ` _(from ${c.events_n} events)_` : ''}`);
  // work recorded AFTER this card was written is the current state: shown first, and the card's Next may already be done
  if (c.tail) L.push(`Current state (after this card, unsaved, ${ago(c.tail.at)}): ${[c.tail.goal && `last request "${clip(c.tail.goal, 160)}"`, c.tail.note && `last result "${clip(c.tail.note, 200)}"`, c.tail.files?.length && `files ${c.tail.files.slice(0, 6).join(', ')}`].filter(Boolean).join('; ')}`);
  if (c.body) L.push(clip(c.body.replace(/\n{2,}/g, '\n'), 700));
  if (c.working) L.push(`Working: ${clip(c.working, 300)}`);
  if (c.broken) L.push(`Broken/open: ${clip(c.broken, 300)}`);
  if (c.next_steps?.length) L.push(`Next${c.tail ? ' (from the card; may be done already, see Current state)' : ''}: ${c.next_steps.slice(0, 6).join('; ')}`);
  if (c.files?.length) L.push(`Files: ${c.files.slice(0, 12).join(', ')}`);
  if (c.note) L.push(`Note for next dev: ${clip(c.note, 300)}`);
  if (c.gaps) L.push(`Not in this card (verify in code before relying on it): ${clip(c.gaps, 300)}`);
  if (commits?.length) L.push(`Commits since this card: ${commits.slice(0, 5).join(' · ')}`);
  return L.join('\n');
}
// Human/LLM label for a session: its card/title, else what little we know, always with age.
export const sessionLabel = (x, n = 50) =>
  `${clip(x.card?.title || x.title || `${x.agent} session, ${x.events} event${x.events === 1 ? '' : 's'}, no card`, n)} (${ago(x.last_active || x.started_at)})`;
// repo-relative path for cards (tool targets are often absolute)
const rel = (root, f) => {
  const r = String(root || '').replace(/\\/g, '/').replace(/\/$/, '') + '/', x = String(f).replace(/\\/g, '/');
  return root && x.toLowerCase().startsWith(r.toLowerCase()) ? x.slice(r.length) : x;
};
const GROUPS = [['decision', 'Decisions'], ['warning', 'Warnings'], ['lesson', 'Lessons'], ['architecture', 'Architecture'],
  ['fact', 'Facts'], ['task', 'Open tasks'], ['preference', 'Preferences (apply only where stated)']];
const cardMeta = (s, x) => `${x ? `${S.ref(x)} · ` : ''}${s.branch || 'no-branch'} · ${s.agent}${s.model ? ` (${s.model})` : ''} · ${ago(x?.last_active || s.started_at)}`;
// (1–2 unsaved events after a save are its closing reply: not worth a mention)
const state = (x, selfId) => `${x.id === selfId ? 'this session' : x.live ? 'live in another window' : x.status === 'ended' ? 'ended' : 'idle'}, ${x.card ? (x.card.quality === 'auto' ? 'auto card' : 'saved card') : 'no card'}${x.unsaved >= 3 || (x.unsaved && !x.card) ? `, ${x.unsaved} unsaved` : ''}${x.raw ? '' : ', no raw log'}`;
const hasContent = (c) => c && (c.title || c.body || c.working || c.next_steps?.length);

// ---------- bootstrap: project knowledge + chosen session cards + other branches + messages ----------
// Returns the text plus `loaded`: ONE line saying what was loaded, what was not, and the exact calls to widen it.
export function bootstrap(s, p, opts = {}) {
  let { sessions = [], goal = '', depth, fresh: freshStart = false, record = true } = opts;
  // choices made outside the chat (dashboard / extension / CLI): one-shot
  const choice = P(s?.choice, null);
  if (choice && s) {
    run('UPDATE sessions SET choice = NULL WHERE id = ?', s.id);
    if (choice.capture) S.setCapture(s.id, choice.capture);
    if (choice.sessions) sessions = [...sessions, ...choice.sessions];
  }
  // one-shot picks are consumed at the session's first real prompt (hook), not here: a phantom session from a window
  // reload must not eat the user's "continue from #3 next time"
  let oneShot = false;
  if (record && !sessions.length && !freshStart) {
    const next = S.nextSessions(p.id);
    if (next.length) { sessions = next; oneShot = true; }
  }
  sessions = S.resolveSessionRefs(p.id, sessions);
  const budget = opts.budget_tokens || BUDGET[depth === 'deep' ? 'deep' : 'normal'];
  const numbered = S.listSessions(p.id, { limit: 200 });
  const byId = new Map(numbered.map((x) => [x.id, x]));

  // 1. session cards: chosen ones, else the most recently ACTIVE session on this branch that has content (a card, or
  //    unsaved work in another window), not only the last saved one
  let defaulted = false;
  if (!sessions.length && !freshStart) {
    const latest = numbered.filter((x) => x.id !== s?.id && (x.branch === p.branch || !p.branch) && (hasContent(x.card) || x.unsaved >= 3))
      .sort((a, b) => String(b.last_active).localeCompare(String(a.last_active)))[0];
    if (latest) { sessions = [latest.id]; defaulted = true; }
  }
  // loaded sessions whose work isn't in a card yet get a deterministic one (no LLM) so the reader sees it
  for (const id of sessions) {
    const x = byId.get(id), ss = S.session(id);
    if (!ss || id === s?.id) continue;
    const c = S.card(id);
    if (!hasContent(c) && S.unsavedCount(ss) >= 1) autoCard(ss);
    else if (c && c.quality !== 'auto' && (x?.unsaved ?? 0) >= 3 && String(x.last_active) > String(c.tail?.at || c.at)) snapshot(ss, 'tail');
  }
  const cards = sessions.map((id) => ({ s: S.session(id), c: S.card(id), x: byId.get(id) })).filter((x) => x.s && x.c);

  // 2. knowledge
  const hits = new Map(goal ? S.search(p.id, goal, { limit: 60 }).map((m, i) => [m.id, 1 - i / 60]) : []);
  const changed = changedFiles(p.root).map((f) => f.replace(/\\/g, '/'));
  const mems = S.freshness(p, all(`SELECT * FROM memories WHERE (project_id = ? OR project_id IS NULL) AND status IN ('active','stale')
      AND muted = 0 AND type != 'idea' AND (scope != 'branch' OR branch = ?)
      AND id NOT IN (SELECT r.b FROM memory_relations r JOIN memories x ON x.id = r.a WHERE r.rel = 'supersedes' AND x.scope = 'branch'
        AND x.branch = ? AND x.status IN ('active','stale'))`, p.id, freshStart ? '__none__' : p.branch ?? '', p.branch ?? '').map(S.hydrate));
  // (on a branch, a project memory that this branch has a newer version of is shown only as that version)
  const items = mems.map((m) => {
    let score = 0;
    if (hits.has(m.id)) score += hits.get(m.id);
    const files = [...m.files, ...m.anchors.map((a) => a.file)];
    if (files.some((f) => changed.some((c) => c.endsWith(f) || f.endsWith(c)))) score += 0.8;
    if (m.scope === 'branch') score += 0.5;
    score += 0.4 * S.decayed(m) + 0.3 * m.confidence;
    if (m.pinned) score += 0.6;
    if (m.status === 'stale' || m.freshness.state === 'missing') score -= 0.8;
    const anc = S.fmtAnchors(m);
    const f = fresh(m, p.root);
    const tag = m.scope === 'branch' ? `[branch ${m.branch}] ` : m.scope === 'user' || m.project_id == null ? '[all projects] ' : '';
    const age = m.type === 'task' ? ` (open ${Math.max(0, Math.round((Date.now() - Date.parse(m.created_at)) / 864e5))}d)` : '';
    const text = `- ${tag}**${m.title}**${age}: ${m.body.replace(/\n+/g, ' ')}${m.why ? ` (why: ${m.why})` : ''}${anc ? ` · \`${anc}\`` : ''}${f ? ` ${f}` : ''}${m.source_model ? ` _(by ${m.source_model})_` : ''} \`${m.id}\``;
    return { id: m.id, kind: m.type, score, text };
  });
  const must = items.filter((i) => ['requirement', 'constraint'].includes(i.kind)).sort((a, b) => b.score - a.score);
  const know = items.filter((i) => !['requirement', 'constraint'].includes(i.kind)).sort((a, b) => b.score - a.score);

  // 3. other active branches (parallel work awareness). A branch whose tip is behind HEAD and contained in it was merged here.
  // ponytail: a fresh branch cut from an older commit also looks "merged"; fast-forward merges look "active". Session status would refine this.
  const head = git(p.root, 'rev-parse', 'HEAD');
  const merged = p.branch ? new Set(git(p.root, 'branch', '--merged', 'HEAD', '--format=%(refname:short) %(objectname)').split(/\r?\n/)
    .map((l) => l.split(' ')).filter(([b, sha]) => b && sha !== head).map(([b]) => b)) : new Set();
  const others = p.branch ? all(`SELECT s.branch, MAX(s.started_at) AS at FROM sessions s WHERE s.project_id = ? AND s.branch IS NOT NULL
      AND s.branch != ? AND s.started_at >= ? GROUP BY s.branch ORDER BY at DESC LIMIT 8`, p.id, p.branch, new Date(Date.now() - 14 * 864e5).toISOString())
    .sort((a, b) => merged.has(a.branch) - merged.has(b.branch)).slice(0, 5)
    .map((b) => {
      const latest = numbered.find((x) => x.branch === b.branch);
      const c = latest?.card;
      return `- \`${b.branch}\`${merged.has(b.branch) ? ` (merged into \`${p.branch}\`)` : ''}: ${latest ? `${S.ref(latest)} ` : ''}${c?.title ? `"${clip(c.title, 90)}"` : latest?.title ? `"${clip(latest.title, 90)}"` : '(no card yet)'} · ${latest?.agent || ''} · ${ago(b.at)}${c?.files?.length ? ` · files: ${c.files.slice(0, 5).join(', ')}` : ''}`;
    }) : [];

  // 4. messages for this session/branch: rendered before the knowledge, so no budget or clip can drop one that is marked read
  const msgs = s && record ? S.unreadMessages(s) : [];
  const from = (m) => { const x = m.from_session && byId.get(m.from_session); return `${m.from_agent}${x ? ` ${S.ref(x)}` : ''}${m.from_branch ? ` on \`${m.from_branch}\`` : ''}`; };

  // assemble within budget: cards ≤45%, must-not-violate ≤15%, then knowledge
  let used = 0;
  const take = (text, cap) => { const t = tokens(text); if (used + t > cap) return false; used += t; return true; };
  const cardTexts = [];
  // one git call for "commits since this card" across all loaded cards (humans commit between agent sessions)
  const oldest = cards.map((x) => x.c.at).filter(Boolean).sort()[0];
  const log = oldest ? git(p.root, 'log', `--since=${oldest}`, '--max-count=30', '--format=%h %cI %s').split(/\r?\n/).filter(Boolean)
    .map((l) => { const [h, d, ...m] = l.split(' '); return { at: Date.parse(d), text: `${h} ${clip(m.join(' '), 60)}` }; }) : [];
  const loadedCards = [];
  for (const { s: cs, c, x } of cards) {
    const parents = (P(cs.loaded, {})?.sessions || []).map((id) => byId.get(id)).filter(Boolean);
    const live = x && x.live ? ` · LIVE in another window${c.quality === 'auto' ? ' (its unsaved work, as an auto card)' : ''}` : '';
    const meta = cardMeta(cs, x) + live + (parents.length ? ` · continues ${parents.map(S.ref).join(', ')}` : '');
    const t = fmtCard(S.card(cs.id), meta, { commits: log.filter((l) => l.at > Date.parse(c.at)).map((l) => l.text) });
    if (take(t, budget * 0.45) || !cardTexts.length) { cardTexts.push(t); loadedCards.push(x || { id: cs.id, seq: cs.seq }); }
  }
  const mustTexts = [], knowTexts = [];
  const maxItems = opts.limit > 0 ? opts.limit : Infinity;
  for (const i of must) if (mustTexts.length < maxItems && take(i.text, used + budget * 0.15)) mustTexts.push(i);
  for (const i of know) if (mustTexts.length + knowTexts.length < maxItems && take(i.text, budget)) knowTexts.push(i);

  const mode = p.mode || 'first run';
  const cur = s && S.session(s.id);
  let out = `# UAC · ${p.name} · branch \`${p.branch || '-'}\` · mode ${mode} · ${cur ? `${cur.capture === 'on' ? 'recording ON' : 'not recording'} · this session ${cur.seq ? `#${cur.seq} ` : ''}${S.shortId(cur.id)} (session_id=${cur.id})` : ''}\n` +
    `Memory = claims, not facts: ✓ matches the code at its anchor · ⚠ file changed since · ✗ anchor gone · (no anchor) can't be checked. Check one only when your task touches it, at its anchored path (relative to the project root); then uac_verify {ids} or uac_update.\n`;
  const knowledgeTokens = [...mustTexts, ...knowTexts].reduce((a, i) => a + tokens(i.text), 0);
  if (!cards.length && knowledgeTokens < NEAR_EMPTY_TOKENS)
    out += `\n> UAC knows almost nothing about this project yet. To build project knowledge, run the uac-init-knowledge skill ("survey this codebase for UAC") or /universal-agent-context:uac init.\n`;
  if (cardTexts.length) out += `\n## Continuing from${defaulted ? ' (most recent session on this branch)' : ''}\n${cardTexts.join('\n\n')}\n`;
  if (msgs.length) {
    out += `\n## Messages for you (reply: uac_message {to:"session:<id>", text})\n${msgs.map((m) => `- from ${from(m)} (${ago(m.created_at)}): ${m.text}`).join('\n')}\n`;
    // a session nobody typed in yet (a window reload) must not consume them: they are marked read at its first prompt
    if ((cur?.prompts || 0) > 0) S.markRead(s, msgs);
  }
  if (mustTexts.length) out += `\n## Must not violate\n${mustTexts.map((i) => i.text).join('\n')}\n`;
  // chosen by score within the budget, shown grouped by type so the reader knows a decision from a task from a preference
  if (knowTexts.length) {
    out += `\n## Project knowledge\n`;
    for (const [type, label] of GROUPS) {
      const g = knowTexts.filter((i) => i.kind === type);
      if (g.length) out += `### ${label}\n${g.map((i) => i.text).join('\n')}\n`;
    }
  }
  if (others.length) out += `\n## Other active branches (parallel work)\n${others.join('\n')}\n`;

  // what was NOT loaded, and the exact call to get it: the reader can tell "complete" from "a slice"
  const omitted = items.length - mustTexts.length - knowTexts.length;
  const loadedIds = new Set(loadedCards.map((x) => x.id));
  const notLoaded = numbered.filter((x) => x.id !== s?.id && !loadedIds.has(x.id) && (hasContent(x.card) || x.unsaved >= 3));
  const rawRef = loadedCards.find((x) => x.raw) || null;
  const wider = [omitted > 0 && `uac_bootstrap{depth:"deep"} (+${omitted} knowledge items)`, notLoaded.length && `uac_bootstrap{sessions:["${S.ref(notLoaded[0]).split(' ')[0]}"]}`,
    rawRef && `uac_get{ids:["${S.ref(rawRef).split(' ')[0]}"], raw:true} (exact history)`].filter(Boolean);
  const loaded = `Loaded ~${used} tok: ${loadedCards.length ? loadedCards.map((x) => `card ${S.ref(x)}`).join(' + ') : 'no session card'} + ${mustTexts.length + knowTexts.length}/${items.length} knowledge items. ` +
    (notLoaded.length || omitted > 0
      ? `Not loaded: ${[notLoaded.slice(0, 4).map((x) => `${S.ref(x)} "${clip(x.title || x.card?.title || x.agent, 40)}" (${state(x)})`).join(' · ') + (notLoaded.length > 4 ? ` · +${notLoaded.length - 4} more (uac_sessions)` : ''), omitted > 0 && `${omitted} knowledge items`].filter(Boolean).join('; ')}. Wider: ${wider.join(' · ')}`
      : `Nothing else stored.${rawRef ? ` Exact history: uac_get{ids:["${S.ref(rawRef).split(' ')[0]}"], raw:true}` : ''}`);

  if (record && s) run('UPDATE sessions SET loaded = ? WHERE id = ?', J({ sessions: cards.map((x) => x.s.id), checkpoints: cards.map((x) => x.c.checkpoint_id).filter(Boolean), goal, depth, fresh: freshStart, one_shot: oneShot, msgs: msgs.map((m) => m.id) }), s.id);
  return { text: out, loaded, tokens: used, cards: cards.length, knowledge: mustTexts.length + knowTexts.length };
}

// ---------- version consistency (hooks vs installed plugin vs MCP server) ----------
// Running sessions keep the old hooks and MCP server until /reload-plugins or a restart, and a second install source (the
// VS Code extension's bundle) can serve the MCP server from another version. Each process stamps its own version on the
// session it serves; any mismatch, or a newer installed version, is said once in plain words. A plugin cannot run
// /reload-plugins itself: the reader tells the user.
export function versionNotes(s, host) {
  const out = [];
  const inst = host === 'claude' ? claudeInstalled() : null;
  if (inst && semverCmp(inst.version, VERSION) > 0)
    out.push(`⚠ UAC ${inst.version} is installed but this session still runs ${VERSION}. Tell the user: type /reload-plugins (or restart the session) to use ${inst.version}.`);
  const cur = S.session(s.id);
  if (cur?.mcp_version && cur.mcp_version !== VERSION)
    out.push(`⚠ This session's UAC MCP server runs ${cur.mcp_version} but its hooks run ${VERSION}. Tell the user: /reload-plugins or restart the session (\`uac doctor\` shows both paths).`);
  return out;
}

// Another session of this project, not live, with ≥10 unsaved events nobody was asked to save yet (tiny ones keep their
// auto card: not worth a Haiku call).
export const OTHER_SAVE_MIN = 10;
export function pendingOther(p, s) {
  return S.listSessions(p.id, { limit: 30 }).find((x) => x.id !== s.id && x.unsaved >= OTHER_SAVE_MIN && !x.live
    && (S.session(x.id).save_asked || 0) < (get('SELECT MAX(id) AS m FROM events WHERE session_id = ?', x.id).m || 0)) || null;
}

// ---------- start context injected by the hook (no questions unless first run) ----------
export function startContext(s, p, { source } = {}) {
  S.maintain(p);
  S.purgePhantoms(p.id, s.id);
  if (p.mode === 'off') return `[UAC is off for "${p.name}". Type "#uac on" to record this session, or run "uac mode manual" to load context again.]`;
  // other sessions' unsaved work (live in another window, ended, or closed without SessionEnd) gets a deterministic card
  // or tail now (no LLM), so it is visible to this session and nothing is lost
  for (const u of S.unsavedSessions(p.id, s.id)) {
    const us = S.session(u.session_id);
    const idle = u.status === 'ended' || Date.now() - Date.parse(u.last_ts) > S.IDLE_MS;
    if (!idle) continue; // a live window saves itself; if the default pick loads it, bootstrap builds its auto card then
    const c = S.card(us.id);
    if (u.quality !== 'llm') { if (!c || String(c.at) < String(u.last_ts)) autoCard(us); } // up-to-date auto cards are left alone (git calls cost time at start)
    else if (idle && !get(`SELECT 1 AS x FROM checkpoints WHERE session_id = ? AND trigger IN ('tail','precompact') AND ts >= ?`, us.id, u.last_ts)) snapshot(us, 'tail');
  }
  let b;
  if (source === 'compact' && s.loaded) {
    const l = P(s.loaded, {});
    b = bootstrap(s, p, { sessions: l.sessions, goal: l.goal, depth: l.depth, fresh: l.fresh, record: false });
    b.text = `[UAC] Context was compacted; re-loaded below.\n\n${b.text}`;
    // this session's own saved card (the compacted conversation included it) + the snapshot of what came after it
    const mine = S.card(s.id);
    if (mine && mine.quality !== 'auto' && mine.summary_id) b.text += `\n## This session so far (its saved card)\n${fmtCard({ ...mine, tail: null }, 'this session')}\n`;
    const snap = get(`SELECT * FROM checkpoints WHERE session_id = ? AND trigger = 'precompact' ORDER BY ts DESC LIMIT 1`, s.id);
    if (snap) b.text += `\n## ${mine?.summary_id ? 'Since that card' : 'Pre-compaction snapshot'} (unsaved)\n${fmtCard({ title: snap.goal, broken: snap.broken, files: P(snap.files, []), next_steps: P(snap.next_steps, []), note: snap.note }, 'this session')}`;
  } else b = bootstrap(s, p, { budget_tokens: START_BUDGET });

  const L = [...versionNotes(s, s.agent)];
  if (!p.mode) L.push(`UAC first run in this project. Ask the user ONCE (AskUserQuestion if available): should UAC be "automatic" (load context + record + auto-save), "manual" (load context, record only after #uac on) or "off"? Then call uac_capture {session_id: "${s.id}", mode, state: "on" for automatic else "off"}. Until then nothing is recorded.`);
  else if (p.mode === 'manual' && S.session(s.id).capture !== 'on') L.push('Recording is off (manual mode). The user can type "#uac on".');
  // resumed sessions: say what UAC holds for THIS session (saved card? unsaved work since when?) and what resuming costs
  if (source === 'resume') {
    const mine = S.card(s.id), unsavedMine = S.unsavedCount(s);
    const since = unsavedMine ? get(`SELECT MIN(ts) AS t FROM events WHERE session_id = ? AND id > ? AND kind != 'pending'`, s.id, s.saved_event_id).t : null;
    if (mine && mine.quality !== 'auto') L.push(`This session was saved before ("${clip(mine.title, 60)}"). New work is recorded in the same session; the next save UPDATES that same card (it covers the whole session).`);
    if (unsavedMine) L.push(`This session has ${unsavedMine} unsaved event(s) since ${ago(since)}${mine?.quality === 'auto' ? ' (only an auto card so far)' : ''}. "#uac save" writes/updates its card.`);
    let bytes = 0;
    try { bytes = s.transcript_path ? fs.statSync(s.transcript_path).size : 0; } catch {}
    const est = Math.round(bytes / 4 / 3); // transcript JSONL is ~3x the text it carries
    if (est > 20000) L.push(`Tip for the user: resuming reloaded this whole conversation (~${Math.round(est / 1000)}K tokens, re-billed unless the prompt cache is still warm). Next time: start a new session and type "#uac continue <n>" to load this session's card (~2K tokens) instead.`);
  }
  const uncaptured = get(`SELECT COUNT(*) AS n FROM sessions WHERE project_id = ? AND id != ? AND capture IN ('off','ask') AND transcript_path IS NOT NULL
      AND started_at >= ? AND NOT EXISTS (SELECT 1 FROM summaries x WHERE x.session_id = sessions.id)`, p.id, s.id, new Date(Date.now() - 3 * 864e5).toISOString()).n;
  if (uncaptured && p.mode) L.push(`${uncaptured} recent session(s) ran without recording; "uac import <n>" can recover one from its transcript.`);
  // another session ended with unsaved work (short sessions never reach the Stop-hook threshold, and SessionEnd can't make
  // an LLM act). automatic: this session's first Stop saves it (a hook block is followed; a "when convenient" note was not).
  // manual: tell the user once.
  const pending = pendingOther(p, s);
  if (pending && p.mode !== 'automatic') {
    L.push(`Session ${S.ref(pending)} "${clip(pending.title || pending.card?.title || '', 50)}" isn't fully saved (${pending.card?.quality === 'llm' ? `${pending.unsaved} events after its last save` : 'auto card only'}). Tell the user once: "#uac save ${pending.n}" writes a full card; the dashboard can delete it instead.`);
    run('UPDATE sessions SET save_asked = (SELECT MAX(id) FROM events WHERE session_id = ?) WHERE id = ?', pending.id, pending.id);
  }
  L.push(b.loaded);
  if (p.mode === 'automatic') L.push('Saving is automatic: when it is time, the Stop hook tells you to spawn the compressor subagent. Do not call uac_digest/uac_save yourself unless that instruction says so.');
  else if (p.mode === 'manual') L.push('Saving: only when the user types "#uac save" (then spawn the compressor subagent as instructed).');
  L.push(`User controls (typed at the start of a line; "uac: …" in Claude Code): #uac continue <n> | fresh | deep | save [n] | name <title> | off.`);
  // the notes and the loaded line must survive the 10K cap; the knowledge (last in the text) is what gets trimmed
  const tail = L.join('\n');
  const room = Math.max(1000, START_MAX - tail.length - 1);
  const text = b.text.length <= room ? b.text : `${b.text.slice(0, b.text.lastIndexOf('\n', room - 60))}\n_(cut to fit: more via uac_bootstrap)_`;
  return `${text}\n${tail}`;
}

// ---------- digest / save (uac-compressor subagent) ----------
// Working tree vs the commit the session started at (covers subagent edits that never appear as events). UAC's own export
// (.context/) is not work. The tree is shared: edits from another open window on this checkout show up here too.
function diffSince(p, commit) {
  if (!commit) return { stat: '', files: [] };
  const X = ['--', '.', ':(exclude).context'];
  const stat = git(p.root, 'diff', '--stat', commit, ...X);
  const files = git(p.root, 'diff', '--name-only', commit, ...X).split('\n').filter(Boolean);
  const untracked = git(p.root, 'ls-files', '--others', '--exclude-standard', ...X).split('\n').filter(Boolean).slice(0, 30);
  const text = [stat, untracked.length ? `untracked: ${untracked.join(', ')}` : ''].filter(Boolean).join('\n');
  return { stat: text ? clip(`(working tree vs session start; may include edits from other windows on this checkout)\n${text}`, 3000) : '', files: [...files, ...untracked] };
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
    else if (e.kind === 'card') lines.push(`PREVIOUS SESSION CARD (merge/rollup, combine into one):\n${clip(e.body, 2500)}`);
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
  // saved before and continued (same session): the new card must cover the WHOLE session, so hand over the current card
  const prevCard = S.card(s.id);
  const previous_card = prevCard && prevCard.quality !== 'auto' ? { title: prevCard.title, body: prevCard.body, working: prevCard.working, broken: prevCard.broken, next_steps: prevCard.next_steps, files: prevCard.files, note: prevCard.note } : null;
  // open tasks are reconciled every save (not only when their anchors changed): finished work must close its task
  const open_tasks = all(`SELECT id, title, body FROM memories WHERE project_id = ? AND type = 'task' AND status IN ('active','stale') ORDER BY updated_at DESC LIMIT 10`, s.project_id)
    .map((m) => ({ ...m, body: clip(m.body, 200) }));
  return { session_id: s.id, branch: s.branch, goal: clip(goal || prevCard?.goal || s.title || '', 500),
    base_event_id: s.saved_event_id, upto_event_id: evs.at(-1)?.id ?? s.saved_event_id,
    events: text, diff_stat: d.stat, recheck, open_tasks, duplicates: duplicates(s.project_id), existing, previous_card,
    how_to_save: HOW_TO_SAVE,
    instructions: previous_card ? 'This session was saved before and then continued. Write the summary and checkpoint as ONE updated card for the whole session: keep what still holds from previous_card, add the new work, drop what is done or no longer true.' : undefined };
}

// Self-contained recipe: whoever calls uac_digest (the compressor, a general-purpose agent, another host's main agent) can save.
const HOW_TO_SAVE = [
  'Make ONE uac_save call: {session_id, base_event_id, upto_event_id (copy all three from this digest), model: <your model id>,',
  '  summary:{title: verb+object+outcome with the main path, body: plain prose, ~200 words, longer only if many decisions} (required),',
  '  checkpoint:{goal, working, broken, files:[], next_steps:[], note: what I\'d tell the next dev, gaps: what you left out or did not verify} (required: goal, and next_steps or note),',
  '  candidates:[{op: add|update|supersede|conflict|verify|done|noop, id? (ids:[…] with supersede merges duplicates into one), type, title, body, why?, anchors:[{file,symbol,line}], confidence}]}',
  'One candidate per recheck item (verify/update/supersede); op "done" for each open_task this session finished; merge real duplicates; durable knowledge only, no secrets. Git is not required. An incomplete card is refused and nothing is deleted.',
].join('\n');

// Same-type memories whose words overlap strongly, clustered (a–b, b–c → one group): the reviewer merges each group into one.
// ponytail: O(n²) Jaccard over ≤300 active memories; switch to FTS neighbours if stores get far bigger
export function duplicates(projectId, min = 0.7) {
  const ms = all(`SELECT id, type, title, body FROM memories WHERE (project_id = ? OR project_id IS NULL) AND status IN ('active','stale') ORDER BY updated_at DESC LIMIT 300`, projectId)
    .map((m) => ({ ...m, w: S.words(m) }));
  const parent = new Map(ms.map((m) => [m.id, m.id]));
  const find = (x) => (parent.get(x) === x ? x : find(parent.get(x)));
  for (let i = 0; i < ms.length; i++)
    for (let j = i + 1; j < ms.length; j++)
      if (ms[i].type === ms[j].type && S.jaccard(ms[i].w, ms[j].w) >= min) parent.set(find(ms[j].id), find(ms[i].id));
  const groups = new Map();
  for (const m of ms) { const r = find(m.id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(m); }
  return [...groups.values()].map((g) => g.filter((m, i) => i === 0 || S.jaccard(g[0].w, m.w) >= min)).filter((g) => g.length > 1 && g.length <= 6)
    .slice(0, 10).map((g) => ({ ids: g.map((m) => m.id), type: g[0].type, titles: g.map((m) => m.title) }));
}

export function addCheckpoint(s, c, trigger = 'manual') {
  const id = uid('c');
  run(`INSERT INTO checkpoints(id, session_id, project_id, ts, trigger, goal, working, broken, files, next_steps, note, gaps) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, s.id, s.project_id, now(), trigger, clip(c.goal, 500), clip(c.working, 1500), clip(c.broken, 1500), J(c.files || []), J(c.next_steps || []), clip(c.note, 800),
    clip(Array.isArray(c.gaps) ? c.gaps.join('; ') : c.gaps, 600));
  return id;
}

// A card that will replace the raw events must be a real card: a weak model's malformed call (strings instead of objects,
// no title, no next step) is refused BEFORE anything is written or deleted, with the exact shape to retry with.
function invalidCard(summary, checkpoint) {
  const obj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const problems = [];
  if (!obj(summary) || !String(summary.title || '').trim()) problems.push('summary must be an object with a title (and body)');
  if (!obj(checkpoint)) problems.push('checkpoint must be an object');
  else if (!String(checkpoint.goal || '').trim() || !(checkpoint.note || (Array.isArray(checkpoint.next_steps) && checkpoint.next_steps.length)))
    problems.push('checkpoint needs goal plus next_steps or note');
  return problems.length ? `uac_save refused, nothing written or deleted: ${problems.join('; ')}. Retry with summary:{title, body}, checkpoint:{goal, working, broken, files:[], next_steps:[], note, gaps}.` : null;
}
const KEEP_TURNS = 10; // raw prompt/assistant turns kept after a save (not injected): the fallback raw log when the host transcript is gone

export function save(s, p, { base_event_id, upto_event_id, summary, checkpoint, candidates = [], model }) {
  // knowledge is scoped to the SESSION's branch, not to whatever the checkout is on when the save runs
  p = { ...p, branch: s.branch ?? null };
  const res = { summary: null, checkpoint: null, added: 0, updated: 0, verified: 0, done: 0, conflicts: 0, pending_review: 0, skipped: 0, events_removed: 0, errors: [], warnings: [] };
  const bad = invalidCard(summary, checkpoint);
  if (bad) throw new Error(bad);
  // another save of this session landed after our digest (two windows, or a background compressor + "#uac save"): its card
  // already covers these events; writing ours too would duplicate the card and every candidate
  if (base_event_id != null && s.saved_event_id > Number(base_event_id))
    return { ...res, skipped_reason: 'already saved by another run after this digest; nothing written (call uac_digest again if there is newer work)' };
  // never mark beyond the last real event: a wrong/huge upto_event_id would hide all future work as "saved"
  const lastId = get('SELECT MAX(id) AS m FROM events WHERE session_id = ?', s.id).m ?? s.saved_event_id;
  const upto = Math.min(Number(upto_event_id ?? lastId), lastId);
  const raw = get(`SELECT COALESCE(SUM(LENGTH(COALESCE(body,'')) + LENGTH(COALESCE(target,''))), 0) AS n FROM events WHERE session_id = ? AND id > ? AND id <= ?`,
    s.id, s.saved_event_id, upto).n;
  // an LLM save replaces this session's auto card
  run(`DELETE FROM summaries WHERE session_id = ? AND quality = 'auto'`, s.id);
  run(`DELETE FROM checkpoints WHERE session_id = ? AND trigger = 'auto'`, s.id);
  res.summary = uid('s');
  // events this card covers, cumulative across saves of the same session (the card replaces the previous one)
  const prev = S.card(s.id);
  const covered = (prev?.quality === 'llm' ? prev.events_n || 0 : 0)
    + get(`SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND id > ? AND id <= ? AND kind != 'pending'`, s.id, s.saved_event_id, upto).n;
  run('INSERT INTO summaries(id, session_id, project_id, title, body, raw_chars, created_at, quality, model, events_n) VALUES (?,?,?,?,?,?,?,?,?,?)',
    res.summary, s.id, p.id, clip(summary.title, 200), summary.body || '', raw, now(), 'llm', model ?? null, covered);
  run('UPDATE sessions SET title = ? WHERE id = ?', clip(summary.title, 120), s.id);
  res.checkpoint = addCheckpoint(s, checkpoint, 'save');
  // consolidation: this card supersedes older checkpoints of this session and the ones it loaded on the same branch
  const loaded = P(s.loaded, {}).checkpoints || [];
  run(`UPDATE checkpoints SET superseded_by = ? WHERE id != ? AND superseded_by IS NULL AND (session_id = ?
       OR (id IN (SELECT value FROM json_each(?)) AND session_id IN (SELECT id FROM sessions WHERE branch IS ?)))`,
    res.checkpoint, res.checkpoint, s.id, J(loaded), s.branch);
  // on a feature branch, project knowledge is not rewritten with facts that exist only on this branch: the change becomes a
  // branch version that replaces the original when the branch is merged (store.promoteBranches)
  const onBranch = !!(s.branch && s.branch !== defaultBranch(p.root));
  for (const c of candidates) {
    try {
      const op = c.op || 'add';
      if (op === 'noop') { res.skipped++; continue; }
      for (const id of [c.id, ...(c.ids || [])].filter(Boolean)) S.ownMemory(id, p.id); // never touch another project's memory
      const target = c.id && S.memory(c.id);
      if (onBranch && (op === 'update' || op === 'supersede') && target?.scope === 'project') {
        const m = S.propose({ ...c, type: c.type || target.type, title: c.title || target.title, body: c.body ?? target.body, anchors: c.anchors || target.anchors, scope: 'branch' }, { s, p, model });
        S.relate(m.id, target.id, 'supersedes');
        res.warnings.push(`${target.id}: kept as is on the default branch; ${m.id} (branch ${s.branch}) replaces it when the branch is merged`);
        res.added++; continue;
      }
      if (op === 'verify' && c.id) { S.verifyMemory(c.id, p); res.verified++; continue; }
      if (op === 'done' && c.id) { S.updateMemory(c.id, { status: 'done' }, { by: 'compressor', reason: c.why || 'task finished' }); res.done++; continue; }
      if (c.anchors?.length) res.warnings.push(...S.anchorHints(p.root, c.anchors).map((w) => `${c.title || c.id}: ${w}`));
      if (op === 'update' && c.id && (c.confidence ?? 0.7) >= S.AUTO_ACCEPT_CONFIDENCE) {
        S.updateMemory(c.id, { body: c.body, title: c.title, why: c.why, files: c.files, anchors: c.anchors, status: 'active' }, { by: 'compressor', reason: c.why || 'updated by compressor' });
        try { S.verifyMemory(c.id, p); } catch (e) { res.warnings.push(e.message); }
        run(`UPDATE memories SET resolved_by = 'compressor', resolved_at = ?, source_model = COALESCE(?, source_model) WHERE id = ?`, now(), model ?? null, c.id);
        res.updated++; continue;
      }
      if (op === 'conflict' && c.id) {
        const m = S.propose({ ...c, status: 'conflict' }, { s, p, model });
        S.relate(m.id, c.id, 'contradicts'); res.conflicts++; continue;
      }
      if (op === 'add') { const d = S.nearDuplicate(p.id, c); if (d) res.warnings.push(`${c.title}: near-duplicate of ${d.id} "${d.title}" (overlap ${d.overlap}); next time update it instead`); }
      const m = S.propose(c, { s, p, model });
      // supersede with ids:[…] merges duplicates: one new memory replaces all of them
      const olds = op === 'update' || op === 'supersede' ? [...new Set([...(c.ids || []), ...(c.id ? [c.id] : [])])].filter((id) => S.memory(id)) : [];
      for (const old of olds) {
        S.relate(m.id, old, 'supersedes');
        if (m.status === 'active') S.updateMemory(old, { status: 'superseded' }, { by: 'compressor', reason: `superseded by ${m.id}` });
      }
      if (m.status === 'proposed') res.pending_review++; else res.added++;
    } catch (e) { res.errors.push(`${c.title || c.id}: ${e.message}`); }
  }
  // the card replaces the raw events (nothing to compress again), except the last few turns, kept as a small raw fallback
  res.events_removed = run(`DELETE FROM events WHERE session_id = ? AND id <= ? AND id NOT IN (SELECT id FROM events WHERE session_id = ? AND id <= ?
      AND kind IN ('prompt','assistant') ORDER BY id DESC LIMIT ${KEEP_TURNS})`, s.id, upto, s.id, upto).changes;
  run(`UPDATE sessions SET saved_event_id = MAX(saved_event_id, ?), quality = 'llm' WHERE id = ?`, upto, s.id); // the card records the compressor's model; the session keeps its own
  try { res.exported = S.exportProjectMd(p); } catch (e) { res.errors.push(`export: ${e.message}`); }
  checkpointWal();
  return res;
}

// Deterministic card from the unsaved events + git (no LLM). Events are kept so an LLM save can refine it later.
export function autoCard(s) {
  if (!s) return null;
  const p = S.project(s.project_id);
  const evs = all(`SELECT * FROM events WHERE session_id = ? AND id > ? AND kind != 'pending' ORDER BY id`, s.id, s.saved_event_id);
  if (!evs.length) return null;
  const prompts = evs.filter((e) => e.kind === 'prompt');
  const files = [...new Set(evs.filter((e) => e.kind === 'tool' && e.target && /[\\/]|\.\w{1,5}$/.test(e.target) && !/\s/.test(e.target)).map((e) => rel(p?.root, e.target)))];
  const d = p && s.start_commit ? diffSince(p, s.start_commit) : { stat: '', files: [] };
  const allFiles = [...new Set([...d.files, ...files])].slice(0, 20);
  const fails = evs.filter((e) => e.kind === 'tool_fail').slice(-3);
  const last = evs.filter((e) => e.kind === 'assistant').at(-1)?.body;
  const goal = prompts[0]?.body || s.title || '';
  // the session's name wins (auto-named from the first real prompt, or renamed by the user)
  const title = s.title ? clip(s.title, 120)
    : clip(`${clip(goal.replace(/\s+/g, ' '), 70)}${allFiles.length ? ` (${allFiles.slice(0, 2).map((f) => f.split(/[\\/]/).pop()).join(', ')})` : ''}`, 120);
  run(`DELETE FROM summaries WHERE session_id = ? AND quality = 'auto'`, s.id);
  run(`DELETE FROM checkpoints WHERE session_id = ? AND trigger = 'auto'`, s.id);
  run('INSERT INTO summaries(id, session_id, project_id, title, body, raw_chars, created_at, quality) VALUES (?,?,?,?,?,?,?,?)',
    uid('s'), s.id, s.project_id, title, `Auto card (no LLM): ${prompts.length} prompt(s), ${evs.length - prompts.length} other events.${prompts.length > 1 ? ` Last request: "${clip(prompts.at(-1).body, 200)}".` : ''}${d.stat ? `\nDiff since start:\n${clip(d.stat, 600)}` : ''}`,
    0, now(), 'auto');
  addCheckpoint(s, { goal: clip(goal, 300), working: '', broken: fails.map((f) => `${f.tool} ${f.target || ''}`).join('; '),
    files: allFiles, next_steps: [], note: clip(last || prompts.at(-1)?.body, 400) }, 'auto');
  run(`UPDATE sessions SET title = COALESCE(title, ?), quality = COALESCE(quality, 'auto') WHERE id = ?`, title, s.id);
  return title;
}

// Deterministic ≤2KB snapshot (no LLM) of the UNSAVED work: before compaction, on pause, and for a session whose last LLM
// save is older than its last events ('tail'). Nothing is written when nothing was recorded.
export function snapshot(s, trigger = 'precompact') {
  if (!S.unsavedCount(s)) return null;
  const q = (sql) => all(sql, s.id, s.saved_event_id);
  const prompts = q(`SELECT body FROM events WHERE session_id = ? AND id > ? AND kind = 'prompt' ORDER BY id`);
  const files = [...new Set(q(`SELECT target FROM events WHERE session_id = ? AND id > ? AND kind = 'tool' AND target IS NOT NULL ORDER BY id DESC LIMIT 80`)
    .map((r) => r.target).filter((t) => /[\\/]|\.\w{1,5}$/.test(t) && !/\s/.test(t)).map((t) => rel(S.project(s.project_id)?.root, t)))].slice(0, 15);
  const fails = q(`SELECT tool, target FROM events WHERE session_id = ? AND id > ? AND kind = 'tool_fail' ORDER BY id DESC LIMIT 3`);
  const last = q(`SELECT body FROM events WHERE session_id = ? AND id > ? AND kind = 'assistant' ORDER BY id DESC LIMIT 1`)[0]?.body;
  const c = { goal: clip((trigger === 'tail' ? prompts.at(-1) : prompts[0])?.body, 300), files, note: clip(last || prompts.at(-1)?.body, 400),
    broken: fails.map((f) => `${f.tool} ${f.target || ''}`).join('; '), working: '', next_steps: [] };
  if (!c.goal && !c.files.length && !c.note) return null;
  while (JSON.stringify(c).length > 2000 && c.files.length) c.files.pop();
  if (JSON.stringify(c).length > 2000) c.broken = '';
  return addCheckpoint(s, c, trigger);
}

// Card text of a session, as an event the compressor reads when combining sessions.
function addCardEvent(into, fromId) {
  const src = S.session(fromId), c = S.card(fromId);
  if (!src || !c) return false;
  S.addEvent(into, 'card', { body: fmtCard(c, cardMeta(src, src.seq ? src : null)), target: fromId });
  return true;
}

// Merge several sessions INTO an existing one: every row moves, the emptied sessions disappear,
// and the merged cards become 'card' events so the next save writes one combined card.
export function mergeSessions(projectId, refs, intoRef) {
  const [into] = S.resolveSessionRefs(projectId, [intoRef]);
  const ids = S.resolveSessionRefs(projectId, refs).filter((id) => id !== into);
  if (!into || !ids.length) throw new Error('merge needs at least one session and a different target (see "uac sessions")');
  const target = S.session(into);
  const moved = { events: 0, summaries: 0, checkpoints: 0, memories: 0 };
  tx(() => {
    // turns kept after earlier saves are already covered by the cards being combined: drop them before re-digesting
    for (const id of [into, ...ids]) run('DELETE FROM events WHERE session_id = ? AND id <= (SELECT saved_event_id FROM sessions WHERE id = ?)', id, id);
    for (const id of ids) {
      addCardEvent(target, id);
      moved.events += run('UPDATE events SET session_id = ? WHERE session_id = ?', into, id).changes;
      moved.summaries += run('UPDATE summaries SET session_id = ? WHERE session_id = ?', into, id).changes;
      moved.checkpoints += run('UPDATE checkpoints SET session_id = ? WHERE session_id = ?', into, id).changes;
      moved.memories += run('UPDATE memories SET source_session = ? WHERE source_session = ?', into, id).changes;
      run('UPDATE messages SET from_session = ? WHERE from_session = ?', into, id);
      run('UPDATE sessions SET rolled_into = ? WHERE rolled_into = ?', into, id);
      run('DELETE FROM message_reads WHERE session_id = ?', id);
      run('DELETE FROM retrievals WHERE session_id = ?', id);
      run('DELETE FROM sessions WHERE id = ?', id);
    }
    run(`UPDATE sessions SET saved_event_id = 0, quality = NULL WHERE id = ?`, into); // needs one combined save
  });
  autoCard(S.session(into));
  S.setNextSessions(projectId, S.nextSessions(projectId).map((x) => (ids.includes(x) ? into : x)).filter((x, i, a) => a.indexOf(x) === i));
  return { ok: true, into, merged: ids, moved };
}

// Roll up many sessions into ONE new session/card ("compress all sessions into a single memory").
// Sources are kept (history) but hidden; the rollup's card becomes the one future sessions continue from.
export function rollup(p, { refs = [], all: everything = false, branch } = {}) {
  const ids = everything
    ? S.listSessions(p.id, { limit: 500 }).filter((x) => x.card && (!branch || x.branch === branch)).map((x) => x.id)
    : S.resolveSessionRefs(p.id, refs);
  const withCards = ids.filter((id) => S.card(id));
  if (withCards.length < 2) throw new Error('rollup needs at least 2 sessions that have cards');
  const id = uid('rollup');
  const br = branch || S.session(withCards[0]).branch || p.branch;
  run(`INSERT INTO sessions(id, project_id, agent, branch, start_commit, capture, status, started_at, ended_at, title)
       VALUES (?,?,?,?,?,?,?,?,?,?)`, id, p.id, 'uac', br, p.commit, 'off', 'ended', now(), now(), `Rollup of ${withCards.length} sessions${br ? ` on ${br}` : ''}`);
  const r = S.session(id);
  for (const sid of [...withCards].reverse()) addCardEvent(r, sid); // oldest first
  run(`UPDATE sessions SET rolled_into = ? WHERE id IN (SELECT value FROM json_each(?))`, id, J(withCards));
  autoCard(S.session(id));
  const n = S.listSessions(p.id, { limit: 200 }).find((x) => x.id === id)?.n;
  return { session_id: id, n, sources: withCards,
    how: `Rollup session #${n} created from ${withCards.length} cards. To write ONE combined card: type "#uac save ${n}" in your chat (the agent spawns ${COMPRESSOR} with session_id=${id}).` };
}

// "Continue this work elsewhere": the next session (any agent/branch) continues from this one.
export function handoff(s, p) {
  const next = [...new Set([s.id, ...S.nextSessions(p.id)])];
  S.setNextSessions(p.id, next);
  const x = S.listSessions(p.id, { limit: 200 }).find((y) => y.id === s.id);
  return { next_sessions: next, how: `The next UAC session in this project continues from this one automatically. In an already-open session type "#uac continue ${x?.n ?? S.shortId(s.id)}". Save first (${COMPRESSOR}) so the card is complete.` };
}

// uac_sessions: one compact line per session, with the refs every tool accepts (the #n never moves; short ids never do either)
export function sessionsIndex(p, s, { limit = 15, all: withHidden = false } = {}) {
  const rows = S.listSessions(p.id, { limit: Math.min(Number(limit) || 15, 100), all: withHidden });
  if (!rows.length) return 'no sessions yet in this project';
  return rows.map((x) => `${x.n ? `#${x.n}` : '(hidden)'} ${x.short} · ${x.branch || '-'} · ${x.agent} · ${ago(x.last_active || x.started_at)} · ${state(x, s?.id)} · ${x.title || x.card?.title ? `"${clip(x.title || x.card?.title, 70)}"` : '(untitled)'}`).join('\n') +
    '\nUse #n, the short id or the full id in uac_get {ids}, uac_bootstrap {sessions}, uac_message {to:"session:<id>"}.';
}
