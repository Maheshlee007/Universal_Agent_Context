# UAC (Universal Agent Context) — improvement notes

Observations from a real session on tkd-app: loaded a "deep" context pack,
cross-checked it against the actual source files, and it held up — but the
gaps below are what would make that verification step unnecessary, or at
least cheaper, next time.

## What went wrong / was limiting

1. **Memory is prose, not pointers.** The bootstrap pack said "layout.js
   exports unit-agnostic row-sizing math" — true, but not actionable. To
   actually touch the code I still had to open the file and find
   `computeRowPlan`. A memory that named the symbol and line would have
   saved a round trip.
2. **No staleness signal at load time.** `uac_bootstrap` returned memory
   with no indication of when it was last checked against the code, or
   whether the referenced files had changed since. I only found out it was
   still accurate by manually reading every file.
3. **Paraphrase drift.** Memory called the second built-in template
   "Standard Sub Jr-Senior"; the actual `id`/`association` in code is just
   `"Association"`. Not wrong, but a paraphrase that doesn't match a grep
   is a trap — a future search for "Standard" would find nothing.
4. **No audit trail visible from the MCP side on how a proposal was
   resolved.** The compressor reported "4 proposals (all add)"; by the time
   `uac_review` ran (via tool call, not the IDE panel), all 4 already showed
   as resolved. Turned out the user had accepted them directly in the VS
   Code UAC review panel — correct behavior, not a UAC bug — but from the
   tool-call side alone there was no way to tell "auto-merged" apart from
   "a human already approved this in another surface." That's the actual
   gap: the two review surfaces (panel vs. `uac_review` tool) don't cross-
   reference who/what resolved a proposal.
5. **No lightweight "still true" action.** After manually verifying memory
   against code, the only tools available were `uac_update` (implies facts
   changed) or `uac_invalidate` (implies facts are wrong). There's no
   `uac_verify`/`uac_touch` to just bump a "confirmed accurate as of X"
   timestamp without creating a new version.
6. **Session start always asks before doing anything.** Even in cases where
   a default is obviously fine, the SessionStart flow stops to ask tier +
   capture on/off before the user has typed a single word. There's already
   a project-level `mode` (manual/automatic) exposed via `uac_capture` —
   but "manual" apparently means "ask every time" rather than "ask only
   when it matters." A sensible default (e.g. auto-bootstrap `relevant`
   tier, capture on) should be loadable with zero prompts, deferring to the
   user only when their first message signals they want something else
   (a specific pack, `fork`, or no context at all).
7. **Session list is hard to disambiguate.** Recent sessions show generic
   auto-titles ("Continue work on tkd-app, understand full session
   history..."). Hard to tell which one actually has useful state without
   opening each.
8. **Checkpoints/packs accumulate instead of consolidating.** Each session
   can leave behind its own checkpoint and/or pack (e.g. this project
   already has checkpoint `c-5047b1`, summary `s-92c2f9`, pack `p-759117`,
   plus older checkpoints from earlier sessions). Once a checkpoint has
   been loaded into a new session and folded into that session's live
   context, the old one just sits there as a separate fragment. Nothing
   merges "loaded checkpoint + this session's new state" back into one
   canonical record — future bootstraps have to re-rank across a growing
   pile of overlapping fragments instead of one coherent state.
9. **`uac_bootstrap` only takes one pack/session at a time.** The `pack`
   and `session_id` params are singular. If relevant context is split
   across, say, a knowledge-survey pack and a separate feature-work
   checkpoint, there's no way to load both into one bootstrap call — you'd
   have to bootstrap one, then manually fetch the other via `uac_get`/
   `uac_search` and merge them yourself.

## Proposed improvements

- **Anchor memories to code, not just prose.** Store `symbol@file:line` (or
  a content hash of that region) alongside the human-readable claim. On
  bootstrap, a quick hash comparison tells you "unchanged since capture" vs.
  "file touched since — verify before trusting."
- **Anchor to a git commit.** Record the commit SHA a memory was written
  against. Bootstrap can then say "written 3 commits ago" instead of a bare
  claim with no freshness context.
- **Quote identifiers verbatim.** When a memory references a template id,
  function name, or constant, use the exact string from the code, not a
  paraphrase — so it's greppable and matches what you'll actually find.
- **Attach resolution provenance to proposals.** When a proposal is
  accepted/rejected — whether via the IDE panel or the `uac_resolve` tool
  call — record *where* and *how* it was resolved (panel click vs. tool
  call vs. auto-merge policy), so a tool-side check like `uac_review` can
  distinguish "a human already handled this elsewhere" from "this was
  silently auto-merged."
- **Add a cheap verify/confirm action** distinct from update/invalidate —
  for exactly the "I checked, it's still accurate" case, so re-verification
  doesn't require faking an "update" with an unchanged body.
- **Auto-bootstrap a default tier with zero prompts.** Make `automatic`
  project mode actually skip the tier/capture question and just load a
  sensible default (e.g. `relevant`, capture on) before the user's first
  message — only asking when the user's own message signals a different
  need (naming a pack, asking for a fresh start, etc).
- **Better session titles.** Derive the auto-title from the actual diff/goal
  of the session rather than a generic restatement, so the recent-sessions
  list is scannable without opening each one.
- **Consolidate checkpoints on load, not just on save.** When a session
  loads a checkpoint and then produces new state, offer to fold the two
  into one updated checkpoint (superseding the old one) instead of leaving
  both as separate fragments. Keep history (nothing lost, same as
  `uac_invalidate`'s superseded-by trail), but make "current state" a
  single node per project, not an ever-growing chain bootstrap has to
  re-synthesize from every time.
- **Support loading multiple packs/checkpoints in one `uac_bootstrap`
  call.** Accept a list of pack ids / session ids, merge and de-duplicate
  their contents by ranking, and return one combined pack instead of
  requiring a single pack/session per call plus manual `uac_get` stitching
  for the rest.
- **Describe tiers with rationale, not just size hints.** Instead of "Minimal
  ~1k, Relevant ~4k, Deep ~10k", say: "Minimal: only must-not-violate constraints
  (risk of breaking prior decisions). Relevant: architecture + active task context.
  Deep: full history + decisions + lessons. Fork: project knowledge only, no session
  state." Bootstrap can then recommend "For bug fixes, use Relevant; for major
  refactor, use Deep."
- **Add memory curation/filtering.** After `uac_review` shows proposals,
  offer a "star/mute/hide" action so users can deprioritize noisy memories
  without deleting them. On next bootstrap, starred memories rank higher.
- **Document session cleanup and cascade rules.** Clarify: deleting a session
  soft-deletes it (orphans its memories unless they're referenced elsewhere),
  or hard-deletes (cascades to memories created only in that session). Expose
  a `uac_delete_session` or similar with clear warnings.
- **Simplify handoff flow.** Instead of "pick: pack or checkpoint or session
  or fork", offer "Continue this work in [new session / new agent / new
  branch]?" and auto-pick the most relevant pack/checkpoint behind the scenes.
- **Add LLM version/signature to checkpoints.** Tag each memory with the LLM
  model that wrote it (e.g. "claude-haiku-4-5"). On load, if the current model
  differs significantly (e.g. haiku → opus), flag it: "Memories written by Haiku,
  you are Opus — verify high-level claims before trusting edge cases."
- **Enable agent-to-agent communication via UAC.** Add a lightweight
  `uac_message` or `uac_handoff_msg` tool so parallel agents can post notes
  to a shared project memory or task queue, visible to all agents working on
  the same goal. Basis: checkpoint + session-specific message board.
- **Verify SQLite working and document troubleshooting.** Test storage layer
  in CI, document where the DB lives, what to do if it's locked/corrupted,
  and fallback options (in-memory cache, cloud sync, etc).

## Other approaches worth considering

- **Tiered memory by volatility.** Split "durable" facts (architecture,
  constraints — change rarely) from "volatile" state (in-progress task,
  open questions — change every session), and weight/expire them
  differently on bootstrap instead of treating all memory as equally fresh.
- **Auto-diff since last checkpoint.** On bootstrap, run `git log
  --since=<checkpoint time>` on the files a memory references and attach a
  one-line "N commits touched this file since the memory was written" —
  turns staleness from a manual grep into
   something the tool hands you.
- **Confidence decay, not binary stale/fresh.** A memory unverified for 50
  commits is a different risk than one unverified for 2 — surface that as
  a gradient, not a flag.

## Additional gaps discovered through use

10. **Tier descriptions are vague and not self-documenting.** Bootstrap asks
    "Pick a size: Minimal ~1k, Relevant ~4k, Deep ~10k, Fork, None." What does
    ~1k actually *contain*? Which tier for a bug fix vs. a new feature? No
    guidance, users have to guess or ask.
11. **No agent-to-agent communication through UAC.** If two parallel agents
    need to coordinate work (e.g. agent A writes a function, agent B needs to
    know its signature for a caller), there's no UAC-native way for them to
    pass messages or share state — they can't chat through the checkpoint
    system.
12. **Memory curation is opaque.** UAC compressor/bootstrap surfaces 4–6
    auto-generated memories. A user has no way to say "I don't care about
    memory #3, it's noise" or "memory #1 is incomplete, don't use it yet."
    Accepting/rejecting is all-or-nothing; fine-grained curation isn't exposed.
13. **Session cleanup is unclear.** No documented way to delete a session.
    When you delete a session, what happens to its memories? Its checkpoint?
    Are they orphaned, or cascade-deleted? Unknown.
14. **Handoff UI/UX is cluttered.** To hand off to another agent/session, you
    have to pick: a pack, a checkpoint, a session, or "fork". Too many choices
    for a user just trying to "continue this work elsewhere."
15. **Unclear storage/backend.** Uses SQLite for persistence — but is it
    verified working in all environments? What happens if the DB file is locked
    or corrupted? No documentation on troubleshooting.
16. **No explicit LLM-to-LLM handoff protocol.** When the compressor runs on
    Haiku and produces memories, how does the next session's Claude model know
    what those memories mean or whether to trust them? Is there a signature or
    version marker, or do we just assume all LLMs interpret the same way?

Here are points 17 to 24 by opus5.5 from webtemplates
A whole session went uncaptured. The first multi-hour session ran with capture off. On resume, uac_bootstrap returned about 46 tokens, which was one preference from another project. Nothing warned about this, and there's no way to import the work afterwards. git status and the chat were the only record.

Subagent edits aren't captured. Background agents changed dozens of files, but hooks only see the main session's tool calls. The fix I suggested: at bootstrap, attach git diff --stat since the session's start_commit. That column already exists.

SQLite works, with two operational problems.

hook-errors.log shows a "database is locked" error at SessionStart. Setting a busy_timeout would fix it.
The write-ahead log is about 3 MB against a 208 KB database, so it is never checkpointed. Running wal_checkpoint(TRUNCATE) on save would fix it.
This also answers your question: the store really is C:\Users\SRI\.uac\uac.db, and no extra package is needed.
Projects are identified by folder path, which splits memory.

tkd-app is registered twice under two folders. The old one holds 3 proposed memories that will never surface.
A Claude scratchpad temp folder was also registered as a project.
Suggested fix: identify projects by git remote and ignore temp folders.
SessionStart asks questions even in autonomous runs. That either blocks the work or gets skipped. I skipped it and used defaults: relevant tier, capture on. This repeats point 6.

A near-empty pack looks like a normal result. "~46 tokens" gave no hint the store was almost empty. The pack should say so and suggest /uac init.

The model switch wasn't recorded. The session kept one id across the Fable to Opus switch. There's no model column in sessions or events, so the model-signature idea in point 16 isn't possible today.

Agent-to-agent messaging is mostly covered already. Within Claude, SendMessage and subagent results already handle it. A UAC message board only helps across different tools, like Codex or Gemini, or across machines. Otherwise it isn't needed yet.

I also added a short "what worked" section. uac_capture on recorded 63 events right away. The schema already has start_commit, memory_versions and memory_relations, so points 8, 17 and 18 mostly need wiring, not new storage.

  what another llm mentioend 
  What actually helped:

Didn't re-derive architecture from scratch — loaded "no build, vendored libs, DOCX/PDF must match" instantly
Saved the 15-event session automatically
Remembers decisions across sessions
On a large multi-repo project, that'd be huge. On 1222 lines of vanilla JS in one dir? Modest.
What didn't help:

Memory is prose ("layout.js exports row-sizing math") not pointers to actual code — I still had to open files and find computeRowPlan
No staleness signal — had to manually verify all 4 memories were still accurate by reading source
Paraphrase drift — called a template "Standard Sub Jr-Senior", code says just "Association" — a grep for "Standard" finds nothing
Accumulating junk — checkpoint + pack + summary all exist separately; bootstrap re-ranks across fragments instead of one clean state
Can't load multiple packs in one call
Real use:
UAC is a session-spanning README, not a code cache. It's for "what did we decide" and "what's off-limits", not for "here are line numbers to edit". For this project, it saved a 10-minute re-orientation. For a 50-file backend with 4 databases and 3 APIs, it'd save an hour.

The friction points in that doc are legit and worth fixing, but they're not making UAC useless — just annoying for now.

Want to keep using it, or disable it for this session?


  ---- user questionsand find outs --
- u mentioned the first run turned on recording, loaded context, edited a file, saved a decision, and ran the uac-compressor subagent on Haiku.But how the another llm knows wat to run.
- the ui to pass respection chats or session to next chart is complicated as fromthe viewer user have to selccte the review, events, packs etc,also there i think once it is compressed that respective session content is replaced with updated or the compresssed version so again no need to compressi guess so.
- ticikng respective memories is complicated because as it is written by llm how can a user selects it, i mentioed based on the session , which session to pass in that major things, as using it complicated.
- also have u checked sqlite is workin else install a package.
- from the sessions with unique id's alone how to delte the session which are not necessary, even uac is off, deep/minimal etc is asking y?
- any delete is not working, is a session is clearted respective memory events etc. should be removed.
- what is the meaining i didn't get for these Pick a size (Minimal ~1k, Relevant ~4k, Deep ~10k, Fork, None) or a hand-picked pack, from the dashboard, the VS Code extension or the CLI. as half baked knowledge no need to provide to llm right.then y, if going to keep add some meaining fulll description.
- can inter communnication with agent is possible via uac, in general claude can do it. check and let me in the planis it required.
- does it really using the SQLite file (~/.uac/uac.db),as i see no folder lir that also , if SQLite file (~/.uac/uac.db), not working what other possibilites.
- what is the use of exe and when the uac install calude will be run, didn't get what u mean after readinthe reacme.
- in lcaude only skills will be shown then how these works Or use /uac pause|resume|stop|save|....?
- if earleir session is saved and it should auto review by haiku and accpt right , user have to do? if user how he knows what is crt and not?
- in cli version it will be more difficult as user have to see the id's and provide the pack and create checkpint it's difficult either provid eautorizationn to compress llm else show that in a text editor with yes no. etc..
- the main thing i asked fo thta feature is if session is selected then regarding everthing it shoudl laod with respective session right, suppose inital basic architeture of the application is loaded and now using that will start two sessions to work on two feature on two branches then it shoould start working and those llm which share a common project can share branch based enhancements and improvments right.
- once a new commit or earleir files got updated it should finally compress the exiting ones which it used  or not necessary u decide the complicated cases what we can do.
