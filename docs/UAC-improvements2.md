# UAC Improvement Feedback

Engineering feedback from testing UAC (v0.3.4) head-to-head against UACE in
this workspace. Everything below is grounded in something actually observed
in this session — tool schemas read, files read, builds run, hook manifests
inspected — not speculation. Where I didn't verify something, it's labeled
as such rather than assumed.

## The decisive answer: use UAC going forward

Not a hedge — here's the concrete evidence, found *after* the initial 8/10
score, that makes this fairly clear-cut:

**UAC's hook coverage is far larger than UACE's, and it's global, not
per-project.** I read UAC's actual hook manifest
(`~/.claude/plugins/cache/uac/universal-agent-context/0.3.4/hooks/hooks.json`).
It wires **8** lifecycle events: `SessionStart`, `UserPromptSubmit`,
`PostToolUse` (async, matcher `*` — every tool call), `PostToolUseFailure`
(async), `SubagentStop`, `PreCompact`, `Stop`, `SessionEnd`. UACE's
`.claude/settings.json` in this same repo wires exactly **2**: `SessionStart`
and `SessionEnd`.

That difference matters concretely, not just numerically:
- The async `PostToolUse` hook means UAC is almost certainly capturing a raw
  event log continuously through a session, not only summarizing once at the
  very end the way UACE's transcript-parsing `SessionEnd` hook does. That's
  what makes `uac_propose`/`uac_checkpoint` calls promotions from an
  existing log, rather than the only record that anything happened.
- `PreCompact` is a real gap UACE has no answer for at all: a long session
  that hits context compaction loses everything not yet saved, for UACE,
  until `SessionEnd` finally fires. UAC has a hook specifically for that
  moment.
- It's installed once, globally, as a Claude Code plugin
  (`~/.claude/plugins/...`) — no per-project `.mcp.json` + generated shell
  scripts + `settings.json` entries to check into every repo, unlike UACE
  (which needed exactly those three things committed into *this* repo for
  it to work at all).

Combined with the earlier findings (no project-id string to mismatch,
typed/anchored/confidence-scored memories, cross-session messaging that
fired unprompted), UAC is the more soundly-architected tool of the two,
even at an early version number. It's also the one you actually control —
continued investment compounds; adopting UACE wouldn't.

**Caveat, stated plainly**: "more hooks exist" is not the same as "I watched
each one fire and do the right thing." I verified the manifest is real, and
`SessionStart`, the cross-session message channel, and `Stop` all confirmed
firing for real during this evaluation. But `Stop` firing correctly is not
the same as the thing it triggers working correctly — see gap #6 below,
where the `Stop`-triggered `uac-compressor` subagent failed on its first
real invocation. I still have not watched `PostToolUse`, `PreCompact`, or
`SubagentStop` fire and confirm their output — that's an honest gap in this
evaluation, not a claim they're broken.

## Gaps to fill (concrete, observed this session)

1. **Memory `type` and `scope` are invisible in `uac_bootstrap`'s text, even
   though the same data already gets grouped correctly elsewhere.** I
   proposed a `preference`-type, `user`-scoped memory alongside
   `lesson`/`task` project-scoped ones. `uac_bootstrap` rendered all three
   under one identical `## Project knowledge` heading — same bullet format,
   no `[preference]` or `[task]` tag, no marker for user-scope vs
   project-scope. This isn't a missing capability: the exported
   `.context/PROJECT.md` file (written by `uac_save`) *does* group by type,
   with real `## Lessons` / `## Open tasks` headings. So the grouping logic
   already exists — it just isn't applied to the text actually injected into
   a live session via `uac_bootstrap`, which is the more consequential
   surface since that's what the working LLM reads turn to turn, not a
   static exported file a human opens separately. **Fix**: reuse
   `PROJECT.md`'s grouping-by-type logic in `uac_bootstrap`'s rendered
   output, plus a scope marker (`user` vs `project`) it doesn't currently
   have either.

2. **A "task" memory that gets fixed has no way to leave the "open" bucket.**
   Concretely observed: after I fixed and verified the Carousel bug and
   updated `m-169bfa`'s title to "— fixed" and its body to state it's
   resolved and build-passing, `.context/PROJECT.md` still lists it under
   `## Open tasks` — because that section is generated from the static
   `type: "task"` field, and nothing transitions a task's lifecycle state
   independent of its content. Worse: `uac_update`'s own schema (checked
   directly) only accepts `id`, `body`, `title`, `anchors`, `confidence`,
   `evidence`, `reason` — **there is no way to change a memory's `type`
   after creation** through that tool. The only place `type` can currently
   change is a compressor `op: "supersede"` candidate, which isn't exposed
   to a normal session doing routine work. **Fix**: either let `uac_update`
   change `type`, or add a separate open/resolved/superseded status field
   that `PROJECT.md`'s task section actually filters on, independent of the
   type used for storage.

3. **No token/item budget control on `uac_bootstrap`.** Its schema has
   `depth`, `fresh`, `goal`, `packs`, `sessions` — no `limit`/`max_items`.
   UACE's equivalent (`get_project_context`) has an explicit `limit` param
   (default 20, max 50, per layer). Right now `uac_bootstrap` appears to
   dump every active memory's full body text unconditionally. Fine at 3
   memories; unverified and likely expensive at, say, 200 memories after
   months of real use on a large project — every session start would pay
   for all of them whether relevant or not. `packs` exists in the schema as
   an opt-in narrowing mechanism, but nothing indicates it's used
   automatically once knowledge count crosses some threshold. **Fix**:
   either a default cap with the option to raise it, or automatic
   pack-based summarization once the active-memory count passes a
   threshold, so it doesn't require the caller to know to ask for `packs`.

4. **Stale memory reconciliation is still manual, and was missed twice in
   this session** — once as `m-e556c0`'s never-updated anchors, once as
   `m-169bfa` staying "not fixed yet" after a session had already fixed and
   messaged about it. The fixing session called `uac_message` (a
   notification) but never called `uac_update` (the actual fact). Nothing
   currently forces or even nudges "you just resolved something described
   in project knowledge — reconcile it." **Fix**: when `uac-compressor` runs
   at session end, have it diff completed work against open `task`/`warning`
   memories it touched and propose an `update`/`supersede` automatically,
   rather than relying on the live session to remember. This is also
   UACE's single biggest gap (its working-memory TODO went stale the same
   way) — worth fixing here since UACE clearly won't. (Directly related to
   gap #2 above — both are really the same underlying problem: nothing
   automatically closes the loop between "work got done" and "the memory
   about that work reflects it.")

5. **Anchors are workspace-root-relative, silently.** I anchored
   `package.json` (meaning the workspace root's) when the real file was at
   `uac-plugin-test/package.json`, and every anchor came back
   `✗ not found` — a false alarm from my own authoring, not a code problem.
   Nothing in the tool description or the returned error says *why* it's
   unresolved or suggests the likely fix (path is relative to the wrong
   root). **Fix**: when an anchor fails to resolve, have `uac_verify` (or
   the propose-time response) suggest the nearest actual match if one exists
   under a different prefix, instead of a bare "not found." Also: a single
   lesson can legitimately apply to multiple sibling instances (this lesson
   applied identically to both `uace-react-test/` and `uac-plugin-test/`) —
   worth explicitly supporting a memory anchored to N equivalent locations,
   which the schema technically allows (anchors is an array) but nothing
   flags "these are alternates" vs. "these are all required."

6. **The `uac-compressor` subagent fails when given only the minimal prompt
   its own `Stop` hook instructs you to send.** Verified directly: the
   `Stop` hook fired for real (good — this closes one of the "unverified"
   items from the first pass of this doc) and printed the exact instruction
   "Spawn the uac-compressor subagent... with the prompt
   'session_id=...'". Following that literally, the spawned subagent
   couldn't complete the task — it got confused about which MCP tool
   namespace it had (thought the project "uses UACE"), claimed it needed a
   git repository (it doesn't — `uac_digest`/`uac_save` don't require one),
   and gave up without calling `uac_digest` even once, despite loading its
   schema via ToolSearch. A second attempt with a full narrative brief
   instead of the bare session id succeeded earlier in this same session,
   and calling `uac_digest` → `uac_save` directly myself (bypassing the
   subagent entirely) worked cleanly on the first try. **This means the
   automatic Stop-hook-triggered save path — the thing that's supposed to
   need zero user/AI effort — may not reliably work in practice**, since it
   hands the subagent exactly the minimal prompt that failed here. **Fix**:
   either have the `Stop` hook's spawned prompt include enough (goal, recent
   summary) that the subagent doesn't need to reconstruct context from
   nothing, or make `uac-compressor`'s own instructions unambiguous that its
   very first move must always be `uac_digest(session_id)` regardless of
   what else is or isn't in its prompt.

7. **Compression is genuinely lossy, and the raw material is discarded, not
   archived.** `uac_save`'s own tool description says it "Replaces the raw
   events" — that's not an inference, it's the documented behavior. Once a
   session's events are compressed into a summary + checkpoint, the
   verbatim detail (an exact error message, a specific back-and-forth, a
   piece of reasoning that didn't make it into the summary) is gone from
   UAC's own store — not hidden, not archived, gone. This showed up
   directly in this evaluation: `uac_digest` returned 44 raw events, and
   after `uac_save` ran, `events_removed: 44` confirmed they're deleted, not
   demoted to cold storage. If a future session needs something that wasn't
   promoted into a memory or checkpoint, there's no way back to it through
   UAC — only through Claude Code's own separate transcript file, if that
   still exists and someone knows to go find it. **Fix**: keep the
   redacted raw events around in a cheap cold-storage tier (e.g. compressed
   to disk, not held in the live context store) for some retention window
   after compression, addressable by session id, instead of hard-deleting
   them the moment a summary exists. Bootstrap/digest shouldn't load them by
   default — they'd stay out of normal context cost — but a deliberate
   "give me the raw log for session X" call should be possible for the
   window where it might still matter.

8. **Compression should also compact the knowledge store itself, not just
   the session log.** Right now `uac-compressor` turns a session's raw
   events into a summary + checkpoint + a handful of reconciled memory
   candidates — but nothing periodically revisits the *accumulated project
   knowledge* itself to merge near-duplicates, retire fully-superseded
   items, or roll many small facts into fewer higher-level ones. Combined
   with gap #3 (no budget cap on `uac_bootstrap`) and gap #4 (stale items
   pile up instead of resolving), this means the knowledge store's honest
   long-run shape is "keeps growing," not "stays a working set." A capped
   `limit` param bounds what any single `uac_bootstrap` call *returns*, but
   doesn't stop the underlying store from bloating — and an ever-growing
   store makes every future ranking/search/dedup decision harder, not just
   more expensive. **Fix**: have compression (either every run, or a
   periodic separate pass) also compact the knowledge base itself — merge
   memories that say the same thing with different wording, drop ones a
   later memory has fully superseded, and consider summarizing a cluster of
   old low-confidence `fact`s into one higher-confidence one once they've
   been individually verified enough times. This is a complement to the
   `limit` param from gap #3, not a replacement for it: capping retrieval
   controls cost per call; compacting the store controls whether the
   thing being retrieved from stays sane at all after a year of daily use
   across many sessions.

## What else it needs for genuinely accurate context

- **Verification needs a cheap trigger, not just a manual call.** Right now
  `uac_verify` is something a session has to remember to call. Tying it to
  the existing `PostToolUse` hook (already firing on every tool call) to
  auto-check anchors touched by a just-edited file would keep the ✓/⚠/✗
  status honest without anyone remembering to ask.
- **A "why did this session know that" trace would make the tool
  self-auditing.** Right now the only way to tell if a fix came from real
  recall vs. lucky grepping is to ask the session directly and trust its
  self-report (which is exactly what I had to do for both UAC and UACE in
  this evaluation). If `uac_bootstrap`'s injected header logged "N project-
  knowledge items injected, M tokens" visibly, a user could tell at a
  glance whether recall happened without interrogating the model about its
  own behavior.
- **Preference memories should be able to say what they're not.** A
  "prefer inline styles over dynamic Tailwind classes" preference is
  narrow and situational; nothing currently distinguishes a narrowly-scoped
  stylistic preference from a blanket rule the way `review_when` does for
  deferred decisions. Worth a similar "applies_when"/counter-example field
  so preferences don't get over-applied outside their real context.
- **`SessionStart` should offer a choice, not silently pick one.** The
  underlying capability to load more than the default already exists —
  `uac_bootstrap` has `depth: normal|deep` and a `sessions: [ids]` param to
  continue from specific prior sessions — but the automatic hook doesn't
  surface that as a choice, it just picks a default. Worth asking once at
  session start (or at least stating what default was picked and how to
  override it) rather than requiring the user to already know `#uac deep`
  or `#uac continue <n>` exist.
- **I want compression to scale with decisions made, not with conversation
  length — and I want to know when it didn't.** This tool's primary
  consumer is an LLM picking the session back up, not a human skimming a
  changelog, so I'll say plainly what I, in that role, actually need: if a
  session card is closer to fixed-size regardless of source complexity, a
  short session and a long, decision-dense one come out looking equally
  confident-and-complete to me — and I have no way to tell which one I can
  trust at face value versus which one quietly dropped something load-
  bearing. That's a worse failure mode than a small card, because I'd act
  on it without knowing anything was missing. What I want: card size tied
  to the number of distinct decisions/constraints/gotchas recorded, not raw
  token count of the source chat, and when compression does have to drop
  something, an explicit signal ("N items retained, M omitted for space")
  instead of silence — that's what tells me to go verify against the actual
  code before relying on the card alone. Untested in this evaluation (only
  one moderately-sized session was ever compressed), but this is what I'd
  need before trusting a card unconditionally on a long-running project.
- **Related sessions should link, not merge.** When session B resolves
  something session A flagged (as literally happened here: one session
  found the Carousel bugs, a separate one later fixed them), the *memory*
  about it should be one continuously-updated record — which already works
  correctly once gap #2/#4 are fixed. But the *session cards* themselves
  are logs of two distinct conversations, possibly far apart, possibly by
  different people/agents — actually merging their text into one would
  erase real provenance (when/by whom each part happened). The better
  version: let a session card reference "resolves session #N" so bootstrap
  can present it as one visible thread without literally combining two
  separate historical records into one.

## To go from 8/10 to 10/10

In priority order, based on what would most change real usage, not just
score better on this specific test:

1. Fix #1 above (render type/scope in context text, matching what
   `PROJECT.md` already does) — cheapest, highest impact of everything
   found.
2. Fix #4 above (auto-reconcile stale task/warning memories at compression
   time) together with #2 (let a memory's `type`/status actually change
   when it's resolved) — these are one problem in practice: a growing pile
   of tasks that say "not fixed yet" about things fixed weeks ago is worse
   than no memory at all, because it's actively wrong, not just silent.
3. Fix #6 above (make the Stop-hook-triggered compressor reliable with only
   a bare session id) — this is the automatic save path UAC's whole pitch
   depends on; if it silently fails in the background the way it did once
   in this evaluation, a user has no way to know their session wasn't
   actually saved.
4. Add the budget/cap control from #3, and pair it with the knowledge-store
   compaction from #8 — capping what a single call returns and periodically
   compacting what's stored are complementary, and both are needed before
   trusting this on a large, long-running, multi-month project (untested at
   that scale in this evaluation).
5. Decide a retention policy for #7 (raw events currently hard-deleted on
   compression) — even a short cold-storage window changes "gone forever"
   into "recoverable if you notice quickly."
6. Verify (don't just infer from the manifest) that `PostToolUse`,
   `PreCompact`, and `SubagentStop` actually do what their presence implies
   — dogfood a session that hits a real compaction event and confirm
   nothing is lost. (`Stop` and `SessionStart` are now confirmed firing;
   see #6 above for the caveat on `Stop`'s downstream reliability.)
7. Check the dashboard (mentioned but not tested in this evaluation) covers
   the same ground as UACE's `get_dashboard` — memories grouped by
   type/scope/verification-state, sessions, active files — since the
   dashboard is the one place the type/scope-invisibility problem in #1
   could be fixed for a human even before the LLM-facing text is.
8. If cross-tool reach (Cursor, Copilot, other clients) is a goal — UACE's
   one real edge is shipping ready-made adapter files
   (`.cursor/rules/*.mdc`, `.github/copilot-instructions.md`) alongside its
   `.mcp.json`, so the same memory is reachable from three clients out of
   the box. UAC's hook-based model is Claude-Code-specific by construction
   (Claude Code plugin hooks); reaching other clients would need parallel,
   separately-authored integrations the way UACE did. Worth being a
   deliberate roadmap decision rather than an oversight, not necessarily
   worth doing immediately.

## From UACE, worth actually taking

Being honest that most of UACE's design is inferior to UAC's on this test,
but two specific things are worth lifting:

- **The explicit `limit` parameter** on its context-loading call (see gap #2
  above) — small, concrete, easy to add.
- **Shipping cross-client adapter files by default** (see priority #6) —
  only if cross-tool reach is actually a goal; skip otherwise, since it's
  real ongoing maintenance surface for a benefit UAC's target users
  (Claude Code users, presumably) may not need.

Everything else UACE does, UAC already does better or has a clear path to
doing better via the fixes above — no need to import UACE's flat
untyped/unanchored memory model, its per-project hook-script setup, or its
single end-of-session-only capture point.

So: enough to understand the project and continue the task — not enough to reconstruct the full history. Those are different jobs, and UAC is explicitly optimized for the first one, which is the right call for a "don't re-explain the project" tool, but worth being clear-eyed about.

One thing this raised that I hadn't tested: does the compressed size scale with source complexity, or is a session card roughly fixed-size regardless of whether the source was 50K or 500K tokens? If it's closer to fixed-size, a longer/more complex session loses proportionally more than a short one — untested here (we only ever compressed one moderately-sized session), but worth flagging as an open question for the developer.