# UAC: questions and answers (v0.3)

Short answers to the questions asked while building UAC. Commands use `uac` as short for `node <repo>/plugin/bin/uac.mjs` (see [INSTALL.md](INSTALL.md)).

UAC keeps two things:
- **Project knowledge:** facts, decisions and rules about the code. Every session gets them.
- **Session cards:** one short card per session: what was done, what works, what is broken, next steps.

---

## Starting and loading

### How does another LLM know what to run?
It does not need to know. The **hook** does the work.
- When a session starts, the UAC hook puts the context into the chat by itself. No tool call is needed.
- Some tools have no start hook (Antigravity), or the start hook was killed by a timeout. Then the hook adds the context to your **first prompt**.
- The save instruction is plain text. It is in the start context and in the Stop hook. On Claude it names the agent exactly (`universal-agent-context:uac-compressor`, `model: haiku`) so the host doesn't fall back to your default model. On other tools, or if the subagent can't be spawned, it says: call `uac_digest`, then follow the `how_to_save` recipe it returns in one `uac_save` call.
- For tools without hooks, paste [PROTOCOL.md](PROTOCOL.md) into `AGENTS.md`, `GEMINI.md` or the rules file.
- If no LLM ever saves, UAC still builds an **automatic card** from the recorded events. No LLM is used for it, so nothing is lost.

### Does UAC still ask questions at every start? Why did it ask "Deep / Minimal" even when UAC was off?
No, not any more. That was the old v0.2 menu. It is removed.
- UAC asks **one** question, **once per project**: `automatic`, `manual` or `off`.
- If nobody answers (for example a headless run), nothing is recorded until a mode is set.
- `off`: one line says UAC is off. Nothing is loaded. Nothing is recorded.
- Change it later with `uac mode off|manual|automatic`, or in the dashboard.

| Mode | Loads context | Records | Saves by itself |
|---|---|---|---|
| automatic | yes | yes | yes |
| manual | yes | only after `#uac on` | only on `#uac save` |
| off | no | no | no |

### What did "Minimal ~1k, Relevant ~4k, Deep ~10k, Fork, None" mean? What are tiers?
They were sizes of the context pack. You are right: the sizes alone meant nothing to a user, and half-baked context should not go to the LLM.

**Tiers are gone.** Sessions and knowledge replace them. Every session now loads the same thing:
1. **Must not violate:** constraints and requirements.
2. **Project knowledge:** short, with the code location and a ✓ / ⚠ / ✗ mark.
3. **Continuing from:** the chosen session cards. The default is the latest card on your branch.
4. **Other active branches** and **messages** for you.

This is about 2,000 tokens. If you want more, type `#uac deep` (about 6,000 tokens). If you want no old session state, type `#uac fresh`. If UAC knows almost nothing yet, the start context says so and suggests `/uac init`.

### What does the start context look like?
```
# UAC · my-app · branch `feature/auth` · mode automatic · recording ON
Memory = claims to verify, not facts: ✓ checked against code · ⚠ file changed since · ✗ not found.
## Continuing from (latest session on this branch)
## Must not violate
## Project knowledge
- **Row sizing**: computeRowPlan returns … · `computeRowPlan@src/layout.js:42` ✓ _(by claude-haiku-4-5)_
## Other active branches (parallel work)
Sessions (for "#uac continue <n>"): #1 … · #2 …
```

---

## Sessions

### How do I pass a session to the next chat? The old viewer was complicated.
Now you pick **sessions**, not reviews, events or packs.
- In a new chat, type `#uac continue 2` (or `#uac continue 2 5` for two sessions). The numbers are in the start context and in `uac sessions`.
- Or choose before the chat starts: tick **"Continue from this in next session"** on a card in the dashboard, or run `uac next 2 5`. The next session loads these cards once.
- If you do nothing, the next session continues from the **latest session on the same branch**.

### After a session is compressed, is its content replaced? Must I compress again?
Yes, it is replaced. No, you do not compress again.
- A successful save writes the card, then **deletes the raw events** of that session.
- The card and the knowledge stay. The old checkpoints this session loaded on the same branch are marked "superseded" by the new card.

### Why did saving launch my default model instead of Haiku?
UAC's agent is namespaced (`universal-agent-context:uac-compressor`), and an older save instruction spawned it by its short name, which doesn't exist — so the host fell back to a general-purpose agent on your default model, without the compressor's instructions.
Fixed: the instruction now spawns the exact namespaced agent with `model: haiku`. As a backstop, `uac_digest` also returns a `how_to_save` recipe, so even a plain general-purpose agent (or the main agent, if no subagent is available) can save correctly on the first try.

### Can I see the raw log after a save?
Yes. `uac session <n> --raw` (CLI) or `uac_get {ids:[<session>], raw:true}` (MCP) shows it.
UAC deletes its own copy of a session's events once they're saved into a card, but the log still exists in the **host's own transcript file**, and that's where `--raw` reads it from.

### What happens when I close a session without saving, and start a new one in the same project?
1. The unsaved session gets an **automatic card** (no LLM). It uses the prompts, the changed files and the git diff.
2. The new start context tells you this.
3. Type `#uac save <n>` to let the agent write a full card for that old session (it spawns `universal-agent-context:uac-compressor` on Haiku for it, or falls back to `uac_digest` + `uac_save` if the subagent can't run).
4. Sessions with nothing in them are marked **"empty · can delete"** in the dashboard. "Delete empty sessions" removes them all.

### Why did empty sessions appear after a window reload?
A reload or a re-opened panel starts a **new** session id (SessionStart fires again), even though you then resume the old conversation. Nobody ever types into the new one.
- These are **phantom sessions**: no prompts, no events, no card, no title. UAC hides them from lists and numbering right away.
- They are deleted when they end, or purged automatically after about a day if the window stays open.
- If you had a one-shot "continue from #n" pick queued for that phantom, the first **real** prompt in any session consumes it, so it isn't lost or duplicated.
- A session with real activity but 0 recorded events (you ran it with recording off) is **not** a phantom: it still counts prompts, so it stays visible with an "ran without recording, `uac import`" hint.

### Are subagent results recorded?
Yes, both kinds:
- **Foreground** subagents: the tool call shows up at `PostToolUse` (first 200 characters), then the full result at `SubagentStop`, tagged with the agent type.
- **Background** agents: `SubagentStop` fires the same way when they finish.
- What is **not** recorded as a user prompt: host notifications like `<task-notification>` or `<agent-message>`. They arrive as a chat turn, but they aren't something you typed — no `#uac` control parsing, no title/goal from them, just a short `notice` event (the full result already came through `SubagentStop`).
- The host's own **compaction summary** (it also fires `SubagentStop`) is skipped entirely — it's harness bookkeeping, not a subagent result worth a card.

### How are sessions named?
- **Automatic:** from your first prompt.
- **Better after save:** the compressor writes a specific title ("verb + object + outcome").
- **Rename:** type `#uac name <title>`, or run `uac name "<title>" --session <n>`, or rename in the dashboard.

### How do I delete sessions I don't need? Only ids are shown.
You do not need ids. Use the numbers.
- `uac sessions` shows `#1`, `#2`, … (newest first).
- `uac rm 4 --dry-run` shows what would be deleted. `uac rm 4` deletes. `uac rm --empty` deletes all empty sessions.
- In the dashboard: **Delete** → **Confirm delete** on a card, or **"Delete empty sessions"**.

### Delete did not work before. What does delete remove now?
The old dashboard used a browser `confirm()` box. Inside VS Code this box always returns "no", so nothing was deleted. Now delete uses two buttons: **Delete**, then **Confirm delete**.

Deleting a session removes **everything** that belongs to it:
- its events,
- its card (summaries and checkpoints),
- its retrieval logs and message read marks,
- the memories that **this session created**.

Before deleting, the dashboard and `uac rm --dry-run` show the counts. This was checked in the SQLite file during the end-to-end test.

### Can sessions or cards be merged?
Yes.
- CLI: `uac merge 3 4 --into 2`. Sessions 3 and 4 move into session 2.
- Dashboard: tick two or more sessions, pick the target, **Merge** → **Confirm**.
- All events, cards and memories move into the target. The emptied sessions are removed. The target gets a combined automatic card right away. The next save writes one combined LLM card.

### Can all sessions be compressed into one?
Yes. This is called **rollup**.
- CLI: `uac rollup --all` (or `uac rollup 2 3 5`, or `uac rollup --all --branch main`).
- In a chat: `#uac rollup` (all sessions with a card on this branch) or `#uac rollup 2 3 5`.
- Dashboard: tick sessions, **"Roll up into one card"**.

Rollup creates **one new session** whose card summarises the others. The originals are **hidden, not lost**: see them with `uac sessions --all` or the dashboard's "show rolled-up" toggle. To get one LLM-written card, type `#uac save <n>` for the rollup session.

### Resuming a session (`claude --resume`) is expensive. Why? What should I do?
- `--resume` makes the host **send the whole old conversation again**, often 50,000–200,000 tokens.
- It is cheaper only while the **prompt cache is warm** (about 1 hour after the last message). After that you pay for all of it again.
- **The UAC way:** start a **new** session and type `#uac continue <n>`. This loads a card of about 2,000 tokens instead.
- When you resume a big session (more than about 20,000 tokens), the UAC start context shows a tip with the estimated size.

---

## Knowledge

### Ticking memories one by one is complicated. The LLM wrote them; how can I choose?
You don't tick memories any more.
- Project knowledge is **always** loaded in short form. You pick **sessions** only.
- If one memory is noise, you can **mute** it (kept, never loaded), **pin** it (loaded first), **edit** or **delete** it. You never need to.

### Who reviews the memories? Must I review everything? How do I know what is correct?
The **saving subagent is the reviewer** (on Claude: `universal-agent-context:uac-compressor`, model Haiku).
- It compares new findings with the existing knowledge and the git diff.
- Items with confidence **≥ 0.7** and no conflict are **accepted automatically**, in every mode.
- **Only conflicts and uncertain items wait for you.** You see them in "Needs your decision" (dashboard), `uac review` (CLI) or the Review tree (VS Code).
- Every memory records **who** accepted it (`auto-policy`, `compressor`, `user-dashboard`, `user-cli`, `user-tool`), **when**, and **which model** wrote it.
- "Recently auto-accepted" in the dashboard shows the last 7 days. You can undo there.
- To know what is correct: every memory points at code (`computeRowPlan@src/layout.js:42`) and shows ✓ / ⚠ / ✗. Agents are told to treat memory as **claims to check**, not facts.

### How do I close a finished task?
The compressor emits `op:'done'` for it on the next save, or you (or any agent) call `uac_update({id, status:'done'})` directly.
A `done` task is kept in history but not loaded into future sessions, same as archived items.

### After an enhancement or new commits, does the AI update the knowledge, or does it go stale?
The AI updates it.
- At **every save**, the compressor gets a `recheck` list: the memories anchored to the files this session changed.
- For each one it must **verify** (still true), **update** (facts changed) or **retire** it (no longer true).
- **Freshness compares file content hashes**, not commit counts. So committing work that was already verified does **not** flag it.
- **⚠ means the file content really changed** since the memory was checked. ✗ means the file or the symbol is gone.
- You can also run `/uac refresh` (skill uac-refresh) to re-check all ⚠ and ✗ items.

### What do ✓ ⚠ ✗ mean?
- **✓** the anchored file has the same content as when the memory was checked.
- **⚠** the file content changed since then. Check before you trust it.
- **✗** the file or the named symbol is not found.

---

## Branches and parallel work

### I load the base architecture, then start two sessions on two feature branches. Can they share their work?
Yes. This is the main use case, and it was tested end to end.
1. Survey the app once: `/universal-agent-context:uac init` (or "survey this codebase for UAC"). This becomes project knowledge.
2. Start session A on `feature/auth` and session B on `feature/theme`.
3. Each session gets:
   - the shared project knowledge,
   - **its own branch's** latest card,
   - an **"Other active branches"** section: the other branch's title, files and last activity.
4. Knowledge written on a feature branch is **branch knowledge** at first. When the branch is **merged**, it becomes project knowledge for everyone.
5. Merged branches are labelled "(merged into `main`)" in the list.

### Can agents talk to each other through UAC? Is it needed?
Yes, and it is cheap.
- Type `#uac msg to branch:feature/theme I renamed getUser to fetchUser`. Or `uac msg "…" --to branch:<b>`, or the `uac_message` tool.
- The message reaches the other session at its **next prompt**, once, even in another tool (Codex, Gemini …).
- Inside Claude alone, subagents and SendMessage already cover this. UAC messages matter **across tools, branches and windows**.

---

## Storage

### Does SQLite really work? Do I need to install a package?
Yes, it works. No package is needed.
- UAC uses `node:sqlite`, which is **built into Node 22.13+**.
- Check with `uac doctor`. It shows the database path, size, integrity check, full-text search (FTS5) and the write-ahead log size.
- Two old problems are fixed: "database is locked" at start (the `busy_timeout` was set in the wrong order) and a large `uac.db-wal` file (it is now truncated on each save and at session end).

### Where is the database? I don't see the folder.
- Windows: `%USERPROFILE%\.uac\uac.db`. On this machine: `C:\Users\SRI\.uac\uac.db`.
- macOS / Linux: `~/.uac/uac.db`.
- The folder starts with a dot, so some file views hide it. Type the path into Explorer, or run `dir %USERPROFILE%\.uac`.
- It is created on **first use** (the first hook or `uac` command).
- `UAC_HOME` changes the location.

### What if SQLite doesn't work?
- If the database is **locked**, hooks write events to `~/.uac/spool.jsonl`. They are imported the next time the database opens. Nothing is lost.
- If FTS5 is missing, search falls back to simple `LIKE` search.
- `uac backup` writes a safe copy to `~/.uac/backups/`.
- Hooks never break your tool. Errors go to `~/.uac/hook-errors.log`.

### A session was not recorded. Can I recover it?
Yes. Type `#uac import` in that session, or run `uac import <n>`. UAC reads the host's transcript file and builds the session from it. Then save as usual.

### Are edits made by subagents captured?
Yes, through git. The save and the automatic card include `git diff --stat` since the session started, plus uncommitted and new files. So edits by subagents or background agents are counted.

### Is the same repo in two folders two projects?
No. Projects are identified by the **git remote**. Two clones of the same repo are one project. Claude temp and scratchpad folders are never registered. `uac projects merge <from> <into>` joins old duplicates.

---

## Tools and commands

### What is the exe for? When does `uac install claude` run?
- **The exe** (`dist/uac.exe`) is only for machines **without Node 22.13+**. It is optional and experimental. Its dashboard (`uac.exe view`) hangs because of a Node single-executable issue, so use `node plugin/bin/uac.mjs view` for the dashboard.
- **`uac install`** runs **once**, by you, after cloning. With no host name it finds every installed tool (Claude, Gemini, Codex, Cursor, Copilot, Antigravity, VS Code) and installs for each. `uac install claude` installs only for Claude. Run it again after moving the repo.
- The VS Code extension runs the install again by itself after an update.

### In Claude only the skills show. How do `/uac pause|resume|save|…` work?
- Plugin commands in Claude have a long name: `/universal-agent-context:uac save`.
- **Easier, and works in every tool:** type `#uac …` anywhere in a message. The hook handles it **without the model**:

| You type | Effect |
|---|---|
| `#uac on` / `#uac off` | Start / stop recording |
| `#uac pause` / `#uac resume` | Pause (writes a checkpoint) / resume |
| `#uac save` | Save this session as a card |
| `#uac save <n>` | Save an older session |
| `#uac stop` | Save, then stop recording |
| `#uac continue 2 5` | Load cards #2 and #5 |
| `#uac fresh` / `#uac deep` | Knowledge only / load more |
| `#uac name <title>` | Rename this session |
| `#uac rollup` / `#uac rollup 2 3` | Roll all sessions on this branch (or #2 and #3) into one card |
| `#uac msg to branch:<b> <text>` | Message other sessions |
| `#uac import` | Recover this session from its transcript |

### The CLI is hard: ids, packs, checkpoints…
Not any more.
- Everything uses **numbers**: `uac sessions`, `uac session 3`, `uac next 3`, `uac rm 4`.
- `uac review` asks you one item at a time: **y** accept, **n** reject, **e** edit in your text editor, **s** skip.
- `uac edit <id>` opens a memory in your editor. Save and close to apply.
- Packs and checkpoints still exist for power users, but you never need them.

### How do I hand work to another window, tool or branch?
Type `/universal-agent-context:uac handoff` (or ask "hand this off"). The agent saves the card and marks it for the next session. In the other window, type `#uac continue <n>`. A new session in the same project loads it by itself.

### Which models wrote my memories? What if the next model is different?
Every memory and card stores the model that wrote it. The start context shows "(by claude-haiku-4-5)". All models get the same rule: memory is a claim to check. The code anchors and ✓ / ⚠ / ✗ make checking cheap.

### Does it work in Cursor and Copilot?
Yes, with one limit. Their prompt hooks **cannot add text** to the chat. So the start context comes from their start hook, and `#uac …` controls are applied silently (no reply is shown).

## Continuing in the SAME session

**I saved (a card was made), then kept working in the same session. Is the new work added to the same session?**
Yes. It's the same session, and new work is recorded there.
- On the next save, the compressor gets the existing card (`previous_card`) and writes ONE updated card for the whole session: the old parts that are still true plus the new work.
- There is no second card and no new session.
- Older checkpoints of that session are marked superseded.
- Until the next save, work after the last card shows in the start context as an "**After this card (unsaved)**" tail, so nothing looks lost.
- If the host compacts the conversation in between, this session's own card (not just a generic snapshot) is re-injected afterward, along with that unsaved tail.

**I didn't save, closed it, and came back much later with `claude --resume`. What happens?**
- The session is marked active again.
- Its recorded events are still there. The auto card made when it closed shows up as "auto card".
- At the start UAC tells you: "This session has N unsaved events since <time>. #uac save writes/updates its card."
- New work keeps being added to the same session. In automatic mode it's saved by itself once enough work has piled up; in manual mode, type `#uac save`.
- Resuming re-sends the whole old conversation to the model, which is expensive. For a cheaper start, open a new session and type `#uac continue <n>`: it loads the ~2K-token card.

## "#uac" at the start of a message in Claude Code
Claude Code treats a message that **starts with `#`** as its own memory shortcut, so UAC never sees it. You have two options:
- Write `uac: save` (or `uac: name My task`, `uac: continue 2`…). It works the same everywhere.
- Put `#uac save` on a later line of the message.

This was found in live testing on 2026-09-28.
