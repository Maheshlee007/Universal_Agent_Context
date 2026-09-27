---
name: uac-brainstorm
description: Runs a divergent brainstorm and stores the results in UAC strictly as type idea, so brainstorms never become facts or decisions. Use when the user asks to brainstorm, explore options, "throw out ideas", or list possibilities for a feature or problem and wants them remembered.
---

# UAC brainstorm

Ideas are cheap and must stay labelled as ideas. You use the uac MCP tools (short names below).

## Steps

1. **Ground it.** Call `uac_search({query:<topic>})` for existing ideas, decisions and constraints on the topic, then `uac_get` the relevant ones.
   - Don't re-propose ideas that already exist.
   - Don't propose ideas that break an active constraint without saying so.
2. **Diverge.** Produce 5 to 12 distinct options. Give each one a one-line pitch, its main upside, its main cost or risk, and the files or modules it would touch.
   - Include at least one "do nothing" or minimal option.
3. **Converge lightly.** Rank the top 3 with a sentence each. Don't decide unless the user explicitly does.
4. **Store.** Ask the user which ideas to keep (AskUserQuestion, multi-select). For each one kept, call:
   `uac_propose({type:"idea", title, body:<pitch + upside + cost>, why:<what prompted it>, files, anchors, confidence})`
   - `anchors:[{file, symbol, line}]`: the existing code each idea would change, identifiers quoted verbatim. Omit for ideas not tied to code.
5. **Report** the ids stored.

## Rules

- The type is **always `idea`**. Never `fact`, `decision`, `requirement` or `task`, even if the user likes one.
- If the user then commits to an idea, that's a separate step. Record a `decision` (ADR style, with why) that references the idea id, and optionally `uac_invalidate` the idea with `superseded_by`.
- To argue whether an idea is needed at all, use `uac-yagni`.
