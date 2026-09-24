# UAC: how it's built (v0.2)

## Layout
```
bin/uac.mjs            entry point (silences node:sqlite warning, then src/cli.mjs)
src/db.mjs             SQLite open/schema/FTS5 (porter + trigram) + JSONL spool fallback
src/store.mjs          projects, sessions, events, memories (lifecycle, versions, relations), search (RRF), git maintenance, PROJECT.md export
src/pack.mjs           start menu, ranked/budgeted context packs (bootstrap), digest/save for the compressor, checkpoints, handoff, packs
src/hook.mjs           host-neutral hook handling (fast path, never throws into the host)
src/adapters/*.mjs     claude, codex, gemini, antigravity, cursor, copilot: normalize(), format(), install()
src/mcp.mjs            MCP stdio server (16 tools), hand-rolled JSON-RPC
src/view.mjs           dashboard HTTP API (127.0.0.1 + token) serving viewer/viewer.html
src/cli.mjs            `uac` commands
viewer/viewer.html     dashboard (single file, vanilla JS)
agents/uac-compressor.md, commands/uac.md, skills/*   model-facing instructions (Claude plugin)
hooks/hooks.json, .mcp.json, .claude-plugin/          Claude Code plugin + local marketplace
extension/             VS Code extension (status bar, pickers, trees, dashboard webview); bundles the CLI
scripts/build-sea.mjs  optional single-file executable build
test/                  node:test: end-to-end core + adapters
```

## Data flow
```
host hook ──► adapter.normalize ──► hook.handle ──► events (redacted, .uacignore, pending until opt-in)
                                          │
           SessionStart ◄── menu ◄────────┘   (≤6K chars: checkpoint, counts, sessions, packs, questions)
model ──► uac_capture / uac_bootstrap (MCP) ──► ranked pack within budget; retrieval logged for uac_why
/uac save | Stop (automatic, ≥40 events) ──► model spawns uac-compressor ──► uac_digest ──► uac_save
      uac_save: summary + checkpoint + candidates(op) ──► memories (proposed | active) + relations ──► .context/PROJECT.md
user ──► dashboard / CLI / extension: review, edit, delete, packs, "next session" pack, session detail
SessionStart (hourly) ──► maintain: expire proposals (7d), promote branch memories on merge, mark stale (git diff since source_commit)
```

## History / Memory / Context (GPT's structure, and what was built)

| GPT proposal | UAC implementation |
|---|---|
| Raw events (layer 0) | `events`: redacted and clipped. Only the compressor and the session-detail view read them. They're never injected. |
| Observations (layer 1) | **Not a separate table.** The compressor turns events straight into typed candidates. A separate observations layer would have meant an LLM call per tool use, which is exactly what makes claude-mem expensive. |
| Session summary (layer 2) | `summaries` |
| Project knowledge, decisions, lessons (layers 3–5) | `memories` with a `type` (fact, decision, constraint, lesson, requirement, preference, warning, idea, task, architecture) |
| Checkpoints | `checkpoints`, written on save, pause, PreCompact (a deterministic snapshot of 2 KB or less), and manually |
| Memory lifecycle | `proposed → active → stale / conflict → superseded / archived`. Proposals expire after 7 days. Each session can make at most 20. |
| memory_versions / memory_relations | Built as proposed (`supersedes`, `contradicts`, …). Accepting a superseding memory retires the old one. |
| Scopes: global, user, project, repo, branch, session | `user` (preferences), `project`, `branch` (promoted to project when the branch is merged). Repo is the same as project. Session state lives in checkpoints and summaries. |
| Proposal and conflict system | Manual mode: everything is reviewed. Automatic mode: decisions, architecture and lessons are accepted automatically. Conflicts are always reviewed. |
| Source attribution + confidence | `source` (user/llm/review), `source_agent`, `source_session`, `source_commit`, `files`, `confidence`. User edits set confidence to 1. |
| Staleness detection | `git diff source_commit..HEAD` over the memory's `files`, then status `stale`. Stale items are flagged ⚠ in packs. |
| Context packs + budget tiers + allocation per category | `bootstrap`: tiers of 1k/4k/10k/fork/none. Seven buckets with fixed shares, then leftover budget is filled by score. |
| Ranking (keyword, scope, recency, importance, confidence, file relevance) | BM25 porter + trigram fused with RRF, plus overlap with the files git reports as changed, scope, decayed importance (23-day half-life; decisions, lessons, constraints and requirements don't decay), confidence, and a stale penalty |
| Explainability | `retrievals` table + `uac_why` + the Retrievals tab in the dashboard |
| Vector search, graph DB | **Deferred.** BM25 + trigram covers paths and identifiers. Vectors are worth adding only if recall measurably falls short. |
| Worker + job queue + Fastify | **Not needed.** Compression runs inside the session through a subagent (the user's decision), so there's no daemon and no port juggling. |
| Memory health / token economics | `/api/health` + the dashboard Overview: counts, sessions, events, average pack tokens, raw vs summarized characters |
| YAGNI with a revisit trigger, brainstorm-as-ideas | `uac-yagni` skill (a decision with `review_when`) and `uac-brainstorm` (type `idea`, excluded from packs and never treated as a fact) |
| Eval harness (recall@k) | **Partly done.** The end-to-end test asserts that specific items are retrieved; a scored benchmark isn't built yet. |

## Choices worth knowing
- **Consent:** hooks can't prompt the user, so the menu asks the model to ask (AskUserQuestion). The VS Code extension offers the same choice as a native picker (`uac choose`), which `uac_bootstrap` picks up. A pack chosen for the next session (`uac next`) is loaded automatically, once.
- **Prompts before opt-in** are stored as `pending`. They become `prompt` if capture is turned on and are deleted if it's turned off.
- **Subagents:** tool calls made inside subagents (`agent_id` set) are skipped. Only the subagent's final message is kept. UAC's own MCP calls are never recorded.
- **Resilience:**
  - Hooks never fail the host. Errors go to `~/.uac/hook-errors.log`.
  - If the DB is locked, events are appended to `~/.uac/spool.jsonl` and imported on the next open.
  - If the system SQLite has no FTS5, search falls back to `LIKE`.

## Why `.mjs`, and why plain JavaScript instead of TypeScript
- **`.mjs`:** it's ESM regardless of the nearest `package.json`. The same files are copied into the Claude plugin cache and into the VS Code extension (whose `package.json` is CommonJS). A `.js` file would silently turn into CommonJS there and break. With `"type":"module"` alone, `.js` would work only in the repo root.
- **No TypeScript (yet):**
  - Hooks run straight from source with plain `node`: no build step, no `dist/` to keep in sync, and no dependencies.
  - The code base is about 1.5k lines.
  - To add types later without a build, use `// @ts-check` + JSDoc, and `tsc --noEmit --checkJs` in CI.
  - Moving to real `.ts` would bring back an esbuild step for every consumer (plugin, extension, exe).

## Verified vs not verified (2026-09-24)

| Area | Evidence |
|---|---|
| Core flows | 19 `node:test` tests pass. They use real hook subprocesses, the real MCP stdio, the real HTTP API, and git branch/merge/diff. |
| Claude Code | Live headless run. Hooks injected the menu; the MCP tools set capture, bootstrapped and proposed; `uac-compressor` (Haiku, about $0.035) saved a summary and checkpoint; `.context/PROJECT.md` was exported. A second session loaded the decision and checkpoint. |
| Dashboard | Headless-Chrome click-through against the real server: packs, next session, session detail, review, edit/delete, deep links |
| VS Code extension | Packaged and installed (`uac-dev.universal-agent-context`). Its CLI calls were checked from the shell. The UI hasn't been clicked through inside VS Code. |
| Gemini, Codex, Cursor, Copilot, Antigravity | Unit tests (normalize, format, idempotent install) and simulated start payloads through the real binary. Gemini's install was written to `~/.gemini/settings.json` (a backup is at `settings.json.uac-backup`). A live Gemini run was blocked because headless `gemini -p` hangs on this machine even with UAC's hooks removed. Codex isn't installed here. |
| Single executable (`dist/uac.exe`, 82 MB) | Hooks, CLI, MCP and FTS5 work. **Known issue:** anything that waits on the event loop (the dashboard HTTP server, timers) hangs inside the executable on this Windows machine. Even a 5-line http server hangs, so it's Node's single-executable runtime, not UAC. Run the dashboard with `node bin/uac.mjs view`. |

## Known limitations / next steps
1. **SessionEnd in `claude -p`** gets "Hook cancelled" because the process exits first. That's harmless: unsaved sessions are picked up at the next start. Sessions stay `active` until then.
2. **Very long sessions:** the digest keeps the head and tail of the session when it's over 60k characters. A map-reduce over chunks would be the upgrade.
3. **Antigravity's PreInvocation** carries no prompt text, so no prompts are captured there (tool events still are).
4. **The scored eval benchmark** (recall@k) and **importers** (claude-mem, claude-remember, CLAUDE.md) aren't built yet.
5. **Signing the exe** would remove the Defender first-run delay.
