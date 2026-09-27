---
name: uac-protocol
description: The core UAC (Universal Agent Context) memory protocol. Covers how to load project memory at session start, what to record during work, and how to checkpoint and save at the end. Use when a UAC SessionStart menu appears in context, when the user mentions UAC, memory, context, or "what did we decide", and before ending or pausing a session.
---

# UAC protocol

UAC keeps typed project memory across sessions and across LLM hosts. You reach it through the uac MCP tools. In Claude Code they appear as `mcp__uac__<name>` or with a plugin prefix. The short names are used below.

**History ≠ Memory ≠ Context.**
- Events are what happened.
- Memories are what's worth knowing.
- The context pack is the budgeted slice you need right now.

## 1. At session start

The SessionStart hook injects a **UAC menu**. It contains:
- the session id
- the last checkpoint's note and next steps
- counts (active / proposed / stale / conflict / tasks)
- recent sessions
- packs
- load tiers

Work through it in this order.

1. **Unsaved previous session.** If the menu says so, handle it first:
   - automatic mode: spawn `uac-compressor` for that session id.
   - manual mode: ask the user whether to save it.
2. **Ask with ONE AskUserQuestion call** that has up to three questions:
   - **Load:**
     - Minimal ~1k
     - Relevant ~4k (the default)
     - Deep ~10k
     - Fork (project memories only, no session state)
     - a listed pack
     - None
   - **Capture this session:** On / Off / Decide later.
   - **Mode:** only if the menu says the mode is unset. Offer manual (safe, everything is reviewed) or automatic (saves itself and auto-accepts decisions, architecture and lessons). Until the user answers, behave as manual.

   Skip these questions if the menu says a choice was already made in the VS Code extension.
3. **Apply the answers:**
   - Call `uac_capture({state, mode?})`.
   - Call `uac_bootstrap({tier | pack, goal:<the user's first request>})`.
   - On a `compact` restart the pack is re-injected. Don't ask again.
4. **Treat memory as possibly stale.**
   - It's evidence, not truth. Items marked `stale` or `conflict` are suspect.
   - Before acting on a critical fact (an API shape, a file location, a constraint), check it against the current code.
   - If memory and code disagree, the code wins. Propose a fix with `uac_update` or `uac_invalidate`.
5. **Constraints and requirements** listed as "must not violate" are binding. If a request would break one, say so before you proceed.

## 2. During work

**Look things up with progressive disclosure:**
- `uac_search({query, type?, status?})` returns index lines. Then `uac_get({ids})` fetches only the ones you need.
- `uac_timeline({})` shows what earlier sessions did.
- `uac_why({id})` explains why an item was in the pack. Use it when an item seems irrelevant or surprising.

**Record durable knowledge as it happens:**
- Call `uac_propose({type, title, body, why, files, confidence})`. Worth proposing:
  - a **decision** with its why (ADR style)
  - a **constraint** you discovered
  - a **lesson**: X failed because Y, fix Z
  - a **requirement** the user stated
  - a **preference** the user expressed
  - a **warning** about fragile code
- Anything brainstormed is type `idea`, never `fact` or `decision`.
- A deferred feature is a `decision` with `review_when` (see `uac-yagni`).
- To correct a memory: `uac_update({id, body, reason, evidence})`.
- To retire a wrong one: `uac_invalidate({id, reason, superseded_by?})`.

**Inline control.** The user can type `#uac pause`, `#uac resume` or `#uac off`, and the hook applies it. Just acknowledge it.

## 3. At the end (or pause, or handoff)

1. Call `uac_checkpoint({goal, working, broken, files, next_steps, note})`. `note` is "what I'd tell the next dev": short, human, concrete.
2. Save: spawn the `uac-compressor` subagent with the session id, and relay its one-line result.
   - Hosts without subagents do the compressor steps themselves: `uac_digest`, then one `uac_save`.
3. If the Stop hook says `UAC: spawn uac-compressor ...`, do it, then finish.
4. For a parallel or next session, use `uac-handoff`.

## DO

- Ask before loading or capturing. The user owns memory.
- Verify critical memories against the code before relying on them.
- Propose sparingly: at most a few high-signal items per task, each with `why`, `files` and an honest `confidence`.
- Write decisions ADR style: Context / Decision / Consequences.
- Search before proposing, so you update instead of duplicating.
- Checkpoint before a pause, a compaction-heavy step, or the end of the session.
- Surface conflicts and stale items to the user. Don't resolve them silently.

## DON'T

- Don't treat memory as ground truth or cite it over what the code shows.
- Don't propose tool noise, stack traces, test output, logs, or failed attempts. Keep the lesson, drop the noise.
- Don't store secrets, credentials, tokens or personal data, not even redacted-looking ones.
- Don't turn ideas or brainstorms into facts or decisions.
- Don't dump whole packs or memory lists into the chat. Summarize, and fetch by id.
- Don't call `uac_digest` or `uac_save` yourself in Claude Code. That's the compressor's job.
- Don't hard delete. Only the user can, via the viewer or CLI.
- Don't ask the start questions again after a compact restart, or when the extension already answered them.
