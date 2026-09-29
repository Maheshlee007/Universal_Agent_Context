# UAC protocol (host-neutral)

> Paste this section into `AGENTS.md`, `GEMINI.md`, or your host's rules file. It's for hosts without Claude Code skills. It matches `plugin/skills/uac-protocol/SKILL.md` (v0.5).

## Universal Agent Context (UAC)

This project uses UAC for project knowledge and session cards shared across sessions, branches and agents. Use the **uac MCP tools** (server `uac`; your host may prefix them, e.g. `mcp__uac__uac_verify`). If your host defers MCP tools, load them first (for example ToolSearch `uac_digest`); they exist even if you don't see them yet.

**Tools (13):** `uac_bootstrap`, `uac_sessions`, `uac_get`, `uac_search`, `uac_propose`, `uac_update`, `uac_verify`, `uac_review`, `uac_message`, `uac_capture`, `uac_handoff`, and for saving `uac_digest`, `uac_save`.

**Session refs:** a session is named `#7 3f9a21c0` (stable number + short id). Pass `#7`, `7`, the short id or the full id to any tool. Numbers never change.

**CLI fallback** (no MCP): `node <repo>/plugin/bin/uac.mjs <command> --json`, where `<repo>` is the UAC checkout. Commands: `status`, `sessions`, `session <n|id> [--raw]`, `search <query>`, `get <id…>`, `next <n…> | --clear`, `msg "<text>" [--to all|branch:<b>|session:<ref>]`, `msgs`, `import [n]`, `mode off|manual|automatic`, `review`, `doctor`, `view`.

### 1. Start of session: context is injected

- If a `# UAC · <project> · branch · mode · recording · this session …` header is in your context, the hook already loaded the chosen session card (default: the most recently active session on this branch), messages, must-not-violate rules, project knowledge and other active branches. **Don't call `uac_bootstrap` to load it again. Don't ask what to load or whether to record.** The `session_id=` in the header is yours; pass it to tools.
- The context opens with `## How to use this context` and `## Project overview` (the project's "what is what": an `overview` memory, or one derived from README/package.json/docs until one is saved), then the card you continue from and `## Timeline` (the latest chapters of all sessions on this branch: `- MM-DD #n · "title" · files: … (s-id)`). All of it is a summary: **before a task, and before answering about earlier work, `uac_search` the task's own key terms and `uac_get` the related chapters and items.** Decisions, failed attempts and open items live there.
- At a prompt, `[UAC] Saved work that may relate to this: s-… "…" · m-… "…"` lists up to 3 saved chapters/items that share several words with the prompt (each id once per session). Open them with `uac_get` before relying on memory.
- Read the line that starts `Loaded ~N tok:`. It says what was loaded, what was **not** loaded (other sessions, more knowledge), and the exact calls to get more (`Wider: …`). Use those calls only if the task needs them. "Nothing else stored" means you have everything.
- No header (MCP-only host, no hooks): call `uac_bootstrap({goal:<the user's first request>})` once, without asking.
- Act only on what the header explicitly asks:
  - **"UAC first run… Ask the user ONCE"**: ask the one mode question (off / manual / automatic), then call `uac_capture` as the header says.
  - **"isn't fully saved… Tell the user once"**: tell the user `#uac save <n>` would write its card.
  - **"Tell the user: type /reload-plugins"**: tell the user. You can't run it.
  - **"UAC knows almost nothing about this project yet"**: suggest surveying the codebase once.
  - **"UAC is off"** or **"off here: … temp/scratch folder"**: do nothing more.
- The user changes what's loaded by typing `#uac fresh`, `#uac continue <n…>` or `#uac deep`. The hook applies it.

### 2. Anchors and freshness

Memory lines look like `- **Title**: body · \`computeRowPlan@src/layout.js:42\` ✓ _(by claude-haiku-4-5)_ \`m-ab12cd\``.
- `symbol@file:line` is the anchor, relative to the project root. Grep the symbol in that file to check it.
- **✓** unchanged since checked: usable. **⚠** file changed since: **check the anchor before relying on it**. **✗** the file is missing, or the symbol is no longer in the file.
- **Judge a memory only at its anchored path.** If its file is gone, a same-named file elsewhere is a DIFFERENT file: don't verify, update or reopen the memory from it. `uac_verify` refuses while an anchored file is missing.
- After checking: still true → `uac_verify({ids:[…]})`; partly wrong → `uac_update({id, body, anchors, reason})`; no longer true → `uac_update({id, status:"superseded", reason, superseded_by?})`.
- **Memories written by another model (`by <model>`) are claims, not facts.** The code wins.
- Must-not-violate constraints and requirements are binding. Warn before breaking one.
- `[branch x]` = knowledge of branch x only. `[all projects]` = user scope, applies to all the user's projects.

### 3. During work

- **Look up:** `uac_search({query, type?, status?})` → `uac_get({ids})`. `uac_search` lists matching memories, then matching saved chapters under `chapters:` (`s-id · #n · date · "title" — snippet`); `uac_get` on an `s-` id returns the chapter with its checkpoint. `uac_sessions({})` lists sessions (#n, short id, live/ended, card, unsaved, raw). `uac_get({ids:["#7"], raw:true})` gives a session's raw log.
- **Propose durable knowledge** with `uac_propose({type, title, body, why, files, anchors, confidence, scope?})`. Types: `decision` (with the why), `constraint`, `lesson` (X failed because Y, fix Z), `requirement`, `architecture`, `fact`, `preference` (say where it applies; default scope is user = all projects, pass `scope:"project"` for this repo only), `warning`, `idea` (brainstorms, never a fact or decision), `task`, `overview` (the project's what-is-what, one per project: a new one replaces the previous). Deferred feature = `decision` with `review_when`.
  - Quote identifiers **verbatim** in backticks; set `anchors:[{file, symbol, line}]` for code.
  - `confidence` ≥ 0.7 is accepted automatically; use < 0.7 for anything inferred.
  - A near-duplicate is refused with the id of the existing memory: update that one. `force:true` only if it really is different.
- **Close a finished task:** `uac_update({id, status:"done", reason})`.
- **Review:** `uac_review({})` lists items that need a human. After the user decides: `uac_review({resolve:[{id, action:"accept"|"reject", body?}]})`.
- **Messages across agents and branches:**
  - Several packages in one repo (`fe/` + `be/`, workspaces): if you work in only one, call `uac_bootstrap({area:"<package>"})` once.
  - Send `uac_message({text, to})`, where `to` is `all`, `branch:<name>`, `session:<ref>`, `package:<name>` (the session working in that package) or `project:<name>` (a project next to this one), when you change something another session depends on (an interface, shared type, schema, route, config key, or a file listed under "Other active branches"). Name the verbatim identifiers.
  - Incoming messages arrive once, in the start context or as `[UAC] Message(s) from other sessions` at a prompt. Act on them. `uac_message({})` without text reads your unread ones.
- **Inline controls** typed by the user (`#uac on|off|pause|resume|save [n]|stop|fresh|continue <n>|deep|name <title>|rollup|import|msg <text>`, or `uac: …`) are applied by the hook. Just acknowledge them.

### 4. Save

When the user types `#uac save`, a hook asks for a save (`[UAC] Save requested…`, or another session "ended with N unsaved events"), or the work is done:
1. If your host has subagents, delegate this to a cheap one. Otherwise do it yourself.
2. Load the tools if they are deferred (ToolSearch `uac_digest`, `uac_save`).
3. `uac_digest({session_id})`. Always pass `session_id` explicitly. It returns `{session_id, goal, base_event_id, upto_event_id, events, existing, diff_stat, recheck, open_tasks, duplicates, previous_chapter, open_items, overview, more, how_to_save}`.
   - `diff_stat` covers all changes since the session started, including subagent and background edits.
   - Every `recheck` item is a memory whose anchored files changed: check it at its anchored path and emit `verify`, `update`, `supersede` or `conflict`.
   - `open_tasks`: close finished ones with `op:'done'`; update the ones still in progress.
   - `duplicates`: groups of same-type memories that overlap. Merge real duplicates with one `op:'supersede'` and `ids:[…]`.
   - Every save is a **chapter**: summarise ONLY the events in this digest. Earlier chapters stay as they are.
   - `open_items`: the session's open next steps, numbered. Put the finished ones' numbers in `checkpoint.closed`; the rest carry forward automatically. Put only new work in `next_steps`.
   - `overview` (`{id, body}` or null): only if this chapter changed what the project is, its parts, its version/state or where its docs live, add ONE candidate `{op:'update', id, type:'overview', title:'Project overview', body}` (`op:'add'` if null), at most 150 words.
   - `more`: the digest is paged; the later events become the next chapter at the next save.
   - `how_to_save` is the full recipe for step 4.
4. ONE `uac_save({session_id, base_event_id, upto_event_id, model:<your model id>, summary:{title, body}, checkpoint:{goal, working, broken, files:[], next_steps:[], closed:[], note, gaps}, candidates:[…]})`.
   - `summary` and `checkpoint` are **required objects**: `summary` needs a `title`; `checkpoint` needs a `goal` plus `next_steps` or a `note`. An incomplete card is refused and nothing is written or deleted; the error says what to fix.
   - Copy `session_id`, `base_event_id` and `upto_event_id` from the digest. A stale `base_event_id` (another save got there first) is rejected.
   - `summary.title`: verb + object + outcome, e.g. `Add per-user login rate limiter in src/auth.js (in-memory Map)`. `body` about 200 words.
   - `checkpoint.gaps`: what you left out or didn't verify. Shown to the next session as "Not in this card".
   - Candidates: durable knowledge only, reconciled against `existing`. `op`: add | update(id) | supersede(id or ids) | conflict(id) | verify(id) | done(id) | noop. At most 20, identifiers verbatim, `anchors` + `files` on code items, honest `confidence`, no secrets. Only this project's memory ids.
5. Reply one line starting `UAC saved:`, e.g. `UAC saved: "<title>" · N accepted, M low-confidence, K conflicts, V verified`.

**Pause:** `uac_capture({state:"paused"})`. **Stop:** save, then `uac_capture({state:"off"})`.
**Handoff** (continue elsewhere): save, then `uac_handoff({})`, then tell the user to type `#uac continue <n>` in the other session.

### DON'T

- Don't reload context or ask load/record questions when the header is present.
- Don't rely on ⚠ / ✗ items or another model's claims without checking the anchor at its own path.
- Don't paraphrase identifiers.
- Don't store tool noise, stack traces, test output, logs, failed attempts, secrets, credentials or personal data.
- Don't dump whole context into the chat. Fetch by id.
- Don't hard delete. That's the user's job (dashboard `uac view`, or `uac rm` / `uac forget`).
