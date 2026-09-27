# UAC v0.3: rethink after real use (2026-09-28)

Inputs: [UAC-IMPROVEMENTS.md](UAC-IMPROVEMENTS.md), which has the Haiku, Sonnet and Opus field notes (points 1–24), plus the user's 14 questions.

## Verdict: same repo, new version (not a new project)
- **What held up in real use (and is kept):**
  - The SQLite store (`C:\Users\SRI\.uac\uac.db` is real, and `node:sqlite` needs no package)
  - Hooks and MCP
  - In-session compression
  - Git staleness checks and branch promotion
- **What failed is the user-facing model:** item-level ticking, tiers with no meaning, questions at every start, deletes that don't work, review burden.
- These are changes in the product layer, not the storage layer. Rewriting from scratch would throw away tested code for no gain. So v0.3 reshapes the UX and restructures the repo.

## The new mental model: **sessions** and **project knowledge**
Users think "continue from *that* session" and "every session should know the architecture". So there are only two things a user ever picks or sees:

1. **Project knowledge**
   - Typed, anchored facts (architecture, decisions, constraints, lessons…).
   - Maintained by the compressor: accepted automatically, fixed automatically when code changes.
   - **Always** loaded in compact form. The user never ticks memories.
2. **Session cards**
   - One compressed card per saved session: a specific title, what was done, current state, next steps, decisions, files, branch, commit range.
   - After compression **the raw events are deleted.** The card *replaces* them, so there's nothing to compress again (this was the user's point).
   - Users pick **sessions** to continue from (one or several), not packs or memories.

Packs, tiers and events become internal plumbing: still there, but hidden unless you go looking.

## Triage: every item, and its decision

| # | Feedback / question | Decision in v0.3 |
|---|---|---|
| Q1 | "How does another LLM know what to run?" | **The hook injects the context itself** (it bootstraps inside SessionStart, or the first prompt where there's no SessionStart). No MCP call is needed to load. The save instruction is plain text in the Stop-hook reason and the injected header, and it names the host-specific way to do it (a subagent on Claude, inline `uac_digest`→`uac_save` elsewhere). Hosts without MCP get `docs/PROTOCOL.md` in AGENTS.md/GEMINI.md. If no LLM ever saves, a **deterministic session card** is built from the events (no LLM), so nothing is lost. |
| Q2, Q3, 14 | Passing sessions to the next chat is complicated; ticking memories makes no sense; handoff is cluttered | The dashboard, extension and CLI are **session-centric**: a list of session cards, each with a "Continue from this" toggle (multi-select), which becomes the next session's context. Memory ticking and pack building are removed from the main UI. "Handoff" = "Continue in another session/branch/agent" = mark this session as next. |
| Q2b | Once compressed, the content should be replaced | Yes. A successful save deletes that session's raw events (`retention.keep_events=false`, the default). The card and the memories remain. |
| Q4, Q9, 15, 19 | Is SQLite really working? Where is it? Fallbacks? | It's working, at `%USERPROFILE%\.uac\uac.db` (`C:\Users\SRI\.uac`). **Fixes:**<br>• `busy_timeout` now comes *before* the WAL pragma. That order bug caused the "database is locked" error at SessionStart.<br>• `wal_checkpoint(TRUNCATE)` runs on save and at session end, which fixes the 3.2 MB write-ahead log.<br>• `uac doctor` shows the path, sizes, `integrity_check` and FTS5.<br>• `uac backup` added.<br>• Fallback: the JSONL spool (exists). No other package is needed. `better-sqlite3` isn't needed and would break the single-file exe. |
| Q5, 6, 24 | Asks about Deep/Minimal even when UAC is off; always asks before doing anything; asks during autonomous runs | **No questions by default.** Modes:<br>• `off`: one line, nothing loaded, nothing recorded.<br>• `manual`: loads knowledge and this branch's latest card automatically, but records nothing until `#uac on`.<br>• `automatic`: loads automatically and records.<br>The **only** question is the first-run mode choice, asked once per project. If the user doesn't answer, it defaults to `manual`. Changing what's loaded is done with `#uac fresh`, `#uac continue <n>`, or the pickers. |
| Q6 | Session delete, cascade | Deleting a session **cascades**: its events, card (summary + checkpoints), retrievals, and the memories *created only by that session*. The confirmation shows the counts. Bulk "delete empty sessions" (0 events, no card). CLI `uac rm <n\|id>…`, `uac rm --empty`. |
| Q6b | "Any delete is not working" | **Root cause:** the viewer guarded every delete with `confirm()`, which returns false inside the VS Code webview, so nothing happened. Replaced with inline two-step buttons ("Delete" → "Confirm delete"). Tested inside the webview path. |
| Q7, 10 | What do Minimal/Relevant/Deep mean? Half-baked context shouldn't go to the LLM | Tiers are **no longer user-facing**. The load is always: project knowledge (compact, anchored, with freshness shown) + the chosen session cards + "must not violate" rules. If a user asks for more (`/uac load deep`), the header explains what's in it. A **near-empty store is shown as such**, with a suggestion to run `/uac init` (point 22). |
| Q8, 11, 20 | Agent-to-agent communication | **Cheap and cross-tool, so it's in.** `uac_message {to: 'all' \| branch \| session, text}` stores a note. The next UserPromptSubmit of any matching session (Claude, Codex, Gemini…) injects it once. Inside Claude alone, SendMessage and subagents already cover this; UAC's value is **across tools and across parallel branches**. |
| Q10 | What's the exe for? When does `uac install claude` run? No instructions | New **docs/INSTALL.md** with per-host steps, what gets written where, and how to verify. `uac install` with no argument **detects** installed hosts (claude, gemini, codex, cursor, code) and installs for each. The exe is only for machines without Node 22.13+. It's optional and experimental (its dashboard hangs, a Node single-executable issue). |
| Q11 | In Claude only skills show; how do `/uac …` commands work? | Plugin commands are namespaced: `/universal-agent-context:uac pause`. INSTALL.md says so. **Recommended everywhere:** inline `#uac pause \| resume \| on \| off \| save \| stop \| fresh \| continue <n>`, which the UserPromptSubmit hook handles in every host, with no model involved. |
| Q12, 4 | Auto-review by Haiku? How does a user know what's correct? Provenance of resolutions | **The compressor is the reviewer.** It reconciles against the existing knowledge and the diff. Items with confidence ≥ 0.7 and no conflict are **accepted automatically in both modes**. Only **conflicts and low-confidence items** wait for a human. Every resolution records `resolved_by` (auto-policy / compressor / user-dashboard / user-tool / user-cli) and `resolved_at`. The dashboard has "Recently auto-accepted", with undo and "wrong → invalidate". |
| Q13 | The CLI is hard (ids, packs) | Numbered lists everywhere: `uac sessions` shows 1..n and `uac next 2 3` takes those numbers. `uac review` is **interactive** when run in a terminal (y / n / e opens the editor / s skip). No ids needed. |
| Q14 | Load the chosen session(s); base architecture + two feature branches; branches share enhancements | **Branch-aware continuity:**<br>• Every session is tagged with its branch and start commit.<br>• Default load = project knowledge + **this branch's** latest card.<br>• A separate "Other active branches" section lists each other branch's latest title, files touched and last activity, so parallel sessions know what the others are changing.<br>• Branch-scoped knowledge is promoted to project knowledge when that branch is merged (exists), and the next session everywhere sees it.<br>• Messages (Q8) let parallel sessions warn each other. |
| Q15 | After new commits, update the existing knowledge | The **compressor re-verifies**: its digest includes the stale memories whose anchored files changed in this session's diff, and it must verify, update or invalidate each one. At load time, each memory shows freshness: "✓ verified" / "⚠ file changed N commits ago" / "✗ symbol not found". `uac_verify` bumps "still true" without writing a new version (point 5). |
| 1, 3 | Memory is prose, not pointers; paraphrases drift | Memories carry **anchors** `[{file, symbol, line}]`. The compressor is told to quote identifiers **verbatim** (greppable) and to fill in anchors. At load, anchors are checked (file exists, symbol present) and shown as `computeRowPlan@src/layout.js:42`. |
| 2, 26 | No staleness at load; confidence should decay as a gradient | Each item shows commits since it was verified (`git rev-list --count <commit>..HEAD -- files`). Ranking decays by commits, not only by days. |
| 7 | Session titles are generic | The compressor writes "verb + object + outcome" titles. Deterministic cards use the first prompt plus the top changed files. The list shows branch · files · decisions count. |
| 8 | Checkpoints and packs pile up | On save, the checkpoints this session *loaded* on the same branch are marked `superseded_by` the new card. The "current state" is one card per branch. History stays browsable. |
| 9 | Bootstrap takes one pack at a time | `uac_bootstrap {sessions:[...], packs:[...]}` takes lists; the results are merged, de-duplicated and ranked. |
| 13 | Curation: star, mute | Memories get `pinned` (star, exists) and `muted` (never loaded, kept). There are dashboard toggles. |
| 16, 23 | LLM signature; model switches aren't recorded | Sessions record `model` (from the hook payload when present). `uac_save` takes a `model` field, and memories store `source_model`. The pack shows "(by claude-haiku-4-5)" per item. Other LLMs get this rule: treat memory as a claim to verify, not a fact; anchors plus freshness make verifying cheap. |
| 17 | A whole session wasn't captured (capture off); no way to import afterwards | `uac import [session]` reads the host transcript (`transcript_path`, which is stored for every session even when capture is off), **only when asked**, and then the normal save runs. The start menu also says "N sessions ran without capture — `#uac import` to recover". |
| 18 | Subagent edits aren't captured | The digest and the deterministic card include `git diff --stat <start_commit>` plus uncommitted changes. That covers edits made by subagents or background agents. |
| 21 | The same repo is two projects; temp folders are registered | Projects are **identified by git remote** when there is one (same remote = same project, and the root is updated). Claude scratchpad and temp folders are never registered. `uac projects` lets you merge and delete. The existing split `tkd-app` is merged by a migration. |
| 22 | A near-empty pack looks normal | When a pack is under 150 tokens, the header says "UAC knows almost nothing about this project yet → /uac init". |
| — | Dev-repo `uac` MCP "Connection closed"; the plugin cache copied `dist/` | Repo restructure: the plugin lives in **`plugin/`**. The marketplace source is `./plugin`, and there's no root `.mcp.json`. Only the plugin folder is copied into Claude's cache. |
| — | Try `npx create-webstack-app` as a test bed | An end-to-end scenario on a scaffolded app, run by a subagent/headless session: base architecture session (init) → two branches with parallel sessions → messages → merge → promotion → deletes. |

## Explicitly not doing (and why)
- **Vectors / embeddings:** anchors and verbatim identifiers make BM25 + trigram search precise. No recall gap has been observed.
- **Cloud sync:** out of scope, local-first.
- **Rewriting in TypeScript:** it would reintroduce a build step for the plugin, extension and exe. JSDoc + `// @ts-check` is the path if types become necessary.

## Repo layout v0.3
```
plugin/                 ← what Claude Code installs (marketplace source ./plugin)
  .claude-plugin/plugin.json   (mcpServers inline)
  hooks/hooks.json  agents/  commands/  skills/
  bin/uac.mjs  src/  viewer/viewer.html
extension/              VS Code extension (bundles ../plugin/{bin,src,viewer})
scripts/                build-sea.mjs, lock-screen.ps1
test/                   node:test
docs/                   PLAN-*, ARCHITECTURE, INSTALL, PROTOCOL, CONTRACT
.claude-plugin/marketplace.json
```
