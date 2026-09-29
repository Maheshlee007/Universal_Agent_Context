---
name: uac-init-knowledge
description: Surveys a repository end to end and seeds UAC project knowledge with architecture, module, convention and constraint memories, each anchored to files and symbols. Use when the user runs /uac init, when a project has few or no active UAC memories, or when the user asks to "learn this codebase" or "build the project map". Best run by a strong model.
---

# UAC init knowledge

**Goal:** a holistic, accurate map of the repo, stored as typed UAC memories. The next session should understand the project without re-exploring it. You use the uac MCP tools (short names below).

## 1. Check what already exists
- Call `uac_search({query:"architecture"})`, `uac_search({query:"convention"})` and `uac_search({query:"constraint"})`.
- Note the existing ids. You'll update or supersede those, not duplicate them.

## 2. Survey (read, don't guess)
- **Manifests:** package.json, pyproject, go.mod, Cargo.toml, *.csproj, and similar. Also the README, docs/, AGENTS.md, CLAUDE.md, and CI config.
- **The layout:** the top two directory levels, the entry points, the build and test commands.
- **Each major module:** its purpose, public surface, key files, and what it depends on.
- **Cross-cutting concerns:** config, auth, data access, error handling, logging, and the test layout.
- **Conventions actually followed in the code:** naming, file layout, patterns, formatting and lint rules.
- **Hard constraints:** runtime versions, platform limits, "never do X" rules in docs or comments, and external API limits.

For big repos, sample representative files per module instead of reading everything.

## 3. Propose memories
Call `uac_propose` once per item, with `scope:"project"`:

| type | one memory per | body |
|---|---|---|
| architecture | the whole system (1 overview), plus one per major module | purpose, boundaries, data flow, key paths |
| fact | a convention (naming, layout, patterns) | the rule plus one example path |
| constraint | a must or must-not | the rule and its source (file, doc or config) |
| warning | fragile or surprising code | the risk and what to do before touching it |
| decision | an evident past choice with a stated reason | ADR: Context / Decision / Consequences |

**Rules:**
- **Quote identifiers verbatim** in backticks (functions, consts, classes, env vars, routes, template ids, commands) so they're greppable. Never paraphrase them.
- Every memory has `anchors:[{file, symbol, line}]` pointing at the code that proves it (real repo-relative paths and symbols you opened), plus `files` and a `confidence`.
  - 0.9: read directly in code or docs (accepted automatically, ≥ 0.7)
  - 0.6: inferred from a pattern (waits for review)
- Only record a `decision` when the why is written down somewhere. Otherwise it's a `fact`.
- Keep bodies tight, at most 120 words. Put detail in paths, not prose.
- Aim for 10 to 30 memories. Stop when more would only restate the code.
- The server stamps `source_commit`. Don't invent commit ids.
- Never record secrets or values from `.env*`, keys, or credential files.
- If an existing memory is still right, `uac_verify({ids})`. If it's wrong, use `uac_update({id, body, anchors, reason, evidence})` or retire it with `uac_update({id, status:"superseded", reason})`. Don't propose a duplicate (it is refused anyway, with the id to update).

## 4. Report
Give one short list: the count by type, the ids created, and anything uncertain that the user should confirm. If anything is below 0.7, suggest `/universal-agent-context:uac review`.
