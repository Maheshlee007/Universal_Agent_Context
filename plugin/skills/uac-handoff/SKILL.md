---
name: uac-handoff
description: Hands the current work to another session (a new window, another branch, or another host such as Codex or Gemini) by saving this session's card and marking it as the next session's context; the other session then types "#uac continue <n>". Use when the user runs /uac handoff, says they are switching sessions, agents or machines, wants to "continue this in another window", or is ending the day mid-task.
---

# UAC handoff

Handoff = "continue from this session somewhere else". The receiving session loads this session's card, with no re-explaining. You use the uac MCP tools (short names below).

## Steps

1. **Save the card.** Spawn `universal-agent-context:uac-compressor` (Agent tool, `run_in_background: false`, `model: "haiku"`; a background save is lost when the session exits) with the prompt the UAC header gives (it starts `session_id=<id>. Step 0: ToolSearch …`). Its reply must start with `UAC saved:`; if it doesn't, or the agent is unavailable, call `uac_digest` yourself and follow its `how_to_save`. The card is the handoff: its `working`, `broken`, `next_steps`, `note` and `gaps` must say exactly where things stand (hosts without subagents: `uac_digest` → `how_to_save`).
2. **Mark it as next.** `uac_handoff({session_id})`. It returns the session ref `#n` (stable; the short id next to it works too).
4. **Tell the user this, and nothing more:**
   ```
   Handoff ready: session #<n> (<short id>)
   A new session in this project will load it automatically.
   In an already-open session (any host), type:  #uac continue <n>
   ```

If the other session works on a different branch and touches the same interfaces, also leave a `uac_message({to:"branch:<name>", text})` naming the verbatim identifiers.
