# UAC: how it's built (v0.3)

UAC is one local SQLite store, host hooks, an MCP server, a CLI and a dashboard. Every host (Claude Code, Gemini CLI, Codex, Cursor, Copilot CLI, Antigravity, VS Code) reads and writes the same store. The user sees two things only: **project knowledge** and **session cards**. See [PLAN-v3.md](PLAN-v3.md) for why, and [CONTRACT.md](CONTRACT.md) for the exact APIs.

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
  src/pack.mjs                    start context, bootstrap, digest/save, auto cards, merge, rollup, handoff, packs
  src/hook.mjs                    host-neutral hook handling, #uac controls; never throws into the host
  src/import.mjs                  rebuild events from a host transcript (#uac import)
  src/adapters/*.mjs              claude, codex, gemini, antigravity, cursor, copilot: normalize(), format(), install()
  src/mcp.mjs                     MCP stdio server (19 tools), hand-rolled JSON-RPC
  src/view.mjs                    dashboard HTTP API (127.0.0.1 + token)
  src/cli.mjs                     `uac` commands (numbered sessions, --json everywhere)
  viewer/viewer.html              dashboard, single file, vanilla JS
extension/                        VS Code extension; scripts/bundle-cli.mjs copies the whole plugin/ into extension/cli
scripts/                          build-sea.mjs (optional exe), lock-screen.ps1
test/                             node:test: core.test.mjs (end to end), adapters.test.mjs
docs/                             PLAN*, CONTRACT, INSTALL, PROTOCOL, FAQ, CHECKLIST, this file
```

## Data model
All tables live in `~/.uac/uac.db` (`%USERPROFILE%\.uac\uac.db` on Windows; `UAC_HOME` overrides it).

| Table | What it holds |
|---|---|
| `projects` | `id` (hash of the normalised git remote, else of the folder), `root`, `name`, `git_remote`, `mode` (`off` / `manual` / `automatic`; null = first run) |
| `sessions` | `id` (the host's session id), `agent`, `model`, `branch`, `start_commit`, `capture` (`on` / `paused` / `off` / `ask`), `status`, `title`, `transcript_path`, `saved_event_id`, `quality` (`auto` / `llm`), `loaded` (what the start context loaded), `ctx_at` (start context delivered), `rolled_into` |
| `events` | Redacted, clipped raw events: `prompt`, `tool`, `tool_fail`, `subagent`, `assistant`, `pending` (typed before opt-in), `card` (a merged/rolled-up card). Deleted by a successful LLM save. |
| `summaries` + `checkpoints` | The **card** of a session = its latest summary (title, body, `quality`, `model`) + latest non-superseded checkpoint (goal, working, broken, files, next steps, note). Checkpoint triggers: `save`, `auto`, `precompact`, `manual`. |
| `memories` | Project knowledge. `type` (architecture, decision, constraint, requirement, lesson, fact, warning, task, preference, idea), `scope` (`user` / `project` / `branch`), `status` (proposed → active → stale / conflict → superseded / archived), `confidence`, `pinned`, `muted`, **anchors** `[{file, symbol, line}]`, **hashes** (content hash per anchored file), `verified_commit`, `last_verified_at`, **provenance** (`source`, `source_agent`, `source_session`, `source_model`, `resolved_by`, `resolved_at`) |
| `memory_versions` / `memory_relations` | Every title/body change; `supersedes` / `contradicts` links |
| `messages` / `message_reads` | Cross-agent notes to `all`, `branch:<b>` or `session:<id>`, read once per session |
| `retrievals` | What each start context loaded and why (`uac_why`) |
| `packs`, `settings` | Power-user packs; one-shot `next_sessions`, hourly maintenance stamps |

## Flows

### Start injection (no MCP call needed)
```
SessionStart hook ─► ensureSession (branch, start_commit, capture from mode) ─► startContext
  maintain (hourly): expire proposals (7 d), promote merged-branch memories, mark ⚠/✗ stale
  auto cards for ended, unsaved sessions (no LLM)
  bootstrap: chosen cards (one-shot `uac next` / dashboard tick) or the latest card on this branch
           + must-not-violate + project knowledge (ranked, with anchors, freshness, source model)
           + other active branches + unread messages      ≈2K tokens (6K with #uac deep), ≤9K chars
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
   digest: unsaved events (head+tail if >60K chars), git diff --stat since start_commit (+ untracked),
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
- Maintenance promotes them to `project` when the branch is merged into the default branch, and archives them when the branch is deleted unmerged.
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
  - Moving to real `.ts` would bring back an esbuild step for every consumer (plugin, extension, exe).

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
| Single executable | Hooks, CLI, MCP and FTS5 work inside `dist/uac.exe`. The dashboard doesn't (see below). |

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
- **Grouped bootstrap.** `startContext` (`pack.mjs`) renders project knowledge grouped under headings (Must not violate · Decisions · Warnings · Lessons · Architecture · Facts · Open tasks · Preferences) instead of one flat list, and opens with `Loaded: N cards · M items · ~T tokens` so the reader knows what it got before reading it.
- **`how_to_save`.** `uac_digest` embeds a self-contained save recipe in its response, so a general-purpose agent (or the main agent, if the compressor subagent can't be spawned) can save correctly without reading any other doc.

## Known limitations
1. **Exe dashboard:** anything that waits on the event loop (the HTTP server, timers) hangs inside the Node single executable on this Windows machine. Even a 5-line server hangs, so it's the runtime, not UAC. Use `node plugin/bin/uac.mjs view`.
2. **Gemini live test blocked:** headless `gemini -p` hangs on this machine even with UAC's hooks removed. The install and the adapter are unit-tested only.
3. **Codex isn't installed** here, so the Codex adapter is unit-tested only (and new hooks must be trusted with `/hooks` in Codex).
4. **Cursor and Copilot prompt hooks can't inject text.** The start context comes from their `sessionStart`; `#uac` controls are applied, but their replies aren't shown.
5. **Antigravity's PreInvocation** carries no prompt text, so its prompts aren't captured (tool events are).
6. **SessionEnd in `claude -p`** is often cancelled because the process exits first. It's harmless: the next start builds the auto card.
7. **Very long sessions:** the digest keeps head + tail over 60K characters. Map-reduce over chunks is the upgrade path.
8. **Not built:** the scored recall@k benchmark, importers for claude-mem / claude-remember / CLAUDE.md, a cost meter, and the `.uac/policy.yml` files from PLAN-v2 §16.
