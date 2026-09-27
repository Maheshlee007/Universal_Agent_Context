# Universal Agent Context (UAC)

UAC gives coding agents such as Claude Code, Gemini CLI, Codex, Cursor, Copilot and Antigravity **memory across sessions, branches and tools**, and you stay in control of it.

You deal with two things:

- **Project knowledge**
  - Durable facts: architecture, decisions (with the why), constraints, lessons.
  - Each one is tied to exact code (`computeRowPlan@src/layout.js:42`) and marked ✓ verified / ⚠ changed since / ✗ not found.
  - It's loaded into every session automatically and kept up to date by the agent after each save.
- **Session cards**
  - One compressed card per session: what was done, what works or is broken, next steps, and files.
  - You pick which sessions the next session continues from. By default it's the latest session on the same branch.

There are no size menus and no questions at every start. The only question is asked once per project: should UAC be **automatic**, **manual** or **off**?

| Mode | What happens |
|---|---|
| automatic | Loads context, records the session, saves by itself (the agent's own cheap subagent writes the card) |
| manual | Loads context. Records only after you type `#uac on`, saves on `#uac save` |
| off | Does nothing (one line says so) |

## Quick start
Needs Node.js 22.13+ and no npm packages.
```
git clone https://github.com/Maheshlee007/Universal_Agent_Context.git
cd Universal_Agent_Context
node plugin/bin/uac.mjs install        # detects Claude/Gemini/Codex/Cursor/Copilot/Antigravity/VS Code and installs for each
node plugin/bin/uac.mjs doctor         # shows the DB path (~/.uac/uac.db), integrity, full-text search
```
Restart your agent and open a git project. **[docs/INSTALL.md](docs/INSTALL.md)** has per-tool details, the VS Code extension, the standalone exe and troubleshooting.

## Everyday use: type these in any chat, with any tool
Type them at the **start of your message** (or the start of a line). Text that merely quotes `#uac …` further inside a line is ignored.

| You type | Effect |
|---|---|
| `#uac name Users pagination` | Name this session. It's also named automatically from your first message |
| `#uac save 3` | Save session #3, e.g. one that ended without a save (it shows "auto card") |
| `#uac rollup` | Compress all sessions on this branch into ONE card. The originals are hidden, not lost |
| `#uac on` / `#uac off` | Start or stop recording this session |
| `#uac save` | The agent compresses this session into a card and updates project knowledge |
| `#uac continue 2 5` | Load session cards #2 and #5 (numbers from the list shown at start, or from `uac sessions`) |
| `#uac fresh` | Project knowledge only, no previous session state |
| `#uac deep` | Load more knowledge than the default |
| `#uac msg to branch:main I renamed getUser → fetchUser` | Leave a note for other sessions: other branches, other tools |
| `#uac import` | This session wasn't being recorded: recover it from the transcript |

In Claude Code the same actions exist as `/universal-agent-context:uac <action>`.

## Parallel work on branches
- Survey the app once (`/universal-agent-context:uac init`, or "survey this codebase for UAC"). That becomes project knowledge that every session gets.
- Start session A on `feature/auth` and session B on `feature/theme`. Each gets the shared knowledge, plus its own branch's latest card, plus an **"Other active branches"** section showing what the other one is doing.
- Messages (`#uac msg`, `uac_message`) reach the other session at its next prompt, even when it runs in a different tool.
- When a branch is merged, its branch-only knowledge becomes project knowledge for everyone.
- When files change, the memories anchored to them are flagged ⚠. The next save re-checks them against the diff and verifies, updates or retires each one.

## Seeing and cleaning up
- **Dashboard:** `uac view`, or the **UAC** panel in VS Code.
  - Sessions as cards, with "Continue from this in next session" and delete (which removes its events, card and the memories it created).
  - "Delete empty sessions".
  - Knowledge with pin / mute / verify / edit / delete.
  - "Recently auto-accepted" with undo.
  - "Needs your decision" (only conflicts and uncertain items).
  - Messages, and project merge / delete.
- **CLI** (numbers, not ids):
  - `uac sessions`, `uac session 3`, `uac next 3`
  - `uac rm 4 --dry-run`, `uac rm 4`, `uac rm --empty`
  - `uac review` (interactive y/n/edit), `uac projects`, `uac backup`
  - `uac merge 4 5 --into 3` merges sessions into one; `uac rollup --all` compresses many into one card; `uac name "…"`

## Resuming vs continuing (token cost)
`claude --resume` re-sends the **whole old conversation**, often 50–200K tokens. That's cheap only while the prompt cache is still warm, which lasts about an hour.
The UAC way is a **new session + `#uac continue <n>`**: it loads that session's card, about 2K tokens, plus project knowledge. When you resume a long session, UAC shows this tip with an estimate.

## Who decides what's true?
The saving subagent is the reviewer:
- It compares new findings with the existing knowledge and the git diff.
- Items it is sure about (confidence ≥ 0.7) are accepted automatically, and every acceptance records who or what accepted it.
- **Only conflicts and uncertain items wait for you.**
- Every memory shows which model wrote it and whether its code anchor still matches. Agents are told to treat memory as claims to verify, not facts.

## Docs
- [INSTALL.md](docs/INSTALL.md): install, update and uninstall for every tool; troubleshooting
- [FAQ.md](docs/FAQ.md): answers to common questions (how other agents know what to do, what's stored where, deletes…)
- [PROTOCOL.md](docs/PROTOCOL.md): paste into AGENTS.md / GEMINI.md for tools without skills
- [ARCHITECTURE.md](docs/ARCHITECTURE.md): how it's built, what's verified
- [PLAN-v3.md](docs/PLAN-v3.md): the v0.3 rethink and a decision on every piece of feedback

## Tests
`npm test` runs 27 tests covering the full flow: hooks, capture, save, knowledge, freshness, branches, messages, deletes, dashboard API, MCP, and all six adapters.
