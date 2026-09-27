---
name: uac-refresh
description: Re-verifies stale UAC memories against the current code, then confirms, updates or invalidates each one. Use when the user runs /uac refresh, when the UAC menu or bootstrap shows stale items, or after large refactors or merges have changed files that memories point to.
---

# UAC refresh

Stale memories point to files that changed after the memory was written. Check each one against the code. Don't just flag it. You use the uac MCP tools (short names below).

## Steps

1. Call `uac_search({query:"", status:"stale", limit:50})`.
   - If the user named a topic or path, use that as the query instead.
   - If an empty query is rejected, search by type (`architecture`, `decision`, `constraint`, ...) with `status:"stale"`.
   - Then `uac_get({ids})` for the full bodies and their `files`.
2. For each memory:
   - Read its `files` as they are now. Look at `git log -p --since=<updated_at> -- <files>` or `git diff <source_commit> -- <files>` where available. If a file is gone, find where the logic moved.
   - Decide:
     - **Still true:** `uac_update({id, body:<same or tightened>, reason:"re-verified against current code", evidence:"<file:line or commit>"})`. This refreshes `last_verified_at`.
     - **Partly true:** `uac_update` with the corrected body, `files` paths in the body if they moved, and the evidence.
     - **No longer true:** `uac_invalidate({id, reason, superseded_by?})`. If something replaced it, first `uac_propose` the new version, then pass its id as `superseded_by`.
     - **Can't tell:** leave it, and list it for the user with the question you couldn't answer.
3. Never mark something verified without actually opening the current file.
4. **Report** in one line: `refreshed N: confirmed A, updated B, invalidated C, unresolved D`. Then list the unresolved ones.

In manual mode, updates become proposals. Suggest `/uac review` afterwards.
