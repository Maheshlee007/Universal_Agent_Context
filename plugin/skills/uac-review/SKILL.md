---
name: uac-review
description: Walks the user through the UAC items that still need a human - conflicts and low-confidence proposals - and accepts, rejects or edits each one. Use when the user runs /uac review, when the UAC header shows conflicts or items waiting for review, or after uac-compressor, uac-init-knowledge or uac-refresh reports low-confidence items or conflicts.
---

# UAC review

The compressor is the first reviewer: candidates with confidence ≥ 0.7 and no conflict are accepted automatically in every mode. Only **conflicts** and **low-confidence** items (< 0.7) wait for a human. You use the uac MCP tools (short names below).

## Steps

1. `uac_review({})` returns `proposed` items and `conflicts` (each with `memory` and `other`). Both empty: say `UAC review queue empty` and stop.
2. Tell the user the counts: `N low-confidence, M conflicts`.
3. **Conflicts first.**
   - Show the existing memory and the new one side by side, with dates, `source_model` and anchors.
   - Check the anchors in the current code, and say which side the code supports.
   - Ask: **Keep new / Keep existing / Merge**.
4. **Low-confidence proposals.**
   - Show `type · title`, body (max 3 lines), `why`, anchors, `confidence`.
   - If the anchor is checkable, check it and recommend.
   - Ask: **Accept / Reject / Edit**. Batch up to 4 per AskUserQuestion call.
5. **Apply** each answer with `uac_resolve({id, action, body?})`:
   - Accept / Keep new: `action:"accept"`. Reject / Keep existing: `action:"reject"`.
   - Edit / Merge: draft the wording, confirm it, then `action:"accept", body:<edited>`.
6. **Finish** with one line: `accepted A, rejected R, edited E`.

**Rules:**
- Don't pre-decide. Recommend when it helps (code supports one side, missing `why`, noise).
- Proposals containing secrets or credentials: recommend Reject and say why.
- Wrong auto-accepted items are fixed in the dashboard ("Recently auto-accepted" → undo / invalidate) or with `uac_invalidate`.
