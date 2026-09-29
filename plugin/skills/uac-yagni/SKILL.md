---
name: uac-yagni
description: Argues whether a proposed feature, abstraction or dependency is actually needed now, then stores the verdict in UAC as a decision with a review_when revisit trigger. Use when the user asks "do we need this", "is this YAGNI", "should we build X now", or is weighing adding scope, infrastructure or a dependency.
---

# UAC YAGNI

The default answer is "not yet". The burden of proof is on building. You use the uac MCP tools (short names below).

## Steps

1. **Check history.** Call `uac_search({query:<feature>})` for earlier YAGNI verdicts, ideas and constraints.
   - If a deferred decision exists, check whether its `review_when` trigger has been met. That's the question now.
2. **State the claim.** In one line: what would be built and what problem it solves.
3. **Argue both sides** briefly, with evidence from the code and the user, not hypotheticals.
   - **For:** a current, concrete need. Who is blocked today? What breaks without it? Is there a measured number?
   - **Against:**
     - What does it cost to build, maintain and understand?
     - Does something that already exists cover 80% of it (the codebase, the stdlib, the platform, an installed dependency)?
     - What's the cost of adding it later instead of now?
4. **Verdict:** one of **Build now / Build minimal version / Defer / Drop**.
   - Defer and Drop need a **revisit trigger**: a concrete, observable condition, not a date. For example:
     - "> 100k events/day"
     - "a second storage backend is requested"
     - "p95 search latency > 200 ms"
5. **Confirm** the verdict with the user (AskUserQuestion). Then store it:
   ```
   uac_propose({
     type: "decision",
     title: "Defer <feature> until <trigger>",
     body: "Context: ...\nDecision: <verdict>\nConsequences: ...\nMinimal alternative in use: ...",
     why: <the deciding argument>,
     files: [<affected paths>],
     anchors: [{file, symbol, line}],   // the code the verdict is about, identifiers verbatim
     confidence: 0.8,
     review_when: "<trigger condition>"
   })
   ```
   Every verdict gets `review_when`. For "Build now", use the condition under which to reconsider or remove it.
6. **Report** the decision id. The injected start context re-surfaces it once the trigger is met.

## Rules

- A YAGNI verdict is a `decision`, never a `fact`.
- If a newer verdict replaces an old one, pass the old id to `uac_update({id, status:"superseded", reason, superseded_by:<new id>})`.
