# UAC protocol (host-neutral)

> Paste this section into `AGENTS.md`, `GEMINI.md`, or your host's rules file. It's for hosts without Claude Code skills. It matches `plugin/skills/uac-protocol/SKILL.md`.

## Universal Agent Context (UAC)

This project uses UAC for project knowledge and session cards shared across sessions, branches and agents. Use the **uac MCP tools** (server `uac`; your host may prefix them, e.g. `mcp__uac__uac_verify`).

**CLI fallback** (no MCP): `node <repo>/plugin/bin/uac.mjs <command> --json`, where `<repo>` is the UAC checkout. Commands: `status`, `sessions`, `session <n|id>`, `search <query>`, `get <id…>`, `next <n…> | --clear`, `msg "<text>" [--to all|branch:<b>|session:<id>]`, `msgs`, `import [n]`, `mode off|manual|automatic`, `review`, `doctor`, `view`.

### 1. Start of session: context is injected

- If a `# UAC · <project> · branch · mode · recording` header is in your context, the hook already loaded project knowledge, this branch's latest session card (or the user's chosen ones), must-not-violate rules, other active branches and messages. **Don't call `uac_bootstrap`. Don't ask what to load or whether to record.**
- No header (MCP-only host, no hooks): call `uac_bootstrap({goal:<the user's first request>})` once, without asking.
- Act only on what the header explicitly asks:
  - **"UAC first run… Ask the user ONCE"**: ask the one mode question (off / manual / automatic), then call `uac_capture` as the header says.
  - **"ended without an LLM save"**: compress that session (section 4) when convenient, after answering the user.
  - **"UAC knows almost nothing about this project yet"**: suggest surveying the codebase once.
  - **"UAC is off"**: do nothing more.
- The user changes what's loaded by typing `#uac fresh`, `#uac continue <n…>` or `#uac deep`. The hook applies it.

### 2. Anchors and freshness

Memory lines look like `- **Title**: body · \`computeRowPlan@src/layout.js:42\` ✓ _(by claude-haiku-4-5)_ \`m-ab12\``.
- `symbol@file:line` is the anchor. Grep the symbol to check it.
- **✓** verified against code: usable. **⚠** file changed N commits since: **check the anchor before relying on it**. **✗** file/symbol not found: find where it moved, or treat as false.
- After checking: still true → `uac_verify({ids:[…]})`; partly wrong → `uac_update({id, body, anchors, reason, evidence})`; wrong → `uac_invalidate({id, reason, superseded_by?})`.
- **Memories written by another model (`by <model>`) are claims, not facts.** The code wins.
- Must-not-violate constraints and requirements are binding. Warn before breaking one.

### 3. During work

- **Look up:** `uac_search({query, type?, status?})` → `uac_get({ids})`. `uac_timeline({})` for past sessions. `uac_why({id})` for why an item was loaded.
- **Propose durable knowledge** with `uac_propose({type, title, body, why, files, anchors, confidence})`. Types: `decision` (ADR: Context / Decision / Consequences), `constraint`, `lesson` (X failed because Y, fix Z), `requirement`, `architecture`, `preference`, `warning`, `idea` (brainstorms, never a fact or decision), `task`. Deferred feature = `decision` with `review_when`.
  - Quote identifiers **verbatim** in backticks; set `anchors:[{file, symbol, line}]` for code.
  - `confidence` ≥ 0.7 is accepted automatically; use < 0.7 for anything inferred.
- **Messages across agents and branches:**
  - Send `uac_message({text, to})`, `to` = `all` | `branch:<name>` | `session:<id>`, when you change something another session depends on (an interface, shared type, schema, route, config key, or a file listed under "Other active branches"). Name the verbatim identifiers.
  - Incoming messages are injected once as `[UAC] Message(s) from other sessions`. Act on them. `uac_messages({})` lists them.
- **Inline controls** typed by the user (`#uac on|off|pause|resume|save|stop|fresh|continue <n>|deep|import|msg <text>`) are applied by the hook. Just acknowledge them.

### 4. End of session: save

When the user types `#uac save`, the Stop hook asks for a save (`[UAC] Save requested…`), or the work is done:
1. If your host has subagents, delegate this to a cheap one. Otherwise do it yourself.
2. `uac_digest({session_id})` — always pass `session_id` explicitly, don't rely on a default — returns `{base_event_id, upto_event_id, events, existing, diff_stat, recheck, open_tasks, duplicates, how_to_save}`.
   - `diff_stat` covers all changes since the session started, including subagent and background edits.
   - Every `recheck` item is a memory whose anchored files changed: verify it against the diff/file and emit `verify`, `update`, `supersede` or `conflict` for it.
   - `open_tasks`: active tasks/warnings from this project. Close finished ones with `op:'done'`; update the ones still in progress.
   - `duplicates`: same-type memory pairs whose titles overlap strongly. Merge real duplicates with `op:'supersede'` and `ids:[…]` (all the duplicate ids) instead of leaving them to grow forever.
   - `how_to_save` is a self-contained recipe for step 3, in case you're not the compressor and this is the first time you're saving.
3. ONE `uac_save({session_id, base_event_id, upto_event_id, model:<your model id>, summary:{title, body ≤200 words}, checkpoint:{goal, working, broken, files, next_steps, note, gaps}, candidates:[…]})`.
   - Copy `session_id`, `base_event_id` and `upto_event_id` straight from the digest. `base_event_id` guards against two saves racing on the same session (a stale base is rejected); `upto_event_id` marks how far this save covers.
   - `summary.title`: verb + object + outcome, e.g. `Add per-user login rate limiter in src/auth.js (in-memory Map)`. Never generic.
   - `checkpoint.gaps`: what you left out or didn't verify. Shown to the next session as "Not in this card".
   - Candidates: durable knowledge only, reconciled against `existing`. `op`: add | update(id) | supersede(id, ids?) | conflict(id) | verify(id) | done(id) | noop. `ids:[…]` on `supersede` merges several duplicate memories into one. At most 20, identifiers verbatim, `anchors` + `files` on code items, honest `confidence`, no secrets.
4. Report one line: `UAC saved: "<title>" · N accepted, M low-confidence, K conflicts, V verified`.

**Pause:** `uac_checkpoint({…})`, then `uac_capture({state:"paused"})`. **Stop:** save, then `uac_capture({state:"off"})`.
**Handoff** (continue elsewhere): checkpoint, save, `uac_handoff({})`, then tell the user to type `#uac continue <n>` in the other session.

### DON'T

- Don't call `uac_bootstrap` or ask load/record questions when the header is present.
- Don't rely on ⚠ / ✗ items or another model's claims without checking the anchor.
- Don't paraphrase identifiers.
- Don't store tool noise, stack traces, test output, logs, failed attempts, secrets, credentials or personal data.
- Don't dump whole context into the chat. Fetch by id.
- Don't hard delete. That's the user's job (dashboard `uac view`, or `uac rm` / `uac forget`).
