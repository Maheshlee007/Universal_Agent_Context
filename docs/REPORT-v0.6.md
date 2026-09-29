# UAC status report: v0.5.1 → v0.6.0 (2026-09-30)

## Where we are
| Target | Installed version | Checked with |
|---|---|---|
| Claude Code plugin | 0.6.0 (`~/.claude/plugins/cache/uac/universal-agent-context/0.6.0/`) | `installed_plugins.json`; the new code is present in the cache |
| VS Code extension | 0.6.0 | `code --list-extensions --show-versions`; the bundled CLI has the new code |
| Git | `main` at `5609f48` (v0.6.0) | `git log` |

After an install, open windows need **Reload Window** (VS Code) or **/reload-plugins** (Claude Code).
- The extension ships the plugin's plain `.mjs` files (129 KB, no dependencies).
- A compiled or bundled build isn't needed: Node runs the files directly, and a build step would only add tooling.

## 1. uac-impromenets3.md: is every issue resolved?
Verified against the code by an independent agent (Sonnet), with live runs of the real hooks, CLI and MCP on an isolated store. Every row has a command it ran and its observed output. The three "partly" rows and one small bug it found were fixed afterwards (last column).

| # | Issue in the doc | Status | Evidence / what fixed it |
|---|---|---|---|
| 1 | `#n` numbers shift; header and `uac_get` disagree; unhelpful "unknown id"; no tool to list sessions | ✅ Resolved | Numbers stored per project (`sessions.seq`) and never move. `uac_get` takes `#2`, `2`, a short id or a full id. A bad ref lists the valid sessions. `uac_sessions` lists them all |
| 2 | Start context never says a deeper option exists | ✅ Resolved | Every start ends with `Loaded … Not loaded … Wider: <exact calls>`, or "Nothing else stored" |
| 3 | An active but unsaved session is invisible; default card ranked by save time | ✅ Resolved | An auto card or tail for unsaved work; the default pick goes by last activity |
| 4 | A session with no transcript is a silent dead entry | ✅ Resolved | Flagged "no raw log"; `uac_get raw` falls back to UAC's kept events |
| 5 | Scope marker missing; explicit scope ignored | ✅ Resolved | `[all projects]` and `[branch x]` tags; explicit scope honoured |
| 6 | Anchor ambiguity (a same-named file reopened a fixed memory) | ✅ Resolved | ✗ names same-named files as DIFFERENT files; `uac_verify` refuses; propose suggests "did you mean" |
| 7 | Compressor fails intermittently | ✅ Resolved | Step 0 ToolSearch; SubagentStop sends a non-saving compressor back; the Stop hook retries once. Foreground spawn (a background save is lost) |
| 8 | A malformed save deleted the raw events | ✅ Resolved | Refused before anything is deleted; the last 10 turns are kept |
| 9 | Near-duplicate knowledge piles up | ✅ Resolved | `uac_propose` refuses near-duplicates (`force` overrides); duplicate groups go to the compressor to merge; doctor counts them |
| 10 | Hooks and MCP on different versions; nothing says reload | ✅ Resolved | Version stamps; a "/reload-plugins" line on mismatch or a newer install; install never repoints to an older copy |
| 11 | A non-git subfolder became a new empty project | ✅ Resolved | Joins the nearest registered ancestor; read-only commands register nothing |
| 12 | Other projects' rows reachable by id | ✅ Resolved | Every by-id read and write is scoped to the project |
| 13a | No "N kept / M omitted" signal | ✅ Resolved in 0.6 | Chapters: nothing is omitted any more (the digest pages instead of cutting). Each chapter shows its event count, and `gaps` says what the model left out |
| 13b | "Why did this session know that" trace | Declined | `uac_why` and the retrieval log were removed as bloat in v0.5; the Loaded line says what was loaded |
| 13c | Preferences need "applies where" | ✅ Resolved | Required by the compressor rules; grouped as "apply only where stated" |
| 14 | Say that a subagent save is cheaper than inline | ✅ Fixed in 0.6 prep | The Stop text now says inline `uac_digest` stays in the conversation and is re-sent every turn |
| 15 | Backup/export story for the single global DB | ✅ Resolved (per-project DB declined) | `uac backup`, doctor integrity, and PROJECT.md with the recent chapters |
| 16 | PreCompact looks like a save | ✅ Fixed in 0.6 prep | After compaction: "Compaction is not a UAC save: N events still unsaved" |
| bug | PROJECT.md showed `#?` for a new session | ✅ Fixed | Numbers are assigned before the export |

Found in the final live runs and fixed:
- **0.5.2:** Haiku invented anchor symbols (e.g. `computeAnchorFreshness`). Those symbols are now dropped at write time, and the 4 affected memories in the real store were repaired.
- **0.6.0:** a long session's card lost its early work. Chapters, below.

## 2. What changed

### 0.5.1: rebuilt and installed both targets
The Claude plugin cache had been copied before the last v0.5 fixes, and VS Code was still on 0.4.0.
- The digest change made then (keep every user request when too long) was only a stopgap on the compressor's *input*.
- It is removed in 0.6.0 and replaced by paging.

### 0.5.2: invented anchor symbols
`fixAnchors` checks the symbol in every LLM-written anchor against its file (`save`, `uac_propose`, `uac_update`). A symbol that isn't there is dropped with a warning, and the file anchor is kept.

### 0.6.0: session chapters (the long-session fix)
**Problem:** every save *replaced* the session's one card, and Haiku had to rewrite the whole session each time. This repo's own 4-day, 5-save session ended with a 799-character card covering only the last hour.

**Design:** option A, chosen after an independent review by Fable and Opus (both picked A):
- **Every save is a permanent chapter** about only its own events. Chapters are never rewritten.
- **Open next steps are carried by code, not by the model.**
  - The digest sends them numbered.
  - The compressor returns `checkpoint.closed: [numbers]`.
  - UAC carries every item not closed forward, word for word, tagged `(open since chN)`. An item can't silently vanish.
- **Start context:** the latest chapter in full, `chapter N/N`, the session goal (from chapter 1), and one index line per earlier chapter (`s-id · time range · "title" · files`). The rule: "if your task touches their files, uac_get the chapter first". Same token budget as before.
- **Drill-down:** `uac_get {ids:["s-…"]}` opens one chapter (summary plus checkpoint). `uac_get` on a session lists all its chapters.
- **Paging:** when more than ~60K characters are unsaved, the digest stops at a page boundary. The rest becomes the next chapter at the next save, so nothing is cut out of the middle.
- **Old cards** show as "pre-chapter card, overlaps later ones". No migration needed.

**Deferred** (both reviewers agreed):
- a raw transcript slice per chapter
- an LLM-written whole-session overview (option B)
- merging tiny chapters

### 0.6.0: monorepos and several projects in one folder
- **Several repos in one parent folder:** these were already separate projects, and a folder holding 2 or more projects is never merged into one. Re-checked live (section 3).
- **One repo with several apps or packages** (Turborepo, pnpm/npm/yarn workspaces, lerna, Nx on workspaces; or Backend/ + Frontend/ with no root manifest): stays **one project**, but:
  - every session records the package it was started in (`sessions.area`)
  - every knowledge item belongs to the package its anchors are in; if they span packages it's repo-wide
  - **a session started inside a package** (e.g. `apps/web`) loads only that package's knowledge and cards plus repo-wide ones. The header says `package apps/web`, and the Loaded line counts "N knowledge items about other packages (uac_search finds them)"
  - **a session at the repo root** loads everything, with each item tagged `[in apps/api]`, so the LLM knows where it applies
  - `uac_sessions` shows each session's package

### Small fixes (0.6 prep)
- The Stop hook's save text states the cost of saving inline.
- After compaction, the start context says compaction is not a save.
- PROJECT.md now shows the latest chapter of each of the last 3 sessions, not 3 chapters of one session.

## 3. How it was tested
- **Unit tests:** 39/39 (34 core plus 5 adapter). New tests:
  - "chapters": two saves give two chapters; a closed item disappears and an open one carries verbatim; the start-context index; `uac_get` of a chapter; paging with no middle cut; a bad `closed` number gives a warning
  - "monorepo": pnpm workspace detection; the session area from its cwd; items filtered inside a package and tagged at the root; the Backend/Frontend fallback; a plain repo has no packages
  - "invented anchor symbol is dropped"
- **Independent verification** of the doc's issues (section 1): live hook, CLI and MCP runs on an isolated store.
- **Live Claude Code runs:**
  - v0.5.1: 5 real `claude -p` sessions on a create-webstack-app Fastify + React app. Covered the knowledge survey, a feature branch, a message, a merge, a fix, and a fresh session reconstructing the history. All passed, including the first live run of promote-on-merge.
  - v0.6.0: a live check of chapters (resume, save again), package scoping (a session inside `Frontend/`) and the parent folder with two repos. Results are in section 5.
- **Design review:** Fable and Opus, independently, as LLM consumers of the tool.

## 4. Not solved, and how it could be
| Item | Why not | How |
|---|---|---|
| A raw transcript slice per chapter | Deferred (YAGNI); `raw:true` on the session works while the host transcript exists | Filter the transcript by the chapter's `from_ts` to `created_at` in `rawLog` |
| Non-JS monorepos (Go `go.work`, Cargo `[workspace]`) | Only JS workspace configs are parsed; the manifest-folder fallback still covers most of these | Parse those two files in `packagesOf` |
| A session at the repo root working only in one package | It gets everything, tagged; there's no automatic narrowing | Narrow by the files touched once the first edits land |
| Session #1 shows "active" after `claude -p` | The host cancels SessionEnd on exit | Already handled: idle after 30 min, ended after 12 h, auto card at the next start |
| The Haiku compressor can overstate results | It writes prose UAC can't check against code | Anchors are checked (0.5.2); when results matter, put the facts in the compressor prompt |
| Gemini and Codex live runs | Headless Gemini hangs on this machine; Codex isn't installed | Covered by unit tests; run live when available |
| A per-project DB file | Declined: the risk was retrieval scoping (fixed), not SQLite | `uac backup` and PROJECT.md |

## 5. v0.6.0 live check results
The checks ran in parallel, each on its own isolated store, using the installed 0.6.0 plugin.

| Check | Result | Evidence |
|---|---|---|
| Parent folder with 2 repos (`parent/r1`, `parent/r2`) plus `r1/sub` | ✅ PASS | Real SessionStart hooks: `parent`, `r1` and `r2` became 3 separate projects, and `r1/sub` mapped to `r1`. Nothing was mixed |
