---
description: Control UAC (Universal Agent Context) memory for this session - capture, save, load, review, view, handoff.
argument-hint: start|pause|resume|stop|save|status|load|review|view|handoff|forget|init|refresh|mode
---

The user ran `/uac $ARGUMENTS`.

Use the uac MCP tools. In Claude Code they appear as `mcp__uac__<name>` or with a plugin prefix. The short names are used below. Get the session id from the UAC SessionStart menu if one is in context, otherwise leave `session_id` out.

The CLI fallback, for when MCP isn't available, is `node "${CLAUDE_PLUGIN_ROOT}/bin/uac.mjs" <command> --json`.

Take the first word of `$ARGUMENTS` as the action and everything after it as the rest. If there's no action, treat it as `status`.

## Actions

**start**
1. Call `uac_capture({state:"on"})`.
2. If nothing has been loaded this session, ask the load tier with AskUserQuestion: Minimal / Relevant / Deep / Fork / None. Then call `uac_bootstrap({tier, goal:<current task>})`.
3. Tell the user `UAC capture on`.

**pause**
1. Call `uac_checkpoint({goal, working, broken, files, next_steps, note})` with the current state of the work. `note` is what you'd tell the next dev.
2. Call `uac_capture({state:"paused"})`.
3. Tell the user `UAC paused - checkpoint saved`.

**resume**
1. Call `uac_capture({state:"on"})`.
2. Call `uac_timeline({})`. Restate the latest checkpoint's next steps in 1 to 3 lines.

**save**
1. Spawn the `uac-compressor` subagent with the Agent (Task) tool. The prompt is `Save UAC session <session_id>`.
2. Relay its one-line result to the user. Don't summarize the session yourself.

**stop**
1. Do everything under **save**.
2. Call `uac_capture({state:"off"})`.
3. Tell the user `UAC stopped - saved and capture off`.

**status**
- Run `node "${CLAUDE_PLUGIN_ROOT}/bin/uac.mjs" status --json`.
- Report in at most 4 lines:
  - mode and capture state
  - counts: active / proposed / stale / conflict / tasks
  - any unsaved sessions
- If anything is proposed or in conflict, suggest `/uac review`.

**load [pack-id | tier]**
- Given a `pk-…` id, call `uac_bootstrap({pack:<id>})`.
- Given a tier name, call `uac_bootstrap({tier})`.
- Given nothing, call `uac_pack({action:"list"})` and ask which pack with AskUserQuestion.
- Treat what's loaded as possibly stale. Verify critical facts against the code.

**review**
1. Call `uac_review({})`.
2. If it's empty, say so and stop.
3. For each proposed item, show the type, title, body, why and files. Ask with AskUserQuestion: Accept / Reject / Edit.
   - Edit: take the user's wording as the new `body`.
4. For each conflict, show both sides. Ask with AskUserQuestion: Keep new / Keep existing / Merge (edit).
   - Keep new: accept the new item.
   - Keep existing: reject the new item.
   - Merge: accept the new item with the merged `body`.
5. Apply each answer with `uac_resolve({id, action:"accept"|"reject", body?})`.
6. Batch up to 4 items per AskUserQuestion call.
7. At the end, give one line: `accepted N, rejected M, edited K`.

**view**
- Run `node "${CLAUDE_PLUGIN_ROOT}/bin/uac.mjs" view` in the background (Bash `run_in_background`). It keeps running.
- Read the `UAC viewer: http://127.0.0.1:…/?t=…` line from its output and give the user that URL.

**handoff [name]**
- Follow the `uac-handoff` skill.
- The short version: `uac_checkpoint`, then `uac_handoff({name})`. Give the user the pack id and the paste-ready line `/uac load <pack-id>`.

**forget <id | query>**
- Given a query, `uac_search` first and confirm which ids with AskUserQuestion.
- Call `uac_invalidate({id, reason:"user asked to forget"})` for each one.
- Agents can't hard delete. If the user wants it erased permanently, send them to `/uac view` and its delete button.

**init**
- Follow the `uac-init-knowledge` skill.

**refresh**
- Follow the `uac-refresh` skill.

**mode [manual | automatic]**
- If no mode is given, ask with AskUserQuestion:
  - manual: nothing is saved without /uac save, and every proposal is reviewed
  - automatic: capture is on, saves happen at the Stop threshold, and decisions, architecture and lessons are auto-accepted
- Then run `node "${CLAUDE_PLUGIN_ROOT}/bin/uac.mjs" mode <mode> --json` and confirm in one line.

Anything else: list the actions above in one line.
