---
description: Control UAC (Universal Agent Context) for this session - record on/off, save, continue from earlier sessions, messages, review, dashboard.
argument-hint: on|off|pause|resume|save|stop|status|fresh|continue <n…>|import|msg <text>|mode off|manual|automatic|review|view|handoff|rm <n…>|doctor|init|refresh|forget
---

The user ran `/universal-agent-context:uac $ARGUMENTS` (this is how the command is invoked in Claude Code).

**Tip for the user:** typing `#uac on`, `#uac off`, `#uac pause`, `#uac resume`, `#uac save`, `#uac stop`, `#uac fresh`, `#uac continue 2 3`, `#uac import` or `#uac msg <text>` anywhere in a prompt does the same thing in every host (Claude, Codex, Gemini, Cursor, Copilot…). The hook handles it with no model involved. Mention this once if the user seems to be learning the commands.

Use the uac MCP tools (in Claude Code: `mcp__uac__<name>` or with a plugin prefix; short names below). Take the session id from the injected UAC header if present, otherwise leave `session_id` out. CLI fallback when MCP isn't available: `node "${CLAUDE_PLUGIN_ROOT}/bin/uac.mjs" <command> --json`.

First word of `$ARGUMENTS` = action, the rest = arguments. No action = `status`.

## Actions

**on** — `uac_capture({state:"on"})`. Reply `UAC recording`.

**off** — `uac_capture({state:"off"})`. Reply `UAC off for this session`.

**pause** — `uac_checkpoint({goal, working, broken, files, next_steps, note})` with the current state (`note` = what you'd tell the next dev), then `uac_capture({state:"paused"})`. Reply `UAC paused - checkpoint saved`.

**resume** — `uac_capture({state:"on"})`. Reply `UAC recording`.

**save** — Spawn the `universal-agent-context:uac-compressor` subagent (Agent tool, `model: "haiku"`, foreground) with the prompt `session_id=<session_id>`. If it is unavailable or fails, call `uac_digest` yourself and follow its `how_to_save`. Relay its one-line result. Don't summarize the session yourself.

**stop** — Do **save**, then `uac_capture({state:"off"})`. Reply `UAC stopped - saved and off`.

**status** — Run `node "${CLAUDE_PLUGIN_ROOT}/bin/uac.mjs" status --json`. Report in at most 4 lines: mode and recording state, knowledge counts, unsaved sessions, items waiting for review. If conflicts or low-confidence items wait, suggest `/universal-agent-context:uac review`.

**fresh** — `uac_bootstrap({fresh:true})`: reload with project knowledge only, no session cards. Say what was loaded in one line.

**continue <n…>** — `uac_bootstrap({sessions:[<n…>]})` with the session numbers as given (same numbering as `uac sessions` and the dashboard). No numbers: run `node "${CLAUDE_PLUGIN_ROOT}/bin/uac.mjs" sessions` and show the first 6 as `#n title`, then ask which. Treat what's loaded as claims to verify (see `uac-protocol`).

**import [n]** — Run `node "${CLAUDE_PLUGIN_ROOT}/bin/uac.mjs" import <n> --json` (no n = the current session). It rebuilds events from the host transcript of a session that ran without recording. Then do **save** for that session.

**msg <text>** — `uac_message({text, to})`. `to` defaults to `all`; if the user names a branch or session use `branch:<name>` / `session:<id>`. Reply `Message posted to <to>`.

**mode off|manual|automatic** — Run `node "${CLAUDE_PLUGIN_ROOT}/bin/uac.mjs" mode <mode> --json` and confirm in one line. No mode given: ask once with AskUserQuestion:
- off: nothing loaded, nothing recorded
- manual: loads project knowledge and this branch's latest session card; records only after `#uac on`
- automatic: loads and records; saves at the end

**review** — Follow the `uac-review` skill (only conflicts and low-confidence items need a human).

**view** — Run `node "${CLAUDE_PLUGIN_ROOT}/bin/uac.mjs" view` in the background (Bash `run_in_background`; it keeps running). Give the user the `UAC viewer: http://127.0.0.1:…/?t=…` URL from its output.

**handoff** — Follow the `uac-handoff` skill.

**rm <n…> | --empty** — Deleting a session cascades (events, card, and memories created only by that session). Run `node "${CLAUDE_PLUGIN_ROOT}/bin/uac.mjs" sessions` and show the sessions to delete with their titles, confirm with AskUserQuestion, then run `node "${CLAUDE_PLUGIN_ROOT}/bin/uac.mjs" rm <n…> --json` (or `rm --empty` for sessions with no events and no card). Report the deleted counts.

**doctor** — Run `node "${CLAUDE_PLUGIN_ROOT}/bin/uac.mjs" doctor`. Relay DB path, sizes, integrity, FTS5, WAL size and recent hook errors; point out anything wrong.

**init** — Follow the `uac-init-knowledge` skill.

**refresh** — Follow the `uac-refresh` skill.

**forget <id | query>** — Given a query, `uac_search` first and confirm the ids with AskUserQuestion. Then `uac_invalidate({id, reason:"user asked to forget"})` for each. Permanent deletion is the user's job, via the dashboard (`view`) or `uac forget <id>`.

Anything else: list the actions above in one line.
