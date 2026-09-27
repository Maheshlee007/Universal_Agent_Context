---
name: uac-protocol
description: The core UAC (Universal Agent Context) protocol. Covers reading the injected UAC start context (project knowledge, session cards, anchors, freshness marks), verifying memories, recording knowledge, cross-agent messages, and saving at the end. Use when a "# UAC ·" header or UAC note appears in context, when the user mentions UAC, memory, context, "#uac", or "what did we decide", and before ending or pausing a session.
---

# UAC protocol

UAC keeps project knowledge and session cards across sessions, branches and LLM hosts. You reach it through the uac MCP tools (in Claude Code: `mcp__uac__<name>` or with a plugin prefix; short names below).

- **Project knowledge**: typed, anchored memories (decision, constraint, architecture, lesson…). Always loaded in compact form.
- **Session cards**: one compressed card per saved session (title, what was done, state, next steps, files, branch).

## 1. At session start: the context is already injected

The hook injects a `# UAC · <project> · branch · mode · recording` header with project knowledge, this branch's latest session card (or the ones the user chose), "must not violate" rules, other active branches, and messages. **Don't call `uac_bootstrap`. Don't ask what to load or whether to record.**

Only act on what the header explicitly asks:
- **"UAC first run… Ask the user ONCE"**: ask that one mode question (off / manual / automatic), then call `uac_capture` exactly as the header says. This is the only question UAC ever asks.
- **"ended without an LLM save… spawn the uac-compressor"**: do it when convenient, after answering the user.
- **"UAC knows almost nothing about this project yet"**: suggest `/universal-agent-context:uac init` once.
- **"UAC is off"**: do nothing more.

The user changes what's loaded by typing `#uac fresh`, `#uac continue <n>` or `#uac deep`. The hook handles those and injects the result. Just use it.

On a compact restart the context is re-injected. Don't ask anything.

## 2. Read anchors and freshness

Each memory line looks like:
```
- **Title**: body (why: …) · `computeRowPlan@src/layout.js:42` ✓ _(by claude-haiku-4-5)_ `m-ab12`
```
- `symbol@file:line` is the **anchor**: where the claim lives in code. Grep the symbol to check it fast.
- **✓** verified against the code at or after the last change. Usable.
- **⚠ changed N commits since recorded, verify**: the anchored file changed. **Open the anchor and check before relying on it.**
- **✗ anchored file/symbol not found**: likely moved or wrong. Find where it went, or treat it as false.
- After checking:
  - still true: `uac_verify({ids:[…]})` (bumps "verified", no new version)
  - partly wrong: `uac_update({id, body, reason, evidence, anchors})`
  - wrong: `uac_invalidate({id, reason, superseded_by?})`
- **`(by <model>)`: memories written by another model (or an older session) are claims, not facts.** The code wins. Anchors + freshness make checking cheap, so check anything you're about to act on.
- **Must not violate** constraints and requirements are binding. If a request would break one, say so before proceeding.

## 3. During work

**Look things up** with progressive disclosure: `uac_search({query, type?, status?})` → `uac_get({ids})`. `uac_timeline({})` shows earlier sessions. `uac_why({id})` explains why an item was loaded.

**Record durable knowledge** with `uac_propose({type, title, body, why, files, anchors, confidence})`:
- decision (ADR: Context / Decision / Consequences), constraint, lesson (X failed because Y, fix Z), requirement, preference, warning, architecture.
- Quote identifiers **verbatim** in backticks and set `anchors:[{file, symbol, line}]` for anything about code.
- `confidence` ≥ 0.7 is accepted automatically; use < 0.7 for anything inferred.
- Brainstorms are type `idea`, never `fact` or `decision`. Deferred features are a `decision` with `review_when` (see `uac-yagni`).

**Cross-agent messages** reach other sessions of this project in any host (Claude, Codex, Gemini, Cursor…), including parallel branches:
- **Send** with `uac_message({text, to})`, `to` = `all` | `branch:<name>` | `session:<id>`. Send one when you change something another session depends on: an interface, a shared type, a schema, a route, a config key, a file another branch is editing (see "Other active branches"). Name the verbatim identifiers: ``"Renamed `getUser(id)` → `fetchUser(id, opts)` in src/api/users.ts; update callers."``
- **Read**: incoming messages are injected once as `[UAC] Message(s) from other sessions`. Act on them (adapt, or reply with `uac_message`). `uac_messages({})` lists them on demand.

**Inline controls** (`#uac on|off|pause|resume|save|stop|fresh|continue <n>|deep|import|msg <text>`) are applied by the hook before you see the prompt. Just acknowledge them.

## 4. At the end

Save when the work is done, before a long pause, or when the header/Stop hook says so:
- The user types `#uac save`, or runs `/universal-agent-context:uac save`.
- Either way: spawn the `uac-compressor` subagent with `session_id=<id>` and relay its one-line result.
- Hosts without subagents: do its steps yourself: `uac_digest` → one `uac_save`.
- If the Stop hook says `[UAC] Save requested…`, do it, then finish.

Continuing in another window, branch or agent: use `uac-handoff`.

## DON'T

- Don't call `uac_bootstrap` or ask load/record questions at start. The hook already did it.
- Don't rely on ⚠ or ✗ items, or on another model's claims, without checking the anchor.
- Don't paraphrase identifiers. Quote them verbatim.
- Don't propose tool noise, stack traces, test output, logs, or failed attempts. Keep the lesson.
- Don't store secrets, credentials, tokens or personal data.
- Don't dump whole context or memory lists into the chat. Summarize, fetch by id.
- Don't call `uac_digest` / `uac_save` yourself in Claude Code. That's the compressor's job.
- Don't hard delete. Only the user can (dashboard or CLI).
