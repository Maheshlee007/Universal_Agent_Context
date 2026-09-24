# UAC protocol (host-neutral)

> Paste this section into `AGENTS.md`, `GEMINI.md`, or your host's rules file. It's for hosts without Claude Code skills. It matches `skills/uac-protocol/SKILL.md`.

## Universal Agent Context (UAC)

This project uses UAC for memory across sessions and agents. Use the **uac MCP tools** (server `uac`). Your host may show them with a prefix, such as `mcp__uac__uac_bootstrap`.

**History ≠ Memory ≠ Context.**
- Events are what happened.
- Memories are typed knowledge.
- A context pack is the budgeted slice you need right now.

**CLI fallback** (when MCP isn't available): `node <path-to-uac>/bin/uac.mjs <command> --json`. Commands:
- `status`
- `capture on|paused|off`
- `mode manual|automatic`
- `choose --tier <t> [--pack ID] [--capture on|off]`
- `sessions`
- `search <query>`
- `view`

### 1. Start of session

1. If a **UAC menu** was injected (by the SessionStart or first-prompt hook), read it. It gives you the session id, the last checkpoint, counts, recent sessions and packs.
   - If there is no menu, call `uac_bootstrap({goal})` with no tier after asking the user (below), or run the CLI `status`.
2. If the menu reports an **unsaved previous session**, deal with it first:
   - automatic mode: compress it (section 3, step 2).
   - manual mode: ask the user.
3. **Ask the user**, in one message (use your host's question UI if it has one):
   - **Load:**
     - Minimal ~1k
     - Relevant ~4k (the default)
     - Deep ~10k
     - Fork (project memories only)
     - a pack id
     - None
   - **Capture this session:** on / off / decide later.
   - **Mode**, only if unset: manual (everything reviewed) or automatic. Behave as manual until answered.

   Skip this if the menu says the choice was already made.
4. Call `uac_capture({state, mode?})`, then `uac_bootstrap({tier | pack, goal:<the user's first request>})`.
5. **Memory may be stale.**
   - Verify critical facts against the code before relying on them. If they disagree, the code wins. Fix the memory with `uac_update` or `uac_invalidate`.
   - Treat "must not violate" constraints and requirements as binding. Warn before you break one.

### 2. During work

- **Progressive disclosure:**
  - `uac_search({query, type?, status?})` returns index lines. Then `uac_get({ids})` for full items.
  - `uac_timeline({})` shows past sessions.
  - `uac_why({id})` explains why an item was loaded.
- **Propose durable knowledge** with `uac_propose({type, title, body, why, files, confidence})`. Types:
  - `decision` (ADR style: Context / Decision / Consequences)
  - `constraint`
  - `lesson` (X failed because Y, fix Z)
  - `requirement`
  - `architecture`
  - `preference`
  - `warning`
  - `idea` (brainstorms: never a fact or decision)
  - `task`

  For a deferred feature, use a `decision` with `review_when:<trigger>`.
- **Correct memory:**
  - `uac_update({id, body, reason, evidence})`
  - `uac_invalidate({id, reason, superseded_by?})`
- **Review** with `uac_review({})`. Walk the user through each item, then `uac_resolve({id, action:"accept"|"reject", body?})`.

### 3. End of session (or pause / handoff)

1. Call `uac_checkpoint({goal, working, broken, files, next_steps, note})`. `note` is "what I'd tell the next dev".
2. **Save.** If your host has subagents, delegate this to a cheap one. Otherwise do it yourself:
   - `uac_digest({session_id})` returns `{upto_event_id, events, existing}`.
   - Then ONE `uac_save({session_id, upto_event_id, summary:{title, body ≤200 words}, checkpoint:{...}, candidates:[...]})`.
   - Candidates are durable knowledge only, reconciled against `existing`:
     - `op`: add | update(id) | supersede(id) | conflict(id) | noop
     - at most 20
     - each with `files` and `confidence`
     - no secrets
   - Report one line: `UAC saved: 1 summary, N proposals, M conflicts`.
3. **Pause:** checkpoint, then `uac_capture({state:"paused"})`.
   **Stop:** save, then `uac_capture({state:"off"})`.
4. **Handoff:** `uac_handoff({name})` returns `pk-…`. Tell the user to load it in the other session.

### DO

- Ask before loading or capturing. The user owns memory.
- Verify critical memories against the code.
- Propose sparingly, with `why`, `files` and an honest `confidence`.
- Search before proposing, so you update instead of duplicating.
- Checkpoint before pausing, compacting or ending.
- Show conflicts and stale items to the user.

### DON'T

- Don't treat memory as ground truth.
- Don't store tool noise, stack traces, test output, logs or failed attempts. Keep the lesson.
- Don't store secrets, credentials, tokens or personal data.
- Don't turn ideas into facts or decisions.
- Don't dump whole packs into the chat. Fetch by id.
- Don't hard delete. That's the user's job, via the viewer (`uac view`) or the CLI.
