---
name: uac-refresh
description: Re-verifies stale UAC memories (marked ⚠ or ✗) against the current code, then verifies, updates or invalidates each one. Use when the user runs /uac refresh, when the UAC header shows ⚠ or ✗ items, or after large refactors or merges have changed files that memories point to.
---

# UAC refresh

Stale memories (⚠ file changed since recorded, ✗ anchor not found) point to files that changed after the memory was written. Check each one against the code. Don't just flag it. You use the uac MCP tools (short names below).

## Steps

1. Call `uac_search({query:"", status:"stale", limit:50})`.
   - If the user named a topic or path, use that as the query instead.
   - If an empty query is rejected, search by type (`architecture`, `decision`, `constraint`, ...) with `status:"stale"`.
   - Then `uac_get({ids})` for the full bodies, `anchors` and `files`.
2. For each memory:
   - Open each anchor (`symbol@file:line`): grep the verbatim symbol, then read its `files` as they are now. Look at `git log -p --since=<updated_at> -- <files>` or `git diff <source_commit> -- <files>` where available. If a file is gone, find where the logic moved.
   - Decide:
     - **Still true:** collect the id; at the end call `uac_verify({ids:[…]})` once. This bumps `last_verified_at` without writing a new version.
     - **Partly true:** `uac_update({id, body, anchors, reason, evidence})` with the corrected body, identifiers quoted verbatim, and anchors pointing at the current `{file, symbol, line}`.
     - **No longer true:** `uac_update({id, status:"superseded", reason, superseded_by?})`. If something replaced it, first `uac_propose` the new version, then pass its id as `superseded_by`.
     - **Can't tell:** leave it, and list it for the user with the question you couldn't answer.
3. Never mark something verified without actually opening the current file.
4. **Report** in one line: `refreshed N: confirmed A, updated B, invalidated C, unresolved D`. Then list the unresolved ones.

If anything ended up as a conflict or low-confidence item, suggest `/universal-agent-context:uac review`.
