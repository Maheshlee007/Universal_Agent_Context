---
name: uac-handoff
description: Hands the current work to another session (a new window, another branch, or another host such as Codex or Gemini) by saving this session's card and marking it as the next session's context; the other session then types "#uac continue <n>". Use when the user runs /uac handoff, says they are switching sessions, agents or machines, wants to "continue this in another window", or is ending the day mid-task.
---

# UAC handoff

Handoff = "continue from this session somewhere else". The receiving session loads this session's card, with no re-explaining. You use the uac MCP tools (short names below).

## Steps

1. **Checkpoint the real state.** `uac_checkpoint({goal, working, broken, files, next_steps, note})`.
   - `working`: done and verified. `broken`: what fails now, with the exact symptom.
   - `next_steps`: ordered, concrete, each doable on its own.
   - `note`: what you'd tell the next dev: the gotcha, the current hypothesis, what not to retry. Quote identifiers verbatim.
2. **Save the card.** Spawn `uac-compressor` with `session_id=<id>` (hosts without subagents: `uac_digest` → `uac_save`), so the card and knowledge are current.
3. **Mark it as next.** `uac_handoff({session_id})`. It returns the session number `n`.
4. **Tell the user this, and nothing more:**
   ```
   Handoff ready: session #<n>
   A new session in this project will load it automatically.
   In an already-open session (any host), type:  #uac continue <n>
   ```

If the other session works on a different branch and touches the same interfaces, also leave a `uac_message({to:"branch:<name>", text})` naming the verbatim identifiers.
