# Universal Agent Context (UAC)

UAC gives coding agents memory across sessions, branches and tools: Claude Code, Codex, Gemini CLI, Cursor, Copilot and Antigravity. It runs locally. It needs Node 22.13+ and no npm packages.

## The problem
- A new agent session forgets everything the last one learned.
- Resuming an old conversation (`claude --resume`) re-sends all of it, often 50K–200K tokens.
- Two windows or two branches working on the same repo don't know about each other.

## What UAC does
- Records each session through the host's hooks and turns it into a short **session card**: what was done, what works, what is broken, next steps, files.
- Keeps **project knowledge**: decisions (with the why), constraints, warnings, lessons, facts, open tasks. Each item is anchored to code (`computeRowPlan@src/layout.js:42`) and marked ✓ / ⚠ / ✗.
- Injects the latest card and the knowledge into every new session, about 2K tokens. No tool call and no question at start.
- Says in one line what it loaded, what it left out, and the exact call to get more.
- Shows other active branches and passes messages between sessions, in any tool.
- Lets you see, edit and delete everything: a dashboard, a CLI, and `#uac …` controls in the chat.

## How it works
```
 session A (any host)                                    ~/.uac/uac.db (SQLite)
   hooks record prompts, tool calls, replies  ─────────►  events
   at save: a cheap subagent (Haiku on Claude)
     reads the digest + git diff, then writes ─────────►  session card + anchored knowledge
                                                           (re-checks memories whose files changed)
 session B starts
   hook injects: card of the latest session on  ◄──────  cards, knowledge, messages
   this branch + knowledge + other branches + messages
   each memory marked  ✓ file unchanged · ⚠ file changed since · ✗ file or symbol gone
 session B ── uac_message / #uac msg ──► session A (delivered once, at its next prompt)
```
If no LLM ever saves a session, UAC builds an **auto card** from the recorded events (no LLM). Nothing is lost.

## Install
```
git clone https://github.com/Maheshlee007/Universal_Agent_Context.git
cd Universal_Agent_Context
node plugin/bin/uac.mjs install     # finds Claude/Codex/Gemini/Cursor/Copilot/Antigravity/VS Code, installs for each
node plugin/bin/uac.mjs doctor      # DB path, integrity, full-text search, versions of hooks/MCP/CLI
```
- Keep the clone where it is: hooks point at it. Re-run `install` after moving it.
- **VS Code extension:** status bar, Sessions/Knowledge/Review trees and the dashboard in a panel. Build and install the `.vsix` as in [INSTALL.md §5](docs/INSTALL.md).
- Restart your agent after installing.
- **After updating UAC:** open Claude Code sessions keep the old version. Type `/reload-plugins` in each (or run "Reload Window" in VS Code). New sessions use the new version. If versions differ, the start context tells you.

Below, `uac` means `node <repo>/plugin/bin/uac.mjs`. Per-host details, uninstall and troubleshooting: [INSTALL.md](docs/INSTALL.md).

## First run
The first session in a project asks one question, once:

| Mode | What happens |
|---|---|
| automatic | Loads context, records the session, saves by itself |
| manual | Loads context. Records only after `#uac on`, saves on `#uac save` |
| off | Does nothing (one line says so) |

Until you answer, nothing is recorded. Change it later with `uac mode …` or in the dashboard's Project tab.

## A typical day

**1. Start a session** on `feature/auth`. The hook injects the context. Trimmed example:
```
# UAC · my-app · branch `feature/auth` · mode automatic · recording ON · this session 4c1e09ab (session_id=4c1e09ab-…)
Memory = claims to verify, not facts: ✓ checked against code · ⚠ file changed since · ✗ anchor gone. Judge a memory only at its anchored path; …

## Continuing from (most recent session on this branch)
### #7 3f9a21c0 · feature/auth · claude (claude-opus-5-5) · 2h ago
**Add per-user login rate limiter in src/auth.js** _(from 91 events)_
Working: limiter blocks the 6th attempt · Next: add a test · Files: src/auth.js
After this card (unsaved, 2h ago): last request "add a test for the limiter"

## Must not violate
- **Uses node test runner**: npm test runs node --test `m-331935`

## Project knowledge
### Decisions
- **In-memory limiter**: a Map per user … (why: no Redis in dev) · `rateLimit@src/auth.js:12` ✓ _(by claude-haiku-4-5)_ `m-a81f02`

## Other active branches (parallel work)
- `feature/theme`: #6 8b2e77d1 "Add dark theme toggle" · codex · 20m ago · files: src/theme.css

Loaded ~1840 tok: card #7 3f9a21c0 + 14/19 knowledge items. Not loaded: #6 8b2e77d1 "Add dark theme toggle" (live in another window, auto card, 12 unsaved) · #5 c01d4e9a "Fix login redirect" (ended, saved card); 5 knowledge items. Wider: uac_bootstrap{depth:"deep"} (+5 knowledge items) · uac_bootstrap{sessions:["#6"]} · uac_get{ids:["#7"], raw:true} (exact history)
```
The last line tells you (and the agent) what is missing and how to get it. When nothing is missing it says "Nothing else stored."

**2. Work.** Hooks record prompts, tool calls and replies. Secrets are redacted.

**3. Automatic save.** In automatic mode, after about 40 unsaved events the Stop hook asks the agent to save. On Claude it spawns the `uac-compressor` subagent on Haiku, so the main conversation doesn't pay for it. You see one line: `UAC saved: "<title>" · N accepted, …`. You can also type `#uac save` at any time.

**4. A second window or branch.** Open another session on `feature/theme`. It gets the shared knowledge, its own branch's latest card, and an "Other active branches" line for `feature/auth`. Knowledge written on a branch stays on that branch until the branch is merged.

**5. Send a message.** In the auth window: `#uac msg to branch:feature/theme I renamed getUser to fetchUser`. The theme session sees it once, at its next prompt, even in another tool.

**6. Next day.** A new session continues from the latest session on its branch by itself. To pick another: `#uac continue 5` (or `#uac continue 5 7`). This loads about 2K tokens instead of a full `--resume`.

**7. Close a task.** When a task is finished, the next save marks it `done` (or an agent calls `uac_update {id, status:"done"}`). It stays in history and is no longer loaded.

**8. Look at the dashboard.** `uac view`, or the UAC panel in VS Code.

## Controls in the chat
Type these at the **start of a line**. In Claude Code, write `uac: save` instead of `#uac save` when it is the first thing in your message: Claude Code treats a message that starts with `#` as its own memory shortcut. `#uac …` on a later line also works. The hook applies them without the model.

| You type | Effect |
|---|---|
| `#uac on` / `#uac off` | Start / stop recording this session |
| `#uac pause` / `#uac resume` | Pause (writes a snapshot) / resume |
| `#uac save` | Save this session as a card |
| `#uac save 3` | Save session #3, e.g. one that ended with only an auto card |
| `#uac stop` | Save, then stop recording |
| `#uac continue 2 5` | Load the cards of #2 and #5 |
| `#uac fresh` | Project knowledge only, no session card |
| `#uac deep` | More knowledge (~6K tokens) |
| `#uac name Users pagination` | Name this session (it is named from your first real prompt anyway) |
| `#uac rollup` / `#uac rollup 2 3` | Roll all sessions on this branch (or #2 and #3) into one card |
| `#uac msg to branch:main <text>` | Note for other sessions (`to all`, `branch:<b>` or `session:<n>`) |
| `#uac import` | This session wasn't recorded: rebuild it from the host transcript |

In Claude Code the same actions exist as `/universal-agent-context:uac <action>`, plus `handoff`, `init` (survey the codebase into knowledge), `refresh` (re-check ⚠/✗ items) and `review`.

## CLI cheat-sheet
| Command | What it does |
|---|---|
| `uac status` | Mode, recording, counts, next-session choice |
| `uac mode off\|manual\|automatic` | Set the project mode |
| `uac sessions [--all]` | List sessions (#n and short id) |
| `uac session 3 [--raw]` | Everything stored for #3 / its raw log |
| `uac next 3 5` / `uac next --clear` | The next session continues from #3 and #5 (once) |
| `uac rm 4 --dry-run` / `uac rm 4` / `uac rm --empty` | Delete sessions (events, card, the memories they created) |
| `uac name "<title>" --session 3` | Rename a session |
| `uac merge 4 5 --into 3` | Merge sessions into one |
| `uac rollup [n…] [--all] [--branch b]` | Compress many sessions into one card (originals hidden, kept) |
| `uac search <q>` / `uac get <id…>` | Search / show memories |
| `uac review` | Decide low-confidence items and conflicts (y/n/e/s) |
| `uac edit <id>` / `uac forget <id…>` | Edit a memory in `$EDITOR` / hard-delete memories |
| `uac msg "<text>" --to branch:<b>` / `uac msgs` | Send / list messages |
| `uac import [n]` | Recover an unrecorded session from its host transcript |
| `uac projects` / `uac projects merge <from> <into>` | List / join duplicate projects |
| `uac view` | Dashboard |
| `uac export` / `uac backup` / `uac doctor` | Rewrite `.context/PROJECT.md` / copy the DB / health check |

Every command takes `--json` and `--cwd DIR`.

## Dashboard
`uac view` (or the UAC panel in VS Code). A **⟳ Refresh** button reloads everything.
- **Sessions:** one card per session with pills (live, auto card, N unsaved, no raw log, empty · can delete). "Continue from this in next session", rename, two-step delete, merge, roll up, "Delete empty sessions".
- **Knowledge:** grouped by type in an accordion, one group open at a time, with ✓/⚠/✗ counts per group. Pin, mute, verify, edit, delete. Items accepted automatically in the last 7 days carry a **new** pill, so you can check them where they are. "Needs your decision" holds conflicts and low-confidence items.
- **Messages:** a scrolling list that refreshes itself every 5 s without touching what you are typing. Send a message, or delete one with 🗑 (two steps).
- **Project:** mode, the project list, merge and delete projects.

## MCP tools (for agents)
The hook already injects the start context. Agents use these tools for more:

| Tool | Use |
|---|---|
| `uac_bootstrap` | Load more or different context: other sessions' cards, `depth:"deep"`, or `fresh` |
| `uac_sessions` | List sessions: #n, short id, branch, age, live/ended, card, unsaved, raw log, title |
| `uac_get` | Full content by id (memory, card, session); `raw:true` adds the raw log |
| `uac_search` | Search this project's memory |
| `uac_propose` | Record a durable memory; refused if a near-duplicate exists (update that one) |
| `uac_update` | Change a memory, or close it: `done`, `superseded`, `archived` |
| `uac_verify` | Mark memories still true after checking them at their anchored path |
| `uac_review` | List items that need a human; `resolve:[…]` applies the user's decision |
| `uac_message` | Send a note to other sessions; without text, read your unread messages |
| `uac_capture` | Recording on/paused/off; optionally set the project mode |
| `uac_handoff` | The next session (any tool or branch) continues from this one |
| `uac_digest` | Compressor only: what to save, the git diff, memories to re-check, `how_to_save` |
| `uac_save` | Compressor only: write the card and the knowledge in one call |

## Session numbers
- Every session gets a number (`#7`) the first time you type a real prompt in it. The number never changes, and it is per project.
- Next to it is a short id (`3f9a21c0`). `#7`, `7`, the short id and the full id all work in `#uac`, the CLI, the dashboard and the MCP tools.
- A wrong reference gets an error that lists the valid sessions.

## Where data lives
- One database for everything: `~/.uac/uac.db` (`%USERPROFILE%\.uac\uac.db` on Windows; `UAC_HOME` moves it). Every read and write is scoped to the current project. User-scope items (tagged `[all projects]`) are shared on purpose.
- A project is identified by its git remote, so two clones are one project. A non-git subfolder of a known project belongs to that project.
- `.context/PROJECT.md` in your repo is a readable export of the knowledge plus the last 3 session cards. Commit it: it travels with the repo and is the recovery path if `~/.uac` is lost.
- `uac backup` writes a copy to `~/.uac/backups/`.

**Privacy.** Everything stays on your machine. Stored text is redacted before it is written: secrets, `<private>…</private>` blocks, e-mail addresses and IPs. The redaction keeps code such as `token: string`. `.uacignore` (plus defaults such as `.env*` and `*.pem`) hides file targets. `uac forget` and the dashboard delete for real.

## Limits
- A plugin can't run `/reload-plugins`. After an update, you type it (or reload the window). UAC tells you when it is needed.
- A branch that was squash-merged and then deleted can't be proven merged. Its knowledge stays branch-scoped: kept, but not loaded on other branches.
- The raw log of a saved session comes from the host's transcript. If the host deletes it, only the card and the last 10 turns UAC keeps remain.
- Cursor and Copilot prompt hooks can't add text, so `#uac` replies aren't shown there (the control is still applied).
- Only Claude Code was tested live. The other hosts are covered by unit tests. See [ARCHITECTURE.md](docs/ARCHITECTURE.md).
- UAC skips temp/scratch folders and says so in one line.

## Docs
- [INSTALL.md](docs/INSTALL.md): install, update, uninstall for every host; troubleshooting
- [FAQ.md](docs/FAQ.md): common questions
- [PROTOCOL.md](docs/PROTOCOL.md): paste into `AGENTS.md` / `GEMINI.md` for hosts without skills
- [ARCHITECTURE.md](docs/ARCHITECTURE.md): how it is built, what was verified
- [CHECKLIST.md](docs/CHECKLIST.md): every requirement and its status
- [PLAN-v5.md](docs/PLAN-v5.md): what changed in v0.5 and why

## Tests
`npm test` runs 36 tests (about 2 minutes): hooks, capture, save, knowledge, freshness, branches, messages, session numbers, deletes, dashboard API, MCP and all six adapters.
