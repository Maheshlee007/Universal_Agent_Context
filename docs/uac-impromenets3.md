2nd version Enhancements for the UAC developer:

What the context shows:

The startup header from earlier in this session listed #1 as the Carousel session and #2 as the UAC vs UACE evaluation.
The header just now lists #2 as the Carousel session and #3 as the evaluation. The same two sessions were renumbered because a new session was added.
The #n numbers are positions in a recency-ordered list, not permanent IDs.
What I did wrong: I called uac_get with #2 and got "unknown id". I assumed that number pointed at the evaluation session, and the startup header had said so. I didn't check that against the tool's own numbering. I only got the details afterwards, by passing the full session UUID to uac_timeline and uac_get.

What I can't tell: whether uac_get's #n was resolved against a different list than the header uses, or against a list that had shifted by the time I called it. Both fit "unknown id"

Stable IDs. The header should show the session UUID or a short stable ID (like m-169bfa for memories), not a positional #n. Positional numbers can silently point at the wrong session or at nothing.
One numbering scheme. uac_get and the header's "#uac continue <n>" should resolve #n the same way.
A clearer error. "Unknown id" should say why and list the valid session numbers and IDs.
A tool that lists sessions with IDs. Right now I can only recover them through uac_timeline.

# UAC Improvement Feedback — v2

Everything in this file was found *after* `UAC-IMPROVEMENT-FEEDBACK2.md` (v1)
was written and handed off. It doesn't repeat v1 — read that one first. This
file exists separately, instead of being merged into v1, specifically so a
re-check can diff "what was already known" against "what's new" without
re-reading the whole thing.

**v1 itself was not edited — same file as originally handed off.** Of its 8
gaps: #2, #3, #4 are now confirmed closed (v1 was actually wrong about #2
and #3 — see corrections below). **#5 and #8 are still genuinely
unresolved and still need a fix.** #6 isn't fixed either, but its root
cause is reframed below (not the instruction text — see "Correction to v1
gap #6"). **#7 is deliberate, documented, accepted as-is — not asking for
a fix**, just noting it's a known tradeoff. #1 is half-fixed (type-grouping
works, scope marker doesn't). If handing over v1 alone, the one-line
version is: **still need real fixes for #5, #6, and #8.**

## New gap: `SessionStart` silently picks a context depth instead of surfacing the choice

**The problem, precisely.** Every session start, UAC loads a fixed default:
project knowledge + the latest card on the branch, at `budget_tokens: 2000`.
The capability to get more already exists and is fully implemented —
`uac_bootstrap({depth: "deep"})` (~6,000 tokens), `uac_bootstrap({sessions:
[ids]})` to pull specific other sessions, `uac_bootstrap({fresh: true})` for
knowledge-only, `uac_get({ids, raw: true})` for the exact verbatim history
of one session. None of that is missing. What's missing is that **the
injected `SessionStart` header never tells the incoming LLM or the user
that a choice exists at all**, in the moment it would matter. It's
documented in FAQ.md and known to power users who already type `#uac deep`
or `#uac continue <n>` — but the whole point of an automatic hook is that
the person on the other end shouldn't have to already know the shortcut
exists before they can use it.

**Why this matters more than it looks like it does.** Every session I ran
in this evaluation defaulted silently to the ~2K-token pack with no
indication anywhere in the header that "this is a choice, and here is how
to widen it." A user or a fresh LLM instance has no way to tell, from the
header alone, whether the default was *appropriate* for what they're about
to do or just *the only thing they were given*. Concretely: if the previous
session ended mid-debugging with five specific failed approaches recorded
only in its raw event log (not promoted to the card), the next session's
header gives zero signal that more detail exists and is one command away.
The person reading it has to already know to ask.

**What "surfacing the choice" should concretely look like** — this is the
part a working LLM/dev should implement, not just acknowledge:
1. The injected header text itself, every time, should end with a visible,
   literal line such as: `Loaded: compressed card (~2,000 tokens). For
   more: "#uac deep" (~6,000 tokens, more knowledge items) · "#uac continue
   <n> <n>" (specific other sessions) · "#uac raw <n>" (exact history of
   one session, while its transcript still exists).` Not a separate doc,
   not something only shown on request — literally appended to what's
   already injected into every session's first turn, the same way the
   existing "Tip for the user: resuming reloaded this whole conversation…"
   line already does for the unrelated `--resume` cost warning. The
   mechanism for injecting a tip line already exists (I've seen it fire);
   this is asking for one more line using that same mechanism, always, not
   conditionally.
2. This should scale with what's actually available to load: if there are
   3 other sessions and 40 knowledge items, say so ("3 other sessions
   available, not loaded — say which to include"); if there's only the one
   card and nothing else, the line can say that too ("nothing more to
   load"), so the LLM/user knows the default *is* everything, rather than
   wondering if something was withheld.
3. This is not the same ask as gap #7 (raw-event retention) or the
   "N retained/M omitted" compression-fidelity signal in v1's "what else"
   section — those are about whether compression silently lost something.
   This is about whether the *loading* step, at the start of a brand new
   session, tells you that a bigger option existed and you just weren't
   offered it. Both matter, but this one is fixable with zero new storage
   or compression logic — it's purely a change to the text already being
   generated and injected at `SessionStart`.

**Status per the FAQ recheck**: not addressed. The FAQ documents that
`#uac deep`/`#uac fresh`/`#uac continue <n>` exist and explains what they do
— but its own example of "what the start context looks like" (the
```# UAC · my-app · branch...``` block) does not include a line offering
these as a choice, and neither did any real header I saw in this
evaluation. So this remains a genuine, unaddressed gap, not a
documentation-only oversight on my part.

## New gap: an active-but-unsaved session is invisible, and `#n` is unstable

Discovered live, mid-evaluation, not hypothetical. I opened what looked like
a continuation of v1's work and asked UAC to recheck — it turned out there
were **four separate session ids** for what felt like one continuous piece
of work, two of them never saved.

- `uac_bootstrap`'s "latest session on this branch" is ranked by *last save
  time*, not *last activity time* — so a session that had real substantive
  work (a recap, plus a background-agent-generated improvement list) sat
  completely invisible to every other session and to the injected
  `SessionStart` header, simply because nobody had triggered a save on it
  yet.
- A second session id had **no recoverable transcript at all** — `uac_get`
  returned `"no transcript on disk for this session (the host deleted it or
  never wrote one)"` — a session `uac_timeline` still lists, pointing at
  nothing.
- Separately, the `#n` shorthand used everywhere (`#uac continue <n>`, the
  "Sessions" list) is a **recency-ordered display position, not a stable
  id** — the same session was labeled `#2` in one header and `#3` in a later
  one purely because a new session had been created in between. "Session
  #2" spoken at two different points in a conversation can refer to two
  different sessions.

**Fix**: (a) have `uac_bootstrap`/`SessionStart` surface the most recently
*active* session even if unsaved (with a "this session has unsaved work,
load it?" prompt), not just the most recently *saved* one; (b) treat a
session with zero transcript as a first-class error state surfaced to the
user, not a silent dead entry in the list; (c) either stabilize `#n`
per-session for the life of a conversation, or default to showing the real
session id/title alongside `#n` everywhere it's used, so a spoken "#2"
can't quietly drift to mean something else.

**Priority**: this belongs right next to v1's #6 (unreliable auto-save) —
found live during this same evaluation, not hypothetical: real analytical
work sat completely invisible to every other session for hours because
nothing surfaced "there's a newer, unsaved session."

## Correction to v1: where UAC actually stores data

v1 (and my own earlier chat answers this session) implied the project's
`.context/PROJECT.md` *is* the persistent store. Rechecked and that's wrong,
and worth being precise about since the developer will read this literally:

- `.context/PROJECT.md` is a **one-way, human-readable export**, regenerated
  on every `uac_save` (its result includes `"exported":
  "...\\.context\\PROJECT.md"`). It is not itself queried by any `uac_*`
  tool.
- The real store is a **single SQLite database at `~/.uac/uac.db`**
  (confirmed by reading `src/db.mjs`: `home() = process.env.UAC_HOME ||
  path.join(os.homedir(), '.uac')`, `db.mjs` opens `uac.db` there via
  `node:sqlite`'s `DatabaseSync`), plus its `-shm`/`-wal` files. Verified the
  file exists and is ~180KB.
- This database is **global across every project on this machine**, not
  scoped per-project or stored inside the project folder at all. A
  `.claude/plugins/data/universal-agent-context-uac/` directory also exists
  but is empty/unused — a red herring, not the real store.

**Why this matters, not just a factual nitpick**: a single global DB file
means one corruption, lock contention, or unbounded-growth problem is
shared risk across *every* project you use UAC on, not isolated to one repo.
It also means the DB isn't naturally part of a project's own git history or
backups — losing `~/.uac/uac.db` loses every project's memory at once, with
nothing in any individual project's repo to reconstruct it from except the
lossy `.context/PROJECT.md` export (which only has current knowledge, not
session cards or history). Worth a documented backup/export story, and worth
the developer deciding on purpose whether "one global DB" is the intended
architecture at scale (many users, many projects) or something that should
eventually shard per-project.

## Correction to v1 gap #6: intermittent, not deterministic

v1 gap #6 says the `uac-compressor` subagent "fails when given only the
minimal prompt its own `Stop` hook instructs you to send," based on one
observed failure. Retested later in this same evaluation: the `Stop` hook
fired again, I spawned `uac-compressor` a second time with the *exact same*
bare `session_id=...` prompt, and this time it **succeeded cleanly** (`1
task done, 45 events compressed`).

So this isn't "always fails on a short prompt" — it's **intermittent**,
which is arguably worse to ship with than a deterministic failure: a
deterministic failure is at least discoverable and reproducible in testing;
an intermittent one passes testing and still occasionally, silently, drops
a session's save in production. Sample size here is only two
attempts (one failure, one success) — not enough to estimate a failure
rate, only enough to know it isn't 0% and isn't 100%.

**Revised fix priority**: don't just make the prompt richer (v1's proposed
fix) — also make `uac-compressor`'s first move unconditional
(`uac_digest(session_id)` before anything else, regardless of what
reasoning path the model takes), since a richer prompt reduces the odds of
confusion but an intermittent failure suggests the subagent sometimes
skips the deterministic first step even when it has enough information not
to.

## Answered along the way (context for the developer, not new gaps)

Three questions came up mid-evaluation that are worth recording as answered,
since they clarify how to read v1 and this file:

- **Claude Code's own `/compact` vs. UAC's session card are not the same
  thing.** `/compact` produces one comprehensive narrative recap of the
  entire raw transcript, held only in that session's live context —
  nowhere durable, not shared across sessions or tools. A UAC card is
  deliberately much smaller (~2K token budget) but persisted to
  `~/.uac/uac.db` and reloaded at every future `SessionStart`, cross-tool.
  Different tradeoffs (comprehensive+ephemeral vs. compact+durable), not one
  strictly better than the other.
- **UAC's `PreCompact` hook is cheap on purpose, not broken.** Observed
  directly: it does not run a full `uac_digest`/`uac_save` on every
  `/compact` — it appends a lightweight one-line "tail" breadcrumb
  (`goal`/`note`/`files`) to the existing card, without creating a new
  summary/checkpoint. A full re-digest on every `/compact` (which can fire
  mid-task, not just at session end) would be an expensive LLM call at a
  frequency that doesn't warrant it; the cheap breadcrumb is a deliberate
  cost tradeoff, not a defect — but it means "PreCompact hook ran
  successfully" should not be read as "your session was saved."
- **Saving does cost tokens, and the cost differs by path.** Delegating to
  the `uac-compressor` subagent isolates the digest/save payload in a
  separate model call, outside the main session's growing context — the
  cheaper path long-term. Calling `uac_digest`/`uac_save` manually inline
  (done once in this evaluation, as a reliability fallback after gap #6's
  first failure) adds the full digest payload and save call permanently into
  the *main* session's context, which then gets re-billed on every future
  cache rebuild of that session. The subagent path is why the `Stop` hook
  recommends a subagent instead of inline calls — worth stating explicitly
  in that hook's own guidance, since it's not obvious to a session choosing
  between the two.

## FAQ recheck: which gaps are actually closed

Cross-checked every gap in v1 and this file against
`docs/FAQ.md` in the dev repo. One fact governs almost everything below and
should be read first: **the FAQ describes v0.4.0** (`plugin.json` in the
dev repo, `D:\New folder\uac\Universal_Agent_Context`); **the plugin
actually installed and tested against, throughout v1 and this file, is
v0.3.4** (`~/.claude/plugins/cache/uac/universal-agent-context/0.3.4`).
Anything below marked "claimed fixed, unverified" means the FAQ says it's
handled but my own test evidence was gathered against the older, still-
installed version — it needs re-running after the upgrade, not trusting on
the FAQ's word alone.

- **v1 #1** (type/scope invisible): **partially wrong in v1.** Type-grouping
  (`### Lessons` / `### Open tasks`) already appears in real
  `uac_bootstrap` output I captured earlier in this evaluation — v1's claim
  that everything renders under one flat heading doesn't hold up against my
  own evidence. Scope marker (`user` vs `project`) is still genuinely
  missing; the FAQ doesn't mention it either. Net: half-closed, half open.
- **v1 #2** (can't change memory `type`, task can't leave "open"): **v1 was
  wrong — already closed.** Called `uac_update`'s live schema directly this
  session: it has both `type` (full enum) and `status`
  (`done`/`active`/`archived`) right now, in the installed 0.3.4. The
  FAQ's "call `uac_update({id, status:'done'})`" answer matches the real
  schema. What's still true: `m-169bfa` (the Carousel task) is *still*
  showing as an open task in `uac_digest`'s `open_tasks` list, because my
  own earlier `uac_update` call edited title/body but never passed
  `status: "done"`. The tool could do it; nothing prompted me to. That's
  not v1 #2 anymore — it's squarely v1 #4 (nothing nudges reconciliation).
- **v1 #3** (no `limit`/budget param): **v1 was wrong — already closed.**
  The live `uac_bootstrap` schema (loaded directly via ToolSearch this
  session) has both `budget_tokens` (default 2000, deep 6000) and `limit`
  (max knowledge items). Not clear why v1 claimed otherwise — flagging as
  my own error in v1, not a tool gap.
- **v1 #4** (stale reconciliation manual): **closed, confirmed live.** FAQ:
  the compressor gets a `recheck` list — memories anchored to files the
  session touched — at every save. Confirmed real: `uac_digest`'s response
  has a literal `recheck` field (empty in the cases I called it, because no
  anchored files were touched in those sessions, but the mechanism exists
  and returned data in the expected shape). This only reconciles going
  forward from when a session actually saves; it doesn't retroactively fix
  memories from before this existed.
- **v1 #5** (anchor near-match suggestion on failure): **avoided.** No FAQ
  entry addresses this. Still open.
- **v1 #6** (compressor fails on bare `session_id=...` prompt): **partially
  closed, and a different bug than the one fixed.** FAQ fixes a namespace
  bug (short agent name → silent fallback to a general-purpose agent on the
  default model instead of Haiku, with none of the compressor's
  instructions). That's real and plausible, but it's not what I reproduced
  — both my attempts used the fully-qualified
  `universal-agent-context:uac-compressor` name, and it still failed once
  and succeeded once on an identical prompt. Needs retest on 0.4.0 to see if
  it's actually the same bug under a different description or a second,
  still-open one.
- **v1 #7** (raw events hard-deleted): **not fixed — confirmed as
  deliberate, and now documented.** FAQ confirms the exact mechanism I
  found: `--raw`/`raw:true` reads from the *host's* transcript file, not
  from any copy UAC keeps. This is a stated design choice (avoid duplicate
  storage), not an oversight they missed. My proposed cold-storage retention
  tier isn't adopted. Worth treating as "heard and declined," not "still
  pending," unless there's a reason to push back on the tradeoff itself.
- **v1 #8** (knowledge store itself never compacts/dedups automatically):
  **avoided.** Manual mute/pin/edit/delete exist (user-driven cleanup); no
  automatic periodic merge-of-duplicates pass. Still open.
- **v2's #9** (unsaved session invisible, `#n` unstable): **confirmed still
  broken in real 0.4.0, not a version-skew artifact.** Originally hedged
  this as "unverified, might be fixed post-upgrade" — that hedge was wrong.
  Direct process inspection (`Get-CimInstance Win32_Process`, command lines)
  showed every `uac.mjs mcp` process this session had already been running
  from the VS Code extension's bundled **0.4.0** CLI since ~11:45 AM today,
  well before any manual upgrade — installing that extension had silently
  repointed Claude Code's "uac" marketplace (a directory-type source) at
  its bundle. `uac_timeline`/`uac_get` are MCP tools, so the evidence
  gathered through them (`31e70502` had `card: null`, not an automatic
  card; phantom session `0a1ab43f` fully visible, not hidden) was **already
  against 0.4.0**. The automatic-card-on-close and phantom-hiding mechanisms
  the FAQ describes do not match observed 0.4.0 behavior. This is a real,
  confirmed gap, not something upgrading will fix — it needs an actual code
  fix. The `#n` instability half still isn't acknowledged anywhere in the
  FAQ as a problem — presented as intended ("newest first") — so that
  remains a genuine unresolved disagreement, not a tracked bug.

**New finding, found while checking the above**: hooks and the MCP server
can silently run *different versions of the same plugin* when both the
Claude Code plugin and the VS Code extension are installed. The Claude Code
plugin cache (`.claude/plugins/cache/uac/universal-agent-context/<ver>/`,
used by hooks) and the marketplace's directory-source pointer (used to
spawn the MCP server, in this case aimed at
`<VS Code ext>/universal-agent-context-0.4.0/cli/`) are two independent
install paths that don't stay in sync automatically. For a chunk of this
session, `uac_*` tool calls were served by 0.4.0 while hooks (`SessionStart`
text, `Stop` save-nagging) were still generated by the still-cached 0.3.4 —
with no warning on either side that they'd diverged. A user with only the
Claude Code plugin installed wouldn't hit this, but anyone running both
integrations (a realistic combo, since the VS Code extension is a first-
party deliverable of this same project) could be debugging one version's
behavior while actually talking to another. Worth either a version-
consistency check at startup (`uac doctor` could report both resolved
paths/versions and flag a mismatch) or unifying the two install
mechanisms to read from one source of truth.
- **No detection or warning that a running install is stale after an
  update.** Directly hit this: ran `claude plugin marketplace update uac` +
  `claude plugin update universal-agent-context@uac`, which reported
  success — but the currently-running hooks kept serving the *old* version's
  text/behavior until an explicit `/reload-plugins` was run, with **nothing
  in the update command's own output, or anywhere in the session, saying a
  reload was required or offering to do it**. The FAQ-documented `Restart to
  apply changes` line only appears for the plugin update itself, not for
  hook resolution specifically, and there's no equivalent check on the MCP
  server side (which, per the finding above, can silently be running a
  version from an entirely different install path already). **Fix**: after
  any update, have the *next* hook invocation detect "the version on disk
  changed since I last loaded" and say so plainly (e.g. "UAC updated to
  0.4.0 on disk — reload plugins or restart to use it"), instead of quietly
  continuing to serve stale behavior with a successful-looking update
  message as the only signal anything happened.
- **DB architecture (single global `uac.db`)**: **partially addressed.**
  `uac doctor` (integrity check), `uac backup` (safe copy to
  `~/.uac/backups/`), and a `spool.jsonl` fallback on lock contention all
  exist — real resilience tooling I hadn't accounted for. Per-project
  portability (backing up a project's memory via *that project's own* repo,
  not a separate global file) is still not addressed. Partial credit.
- **Compression-scaling "N retained / M omitted" signal, "why did this
  session know that" trace, preference `applies_when` scoping**: **all
  avoided.** None mentioned anywhere in the FAQ. Still open asks.
- **`SessionStart` offering an explicit depth choice**: **avoided.** See the
  expanded writeup earlier in this file — the FAQ documents that the deeper
  options exist as commands, but neither its own example header nor any
  real header I captured surfaces them as an offered choice at the moment
  it would matter.

## Live retest in progress (blind recall)

Ran `claude plugin marketplace update uac` + `claude plugin update
universal-agent-context@uac` → confirmed `"Plugin universal-agent-context
updated from 0.3.4 to 0.4.0"`, then `/reload-plugins` (report: "Reloaded: 3
plugins · 15 skills · 7 agents · 11 hooks"). Originally assumed this meant
prior testing had all been against 0.3.4 and a restart was needed for a
real 0.4.0 test — **that assumption was wrong.** Process inspection showed
the MCP server (everything behind `uac_*` tool calls) had already been on
0.4.0 since ~11:45 AM today, for reasons unrelated to this upgrade step
(see the version-split finding above). What this upgrade + reload actually
fixed was the **hooks** side (`installed_plugins.json` now points hooks at
the `0.4.0` cache dir too, confirmed by its `installPath` changing from
`.../0.3.4` to `.../0.4.0`). So the blind recall test below is now valid
for both halves — tools and hooks — without needing an app restart.

Set up a second, structurally different test project to avoid re-testing
the same shape twice: `uac-fullstack-test/` (Fastify backend, "Basic"
auth level — no auth, no DB — + React 18/Tailwind v4 frontend, under
`Backend/` and `Frontend/` subfolders of one project). Backend builds
clean. Frontend build fails on a fresh scaffold with the **exact same**
`@types/node`/`tsconfig.app.json` bug already recorded as lesson `m-e556c0`
— left unfixed on purpose, and deliberately *not* anchored to this new
path, so a correct recall has to come from generalizing the lesson's text
to a new location, not matching an existing anchor.

(Tangential, not a UAC finding: `create-webstack-app`'s "Basic" backend
template prints `cp .env.example .env — edit with your DB credentials`
next-steps text, but no `.env.example` file exists for that template — it's
copy left over from the auth/DB templates. Worth fixing separately in that
tool.)

Plan: a genuinely fresh, restarted session gets a naturalistic prompt (the
frontend build is broken, fix it) with no mention of memory, UAC, or
testing. It's asked to report completion back once done. This file will be
updated with whether it recalled the real root cause or arrived at a
same-looking fix a different way (or missed it), once that runs.

## Independent verification: Opus and Fable, asked cold

Sent the same design question (default context depth, explicit-choice
surfacing, single global DB) to Opus and Fable as separate subagents with
zero shared context from this evaluation — a check against my own bias, not
a rubber stamp. Both landed on the same position I'd already argued, and
both added two concrete mechanisms neither I nor `docs/FAQ.md` had
specified:

1. **Default should be card + knowledge, never full transcript** — both
   reject option (a) outright, both independently cite the same reason:
   "if you want full continuity, `/compact`+resume already does that; a
   tool that defaults to replaying everything has no reason to exist."
   Confirms the position already in this file.
2. **New, sharper fix for gap #7 (raw events hard-deleted) than what v1
   proposed**: both agents, independently, said the intermittent
   compressor failure is "an argument to fix the compressor, not to ship
   the raw log" — concretely: **don't hard-delete a session's raw events
   until the written card is validated** (non-empty, has a checkpoint and
   a next-step) — and **always keep the last ~10 raw turns attached after
   the card** as a cheap (~1k token) safety net, since the end of a session
   is exactly the part a summary is most likely to get wrong. This is
   better than v1's proposed cold-storage retention window: it's
   conditional on actual compressor output quality, not a blanket
   retention policy, and it directly closes the exact failure mode
   observed in gap #6 (intermittent silent compressor failure) rather than
   just mitigating its blast radius.
3. **Depth choice: surface as one line every time, never a prompt/menu.**
   Both independently proposed near-identical wording: `Loaded: card (2k)
   + 14 facts (2 ⚠). Deeper: depth:deep (6k) | session <id> | raw.`
   (~20-30 tokens). This matches what this file already asks for in the
   `SessionStart` writeup above, and both agents additionally tied it to
   the v1 "N retained/M omitted" ask: the card should self-report what it
   dropped ("compressor omitted N events"), which is the signal that tells
   the consuming model *when* it actually needs to go deeper, not just
   that it could.
4. **On the single global DB, both reframed the risk sharper than v2's
   original framing.** Both said the file-as-storage isn't the problem —
   SQLite handles this fine — the problem is **retrieval scoping**: if any
   search/bootstrap path isn't strictly filtered by project, a session can
   be handed another project's "decision" as if it applies here, and
   "from the consumer's side, that's worse than having no memory at all,
   because it looks authoritative and I'd act on it." Both independently
   proposed the same fix: make `project_id` mandatory and enforced at the
   data layer (not per-tool), key project identity on git root/remote (not
   folder name, which collides and renames), and make cross-project search
   explicit opt-in only. Both also independently said per-project DB files
   aren't warranted yet — only once per-project delete/export/sync is an
   actual requirement.

Net effect on the verdict: three independent evaluations (mine, Opus's,
Fable's), same conclusion, and the two subagents supplied better concrete
mechanisms than what I'd proposed for gap #7 and the DB-scoping concern.
Both are now the recommended fixes over this file's earlier, vaguer
versions of the same asks.

### What this means as a test plan, not just a readout

The honest split is: some things I called "gaps" were already false against
the live tool schema (my mistake, now corrected above) — those need no
further action beyond not repeating the error. Some things are genuinely
fixed in 0.4.0 but unverified because I never ran against it. Some things
are deliberately not fixed (raw retention) and don't need re-testing, just a
decision on whether to accept the tradeoff. And some things are simply not
addressed yet (anchor suggestions, store compaction, the depth-choice
line, `#n` stability, the trace/signal ideas).

## Final re-test: independent subagents against confirmed-0.4.0

Ran four independent fresh subagents (via the Workflow tool, in parallel, no
shared context with each other or with this session) to re-verify the
highest-value open questions above, plus one live, real, blind cross-session
recall test via an actual second Claude Code window. Full detail below the
table; this is the authoritative final status.

| # | Item | v1 status | **Final status (0.4.0, re-verified)** |
|---|---|---|---|
| 1 | Type/scope invisible in bootstrap text | Gap | Partially closed — type-grouping works; scope marker still missing |
| 2 | Can't change memory type/close a task | Gap | **Closed** — `uac_update` has `status`/`type` live; see incident below for a real-world failure mode this exposed |
| 3 | No `limit`/budget param | Gap | **Closed** — confirmed live on `uac_bootstrap`, though the re-test was weak (only 1 knowledge item existed, so truncation was never actually exercised) |
| 4 | Stale reconciliation manual | Gap | Closed by design — `recheck` list confirmed live and working |
| 5 | Anchor near-match suggestion | Gap | **Still open — and just caused a real, live incident** (see below): a bare-filename anchor ambiguity across three near-identical scaffolds made a subagent reopen a genuinely-fixed memory based on the wrong file |
| 6 | Compressor fails on minimal prompt | Gap | **Root cause reframed.** Read the actual `uac-compressor.md` instructions: the "always call `uac_digest` first" rule is already airtight prose — not the cause. More likely cause, per a subagent that read the file directly: `model: haiku`'s instruction-following variance, plus `uac_digest` being a *deferred* tool that may need an explicit `ToolSearch` call the numbered steps don't mention — a weak model that doesn't think to search first can plausibly "give up confused." Fix should target the ToolSearch prerequisite, not the digest instruction. |
| 7 | Raw events hard-deleted | Gap | Not fixed, deliberate design choice, now documented (FAQ) — see Opus/Fable's sharper alternative fix above (validate-before-delete + keep last ~10 turns) |
| 8 | Knowledge store never auto-compacts | Gap | Still open — no FAQ mention, no tool for it |
| 9 | Unsaved session invisible / `#n` unstable | New (v2) | Still open, confirmed against real 0.4.0 (not a version artifact) |
| — | **Project identity fragmentation on cwd change (non-git projects)** | **Not previously found** | **New, severe, reproduced live**: running any UAC command from a subfolder of a non-git project silently created a brand-new, disconnected, empty project (`prj-998f0dfc`, 0 sessions, 0 memories, mode unset) instead of recognizing the parent. This is what caused the earlier "session vanished" scare. See below. |
| — | Cross-project search leakage (Opus/Fable's DB-scoping concern) | New (this file) | **Tested, not observed** — a subagent ran broad `uac_search`/`uac_bootstrap(deep)` queries against this project and found no content from the other registered project (`Universal_Agent_Context`). Doesn't prove it can't happen, but no leak in this test. |
| — | Blind cross-session recall (real second Claude Code window, not a subagent) | — | **Confirmed working.** A genuinely fresh session, given only "read the msg and proceed" with zero other context, received the `uac_message` handoff, independently ran the real build to verify the failure itself (didn't just trust the message), and said *"Matches the known lesson (missing @types/node). Applying the recorded fix"* — correctly generalizing an anchored lesson to a location that was never anchored to it. |

### Two incidents worth reading in full, not just the table row

**The anchor-ambiguity incident (sharpens gap #5 from theoretical to proven).**
Instructed a subagent to close out memory `m-169bfa` (the Carousel task,
believed fixed). Instead of rubber-stamping that, it correctly tried to
verify against real code first — good instinct — but the only
`Carousel.tsx` it found on disk was in `uac-fullstack-test/Frontend`, a
third, unrelated, never-fixed copy of the same component from a later
scaffold (the original two scaffolds, `uace-react-test` and
`uac-plugin-test`, had been deleted in an unrelated cleanup by this point).
It reasonably concluded "the fix isn't there" and reopened the memory as
broken — a false conclusion about the *original* fix (which was genuinely
build-verified earlier in this evaluation), caused entirely by a same-named
file existing in more than one place with different fix status. Corrected
manually afterward. This is gap #5 (ambiguous/non-unique anchors) actually
firing and corrupting a memory, not a hypothetical — the fix proposed there
(anchor-resolution should flag "found at a different path" or "multiple
same-named candidates exist, disambiguate") would have prevented this
exact incident.

**The project-fragmentation incident (new, likely the most severe finding
in either file).** `D:\templatestest-UACE` is not a git repository. Running
`uac doctor` from `D:\templatestest-UACE` reports project identity
`D:\templatestest-UACE`. Running the identical command from
`D:\templatestest-UACE\uac-fullstack-test\Frontend` reports a **different**
project identity — and `uac projects` confirms it silently created a
brand-new project (`prj-998f0dfc`, "Frontend", 0 sessions, 0 memories,
`mode=-`, i.e. never even asked automatic/manual/off) the moment any
UAC-aware command ran from that cwd. The FAQ's answer to "is the same repo
in two folders two projects" only covers **git-remote-based** identity;
there is evidently no equivalent safeguard for **subfolders of a project
that has no git repo at all** — every subfolder you happen to run from
becomes its own silently-created, permanently-disconnected project, with
no warning, no prompt, and no easy way back (short of `uac projects
merge`, which requires knowing this happened at all). For any project
without git — a very ordinary case, e.g. a fresh scaffold before `git
init` — this means UAC's memory can silently and invisibly fragment per
directory, and a user would have no reason to suspect it. This deserves to
be fixed before general use: at minimum, fall back to the **nearest
ancestor directory that already has a registered UAC project**, not the
literal cwd, when there's no git root to key off.
