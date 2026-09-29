# UAC: how it's built (v0.5)

UAC is one local SQLite store, host hooks, an MCP server, a CLI and a dashboard. Every host (Claude Code, Gemini CLI, Codex, Cursor, Copilot CLI, Antigravity, VS Code) reads and writes the same store. The user sees two things only: **project knowledge** and **session cards**. See [PLAN-v3.md](PLAN-v3.md) and [PLAN-v5.md](PLAN-v5.md) for why. The MCP tool schemas are in `plugin/src/mcp.mjs`.

## Layout
```
.claude-plugin/marketplace.json   root marketplace, source ./plugin
plugin/                           what Claude Code installs (only this folder is copied into its cache)
  .claude-plugin/plugin.json      manifest, mcpServers inline (no root .mcp.json)
  hooks/hooks.json                SessionStart, UserPromptSubmit, PostToolUse(+Failure), SubagentStop, PreCompact, Stop, SessionEnd; 30 s timeouts
  agents/uac-compressor.md        the saving subagent (digest → reconcile → save)
  commands/uac.md                 /universal-agent-context:uac <action>
  skills/                         uac-protocol, uac-init-knowledge, uac-refresh, uac-review, uac-handoff, uac-yagni, uac-brainstorm
  bin/uac.mjs                     entry point (silences the node:sqlite warning, then src/cli.mjs)
  src/db.mjs                      open, schema + additive migrations, FTS5 (porter + trigram), WAL checkpoint, JSONL spool
  src/store.mjs                   projects (remote-keyed), sessions, cards, cascade delete, messages, memories, freshness, search, maintenance, PROJECT.md export
  src/pack.mjs                    start context, bootstrap, digest/save, auto cards, merge, rollup, handoff, version notes
  src/hook.mjs                    host-neutral hook handling, #uac controls; never throws into the host
  src/import.mjs                  rebuild events from a host transcript (#uac import)
  src/adapters/*.mjs              claude, codex, gemini, antigravity, cursor, copilot: normalize(), format(), install()
  src/mcp.mjs                     MCP stdio server (13 tools), hand-rolled JSON-RPC
  src/view.mjs                    dashboard HTTP API (127.0.0.1 + token)
  src/cli.mjs                     `uac` commands (numbered sessions, --json everywhere)
  viewer/viewer.html              dashboard, single file, vanilla JS
extension/                        VS Code extension; scripts/bundle-cli.mjs copies the whole plugin/ into extension/cli
scripts/                          lock-screen.ps1
test/                             node:test: core.test.mjs (end to end), adapters.test.mjs
docs/                             PLAN*, CONTRACT, INSTALL, PROTOCOL, FAQ, CHECKLIST, this file
```

## Data model
All tables live in `~/.uac/uac.db` (`%USERPROFILE%\.uac\uac.db` on Windows; `UAC_HOME` overrides it).

| Table | What it holds |
|---|---|
| `projects` | `id` (hash of the normalised git remote, else of the folder), `root`, `name`, `git_remote`, `mode` (`off` / `manual` / `automatic`; null = first run) |
| `sessions` | `id` (the host's session id), `seq` (stable per-project #n), `agent`, `model`, `branch`, `start_commit`, `capture` (`on` / `paused` / `off` / `ask`), `status`, `title`, `transcript_path`, `saved_event_id`, `quality` (`auto` / `llm`), `loaded` (what the start context loaded), `ctx_at` (start context delivered), `rolled_into`, `prompts`, `last_active_at`, `save_asked` / `save_retry`, `hook_version` / `mcp_version` (which UAC served it) |
| `events` | Redacted, clipped raw events: `prompt`, `tool`, `tool_fail`, `subagent`, `assistant`, `pending` (typed before opt-in), `card` (a merged/rolled-up card). Deleted by a successful LLM save. |
| `summaries` + `checkpoints` | The **card** of a session = its latest summary (title, body, `quality`, `model`) + latest non-superseded checkpoint (goal, working, broken, files, next steps, note). Checkpoint triggers: `save`, `auto`, `precompact`, `manual`. |
| `memories` | Project knowledge. `type` (architecture, decision, constraint, requirement, lesson, fact, warning, task, preference, idea), `scope` (`user` / `project` / `branch`), `status` (proposed → active → stale / conflict → superseded / archived), `confidence`, `pinned`, `muted`, **anchors** `[{file, symbol, line}]`, **hashes** (content hash per anchored file), `verified_commit`, `last_verified_at`, **provenance** (`source`, `source_agent`, `source_session`, `source_model`, `resolved_by`, `resolved_at`) |
| `memory_versions` / `memory_relations` | Every title/body change; `supersedes` / `contradicts` links |
| `messages` / `message_reads` | Cross-agent notes to `all`, `branch:<b>` or `session:<id>`, read once per session |
| `settings` | One-shot `next_sessions`, maintenance stamps, the versions hooks/MCP last ran (`running:hooks`, `running:mcp`) |
| `retrievals`, `packs` | Legacy (v0.2–0.4). Still in the schema and cleaned up by deletes; nothing writes them since v0.5 |

## Flows

### Start injection (no MCP call needed)
```
SessionStart hook ─► ensureSession (branch, start_commit, capture from mode) ─► startContext
  maintain (hourly): expire proposals (7 d), end sessions idle 12 h, mark ⚠/✗ stale
  auto cards for other sessions' unsaved work: live, ended or idle 30 min (no LLM); promoteBranches (every start)
  bootstrap: chosen cards (one-shot `uac next` / dashboard tick) or the most recently active session on this branch
           + must-not-violate + project knowledge (ranked, with anchors, freshness, source model)
           + unread messages (before the knowledge) + other active branches + the Loaded/Not loaded/Wider line   ≈2K tokens (6K with #uac deep), ≤9K chars
  first run: one question (automatic / manual / off); resume: token-cost tip
─► hook marks ctx_at. If the host killed the hook first (timeout), the first prompt re-delivers the start context.
```
Hosts without SessionStart (Antigravity) get it on the first prompt the same way.

### Capture
- `UserPromptSubmit`: `#uac …` controls are applied first, with no model involved. Then the prompt is stored if recording is on, or stored as `pending` in `ask` state (kept on opt-in, deleted on opt-out). Unread messages are injected.
- `PostToolUse`: tool name + target + a clipped response. UAC's own MCP calls, TodoWrite and similar tools are skipped. Tool calls inside subagents are skipped; `SubagentStop` keeps the subagent's final message, and the git diff covers its edits.
- `Stop`: the last assistant message. In automatic mode, after 40 unsaved events, it blocks once with the save instruction.
- `PreCompact`: a deterministic ≤2 KB checkpoint. After compaction the start context is re-injected with that snapshot.
- `SessionEnd`: status `ended`, auto card if ≥3 unsaved events, WAL checkpoint.
- Every stored text is redacted (secrets, `<private>…</private>`, e-mail and IP). The redaction is code-aware: `token: string`, `secret: env.JWT_SECRET` and `token = getToken()` are kept. `.uacignore` + defaults (`.env*`, `*.pem`, …) hide file targets. If the DB is locked, events go to `~/.uac/spool.jsonl`.

### Save (replaces events)
```
#uac save | Stop block | /uac save ─► model spawns uac-compressor (other hosts: inline) ─► uac_digest
   digest: unsaved events (over 60K chars: tool lines dropped, then head + every user request + tail), git diff --stat since start_commit (+ untracked),
           recheck = memories anchored to touched files, existing-memory index
─► compressor reconciles ─► uac_save {summary, checkpoint, candidates[op add|update|supersede|conflict|verify|noop], model}
   · the auto card is replaced by the LLM card; the session title becomes the card title
   · the new checkpoint supersedes older ones of this session and the ones it loaded on the same branch
   · confidence ≥ 0.7 and no conflict → active (resolved_by auto-policy / compressor); else proposed; conflicts link `contradicts`
   · raw events up to upto_event_id are DELETED; quality = llm; PROJECT.md export; WAL truncate
```
Sessions that end without an LLM save get a deterministic **auto card** (first prompt + changed files + diff stat + failures + last reply). Their events are kept until an LLM save refines it (`#uac save <n>`).

### Freshness
- At write, update and verify time, UAC stores a content hash (CRLF-normalised) of every anchored file.
- At load, each memory is: **✗** if an anchored file or symbol is missing; **⚠** if a file's current hash differs; **✓** otherwise. The commit count since verification is shown next to ⚠.
- Hashes, not commit counts, decide. So committing already-verified work doesn't flag it. Legacy rows (before v0.3.1) get a one-time baseline from the first commit after they were written.
- ⚠/✗ items are ranked lower and marked `stale` by maintenance. They return to `active` when the code matches again, or when `uac_verify` / the dashboard's verify / the compressor's `op:verify` confirms them.

### Branches
- Each session records its branch and start commit. The default card is the latest one on the **same branch**.
- Memories written on a non-default branch are `scope=branch` and are loaded only on that branch.
- `promoteBranches` (every start) makes them `project` when the branch is merged into the default branch, also after the branch was deleted if its memories' commits are in the default branch. A squash-merged, deleted branch can't be proven merged: its knowledge stays branch-scoped.
- "Other active branches" lists up to 5 branches with sessions in the last 14 days: title, agent, age, files. Branches merged into the current one are labelled "(merged into `<branch>`)" and listed last.
- Messages reach matching sessions at their next prompt, in any host.

### Merge and rollup
- **Merge** (`mergeSessions`): moves events, summaries, checkpoints, memories, retrievals and messages of the source sessions into the target; adds one `card` event per source card; deletes the emptied sessions; builds a combined auto card. The next save writes one LLM card.
- **Rollup** (`rollup`): creates a new `rollup-…` session whose events are the source cards (oldest first). The sources get `rolled_into` and are hidden from lists and numbering, but kept (`--all` / "show rolled-up"). `#uac save <n>` writes the single combined card.
- **Delete** (`deleteSession`): events, summaries, checkpoints, retrievals, message reads and the memories whose `source_session` is this session. `sessionImpact` shows the counts first. `cleanupEmpty` removes sessions with no events, card or memories that are older than 30 minutes.

## Why `.mjs`, and why plain JavaScript instead of TypeScript
- **`.mjs`:** it's ESM regardless of the nearest `package.json`. The same files are copied into the Claude plugin cache and into the VS Code extension (whose `package.json` is CommonJS). A `.js` file would silently turn into CommonJS there and break. With `"type":"module"` alone, `.js` would work only in the repo root.
- **No TypeScript (yet):**
  - Hooks run straight from source with plain `node`: no build step, no `dist/` to keep in sync, and no dependencies.
  - The code base is about 2.5k lines.
  - To add types later without a build, use `// @ts-check` + JSDoc, and `tsc --noEmit --checkJs` in CI.
  - Moving to real `.ts` would bring back an esbuild step for every consumer (plugin, extension).

## Verified vs not verified (2026-09-28)

| Area | Evidence |
|---|---|
| Core flows | `npm test`: `node:test` suites using real hook subprocesses, real MCP stdio, the real HTTP API and real git branch/merge/diff. They cover hooks, capture, save, knowledge, freshness, branches, messages, cascade deletes, dashboard API, MCP and all six adapters. |
| **End-to-end run (Claude Code, headless)** | A real `claude -p` run on an Express project scaffolded with `create-webstack-app`: |
| · first run | The start context asked the one first-run mode question (automatic / manual / off). |
| · knowledge survey | A knowledge survey (`uac-init-knowledge`) seeded memories with `file`/`symbol` anchors. |
| · parallel branches | Sessions on `feature/auth` and `feature/theme`: each loaded the shared knowledge plus its own branch card, and listed the other branch under "Other active branches". |
| · messages | A `#uac msg to branch:feature/theme …` from the auth session was delivered once at the theme session's next prompt (cross-branch). |
| · merge → promotion | After merging a feature branch, its branch-scoped memories became project knowledge on `main`. |
| · rename → ✗ | Renaming an anchored symbol made its memory show ✗ at the next start. |
| · continue-from | `#uac continue <n>` loaded the chosen card into a new session. |
| · cascade delete | `uac rm` removed the session's events, card rows and created memories, checked by querying SQLite directly. |
| · dashboard API | The dashboard HTTP API was checked against the live server on the same data. |
| Dashboard in VS Code | Deletes use two-step buttons, because `confirm()` returns false in the webview (the root cause of "delete doesn't work"). |
| Gemini, Codex, Cursor, Copilot, Antigravity | Unit tests (normalize, format, idempotent install) and simulated payloads through the real binary. See the limitations. |

### Bugs the e2e run found (all fixed, v0.3.1)
1. **Start context lost on hook timeout.** The host killed a slow SessionStart hook, so the session never got its context. Fix: the hook records `ctx_at` only after writing its output, and the first prompt re-delivers the start context when it is missing. Git calls are cached per hook process (a start ran ~12 git commands), and hook timeouts went to 30 s.
2. **Commit-count freshness gave false positives.** Memories are written at session end, *before* the work is committed, so the commit that landed the verified work flagged its own memory ⚠. Fix: content hashes per anchored file; ⚠ now means the content really changed.
3. **`token: string` was redacted.** Key/value secret redaction ate TypeScript types and code. Fix: code-aware redaction keeps types, env references, calls and member access, and only redacts values that look like secrets.
4. **Merged branches looked active.** "Other active branches" listed a branch that had already been merged. Fix: merged branches are labelled "(merged into …)" and sorted last.
5. **The session model was overwritten** by the compressor's model on save. Fix: the card records the compressor's model; the session keeps its own.
6. **Sessions were listed as "(untitled)".** Fix: labels fall back to the title, then "agent session, N events, no card", always with age.

## v0.4 changes

Full reasoning and the point-by-point triage: [PLAN-v4.md](PLAN-v4.md).

- **Phantom sessions.** Hosts start a new session id on a window reload or re-opened panel, even though the user resumes the old conversation into a different session. A session with no prompts, no events, no card and no title is a phantom (`PHANTOM` query, `isPhantom`, `store.mjs`): hidden from lists/numbering right away, deleted at `SessionEnd`, and purged (`purgePhantoms`) once ended or a day old. `sessions.prompts` (incremented on every real prompt, even in `manual`/`off` mode) is what tells a phantom apart from a real session that just wasn't recorded.
- **Host-injected prompt classification.** `hook.mjs` recognizes turns the host injects rather than the user typing (`<task-notification>`, `<agent-message>`; `INJECTED` regex, plus `stripReminders` for `<system-reminder>`/local-command echoes). These are stored as a short `notice` event, not a `prompt`: no `#uac` control parsing, no title/goal candidate. The host's own compaction-summary `SubagentStop` is skipped by content heuristic (marked `ponytail:` — switch to an explicit agent-type check if the host ever exposes one).
- **Snapshot vs. card precedence, and the unsaved tail.** `card()` (`pack.mjs`) prefers `save`/`auto`/`manual` checkpoints over a `precompact` snapshot, so a mid-session compaction no longer outranks the session's real card. After compaction, the start context re-injects this session's own card plus a snapshot built from events since the last save (the "After this card (unsaved)" tail).
- **Save concurrency guard.** `uac_digest` returns `base_event_id` alongside `upto_event_id`; `save()` (`pack.mjs`) rejects a save whose `base_event_id` is behind the session's current `saved_event_id`, so two saves racing on the same session (e.g. a manual `#uac save` and an automatic Stop-hook save) can't silently clobber each other.
- **Stop-hook backoff.** `sessions.save_asked` records the event id at which the Stop hook last asked for a save. It only re-asks once another `STOP_THRESHOLD` (40) events have piled up, instead of blocking on every Stop after one failed/skipped save.
- **`sessions.prompts` / `last_active_at`.** Real activity now updates `last_active_at` (throttled to once a minute) independent of recording state, so "most recently active session" (the MCP default when no `session_id` is given) and phantom detection both work even in `manual`/`off` mode.
- **Grouped bootstrap.** `startContext` (`pack.mjs`) renders project knowledge grouped under headings (Must not violate · Decisions · Warnings · Lessons · Architecture · Facts · Open tasks · Preferences) instead of one flat list, and says `Loaded: N cards · M items · ~T tokens` (v0.5 replaced this with the "Loaded … Not loaded … Wider" line).
- **`how_to_save`.** `uac_digest` embeds a self-contained save recipe in its response, so a general-purpose agent (or the main agent, if the compressor subagent can't be spawned) can save correctly without reading any other doc.

## v0.5 changes

Full reasoning, including what was declined: [PLAN-v5.md](PLAN-v5.md).

- **Stable session numbers (`sessions.seq`).** `assignSeq` (`store.mjs`) gives a session the next per-project number once it stops being a phantom (its first real prompt), in start order. The number never changes. `ref()` prints `#n shortid` (first 8 characters of the id) in the header, cards, tools, CLI, dashboard and extension. Merging projects renumbers the source project's sessions after the target's.
- **One resolver.** `resolveSessionRef` accepts `#n`, `n`, the full id or a unique prefix of 6+ characters, only within the current project. Hook controls, MCP tools, CLI and dashboard all use it. A miss throws `sessionRefError`, which lists valid sessions so the retry is one call.
- **Project scoping.** `ownMemory` makes every by-id read and write act only on this project's memories (user-scope rows, `project_id` NULL, are shared on purpose). `save()` rejects candidates naming another project's memory. `projectFor` maps a non-git subfolder to the nearest registered ancestor (never the home folder or a drive root) and, with `create:false`, read-only CLI commands never register a project. An existing session always uses its own project, even if the cwd moved.
- **Save validation.** `invalidCard` (`pack.mjs`) refuses a save whose `summary` isn't an object with a title, or whose `checkpoint` lacks a goal plus next steps or a note, before anything is written or deleted. The `base_event_id` guard from v0.4 stays. After a save the last 10 prompt/assistant events are kept (`KEEP_TURNS`) as the fallback raw log; they are not injected. The compressor's step 0 is a literal ToolSearch; SubagentStop sends a compressor back once if its reply doesn't start with "UAC saved:", and the Stop hook asks for one retry when a requested save didn't land (`save_retry`).
- **Version stamps.** Each process reads its own `plugin.json`. Hooks stamp `hook_version` and the MCP server stamps `mcp_version` on the session they serve. `versionNotes` adds one line ("Tell the user: type /reload-plugins") when they differ or a newer version is installed. `adapters/claude.mjs install` never repoints the `uac` marketplace at an older copy at another path, and runs `plugin update` after the marketplace refresh. The extension offers "Reload Window" after it updates. `uac doctor` prints all versions.
- **Branch versions.** An update or supersede of a project memory from a feature-branch session is stored as a branch memory with a `supersedes` link. On that branch the bootstrap shows only the branch version; elsewhere the original. `promoteBranches` runs at every start: when the branch is merged, its memories become project scope and the originals they supersede are marked superseded.
- **Start context.** Other sessions' unsaved work gets a deterministic auto card (or a tail snapshot) at every start; a session with no event for 30 min (`IDLE_MS`) counts as idle, and maintenance marks it ended after 12 h. The default card is the most recently active session on the branch. Messages render before the knowledge so the clip can't drop one already marked read. One computed line ends the context: `Loaded … Not loaded … Wider: <exact calls>` or "Nothing else stored". Anchor ✗ is split into file missing / symbol not in file; `verifyMemory` refuses while an anchored file is missing. Scratch folders get one "off here" line instead of silence.
- **Message delivery rule** (`unreadMessages`). A message is delivered once per recipient session: to sessions that were open when it was posted, and, if nobody has read it yet, to the next session that starts. Later sessions don't see it. A `session:<ref>` message always reaches that session. Messages older than 14 days are not delivered. `deleteMessage` backs the dashboard's 🗑.
- **Dedup.** `nearDuplicate` (word-set Jaccard on title + body, ≥ 0.6, same type) makes `uac_propose` refuse a near-duplicate unless `force:true`. The digest's `duplicates` are clusters, not pairs.
- **Removed.** MCP tools went from 19 to 13: `uac_pack` and packs, v0.2 tiers and `uac choose`, `uac_why` and the retrieval log, `uac_checkpoint`. `uac_timeline` became `uac_sessions`; `uac_invalidate` folded into `uac_update` (status `superseded`), `uac_resolve` into `uac_review {resolve}`, `uac_messages` into `uac_message` (no text = read). Also removed: the dashboard's "Advanced" section and "Recently auto-accepted" (replaced by a "new" pill), the single-executable build (`scripts/build-sea.mjs`), dead helpers.
- **`.context/PROJECT.md`** now also carries the last 3 LLM session cards, so a clone or a lost `~/.uac` still has them.

## v0.5.1 changes
- **Large-session digest** (`digest`, `pack.mjs`): see Known limitations 6. Regression test: "large session digest keeps every user request".
- Version bump so the Claude plugin cache (`~/.claude/plugins/cache/uac/universal-agent-context/0.5.1/`) and the VS Code extension carry every v0.5 fix; the 0.5.0 cache was copied before the last fixes landed.

## v0.5.2 changes
- **Invented anchor symbols are dropped at write time** (`fixAnchors`, `store.mjs`; used by `save`, `uac_propose`, `uac_update`). The final live run showed Haiku quoting symbols that are not in the file (e.g. `computeAnchorFreshness`); stored as is, every later reader saw "✗ symbol gone". Now the file anchor is kept, the symbol is dropped and the save returns a warning. Test: "invented anchor symbol is dropped".

## Known limitations
1. **Gemini live test blocked:** headless `gemini -p` hangs on this machine even with UAC's hooks removed. The install and the adapter are unit-tested only.
2. **Codex isn't installed** here, so the Codex adapter is unit-tested only (and new hooks must be trusted with `/hooks` in Codex).
3. **Cursor and Copilot prompt hooks can't inject text.** The start context comes from their `sessionStart`; `#uac` controls are applied, but their replies aren't shown.
4. **Antigravity's PreInvocation** carries no prompt text, so its prompts aren't captured (tool events are).
5. **SessionEnd in `claude -p`** is often cancelled because the process exits first. It's harmless: the next start builds the auto card.
6. **Very long sessions:** over 60K characters the digest drops plain tool lines first (`diff_stat` still lists every changed file), then keeps the head, every user request (clipped) and the tail. Replies and tool results in the middle are lost; map-reduce over chunks is the upgrade path.
7. **Not built:** the scored recall@k benchmark, importers for claude-mem / claude-remember / CLAUDE.md, a cost meter, and the `.uac/policy.yml` files from PLAN-v2 §16.
8. **Host transcripts** can be deleted by the host. The raw log then falls back to the last 10 turns UAC keeps after a save.
9. **Reload:** a plugin can't run `/reload-plugins`; running sessions keep the old version until the user types it or restarts.
