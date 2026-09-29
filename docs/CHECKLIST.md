# UAC requirements checklist (v0.5, 2026-09-29)

Every requirement and feedback point in the project, with its status and where it lives. Each ✅ was checked against the code with grep. `uac` = `node plugin/bin/uac.mjs`. Code paths are relative to `plugin/src/` unless they are given in full.

✅ done (how to use it) · ⚠ partial (what is missing) · ❌ not done (why)

## 1. Original goals (PLAN.md §1)

| Goal | Status | How to use / where |
|---|---|---|
| Works across Claude Code, Codex, Gemini, Antigravity, Cursor, Copilot | ⚠ | Six adapters (`adapters/*.mjs`), `uac install`. Claude was verified live; the others are unit-tested only (see ARCHITECTURE "Known limitations"). |
| Opt-in recording; pause / resume / stop at any time | ✅ | Mode per project (`uac mode off\|manual\|automatic`), `#uac on\|off\|pause\|resume\|stop` (`hook.mjs` CONTROL) |
| Compression by a cheap LLM into structured summaries | ✅ | `uac-compressor` subagent (`plugin/agents/uac-compressor.md`, `model: haiku`) → `uac_digest` / `uac_save` (`pack.mjs` digest/save) |
| User can view, edit and delete everything | ✅ | `uac view` dashboard, `uac session <n>`, `uac edit <id>`, `uac forget <id>`, `uac rm <n>` |
| Choose what to load at start (all / selected / budget) | ✅ | Changed in v0.3: you pick **sessions** (`#uac continue <n…>`, `uac next <n…>`, dashboard tick); knowledge is always loaded; `#uac deep` loads more. There is no user-facing token budget, by design. |
| Holistic project knowledge built once by a strong model, loaded by every session, updated after features land | ✅ | `uac-init-knowledge` skill (`/universal-agent-context:uac init`); loaded by `bootstrap`; kept current by the digest `recheck` + `op:verify\|update` at every save |
| MCP server + skills so any LLM can read and update the store | ✅ | `mcp.mjs` (13 tools since v0.5), `plugin/skills/*`, `docs/PROTOCOL.md` for hosts without skills |

## 2. Extra features (PLAN.md §14)

| # | Feature | Status | Where / note |
|---|---|---|---|
| 1 | Consent, pause, inline `#uac pause` | ✅ | `hook.mjs` CONTROL |
| 2 | Context packs for parallel sessions | ✅ (changed) | Packs were removed in v0.5. Parallel sessions pick session cards (`#uac continue <n…>`, `uac next`) and see "Other active branches". |
| 3 | Branch knowledge promoted on merge | ✅ | `store.mjs` `promoteBranches()` (every start since v0.5; also after the branch is deleted, if its commits are in the default branch) |
| 4 | Staleness from git | ✅ | Content hashes + anchors, `store.mjs` `freshness()`; shown as ✓ ⚠ ✗ |
| 5 | Temporal facts: invalidate, history, undo | ⚠ | `uac_update {status:"superseded"}` (was `uac_invalidate`), `memory_versions`, `GET /api/memories/:id` returns versions. No "restore old version" button in the dashboard. |
| 6 | Reconciliation ADD / UPDATE / INVALIDATE / NOOP | ✅ | `uac_save` candidate ops `add\|update\|supersede\|conflict\|verify\|noop` (`pack.mjs` save) |
| 7 | Todo carry-over at the top of the start menu | ⚠ | Next steps are in the card ("Next: …") and `task` memories are loaded as knowledge. There is no separate todo section. |
| 8 | Decision log with the why | ✅ | `decision` memories with `why`; the "Decisions" section in `.context/PROJECT.md` |
| 9 | YAGNI gate skill | ✅ | `plugin/skills/uac-yagni` (decision + `review_when`) |
| 10 | Brainstorm mode, saved as ideas | ✅ | `plugin/skills/uac-brainstorm` (type `idea`, never loaded as fact) |
| 11 | Consolidation (roll up old summaries) | ✅ | `uac rollup [--all]`, `#uac rollup`, dashboard "Roll up into one card" (`pack.mjs` rollup). On demand only, not every N sessions. |
| 12 | `doctor` | ⚠ | `uac doctor`: DB path, sizes, integrity, FTS5, WAL, counts, hook errors. It doesn't audit oversized or orphaned memories. |
| 13 | Cost meter (cost per compression) | ❌ | Not built. The subagent runs inside the host session, so UAC never sees the price. |
| 14 | Import from claude-mem, claude-remember, CLAUDE.md | ⚠ | Only the host transcript import is built (`uac import`, `#uac import`, `import.mjs`). The other importers aren't built: nobody asked for them yet. |
| 15 | Two scopes: user profile + project | ✅ | `preference` → `scope=user`, plus `project` and `branch` (`store.mjs` propose) |
| 16 | Privacy: `<private>`, secret redaction, excludes, forget | ✅ | `util.mjs` `redact()` (code-aware), `.uacignore` + defaults, `uac forget` |

## 3. Decisions and packaging (PLAN-v2 §16–19)

| Item | Status | Where / note |
|---|---|---|
| §16.1 Modes per project, asked once | ✅ | `off` / `manual` / `automatic`; the first-run question is in `pack.mjs` startContext |
| §16.2 Compression in-session by a subagent, no API key | ✅ | `uac-compressor` (Haiku); other hosts save inline |
| §16.3 `.context/PROJECT.md` export (to commit) | ✅ | `store.mjs` exportProjectMd, rewritten on every save/edit; `uac export`. Committing it is your step. |
| §16.4 `.uac/policy.yml` + `.uac/policy.local.yml` | ❌ | Not built. The only policy (auto-accept at confidence ≥ 0.7, 20 proposals per session, 7-day expiry) is in `store.mjs` constants. No one has needed to change it. |
| §16.5 Name "Universal Agent Context", prefix `uac` | ✅ | Everywhere |
| §17 Extension: status bar, click to toggle | ✅ | `extension/extension.js` createStatusBarItem |
| §17 Extension: QuickPick at session start | ✅ | Changed: starts no longer ask anything. "UAC: Continue from session…" (multi-select) picks the next session's cards. |
| §17 Extension: trees, review badge, webview, notifications | ✅ | Sessions / Knowledge / Review trees; dashboard webview; "N proposals to review" and "UAC message from …" notifications |
| §17 Extension as installer | ✅ | "UAC: Install for detected tools"; re-runs `uac install` after an extension update |
| §17 Extension watches for new sessions | ✅ | Polls every 3 s, messages every 10 s |
| §17 Publish to Marketplace / Open VSX | ❌ | Not published. Install the `.vsix` by hand (INSTALL §5). |
| §17 One VSIX per platform with a bundled binary | ⚠ | The VSIX bundles the `.mjs` plugin, so it needs Node ≥ 22.13 on PATH (or `uac.nodePath`) |
| §19 `node:sqlite` driver | ✅ | `db.mjs`; no npm packages |
| §19 `better-sqlite3` fallback driver | ❌ | Dropped: `node:sqlite` works everywhere we tested, and a native module would bring back an install step |
| §19 JSONL spool when the DB is locked | ✅ | `~/.uac/spool.jsonl`, imported on the next open (`db.mjs` spool) |
| §19 Single executable | ❌ removed | Removed in v0.5: its dashboard hung (Node single-executable issue) and nobody shipped it. Node 22.13+ is required. |
| §19 FTS5 missing → `LIKE` search | ✅ | `store.mjs` search (`hasFts`) |
| §18 Database MCP server | ❌ | A separate project, parked on purpose (not part of UAC) |

## 4. Field feedback (UAC-IMPROVEMENTS.md points 1–24 and the proposals)

| # | Point | Status | How to use / where |
|---|---|---|---|
| 1 | Memory is prose, not pointers | ✅ | Anchors `[{file, symbol, line}]`, shown as `computeRowPlan@src/layout.js:42` (`store.mjs` fmtAnchors); the compressor and init skill must fill them |
| 2 | No staleness signal at load | ✅ | ✓ / ⚠ / ✗ per item, with "(N commits)" next to ⚠ (`pack.mjs` fresh) |
| 3 | Paraphrase drift: quote identifiers verbatim | ✅ | Rule in `uac_propose`, the compressor and init skill; anchor symbols are checked with a text search (✗ if not found) |
| 4 | Resolution provenance (panel vs. tool vs. auto) | ✅ | `resolved_by` = auto-policy / compressor / user-dashboard / user-cli / user-tool / ttl-expired, plus `resolved_at` (`store.mjs` resolve) |
| 5 | Cheap "still true" action | ✅ | `uac_verify {ids}`, dashboard Verify, compressor `op:verify` (`store.mjs` verifyMemory) |
| 6 | Start always asks before doing anything | ✅ | No questions except the one-time mode choice; context is injected by the hook |
| 7 | Session titles are generic | ✅ | Auto-named from the first prompt, compressor title on save, `#uac name` / `uac name` / dashboard ✎ |
| 8 | Checkpoints and packs pile up | ✅ | Save supersedes loaded checkpoints on the same branch; merge and rollup combine sessions |
| 9 | Bootstrap takes one pack at a time | ✅ | `uac_bootstrap {sessions:[…]}`, `#uac continue 2 5` (packs removed in v0.5) |
| 10 | Tier descriptions are vague | ✅ | Tiers removed (v0.3); their leftovers and `uac choose` removed in v0.5 |
| 11 | No agent-to-agent communication | ✅ | `#uac msg`, `uac msg`, `uac_message` (no text = read), dashboard Messages; delivered at the next prompt |
| 12 | Memory curation is opaque | ✅ | Pin / mute / verify / edit / delete in the dashboard; `uac edit`, `uac forget` |
| 13 | Session cleanup and cascade unclear | ✅ | `uac rm <n> [--dry-run]`, `uac rm --empty`, dashboard two-step delete; cascade in `store.mjs` deleteSession |
| 14 | Handoff is cluttered | ✅ | `/uac handoff` (uac-handoff skill, `uac_handoff`), then `#uac continue <n>` |
| 15 | Is SQLite verified? Locked or corrupt DB? | ✅ | `uac doctor`, `uac backup`, spool fallback; troubleshooting in INSTALL §9 |
| 16 | LLM-to-LLM trust, model signature | ⚠ | `source_model` on memories and cards, shown as "(by …)"; every model gets "claims to verify". There is no special warning when the loading model differs from the writer. |
| 17 | A whole session went uncaptured | ✅ | `#uac import`, `uac import <n>`; the start context counts sessions that weren't recorded |
| 18 | Subagent edits aren't captured | ✅ | `git diff --stat` since `start_commit` + untracked files in the digest and the auto card (`pack.mjs` diffSince) |
| 19 | "database is locked", WAL never checkpointed | ✅ | `busy_timeout` before WAL (`db.mjs`); `wal_checkpoint(TRUNCATE)` on save, at session end and in doctor |
| 20 | Messaging mostly covered inside Claude | ✅ | Built anyway for cross-tool and cross-branch use (point 11) |
| 21 | Projects keyed by folder path; temp dirs registered | ⚠ | Keyed by git remote, scratch dirs skipped (`store.mjs` projectFor, isScratch). **Duplicates that already exist aren't merged by themselves:** run `uac projects` then `uac projects merge <from> <into>`, or use the dashboard. |
| 22 | A near-empty pack looks normal | ✅ | "UAC knows almost nothing about this project yet … init" under 150 tokens |
| 23 | Model switch not recorded | ✅ | `sessions.model` (from the hook payload), `summaries.model`, `memories.source_model`; a save no longer overwrites the session model |
| 24 | Start asks questions in autonomous runs | ✅ | Same as 6. Unanswered first run: nothing recorded, no blocking. |
| — | Tiered memory by volatility | ✅ | Cards hold the changing state and knowledge holds the durable facts; decisions, lessons, constraints and requirements don't decay (`store.mjs` DECAY_EXEMPT) |
| — | "N commits touched this file since" | ✅ | `commits_since` in freshness |
| — | Confidence decay as a gradient | ✅ | `decayed()`: 23-day half-life, divided by (1 + 0.25 × commits since) |
| — | Test SQLite in CI | ⚠ | `npm test` covers the store end to end, but there's no CI pipeline (no `.github/`) |
| — | Other fallbacks (in-memory cache, cloud sync) | ❌ | Not planned: the spool covers locks; cloud sync is out of scope (local-first) |

## 5. The user's questions (end of UAC-IMPROVEMENTS.md)
Full answers are in [FAQ.md](FAQ.md).

| Question | Status | Answer / where |
|---|---|---|
| How does another LLM know what to run? | ✅ | The hook injects the context; the save instruction is plain text; PROTOCOL.md for hosts without hooks; auto card if nobody saves |
| Passing sessions to the next chat is complicated | ✅ | Session cards with "Continue from this in next session"; `#uac continue <n>` |
| Once compressed, replace the content (no need to compress again) | ✅ | A save deletes the raw events (`pack.mjs` save `events_removed`) |
| Ticking memories is complicated | ✅ | No ticking; knowledge is always loaded; pick sessions |
| Is SQLite working, or install a package? | ✅ | `node:sqlite`, no package; `uac doctor` |
| Delete unneeded sessions by id; why ask Deep/Minimal when off? | ✅ | Numbers (`uac rm 4`), `--empty`; `off` shows one line, no questions |
| Deletes don't work; clear events and memories too | ✅ | Two-step buttons (the webview `confirm()` bug); cascade delete, verified in SQLite in the e2e run |
| What do Minimal / Relevant / Deep mean? | ✅ | Removed; FAQ explains what is loaded now |
| Is inter-agent communication possible or needed? | ✅ | Built: `#uac msg` / `uac_message` |
| Is `~/.uac/uac.db` real? Other options? | ✅ | `C:\Users\SRI\.uac\uac.db` (a dot folder, created on first use); spool, LIKE, backup |
| What is the exe for; when does `uac install claude` run? | ✅ | The exe was removed in v0.5; install: INSTALL §3, FAQ |
| Only skills show in Claude; how do `/uac …` commands work? | ✅ | `/universal-agent-context:uac <action>`, or `#uac …` everywhere |
| Auto-review by Haiku; how does the user know what is correct? | ✅ | Compressor = reviewer, ≥ 0.7 auto-accept, only conflicts/uncertain wait; provenance + anchors + ✓⚠✗ |
| The CLI is hard (ids, packs); use a text editor with yes/no | ✅ | Numbered commands; `uac review` y/n/e/s; `uac edit` in `$EDITOR` |
| Load the chosen session; base architecture + two feature branches share work | ✅ | Branch cards, "Other active branches", branch → project promotion on merge, messages; e2e verified |
| After new commits, update the existing knowledge | ✅ | Digest `recheck` → verify / update / retire at every save; content-hash freshness |

## 6. New asks (v0.3.2)

| Ask | Status | How to use / where |
|---|---|---|
| Closed unsaved session → automatic card; start context says so; `#uac save <n>` writes a full card | ✅ | `pack.mjs` autoCard + startContext "Unsaved previous session(s)"; `hook.mjs` `case 'save'` with a number |
| Dashboard marks empty sessions "empty · can delete" | ✅ | `plugin/viewer/viewer.html` pill + "Delete empty sessions"; `empty` flag in `store.mjs` listSessions |
| Merge sessions / cards | ✅ | `uac merge <n…> --into <n>`, `POST /api/sessions/merge`, dashboard tick → Merge (`pack.mjs` mergeSessions) |
| Compress all sessions into one | ✅ | `uac rollup --all`, `#uac rollup`, `POST /api/sessions/rollup`, dashboard "Roll up into one card"; sources hidden (`uac sessions --all`, "Show rolled-up sessions") |
| Knowledge updated after enhancements, not stale | ✅ | Digest `recheck`; content hashes (`store.mjs` hashFile / freshness) |
| Resume is expensive: explain, and tip at start | ✅ | Tip when the resumed transcript is over ~20K tokens (`pack.mjs` startContext, `source === 'resume'`); FAQ |
| Session names: automatic, better after save, rename | ✅ | `#uac name <title>`, `uac name "<title>" [--session n]`, `PUT /api/sessions/:id {title}`, dashboard ✎ |
| VS Code extension icon | ✅ | `extension/package.json` `"icon": "media/icon.png"`, generated by `extension/scripts/make-icon.ps1`; activity-bar icon `media/uac.svg`. Rebuild the VSIX to ship it (the built `universal-agent-context-0.3.1.vsix` is older than these files). |
| Documentation: FAQ, architecture, checklist | ✅ | `docs/FAQ.md`, `docs/ARCHITECTURE.md`, this file |

## 7. v0.4 (UAC-improvements2.md + user observations)

Source: [PLAN-v4.md](PLAN-v4.md). "Where" gives file + function.

| Item | Status | Where |
|---|---|---|
| U1 Empty stale sessions after a window reload | ✅ | `sessions.prompts` counter; phantom query `PHANTOM` and `isPhantom` (`pack.mjs`); purged at `ensureSession` / SessionEnd; hidden from `listSessions` (`store.mjs`) |
| U2 Subagent/host-injected turns recorded as user prompts | ✅ | `INJECTED` regex + `stripReminders` (`hook.mjs`); non-user turns stored as a short `notice` event, not a prompt; compaction-summary SubagentStop skipped |
| U3 Save launched the default model, not Haiku | ✅ | `saveInstruction` names `subagent_type "uac-compressor"` and `model "haiku"` explicitly (`hook.mjs`/`pack.mjs`); `uac_digest` returns `how_to_save` so any agent can save without the subagent |
| U4 Knowledge tab cluttered | ✅ | Accordion by type, one group open (`viewer.html`) |
| U5 Work after a card save; precompact outranking the checkpoint | ✅ | `card()` prefers save/auto/manual checkpoints over `precompact` (`pack.mjs`); after compaction, this session's own card + an unsaved-events tail are re-injected |
| B1 Type/scope invisible in bootstrap | ✅ | `startContext` renders grouped sections: Must not violate · Decisions · Warnings · Lessons · Architecture · Facts · Open tasks · Preferences, `[branch x]` tags (`pack.mjs`) |
| B2 Tasks can't be closed; `uac_update` can't change type | ✅ | `updateMemory` accepts `type`/`status`; status `done` stored as archived + `resolved_by` (`store.mjs`); compressor op `done` (`pack.mjs save`) |
| B3 No limit on bootstrap | ✅ (small) | `limit` / `budget_tokens` in the `uac_bootstrap` tool schema (`mcp.mjs`) |
| B4 Stale tasks never reconciled | ✅ | `open_tasks` in `uac_digest` (`pack.mjs`); compressor closes or updates them |
| B5 Anchor ✗ without a hint; alternates | ✅ hint / ❌ alternates | propose/update/verify suggest a git-matched alternate path (`store.mjs`); "any of" alternates skipped — one clear anchor is enough, and it's a rare case |
| B6 Compressor fails with the bare prompt | ✅ | Root cause = U3; self-describing `uac_digest` + agent file says "first call is always uac_digest" |
| B7 Raw events hard-deleted | ✅ (changed from plan) | `uac_get {raw:true}` / `uac session <n> --raw` read the **host's own transcript** (`rawLog`, `import.mjs`), not a UAC-side archive. The plan's `event_archive` table was dropped: the transcript is already the full-fidelity original, and a second UAC copy would extend how long sensitive text is retained |
| B8 Knowledge store only grows | ✅ | Compressor op `supersede` with `ids:[…]` merges duplicates into one memory; `uac_digest` returns `duplicates` (Jaccard title overlap) for the reviewer (`pack.mjs`) |
| Extra: verify on PostToolUse | ❌ skip | Freshness already recomputes from content hashes on every load; PostToolUse can't talk to the model and would add latency for no reader |
| Extra: "why did it know that" | ✅ | v0.5: one "Loaded … Not loaded … Wider" line (`pack.mjs bootstrap`, see §8 A4) |
| Extra: preference `applies_when` | ✅ (instruction, no field) | Compressor/propose rules require the body to state where a preference applies; rendered under "Preferences (apply only where stated)" |
| Extra: SessionStart should offer a choice | ✅ (kept from v0.3) | Start states the default and the one-line override; no blocking question |
| Extra: card size vs decisions; say what was dropped | ✅ | `checkpoints.gaps` column; rendered as "Not in this card: …" (`store.mjs`, `pack.mjs`) |
| Extra: link, don't merge, related sessions | ✅ | Card shows "continues #3"; `done` op links a task to its resolving session |
| Priority 6: verify hooks really fire | ✅ (verification only) | Live DB evidence found U1/U2/U5; no code change by itself |
| Priority 7: dashboard grouped by type/scope/verification | ✅ | Same as U4, plus scope pill and per-group freshness counts (`viewer.html`) |
| Priority 8: cross-client rules files | ❌ skip | The doc assumed Claude-only; UAC already ships live hook adapters for six hosts. A static rules file would duplicate that context (double tokens) and go stale. `PROTOCOL.md` stays for hosts without hooks |
| C: `limit` (from UACE) | ✅ | Same as B3 |
| C: "commits since this card" | ✅ | One git call per bootstrap, rendered under each card (`fmtCard`, `pack.mjs`) |
| C: file watcher (from UACE) | ❌ skip | `PostToolUse` + `git diff` since session start already see every edit, including subagents' |
| D: Stop-hook nag loop | ✅ | `sessions.save_asked`; re-asks only after another `STOP_THRESHOLD` (40) events (`hook.mjs`) |
| D: controls/goal text from subagent or harness | ✅ | Fixed at the source: prompt classification (`INJECTED`, same as U2) |
| D: two windows, phantom purge race | ✅ | Purging an open phantom is harmless; its first real prompt re-creates it via `ensureSession` |
| D: manual/off sessions with 0 events but real | ✅ | `sessions.prompts` keeps them out of the phantom query even with no recorded events |

## 8. v0.5 (uac-impromenets3.md + user asks)

Source: [PLAN-v5.md](PLAN-v5.md). Code paths are relative to `plugin/src/`.

| Item | Status | Where |
|---|---|---|
| A1 `uac_get "#2"` gave "unknown id" | ✅ | One resolver `resolveSessionRef` (`#n`, `n`, full id, 6+ char prefix, this project only) for hooks, MCP, CLI and dashboard; `sessionRefError` lists the valid sessions (`store.mjs`) |
| A2 `#n` drifted | ✅ | `sessions.seq`, assigned once by `assignSeq` when a session stops being a phantom; `ref()` prints `#n shortid` everywhere (`store.mjs`, `db.mjs`) |
| A3 No MCP tool lists sessions | ✅ | `uac_sessions` replaces `uac_timeline` (`mcp.mjs`) |
| A4 Start context never says what was left out | ✅ | One "Loaded … Not loaded … Wider" line, or "Nothing else stored" (`pack.mjs bootstrap`) |
| A5 Live or unsaved sessions invisible | ✅ | Auto cards for other sessions' unsaved work at every start; default card by last activity; "live"/"ended" labels; idle after 30 min without events (`pack.mjs startContext`, `store.mjs IDLE_MS`) |
| A6 Sessions with no transcript are dead entries | ✅ | `raw` flag in `listSessions`; "Wider" offers raw only where it exists; `uac_get raw` falls back to the last 10 kept turns (`pack.mjs KEEP_TURNS`) |
| A7 Scope marker missing; repo preference became global | ✅ | An explicit scope wins in `propose`; user-scope items tagged `[all projects]` (`store.mjs`, `pack.mjs`) |
| A8 Anchor ambiguity reopened a memory from another file | ✅ | ✗ split into "file missing" / "symbol not in file"; same-named files listed as DIFFERENT files; `verifyMemory` refuses while an anchored file is missing (`store.mjs anchorHints`, `freshness`) |
| A9 Compressor failed intermittently | ✅ | Literal ToolSearch step 0 in the agent file and the spawn prompt; SubagentStop blocks a reply without "UAC saved:"; the Stop hook asks for one retry (`agents/uac-compressor.md`, `pack.mjs compressorPrompt`, `hook.mjs`) |
| A10 A malformed save deleted all raw events | ✅ | `invalidCard` refuses before any write; the last 10 prompt/reply events are kept (`pack.mjs save`) |
| A11 Near-duplicate knowledge piles up | ⚠ | Clustered `duplicates` in the digest; `uac_propose` refuses a near-duplicate unless `force:true` (`store.mjs nearDuplicate`, `mcp.mjs`). The planned duplicate count in `uac doctor` is not there |
| A12 Hooks and MCP on different versions | ✅ | Each process reads its own plugin.json; `hook_version` / `mcp_version` stamps; one "type /reload-plugins" line (`pack.mjs versionNotes`, `hook.mjs`); install never repoints to an older copy (`adapters/claude.mjs`); the extension offers Reload Window; `uac doctor` shows all versions |
| A13 Non-git subfolder became a new project | ✅ | Nearest registered ancestor (never home or a drive root); read-only CLI commands don't register projects (`store.mjs projectFor`, `cli.mjs`) |
| A14 Other projects' rows reachable by id | ✅ | `ownMemory` scopes reads and writes; foreign candidate ids in a save are rejected (`store.mjs`, `pack.mjs save`) |
| A15 Compact/resume from a moved cwd loaded another project | ✅ | An existing session always uses its own project (`hook.mjs handle`) |
| A16 The clip could cut messages already marked read | ✅ | Messages rendered before the knowledge, never clipped (`pack.mjs bootstrap`) |
| A17 Hooks silent in Temp/claude folders | ✅ | The start context says so in one line; `UAC_ALLOW_SCRATCH=1` (`hook.mjs`, `store.mjs isScratch`) |
| B Dashboard Refresh button | ✅ | `#refresh` (`viewer/viewer.html`) |
| B Messages refresh every 5 s without touching the composer | ✅ | 5 s poll (`viewer.html`) |
| B Delete a message (two-step 🗑) | ✅ | `DELETE /api/messages/:id` (`viewer.html`, `view.mjs`, `store.mjs deleteMessage`) |
| B Scrolling message list | ✅ | Messages tab (`viewer.html`) |
| B "Recently auto-accepted" removed | ✅ | A "new" pill on items auto-accepted in the last 7 days, inside their group (`viewer.html`) |
| B Reload after an update | ✅ | Same as A12; README and FAQ say how |
| B 19 MCP tools cut to 13 | ✅ | Removed `uac_pack` + packs, tiers + `uac choose`, `uac_why` + the retrieval log, `uac_checkpoint`; `uac_timeline` → `uac_sessions`; `uac_invalidate` → `uac_update`; `uac_resolve` → `uac_review`; `uac_messages` → `uac_message` (`mcp.mjs`) |
| B Dashboard "Advanced" section, single-exe build, dead helpers | ✅ removed | `viewer.html`; `scripts/build-sea.mjs` deleted |
| B README rewritten | ✅ | `README.md` |
| C Inject the last ~10 raw turns at every start | ❌ declined | Every reader would pay ~1K tokens each session for a rare need. They are kept (A10); the card's "after this card" tail and `raw:true` cover it |
| C Per-project database files | ❌ declined | The risk was retrieval scoping (A14), not SQLite. `uac backup` and PROJECT.md (now with the last cards) are the recovery path |
| C Periodic LLM merge pass over knowledge | ❌ declined | It could silently destroy distinct facts. Write-time dedup and the save-time duplicates list cover it |
| C Automatic `/reload-plugins` | ❌ declined | A host slash command a plugin cannot run |
| C Merge "merge" into "rollup" | ❌ declined | The user asked for both |
| C Remove the brainstorm and YAGNI skills | ❌ declined | The user asked for both |

| v0.5.1 Large-session digest keeps every user request | ✅ | `digest` in `plugin/src/pack.mjs`, test "large session digest…" |
| v0.5.1 Extension and Claude plugin rebuilt and installed | ✅ | VSIX 0.5.1 installed; plugin cache `0.5.1/` |

## 9. Not done, in one list
- Cost meter (§14.13): the host session runs the compressor, so UAC can't see its price.
- claude-mem / claude-remember / CLAUDE.md importers (§14.14): no demand yet.
- `.uac/policy.yml` files (PLAN-v2 §16.4): the defaults haven't needed changing.
- `better-sqlite3` driver: not needed.
- Marketplace / Open VSX publishing of the extension.
- Database MCP server: a separate, parked project.
- A CI pipeline; the scored recall@k benchmark.
- Live tests for Gemini (headless hangs on this machine) and Codex (not installed).
- v0.4: verify-on-PostToolUse — freshness already comes from content hashes at load time; no call needed.
- v0.4: anchor alternates ("any of" a memory anchors several files) — one clear anchor is enough for the rare cases seen so far.
- v0.4: cross-client static rules files — would duplicate the live hook-injected context and go stale.
- v0.4: a file watcher — `git diff` since session start plus `PostToolUse` already cover every edit.
- v0.4: a UAC-side raw-event archive (`event_archive`) — replaced by reading the host transcript (`uac session <n> --raw`, `uac_get {raw:true}`), since the transcript is already the full-fidelity original and a second copy would extend retention of sensitive text.
- v0.5: the declined items of §8 C (raw turns at every start, per-project DB files, a periodic LLM merge pass, automatic `/reload-plugins`).
- v0.5: a squash-merged, deleted branch can't be proven merged; its knowledge stays branch-scoped.
- v0.5: `uac doctor` doesn't count duplicate pairs yet (PLAN-v5 A11 says it does).
