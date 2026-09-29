# UAC: questions and answers (v0.5)

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
- The save instruction is plain text. It is in the start context and in the Stop hook. On Claude it names the agent exactly (`universal-agent-context:uac-compressor`, `model: haiku`) and gives it a prompt whose step 0 loads its tools with ToolSearch (they are deferred). On other tools, or if the subagent can't run, it says: call `uac_digest`, then follow the `how_to_save` recipe it returns in one `uac_save` call.
- For tools without hooks, paste [PROTOCOL.md](PROTOCOL.md) into `AGENTS.md`, `GEMINI.md` or the rules file.
- If no LLM ever saves, UAC still builds an **auto card** from the recorded events. No LLM is used for it, so nothing is lost.

### Does UAC ask questions at every start?
No. UAC asks **one** question, **once per project**: `automatic`, `manual` or `off`.
- If nobody answers (for example a headless run), nothing is recorded until a mode is set.
- `off`: one line says UAC is off. Nothing is loaded. Nothing is recorded.
- Change it later with `uac mode off|manual|automatic`, or in the dashboard's Project tab.

| Mode | Loads context | Records | Saves by itself |
|---|---|---|---|
| automatic | yes | yes | yes |
| manual | yes | only after `#uac on` | only on `#uac save` |
| off | no | no | no |

### What happened to "Minimal / Relevant / Deep" tiers and packs?
They are gone (tiers in v0.3, packs and `uac choose` in v0.5). Every session loads the same thing, in this order:
1. **Continuing from:** the chosen session cards. The default is the most recently active session on your branch.
2. **Messages for you** from other sessions.
3. **Must not violate:** constraints and requirements.
4. **Project knowledge**, grouped by type, each item with its code anchor and a ✓ / ⚠ / ✗ mark.
5. **Other active branches.**
6. One line: what was loaded, what was not, and how to get more.

This is about 2,000 tokens. `#uac deep` loads more (about 6,000). `#uac fresh` loads knowledge only. If UAC knows almost nothing yet, the start context says so and suggests `/uac init`.

### What does the start context look like?
```
# UAC · my-app · branch `feature/auth` · mode automatic · recording ON · this session 4c1e09ab (session_id=4c1e09ab-…)
Memory = claims to verify, not facts: ✓ checked against code · ⚠ file changed since · ✗ anchor gone. Judge a memory only at its anchored path; after checking, uac_verify {ids} or uac_update.
## Continuing from (most recent session on this branch)
### #7 3f9a21c0 · feature/auth · claude (claude-opus-5-5) · 2h ago
## Must not violate
## Project knowledge
### Decisions
- **Row sizing**: computeRowPlan returns … · `computeRowPlan@src/layout.js:42` ✓ _(by claude-haiku-4-5)_ `m-ab12cd`
## Other active branches (parallel work)
Loaded ~1840 tok: card #7 3f9a21c0 + 14/19 knowledge items. Not loaded: … Wider: …
User controls (typed at the start of a line; "uac: …" in Claude Code): #uac continue <n> | fresh | deep | save [n] | name <title> | off.
```

### What does the "Loaded … Not loaded … Wider" line mean?
It tells the reader whether it got everything or a slice.
- **Loaded:** the cards and how many knowledge items (`14/19`) went in, with the token count.
- **Not loaded:** other sessions with content (up to 4, each with its state: live in another window, ended, auto card, N unsaved, no raw log) and the number of knowledge items left out.
- **Wider:** the exact calls that get the rest, for example `uac_bootstrap{depth:"deep"}`, `uac_bootstrap{sessions:["#6"]}`, `uac_get{ids:["#7"], raw:true}`. The raw call is offered only when a raw log exists.
- When nothing was left out, it says "Nothing else stored."

### Why does UAC say "type /reload-plugins"?
Open Claude Code sessions keep the hooks and MCP server they started with. After an update, UAC adds one line to the start context when:
- a newer UAC is installed than the one this session runs, or
- this session's MCP server and its hooks run different versions.

A plugin can't run `/reload-plugins` itself, so the agent asks you to type it (or restart the session). In VS Code the extension offers **Reload Window** after it updates. `uac doctor` shows the version and path of the CLI, the hooks, the MCP server and the installed plugin.

---

## Sessions

### What are session numbers? Do they change?
No. Each session gets a number per project, `#1`, `#2`, …, the first time you type a real prompt in it. The number never moves after that.
- Next to every number is a short id (`#7 3f9a21c0`). `#7`, `7`, the short id (6+ characters) and the full id work everywhere: `#uac`, the CLI, the dashboard and the MCP tools.
- Only sessions of the current project resolve. A wrong reference gets an error that lists the valid sessions.
- A brand-new session has no number yet in its own header (only the short id). It gets one at its first prompt.
- Numbers of deleted or merged sessions are not reused.

### How do I pass a session to the next chat?
You pick **sessions**.
- In a new chat, type `#uac continue 2` (or `#uac continue 2 5`). The numbers are in the start context, in `uac sessions` and in the dashboard.
- Or choose before the chat starts: tick **"Continue from this in next session"** on a card in the dashboard, or run `uac next 2 5`. The next session loads these cards once.
- If you do nothing, the next session continues from the **most recently active session on the same branch** that has a card or unsaved work.

### After a session is saved, is its content replaced? Must I save again?
Yes, it is replaced. No, you do not save again.
- A successful save writes the card, then deletes UAC's copy of that session's raw events, except the last 10 prompt/reply turns. Those are kept as a fallback raw log and are never injected.
- The card and the knowledge stay. The old checkpoints this session loaded on the same branch are marked superseded by the new card.
- If you keep working in the same session, the next save updates the same card.

### Why can a save be refused?
Because a bad save would delete the raw events and leave nothing useful. `uac_save` refuses, and writes and deletes **nothing**, when:
- `summary` is not an object with a title, or `checkpoint` is not an object with a `goal` plus `next_steps` or a `note`;
- `base_event_id` is behind the session's last save (another save got there first);
- a candidate names a memory of another project.

The error gives the exact shape to retry with. On Claude, if the compressor stops without replying "UAC saved:", the SubagentStop hook sends it back once with the steps. If an automatic save still doesn't land, the Stop hook says so and asks for one retry.

### Why did saving launch my default model instead of Haiku?
An old save instruction used the agent's short name, which doesn't exist, so the host fell back to a general-purpose agent on your default model. Now the instruction names `universal-agent-context:uac-compressor` with `model: haiku`. `uac_digest` also returns a `how_to_save` recipe, so any agent can save correctly on the first try.

### Can I see the raw log after a save?
Yes. `uac session <n> --raw` (CLI) or `uac_get {ids:["#n"], raw:true}` (MCP).
It reads the **host's own transcript file**. If the host deleted it, you get the last 10 turns UAC kept. `uac_sessions` and the dashboard show "no raw log" when the transcript is gone.

### What happens to a session that ended without a save?
UAC finishes it for you:
1. When any other session of the project starts, the unsaved session gets an **auto card** (no LLM): prompts, changed files, git diff, last reply. So its work is visible right away, labelled "live in another window" or "ended".
2. A session with no SessionEnd (a killed window) counts as idle after 30 minutes without events, and is marked ended after 12 hours.
3. If it has 10 or more unsaved events:
   - **automatic:** the new session's first Stop asks its agent to save the old session with the compressor. Once per session.
   - **manual:** the start context tells you once: type `#uac save <n>`.
4. Sessions with nothing in them are marked **"empty · can delete"** in the dashboard. "Delete empty sessions" removes them.

### Why did empty sessions appear after a window reload?
A reload starts a **new** session id, even though you then resume the old conversation. Nobody types into the new one.
- These are **phantom sessions**: no prompts, no events, no card, no title. UAC hides them and gives them no number.
- They are deleted when they end, or purged after about a day.
- A "continue from #n" pick queued for the next session is consumed only by a **real** first prompt, so a phantom doesn't eat it.
- A session with real prompts but 0 recorded events (recording was off) is **not** a phantom. It stays visible with a "`uac import`" hint.

### Are subagent results recorded?
Yes.
- **Foreground** subagents: the tool call at `PostToolUse` (first 200 characters), then the full result at `SubagentStop`, tagged with the agent type.
- **Background** agents: `SubagentStop` fires the same way when they finish.
- Host notifications (`<task-notification>`, `<agent-message>`) are not treated as your prompts: no `#uac` parsing, no title from them, just a short `notice` event.
- The host's compaction summary is skipped.

### How are sessions named?
- **Automatic:** from your first real prompt ("ok", "continue", "go on" don't count).
- **Better after save:** the compressor writes a specific title ("verb + object + outcome").
- **Rename:** `#uac name <title>`, `uac name "<title>" --session <n>`, or ✎ in the dashboard.

### How do I delete sessions?
- `uac sessions` lists them (`#7 3f9a21c0 …`, newest at the top; the numbers are stable).
- `uac rm 4 --dry-run` shows what would be deleted. `uac rm 4` deletes. `uac rm --empty` deletes all empty sessions.
- Dashboard: **Delete** → **Confirm delete** on a card, or **"Delete empty sessions"**.

Deleting a session removes its events, its card (summaries and checkpoints), its message read marks and the memories **this session created**. The dashboard and `--dry-run` show the counts first. (The old dashboard used `confirm()`, which always returns "no" inside VS Code; delete now uses two buttons.)

### Can sessions be merged or rolled up?
- **Merge:** `uac merge 3 4 --into 2`, or tick sessions in the dashboard → **Merge**. Events, cards and memories move into the target; the emptied sessions are removed. The next save writes one combined card.
- **Rollup:** `uac rollup --all` (or `uac rollup 2 3 5`, `--branch main`), `#uac rollup`, or the dashboard's "Roll up into one card". It creates one new session whose card summarises the others. The originals are **hidden, not lost** (`uac sessions --all`). `#uac save <n>` for the rollup session writes one LLM card.

### Resuming a session (`claude --resume`) is expensive. What should I do?
- `--resume` sends the whole old conversation again, often 50,000–200,000 tokens. It is cheaper only while the prompt cache is warm (about an hour).
- **The UAC way:** start a **new** session and type `#uac continue <n>`. This loads a card of about 2,000 tokens.
- When you resume a big session (over about 20,000 tokens), the start context shows a tip with the estimated size.

### I saved, then kept working in the same session. Is the new work added?
Yes. It's the same session.
- The next save gets the existing card (`previous_card`) and writes ONE updated card for the whole session.
- Until then, work after the card shows as an "**After this card (unsaved)**" tail in other sessions' start context.
- If the host compacts the conversation, this session's own card and that tail are re-injected.

### I didn't save, closed it, and came back with `claude --resume`. What happens?
- The session is active again, with its recorded events and its auto card.
- The start context says "This session has N unsaved events since <time>. #uac save writes/updates its card."
- New work is added to the same session and saved as usual.

---

## Knowledge

### Must I tick or review every memory?
No.
- Project knowledge is **always** loaded in short form. You pick **sessions** only.
- You can **mute** a memory (kept, never loaded), **pin** it (loaded first), **edit** or **delete** it. You never need to.

### Who reviews the memories? How do I know what is correct?
The **saving subagent is the reviewer** (on Claude: `uac-compressor` on Haiku).
- It compares new findings with the existing knowledge and the git diff.
- Items with confidence **≥ 0.7** and no conflict are accepted automatically.
- **Only conflicts and uncertain items wait for you:** "Needs your decision" (dashboard), `uac review` (CLI) or the Review tree (VS Code).
- Items accepted automatically in the last 7 days carry a **new** pill in their group in the dashboard. Edit or retire them there if they are wrong.
- Every memory records who accepted it, when, and which model wrote it.
- Every memory points at code (`computeRowPlan@src/layout.js:42`) and shows ✓ / ⚠ / ✗. Agents treat memory as **claims to check**, not facts.

### Why was my new memory refused as a duplicate?
`uac_propose` refuses a memory of the same type that says almost the same thing as an existing one, and names that memory. Update it instead (`uac_update`). `force:true` overrides. At save time, `uac_digest` also lists clusters of near-duplicates so the compressor can merge them into one.

### How do I close a finished task?
The compressor emits `op:'done'` for it on the next save, or any agent calls `uac_update({id, status:'done', reason})`. A `done` task stays in history but is not loaded again.

### How do I retire a memory that is no longer true?
`uac_update({id, status:'superseded', reason, superseded_by?})`. (This replaced `uac_invalidate` in v0.5.)

### After new commits, does the AI update the knowledge?
Yes.
- At **every save**, the compressor gets a `recheck` list: the memories anchored to files this session changed. For each one it must verify, update or retire it.
- **Freshness compares file content hashes**, not commit counts. Committing work that was already verified does not flag it.
- `/uac refresh` (skill uac-refresh) re-checks all ⚠ and ✗ items.

### What do ✓ ⚠ ✗ mean?
- **✓** the anchored file has the same content as when the memory was checked.
- **⚠** the file content changed since then. Check before you trust it.
- **✗** either the anchored **file is missing**, or the **symbol is no longer in the file**. For a missing file, UAC lists same-named files elsewhere and warns that they are DIFFERENT files: don't verify or reopen the memory from them. Judge a memory only at its anchored path. `uac_verify` refuses while an anchored file is missing.

### What does `[all projects]` mean?
The item is user scope: it applies to all your projects (usually a preference). Say where a preference applies when you write it. An explicit `scope:"project"` keeps a repo-specific preference in this repo.

---

## Branches and parallel work

### Two sessions on two feature branches: can they share their work?
Yes. This was tested end to end.
1. Survey the app once: `/universal-agent-context:uac init` (or "survey this codebase for UAC"). This becomes project knowledge.
2. Start session A on `feature/auth` and session B on `feature/theme`.
3. Each session gets the shared knowledge, **its own branch's** latest card, and an **"Other active branches"** section: the other branch's latest session, title, files and last activity.
4. Merged branches are labelled "(merged into `main`)" and listed last.

### What happens to branch knowledge before and after a merge?
- **Before the merge:** knowledge written on a feature branch is **branch knowledge**. It is loaded only on that branch, tagged `[branch <name>]`. If a branch session updates or supersedes a project memory, that is stored as a **branch version**: the branch sees the new version, other branches still see the original.
- **After the merge** into the default branch: the branch knowledge becomes project knowledge for everyone, and branch versions replace the originals. This is checked at every session start, so the next session sees it.
- A branch that was merged and then deleted is still recognised, as long as its memories' commits are in the default branch.
- **Not handled:** a squash-merged, deleted branch can't be proven merged. Its knowledge stays branch-scoped: kept, not lost, but not loaded on other branches.

### Can agents talk to each other through UAC?
Yes.
- Type `#uac msg to branch:feature/theme I renamed getUser to fetchUser`. Or `uac msg "…" --to branch:<b>`, or `uac_message {text, to}` (`to` = `all`, `branch:<name>` or `session:<#n|id>`).
- Inside Claude alone, subagents already cover this. UAC messages matter **across tools, branches and windows**.

### Who gets a message, and how often?
Each recipient sees a message **once**, at its next prompt (or in its start context, before the knowledge, where no clip can cut it).
- Sessions that were open when the message was posted get it.
- If nobody has read it yet, the next session that starts gets it.
- Sessions that start later don't see it again, so a note to `main` doesn't become a banner forever.
- A message to one session (`session:<ref>`) always reaches that session.
- Messages older than 14 days are not delivered. In the dashboard's Messages tab you can delete a message.
- `uac_message` without text reads your unread messages.

---

## Storage

### Does SQLite really work? Do I need to install a package?
Yes, and no package is needed. UAC uses `node:sqlite`, built into Node 22.13+. `uac doctor` shows the database path, size, integrity, full-text search (FTS5), the WAL size and the versions in use.

### Where is the database?
- Windows: `%USERPROFILE%\.uac\uac.db`. macOS / Linux: `~/.uac/uac.db`. `UAC_HOME` changes it.
- The folder starts with a dot, so some file views hide it. It is created on first use.

### One database for all projects: can one project see another's data?
No. Every read and write is scoped to the current project, including lookups by id. A save that names another project's memory is rejected. User-scope items (`[all projects]`) are shared on purpose. `.context/PROJECT.md` in each repo holds its knowledge and the last 3 session cards, and `uac backup` copies the whole DB.

### What if SQLite doesn't work?
- If the database is **locked**, hooks write events to `~/.uac/spool.jsonl`. They are imported the next time the database opens.
- If FTS5 is missing, search falls back to `LIKE`.
- `uac backup` writes a copy to `~/.uac/backups/`.
- Hooks never break your tool. Errors go to `~/.uac/hook-errors.log`.

### A session was not recorded. Can I recover it?
Yes. Type `#uac import` in that session, or run `uac import <n>`. UAC rebuilds the session from the host's transcript. Then save as usual.

### Are edits made by subagents captured?
Yes, through git. The save and the auto card include `git diff --stat` since the session started, plus uncommitted and new files.

### Is the same repo in two folders two projects? What about subfolders?
- Projects are identified by the **git remote**, so two clones are one project. `uac projects merge <from> <into>` joins old duplicates.
- A non-git subfolder of a registered folder belongs to that folder's project (never the home folder or a drive root).
- A session always stays in its own project, even if the agent `cd`s elsewhere or resumes from another folder.
- Read-only CLI commands (`uac sessions`, `uac search`, …) never register a new project.
- Temp and scratch folders (`Temp/claude…`) are skipped. The start context says so in one line. `UAC_ALLOW_SCRATCH=1` records there (for tests).

---

## Tools and commands

### When does `uac install` run? Can it downgrade me?
- **`uac install`** runs once, by you, after cloning. With no host name it finds every installed tool and installs for each. `uac install claude` installs only for Claude. Run it again after moving the repo or pulling an update.
- The VS Code extension runs the install again after it updates, then offers **Reload Window**.
- **It never downgrades Claude Code:** if the registered UAC source is a newer version at another path, install keeps it and says so.
- There is no standalone exe any more (removed in v0.5: its dashboard hung and nobody used it). Use Node 22.13+.

### How do the `#uac` controls work? In Claude only the skills show.
- Plugin commands in Claude have a long name: `/universal-agent-context:uac save`.
- **Easier, and works in every tool:** type `#uac …` at the start of a line. The hook handles it **without the model**. In Claude Code, write `uac: save` when it's the first thing in your message (Claude Code treats a message starting with `#` as its memory shortcut), or put `#uac save` on a later line.

| You type | Effect |
|---|---|
| `#uac on` / `#uac off` | Start / stop recording |
| `#uac pause` / `#uac resume` | Pause (writes a snapshot) / resume |
| `#uac save` / `#uac save <n>` | Save this session / another session |
| `#uac stop` | Save, then stop recording |
| `#uac continue 2 5` | Load cards #2 and #5 |
| `#uac fresh` / `#uac deep` | Knowledge only / load more |
| `#uac name <title>` | Rename this session |
| `#uac rollup` / `#uac rollup 2 3` | Roll sessions into one card |
| `#uac msg to branch:<b> <text>` | Message other sessions |
| `#uac import` | Recover this session from its transcript |

### Which MCP tools are there?
13 (there were 19): `uac_bootstrap`, `uac_sessions`, `uac_get`, `uac_search`, `uac_propose`, `uac_update`, `uac_verify`, `uac_review`, `uac_message`, `uac_capture`, `uac_handoff`, and, for the compressor, `uac_digest` and `uac_save`. Removed in v0.5: `uac_pack`, `uac_why`, `uac_checkpoint`; `uac_timeline` became `uac_sessions`; `uac_invalidate` is `uac_update {status:"superseded"}`; `uac_resolve` is `uac_review {resolve:[…]}`; `uac_messages` is `uac_message` without text. See the table in the [README](../README.md#mcp-tools-for-agents).

### The CLI is hard: ids…
- Everything takes the stable numbers or short ids: `uac sessions`, `uac session 3`, `uac next 3`, `uac rm 4`.
- `uac review` asks one item at a time: **y** accept, **n** reject, **e** edit, **s** skip.
- `uac edit <id>` opens a memory in your editor.

### How do I hand work to another window, tool or branch?
Type `/universal-agent-context:uac handoff` (or ask "hand this off"). The agent saves the card and marks it for the next session. In the other window, type `#uac continue <n>`. A new session in the same project loads it by itself.

### Which models wrote my memories?
Every memory and card stores the model that wrote it; the start context shows "(by claude-haiku-4-5)". All models get the same rule: memory is a claim to check.

### Does it work in Cursor and Copilot?
Yes, with one limit. Their prompt hooks can't add text to the chat. The start context comes from their start hook, and `#uac …` controls are applied silently.
