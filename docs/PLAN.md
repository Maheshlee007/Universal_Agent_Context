# ctxkeeper — Cross-LLM Session Context Plugin: Plan v1

> Working name `ctxkeeper` (rename freely). Status: draft for comparison with other LLMs' plans.

## 1. Goal
Keep the context from one coding session and hand it to the next session, or to a parallel one, across Claude Code, Codex CLI, Gemini CLI, Antigravity, Cursor and Copilot CLI:
- **Opt-in.** At session start the user chooses whether to record. They can pause, resume or stop at any time.
- **Compression.** Sessions are compressed by a cheap long-context LLM into structured summaries.
- **User control.** The user can view, edit and delete everything that was stored (web viewer plus CLI).
- **Choosing context.** At the start of a new session the user picks what to load: all of it, selected items, or up to a token budget.
- **Holistic project knowledge.** A "holistic view" of the project, built once by a strong model and loaded by any session, including parallel ones. It is updated after features land.
- **LLM access.** An MCP server and skills let any LLM read and update the store.

## 2. Research summary (repos analysed)

| Repo | What it is | Reuse | Avoid / gap |
|---|---|---|---|
| [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) (Apache-2.0, ~94k★, v13.25) | Hooks capture every tool call → Haiku observer (Agent SDK) → SQLite + FTS5 + Chroma; Express worker on :37777; React viewer; MCP search | Per-CLI hook **adapters** (`src/cli/adapters/*`); **FTS5 external-content tables + triggers**; typed observation / summary **schema** (`src/sdk/prompts.ts`, `plugin/modes/code.json`); **3-layer MCP retrieval** (search index → timeline → get by ids); **measure-and-drop 10K-char budget** (`ContextBudget.ts`); `<private>` tag stripping; exclude globs | An LLM call on *every* tool use (cost); Bun + uvx/Chroma + tree-sitter + Express worker (weight); needs Git Bash on Windows; no opt-in, pause, edit, context selection or project knowledge doc |
| [Digital-Process-Tools/claude-remember](https://github.com/Digital-Process-Tools/claude-remember) (listed in the official Anthropic marketplace) | Incremental transcript extraction → Haiku → tiered markdown (now → today → recent → archive); multi-host manifests | **Incremental transcript parsing** (read from a saved offset instead of re-reading the file); **tiered rollup**; manifests for Codex, Gemini and Antigravity (`.codex-plugin/`, `.gemini/`); per-host transcript parsers (`pipeline/host.py`) | Always on; bash + Python; had a Windows temp-file leak; no MCP; no selection step |
| anthropics/claude-plugins-official: `claude-md-management`, `session-report` | `/revise-claude-md` proposes diffs that the user approves; transcript JSONL miner | **Propose a diff, user approves** flow for knowledge updates; transcript parsing rules (dedupe by `uuid` / `requestId`, skip `isSidechain` / `isMeta` / `isCompactSummary`; subagent transcripts in `<sid>/subagents/*.jsonl`) | — |
| Claude API memory tool `memory_20250818` | Client-side file-memory commands: view / create / str_replace / insert / delete / rename | **Mirror these verbs** in our MCP tools so models already know how to use them | — |
| [basic-memory](https://github.com/basicmachines-co/basic-memory) | Markdown as source of truth + SQLite index, wikilinks | A human-readable markdown **export** of the knowledge doc | Capture is manual only |
| [mem0 / OpenMemory](https://github.com/mem0ai/mem0) | Fact extraction with an ADD / UPDATE / DELETE / NOOP reconciliation step | **Reconciliation step** when merging new facts into project knowledge (stops bloat) | Docker + vector DB; memories are opaque |
| [graphiti](https://github.com/getzep/graphiti) | Temporal knowledge graph | **`valid_from` / `invalid_at`** on knowledge items: old facts are invalidated, not deleted | Needs Neo4j |
| [letta-code](https://github.com/letta-ai/letta-code) | Self-editing memory blocks, git-backed, background "sleeptime" | **Background consolidation pass** ("dream"); `/doctor` audit of memory quality | It replaces your CLI rather than plugging into it |
| [beads](https://github.com/steveyegge/beads) | Agent task graph, CLI-first | **Hash ids** (`ck-a1b2`), which don't collide across parallel sessions; **CLI works for any LLM without MCP** | Dolt dependency |
| [claude-supermemory](https://github.com/supermemoryai/claude-supermemory) | Hook-based capture to a cloud API | **Two scopes**: user profile (cross-project preferences) + project | Tied to a cloud backend |
| [zilliztech/claude-context](https://github.com/zilliztech/claude-context) | Semantic code search | Merkle / hash-based incremental re-indexing, which becomes our **staleness detection** | Code search only; out of scope |
| Antigravity Knowledge Items | A subagent distills each conversation at session end | End-of-session **distillation** rather than a per-tool LLM call | — |

**Conclusion.** Build a lean core that mostly takes ideas from claude-mem and claude-remember. It runs no LLM in the hook path and no daemon, uses no vectors in v1, and needs zero native dependencies. Our differentiators are consent, editing, selective loading, context packs for parallel sessions, and living project knowledge.

## 3. Hard constraints found in research
1. **Hooks cannot prompt the user** (no TTY). Consent and context selection must go through the model:
   - The SessionStart hook injects "ask the user", and the model then calls `AskUserQuestion` (Claude Code) or the equivalent on the host.
   - On hosts where that isn't possible, the fallback is an MCP elicitation, a slash command, or the CLI.
2. **Injected context is capped at 10,000 characters** per hook output (beyond that it spills to a file and only a 2K preview is shown). So inject a small index, then fetch details through MCP (progressive disclosure).
3. **Transcript JSONL is an internal format** and changes between versions. Keep the parser in one isolated module per host.
4. **Subagent calls** carry `agent_id` in the hook input. `SubagentStop` provides `last_assistant_message` and `agent_transcript_path`.
5. **Antigravity has no SessionStart.** Inject on the first `PreInvocation` instead.
6. **Codex needs `/hooks` trust**, and Copilot plugin `preToolUse` hooks are buggy. Neither matters here, because we rely on SessionStart, PostToolUse and Stop/SessionEnd.

## 4. Architecture

```
 Host CLI (Claude Code / Codex / Gemini / Antigravity / Cursor / Copilot)
   │ hooks (JSON stdin)                 │ MCP (stdio)            │ shell
   ▼                                    ▼                        ▼
 ck hook <host> <event>           ck mcp                    ck <cmd>   ← one bundled ck.mjs
   │ adapter → normalized event        │                         │
   └──────────────┬─────────────────────┴─────────────────────────┘
                  ▼
            core (TypeScript)
   store.ts (node:sqlite, WAL)   budget.ts   redact.ts   transcript/<host>.ts
                  │
                  ├── ~/.ctxkeeper/ctx.db            (source of truth, all projects)
                  ├── <repo>/.context/PROJECT.md     (one-way export of knowledge, git-diffable)
                  └── compress worker: `ck compress <sid>` spawned detached → LLM provider
 ck view → node:http + one static viewer.html (CRUD, approvals, pause toggle)
```

- **Runtime:** Node ≥ 22.13 (24 LTS preferred), TypeScript bundled by esbuild into a **single `ck.mjs`**, run with plain `node`: no npx, no tsx, no Bun, no Python.
- **Storage:** built-in `node:sqlite`, so no native build and no Windows toolchain pain.
  - WAL mode plus `busy_timeout=5000` makes parallel sessions safe.
  - Probe for FTS5 at startup and fall back to `LIKE` if it's missing.
- **Why not JSON / json-server:** whole-file rewrites mean parallel sessions lose writes, and there is no search. json-server is a mock, not a store.
- **Hooks do only a cheap append and exit** (~50 ms). No LLM runs inside a hook. Compression runs as a detached child process (`ck compress`), with a lock row so it runs only once per session.
- **Dependencies:** `@modelcontextprotocol/sdk` only (bundled). The LLM calls use `fetch`.

## 5. Data model (SQLite)

```sql
projects(id TEXT PK, root TEXT UNIQUE, name, git_remote, created_at)
sessions(id TEXT PK,            -- host session id
  project_id, host, branch, parent_pack_id NULL,
  state TEXT CHECK(state IN ('ask','recording','paused','stopped','off')),
  started_at, ended_at, title, compressed_at, cost_usd)
events(id INTEGER PK, session_id, ts, kind,  -- prompt|tool|assistant|subagent|compact|note
  tool, target, body, agent_id NULL, private INTEGER DEFAULT 0)
summaries(id TEXT PK /* ck-xxxx hash */, session_id, level, -- session|day|rollup
  title, summary, decisions JSON, files JSON, todos JSON, gotchas JSON, tags JSON,
  knowledge_delta TEXT, pinned INTEGER, edited_by_user INTEGER, created_at, updated_at)
knowledge(id TEXT PK, project_id, section,  -- overview|architecture|modules|conventions|decisions|gotchas|glossary|features
  key, body, source_session, source_commit,
  valid_from, invalid_at NULL, status TEXT, -- active|proposed|stale
  updated_at)
knowledge_rev(id, knowledge_id, body, author, -- user|llm:<model>
  ts)                                          -- full history, supports undo
packs(id TEXT PK, project_id, name, description, created_at)  -- named, reusable context bundles
pack_items(pack_id, item_type, item_id, order_no)             -- knowledge section / summary / note
ideas(id, project_id, title, body, status, -- brainstorm|accepted|rejected|yagni
  created_at)
settings(scope /* global|project */, key, value)
-- FTS5 external-content tables + triggers on summaries, knowledge, ideas (claude-mem pattern)
```

- Ids are short hashes (`ck-a1b2`), so parallel sessions and branches never collide.
- Knowledge is never hard-deleted by the LLM. It sets `invalid_at`. Only the user deletes, and every change leaves a `knowledge_rev` row.

## 6. Session lifecycle

**1. SessionStart** (startup / resume / clear / compact)
- The hook resolves the project from `cwd` and creates or finds the session with `state = settings.default_mode` (`ask` by default).
- It injects at most ~8K characters:
  - A header: "ctxkeeper available".
  - A **menu** of loadable context, each with a token estimate:
    - Project knowledge (overview line + size)
    - The last N sessions (id · date · branch · title)
    - Packs
    - Open todos from the last session
  - An instruction: *"Use AskUserQuestion: (1) record this session? yes / no / paused; (2) load which context? [project knowledge] [last session] [pack X] [all within budget] [none]. Then call `ctx_set_state` and `ctx_load`."*
- On `compact`, it re-injects whatever was loaded before (the set is stored per session), so compaction doesn't lose it.

**2. Recording** (state = recording)
- `UserPromptSubmit`: append the prompt (after redaction). Also check for inline commands like `#ctx pause`.
- `PostToolUse`: append `tool + target` only (path, command, first 200 characters of the result). Tools in the skip list (e.g. TodoWrite) are dropped.
  - Subagent calls, detected by `agent_id`, follow `record_subagents = none | summary | full`. The default is `summary`: we store only `SubagentStop.last_assistant_message`.
- `PreCompact`: flush, and store the compact summary from `PostCompact`.
- `paused`: hooks exit immediately. `stopped`: same, and the session is never compressed unless the user asks.

**3. Save** (Stop is debounced, plus SessionEnd, plus manual `/ctx save`)
- Spawn `ck compress <sid>` detached. It:
  - Pre-filters the transcript (see §7).
  - Calls the LLM and writes a `summaries` row plus a `knowledge_delta`.
  - Reconciles the delta against the knowledge doc using ADD / UPDATE / INVALIDATE / NOOP. The resulting items are `status = proposed`, unless `auto_apply_knowledge = true`.
  - Regenerates `.context/PROJECT.md`.

**4. Next session.** The model sees the proposed knowledge changes in the menu and asks the user to approve them. The user can also approve in the viewer, which shows a diff (the claude-md-management pattern).

## 7. Compression
- **Pre-filter first** (this removes 70–90% of tokens):
  - Keep user prompts, the assistant's final texts, and tool name + target.
  - Drop file dumps and big tool outputs.
  - Dedupe transcript lines by `uuid` / `requestId`.
  - Strip `<private>…</private>`.
  - Redact secrets (regex for keys and tokens).
- **Providers** (configured by `compress.provider`):
  - `claude-cli` (default, no key): `claude -p --model haiku --output-format json`. It runs with env `CTXKEEPER_CHILD=1`, which every hook checks so the child session doesn't trigger our own hooks.
  - `anthropic`: API key; `claude-haiku-4-5-20251001`. Falls back to `claude-sonnet-5` (1M context) when the filtered text is over ~180K tokens.
  - `gemini` (Flash, 1M context), `openai-compatible` and `ollama`: optional.
- **Map-reduce** only above the context limit: chunks of about 100K tokens, then one merge call.
- **Output:** JSON schema with `title, summary, decisions[{what,why}], files_touched[{path,change}], todos[], gotchas[], tags[], knowledge_delta[{section,key,op,body}]`.
- **Rollup** (claude-remember tiers): many old session summaries are periodically rolled into a `rollup` summary. This keeps the menu small.
- The prompts live in `prompts/*.md`, not in code, so they can be edited and translated.

## 8. The holistic project view (a core feature)
- **`/ctx init-knowledge`** (skill): a strong model (e.g. Fable or Codex) explores the repo and fills in the knowledge sections: overview, architecture, modules, data flow, conventions, build/test, gotchas. It writes them through `ctx_knowledge_upsert`. Each item records the current `source_commit`.
- **Parallel sessions:** session B loads a pack ("holistic view" + optionally session A's summary) at startup, and works on its own feature. B's delta is proposed against the same knowledge rows. Parallel writes are safe thanks to WAL plus per-item revisions. If two sessions changed the same item, the viewer shows the conflict.
- **Branch awareness:** summaries are tagged with `branch`. Deltas from a feature branch stay `proposed` (scoped to that branch) until the branch is merged: `ck sync` checks `git branch --merged` at SessionStart. They are promoted to `active` on merge and invalidated if the branch is deleted without a merge. This answers "once the feature is implemented, update the holistic view".
- **Staleness detection:** for each knowledge item, compare the files it mentions against `git diff <source_commit>..HEAD --name-only`. Items whose files changed are flagged `stale` in the menu, and `/ctx refresh-knowledge` asks the LLM to re-verify only those items.

## 9. MCP server (`ck mcp`, stdio): tools
The names and descriptions are written so any LLM picks the right one. The verbs mirror the Claude memory tool.

| Tool | Purpose |
|---|---|
| `ctx_menu` | Same menu as SessionStart (for hosts without hooks) |
| `ctx_set_state(state)` | recording / paused / stopped / off for the current session |
| `ctx_load(items[], budget_tokens?)` | Returns the chosen context, packed to the budget by measure-and-drop |
| `ctx_search(query, type?, limit)` | FTS5 BM25 → compact index (id, title, 1 line) |
| `ctx_get(ids[])` | Full details of summaries or knowledge items |
| `ctx_timeline(anchor_id, before, after)` | Neighbouring items in time |
| `ctx_knowledge_view(section?)` | Read the project doc |
| `ctx_knowledge_upsert(section, key, body)` | Add or replace an item (creates a revision; `proposed` unless auto) |
| `ctx_knowledge_str_replace(id, old, new)` | Surgical edit |
| `ctx_knowledge_invalidate(id, reason)` | Retire a fact (not a delete) |
| `ctx_note(text, tags?)` | Model or user adds a manual note to the current session |
| `ctx_pack_create(name, items[])` / `ctx_pack_list` | Handoff bundles for parallel or next sessions |
| `ctx_save()` | Trigger compression now |
| `ctx_idea_add / ctx_idea_list` | Brainstorm / YAGNI backlog |

Hosts without MCP use the same verbs through the shell: `ck search …`, `ck load …`, with JSON output.

## 10. Skills and commands
- **Skills** (`skills/*/SKILL.md`, host-neutral markdown):
  - `ctx-start`: how to present the menu, ask the questions and load context.
  - `ctx-read`: how to use context progressively (search → get), trust recent over old, verify stale items.
  - `ctx-update-knowledge`: when and how to propose knowledge deltas.
  - `ctx-init-knowledge`: the holistic repo survey.
  - `ctx-handoff`: build a pack for a parallel session.
  - `ctx-brainstorm`: structured ideation that saves its output to `ideas`.
  - `ctx-yagni`: challenge a proposed feature before building it, and store the verdict.
- **Commands:** `/ctx start | pause | resume | stop | status | save | load | view | handoff | forget <id> | init-knowledge | refresh-knowledge`.

## 11. Viewer (`ck view` → http://127.0.0.1:<port>, localhost only, random token in the URL)
- Plain `node:http` plus a single `viewer.html` (vanilla JS, no build step).
- **Tabs:**
  - **Sessions:** list, detail, edit or delete a summary, pin.
  - **Knowledge:** by section, inline edit, revision history with undo, approve or reject proposed items, conflict view.
  - **Packs:** build by selecting items.
  - **Ideas.**
  - **Settings:** default mode, provider, budgets, recording of subagents and tools, excludes.
  - **Live:** the current session's state with a pause/stop toggle.
- The viewer is started on demand and exits when idle. No resident daemon.

## 12. Cross-LLM adapters

| Host | Inject | Capture | Save | Manifest |
|---|---|---|---|---|
| Claude Code | SessionStart `additionalContext` | UserPromptSubmit, PostToolUse, SubagentStop, PreCompact / PostCompact | Stop (debounced), SessionEnd | `.claude-plugin/plugin.json`, `hooks/hooks.json`, `.mcp.json` |
| Codex CLI | SessionStart | UserPromptSubmit, PostToolUse, SubagentStop | Stop, SessionEnd | `.codex-plugin/`, `hooks.json` |
| Gemini CLI | SessionStart | BeforeAgent, AfterTool | SessionEnd, PreCompress | `gemini-extension.json` |
| Antigravity | first PreInvocation (`injectSteps`) | PostToolUse | Stop | `.agents/hooks.json` + plugin |
| Cursor | sessionStart `additional_context` | beforeSubmitPrompt, postToolUse | stop, sessionEnd | `.cursor/hooks.json` |
| Copilot CLI | sessionStart | userPromptSubmitted, postToolUse | sessionEnd | `.github/hooks/*.json` |
| Anything else | `AGENTS.md` / `GEMINI.md` pointer: "run `ck menu`" + MCP | — | manual `ck save` | — |

- Each adapter is roughly 30 lines: it maps the host's event names and fields to a `NormalizedEvent` and formats the output key (`additionalContext` / `additional_context` / `injectSteps`).
- `ck install <host>` writes that host's config. Hooks are declared as `node "${PLUGIN_ROOT}/dist/ck.mjs" hook <host> <event>`, with **no bash**, so they run natively on Windows.

## 13. Repo layout
```
ctxkeeper/
  src/  cli.ts  hook.ts  mcp.ts  view.ts  compress.ts
        store.ts  budget.ts  redact.ts  providers.ts
        adapters/{claude,codex,gemini,antigravity,cursor,copilot}.ts
        transcript/{claude,codex,gemini}.ts
  prompts/  summarize.md  merge.md  reconcile.md  init-knowledge.md
  skills/   ctx-start/ ctx-read/ ctx-update-knowledge/ ctx-init-knowledge/ ctx-handoff/ ctx-brainstorm/ ctx-yagni/
  commands/ ctx.md
  viewer/   viewer.html
  .claude-plugin/plugin.json   hooks/hooks.json   .mcp.json
  .codex-plugin/  gemini-extension.json  antigravity/  cursor/  copilot/
  dist/ck.mjs    (committed build → no install step for users)
  test/ *.test.mjs   (node:test)
```

## 14. Extra features (beyond existing plugins)
1. **Consent, pause and stop**, plus inline `#ctx pause` in a prompt.
2. **Context packs**, so a strong model's survey can be handed to cheap parallel sessions.
3. **Branch-aware knowledge promotion** on merge (§8).
4. **Staleness detection** tied to git diff since `source_commit`.
5. **Temporal facts:** invalidate rather than delete, with full revision history and undo.
6. **Reconciliation** (ADD / UPDATE / INVALIDATE / NOOP), so knowledge doesn't bloat.
7. **Todo carry-over:** unfinished `todos` from the last session appear at the top of the menu.
8. **Decision log:** decisions with their "why", a lightweight record of architecture decisions (ADR-style).
9. **YAGNI gate skill:** before a feature is built, the model argues whether it is needed. The verdict is stored in `ideas`, so rejected ideas aren't re-proposed.
10. **Brainstorm mode:** divergent, then convergent, ideation saved as ideas that can later be promoted to the knowledge `features` section.
11. **Sleeptime consolidation:** `ck consolidate` (on demand, or every N sessions) rolls up old summaries and dedupes knowledge.
12. **`ck doctor`:** audits memory (stale, conflicting, oversized, orphaned items).
13. **Cost meter:** records `cost_usd` per compression and shows a monthly total in the viewer.
14. **Import:** from claude-mem SQLite, claude-remember markdown, and existing CLAUDE.md / AGENTS.md.
15. **Two scopes:** a user profile (global preferences) plus the project.
16. **Privacy:** `<private>` tags, secret redaction, project exclude globs, and "forget" that hard-deletes on user request.

## 15. Phases
| # | Deliverable | Done when |
|---|---|---|
| P0 | Store + CLI skeleton (`store.ts`, schema, FTS5 probe, `ck status/search/get`) | node:test passes on Windows and Linux |
| P1 | Claude Code hooks: consent menu, state machine, event capture, redaction | Start a session → asked to record → pause and resume work → events stored |
| P2 | Compression (claude-cli + anthropic providers, pre-filter, map-reduce, recursion guard) | A real session produces a summary for under $0.15 |
| P3 | MCP server + skills + `ctx_load` with budget | A new session loads selected context under the budget |
| P4 | Viewer (CRUD, approvals, pause toggle, revisions) | User edits or deletes an item and the change shows up in the next session |
| P5 | Knowledge: init, reconcile, packs, branch promotion, staleness, `.context/PROJECT.md` export | Parallel session scenario works end to end |
| P6 | Adapters: Codex, Gemini, Antigravity, Cursor, Copilot + `ck install` | The same store is used from 2+ hosts |
| P7 | Extras: YAGNI / brainstorm skills, consolidate, doctor, import, cost meter | — |

## 16. Deliberately out of v1 (YAGNI)
- **Vector embeddings.** Add them when the store has more than ~10K items or users complain about concept search. The plan then is brute-force cosine similarity in JS, not sqlite-vec, which is flaky on Windows.
- **Resident worker daemon.**
- **Two-way sync of the markdown export.** It stays read-only; edit through the viewer or MCP.
- **Cloud sync and team sharing.** Packs can be exported as markdown files instead.
- **tree-sitter code indexing.** That's claude-context's job.

## 17. Open questions for the user
1. **Default mode:** `ask` every session (my recommendation), or `always` / `never`?
2. **Default compression provider:** `claude -p` with no key but using your plan's quota, or the Anthropic API with a key (about $0.05–0.15 per session)?
3. **Git:** commit `.context/PROJECT.md` to the repo (shareable, my recommendation) or keep it local only?
4. **Knowledge updates:** always need approval (my recommendation), or auto-apply on merge?
5. **Name?**
