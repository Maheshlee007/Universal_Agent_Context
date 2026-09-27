---
name: uac-handoff
description: Packages the current work into a UAC checkpoint and pack that a parallel or later session (any host - Claude, Codex, Gemini and others) can load with one line. Use when the user runs /uac handoff, says they are switching sessions, agents or machines, wants to "continue this in another window", or is ending the day mid-task.
---

# UAC handoff

The goal is that the receiving session starts exactly where this one stopped, with no re-explaining. You use the uac MCP tools (short names below).

## Steps

1. **Checkpoint the real state.** Call `uac_checkpoint({goal, working, broken, files, next_steps, note})`.
   - `working`: what is done and verified.
   - `broken`: what fails right now, with the exact symptom.
   - `next_steps`: ordered, concrete, each one doable on its own.
   - `note`: what you'd tell the next dev. Cover the gotcha, the current hypothesis, and what not to retry.
2. **Record unsaved decisions.** Anything decided in this session that isn't a memory yet gets a `uac_propose`, so it travels with the pack.
3. **Create the pack.** Call `uac_handoff({name})`.
   - Default `name`: a short slug of the goal.
   - It returns a pack id like `pk-3f2a`.
4. **Give the user this, and nothing more:**
   ```
   Handoff ready: pk-3f2a
   In the other session run:  /uac load pk-3f2a
   (other hosts: ask the agent to call uac_bootstrap with pack "pk-3f2a")
   ```
5. If this session is ending, offer `/uac save` so the full summary is stored too.

**Parallel sessions:** a Fork load (project memories only) is often enough for a clean side session. Suggest it if the other session is unrelated work.
