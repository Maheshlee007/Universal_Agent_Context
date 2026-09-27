---
name: uac-review
description: Walks the user through pending UAC memory proposals and conflicts, and accepts, rejects or edits each one. Use when the user runs /uac review, when the UAC menu shows proposed or conflict counts above zero, or after uac-compressor, uac-init-knowledge or uac-refresh has produced proposals.
---

# UAC review

The user owns memory. Nothing proposed becomes active without their say, except the auto-accept types in automatic mode. You use the uac MCP tools (short names below).

## Steps

1. Call `uac_review({})`. It returns `proposed` items and `conflicts` (each conflict has `memory` and `other`). If both are empty, say `UAC review queue empty` and stop.
2. Tell the user the counts first: `N proposals, M conflicts`.
3. **Proposals:**
   - For each one, show:
     - `type · title`
     - the body, max 3 lines
     - `why`
     - `files`
     - `confidence`
   - Ask with AskUserQuestion: **Accept / Reject / Edit**.
   - Batch up to 4 items per call.
   - If there are more than 12 proposals, first offer "Accept all with confidence ≥ 0.8, review the rest".
4. **Conflicts:**
   - Show the existing memory and the new one side by side, with dates and sources.
   - If one side is checkable, check the current code, and say which side it supports.
   - Ask: **Keep new / Keep existing / Merge**.
5. **Apply** each answer with `uac_resolve({id, action, body?})`:
   - Accept: `action:"accept"`.
   - Reject: `action:"reject"`.
   - Edit: ask for the new wording, or draft it and confirm. Then `action:"accept", body:<edited>`.
   - Keep new: accept the new item.
   - Keep existing: reject the new item.
   - Merge: accept the new item with the merged `body`.
6. **Finish** with one line: `accepted A, rejected R, edited E`.

**Rules:**
- Don't pre-decide for the user.
- Recommend, if it helps. For example, flag low confidence, missing `why`, secrets, or noise that should be rejected.
- Proposals that contain secrets or credentials: recommend Reject and say why.
