# UAC — Combined Plan v2 (Claude v1 + GPT + Gemini)

> v1 is kept in [PLAN.md](PLAN.md). This file is the merged design.

## 1. Rating the plans

Scored 1–10. "Implementability" means how realistic it is to build and run on Windows, macOS and Linux.

| Criterion | Claude v1 | GPT | Gemini |
|---|---|---|---|
| Covers the user's requirements (consent, pause/stop, view/edit, choose context, holistic view, parallel sessions, MCP + skills) | 8 | 8 | 6 |
| Conceptual model of memory | 6 | **9** | 4 |
| Grounded in verified host constraints and real repos | **9** | 4 | 2 |
| Implementability / dependency weight | **9** | 5 | 5 |
| Cross-LLM strategy | 8 | 8 | 4 |
| Extra features | 7 | **9** | 5 |
| Evaluation / measurability | 3 | **9** | 1 |
| Phasing matches what the user needs first | 7 | 5 | 3 |
| Concreteness (runnable config and code) | 5 | 3 | **7** |
| **Overall** | **7.5** | **7.5** | **4** |

### Gemini: verified problems
- **2 of its 3 repo links are wrong.** `thedotil/claude-mem` returns 404 (the real repo is `thedotmack/claude-mem`). `glimmering/context-mode` returns 404 (the real one is **`mksglu/context-mode`**, 24k★, and its features are nothing like what Gemini describes). The "official remember" plugin isn't in `anthropics/claude-code` and isn't key-value storage. It's the third-party `claude-remember`, which stores tiered markdown.
- **It says "SessionStart prompts the user interactively."** Hooks have no TTY, so this can't work.
- **Its `hooks.json` wouldn't load:**
  - SessionStart is missing the nested `hooks` array.
  - Its `"type":"agent"` hook uses a `name` field that doesn't exist.
  - It calls `.sh` scripts, which don't run natively on Windows.
- Python + FastMCP adds a second toolchain. `max_tokens*4` truncation cuts content mid-item.
- A single `holistic_view TEXT` column can't be versioned, can't be reviewed item by item, and can't detect conflicts.
- It has no scopes, confidence, source attribution, eval, or discussion of the 10K injection cap.

### Gemini: ideas worth keeping (adopted below)
- **A "fork" option at session start:** load the architecture map but none of the other session's transient state. This is our pack + tier, and v2 now names it explicitly in the menu.
- **Editing in your own editor:** `uac edit` writes a temporary markdown file, you edit it, and when you close it the changes are parsed and applied **once**. This is a lightweight alternative to the viewer. Gemini's continuous file-watcher sync-back is dropped, because two-way sync is where these tools break.
- **YAGNI pruning at compression:** stack traces, test-run output and failed syntax attempts are discarded; the *why*, the interface change and the edge cases are kept. Folded into the pre-filter and the summarize prompt.
- **ADR-formatted decisions:** Context / Decision / Status / Consequences. This becomes the render format for type `decision`.
- **IP/PII redaction**, in addition to secrets.

### mksglu/context-mode: found while checking Gemini's links
- It confirms our stack: `node:sqlite`, FTS5, BM25, Porter stemming, 17 platforms.
- **Steal:** a **priority-tiered PreCompact snapshot of ≤2 KB** (active files, tasks, rules, last prompt, dropping the lowest tier first). It also uses **Porter + trigram FTS merged by RRF**, a cheap retrieval upgrade that needs no vectors.
- It's complementary rather than competing: context-mode sandboxes tool *output* to save context *within* a session. Users can run both.

### GPT: what it got right, adopted in v2
- **"History ≠ Memory ≠ Context"** as the founding principle. History is what happened, memory is what's worth knowing, and context is what this agent needs right now. v1 blurred this by keeping sessions and knowledge but no typed middle layer.
- **Typed memories**: fact, decision, constraint, lesson, requirement, preference, warning, idea, task. **Ideas and YAGNI verdicts can never become facts.**
- A **memory lifecycle** (candidate → proposed → active → stale → superseded → archived), **relations** (supersedes, contradicts, depends_on), and **conflict detection**.
- **Scopes**: user, project, branch, session.
- **Source attribution + confidence** on every memory: agent, session, commit, file.
- **Checkpoints** as a distinct record: the exact state of the work you'd need to resume.
- **Three separate consents**: load, capture, save.
- A **policy file** and **`.ctxignore`**.
- **YAGNI with a revisit trigger**: "deferred until more than 100k events/day".
- **Budget tiers with per-category allocation.**
- **Explainability**: each retrieval records why an item was included.
- **Eval harness** (recall@k), **token-economics metrics**, and a **memory health** dashboard.
- A **narrow agent API**: `propose` by default, and `update` must carry a reason and evidence.

### GPT: where it's wrong or heavier than needed, not adopted
| GPT says | Problem | v2 decision |
|---|---|---|
| Start-of-session UI box with [Full] [Relevant] [Choose] buttons | **Hooks cannot prompt the user; they have no TTY.** GPT never addresses this. | The hook injects a menu. The model asks via AskUserQuestion, or an MCP elicitation (supported in Claude Code and in Codex since v0.119). CLI fallback. |
| `better-sqlite3` | Native module that breaks on new Node versions and needs build tools on Windows | Built-in `node:sqlite` (no native build) |
| Fastify API + resident worker + port | A daemon to supervise, port conflicts, claude-mem's biggest pain point | No worker at all: compression runs as an in-session subagent (§7a). The viewer is `node:http`, started on demand. |
| Vectors in phase 3, before cross-host support | Speculative; sqlite-vec is flaky on Windows; BM25 is better for paths and identifiers | No vectors until the eval harness shows a recall gap. When they come: brute-force cosine in JS plus reciprocal rank fusion (RRF). |
| Tiny local model for classification + cheap LLM + strong LLM | Three model configs to maintain | One cheap model per session plus an optional strong model for consolidation. Classification comes from the same summarize call. |
| Viewer in phase 5 | The user explicitly needs to view and edit, so it can't wait that long | Viewer in phase 3 |
| Code indexing (claude-context) inside the engine | Scope creep | Out of scope. It can run alongside as a separate MCP server. |
| 10K-char injection cap, Antigravity having no SessionStart, the `claude -p` recursion guard | Not mentioned | Handled (§4) |
| Graph DB later | — | Agreed: a `memory_relations` table in SQLite is enough |

### Claude v1: gaps now fixed
- There was no typed memory layer, confidence or source attribution.
- Only two scopes.
- Consent was a single question.
- No checkpoints, explainability, eval or metrics.
- Conflicts were mentioned but not modelled.

## 2. Extra ideas added in v2
Sources: GPT, the follow-up repo verification, and my own additions.

1. **Goal-conditioned bootstrap**, from KeystoneScience/codex-mem. `uac_bootstrap(goal)` ranks memories against the user's first prompt. It isn't a fixed dump.
2. **Proposal TTL + rate limit**, from sinfawkes/claude_mem. Unreviewed proposals expire after 7 days, and each session can make at most N proposals, so a runaway agent can't flood the store.
3. **Recency decay with exemptions**, from claude-context-manager. Importance halves every ~23 days. Pinned items, decisions, lessons and constraints don't decay.
4. **Lessons from failures**, from claude-context-manager. `PostToolUseFailure` plus a later success on the same target becomes a candidate lesson ("X fails because Y, fix Z").
5. **Surprise boost** for the first time a file or module is touched in a project. It feeds into the holistic view.
6. **Transcript backfill**, from 0x4d…/codex-mem. At SessionStart, parse any previous session's transcript that ended without a save (a crash, or a host whose hooks don't fire). This covers hosts with weak hook support.
7. **PreCompact checkpoint + dedupe**, from context-memory. Snapshot before compaction, and skip the auto-save if a manual save happened in the last 5 minutes.
8. **`agent` attribution column + idempotent installer**, from claude-mem-codex. The installer appends to a host's hooks and never overwrites existing ones.
9. **File-overlap ranking** (mine). Memories whose `files` overlap the current `git status` / `git diff` get a score boost, so a session touching `src/auth` automatically surfaces auth decisions. (GPT's §45 idea, made concrete.)
10. **Handoff between sessions** (mine). `uac_handoff(to="parallel")` writes a pack plus a one-line command the user pastes into the other session: `uac load pk-3f2a`.
11. **Memory as reviewable diffs** (mine). Accepted proposals regenerate `.context/PROJECT.md`, so knowledge changes show up in PR review next to the code that caused them.
12. **Re-verify, not just flag stale** (mine plus sinfawkes). `uac refresh` sends only the stale items plus the diff of their files to the model, which confirms, updates or invalidates each one.
13. **Requirement guard** (GPT, made concrete). Active `requirement` and `constraint` memories whose files overlap the current work are always included in the context pack, in a "must not violate" section.
14. **Session-end "what I'd tell the next dev"** (mine). A mandatory short field in every checkpoint, written for a human.
15. **Priority-tiered ≤2 KB compaction snapshot**, from context-mode. On PreCompact, the checkpoint is written with tiered priority and re-injected on `SessionStart:compact`.
16. **Porter + trigram FTS with RRF**, from context-mode. This is the first retrieval upgrade, before vectors are ever considered. The trigram index matches substrings of identifiers (`AuthServ` → `AuthService`).
17. **`uac edit` in your own editor**, from Gemini. The change set is applied once, with a diff shown for confirmation.
18. **"Fork" start option**, from Gemini. Load project memories only, excluding session-scoped ones. Useful for a clean parallel feature session.

## 3. Principles
1. **History ≠ Memory ≠ Context.** Events are history. Typed memories are knowledge. A context pack is a budgeted, ranked subset built for one goal.
2. **The user owns memory.** Loading, capturing and saving each need consent. Everything can be viewed, edited, invalidated or deleted.
3. **Hooks are dumb and fast.** No LLM and no network in a hook, only an append.
4. **Progressive disclosure.** Inject an index, then fetch on demand.
5. **Evidence over belief.** Every memory has a source, confidence and `source_commit`, and gets re-verified when its files change.
6. **Protocol, not a plugin.** The core plus MCP is the product. Host adapters are thin, best-effort shims.

## 4. Verified host constraints (unchanged from v1 §3, plus one addition)
- Hooks can't prompt, so the model asks via AskUserQuestion or **MCP elicitation** (Claude Code yes; Codex since v0.119).
- Injected context is capped at 10K characters.
- Transcript formats are unstable, so there's one parser module per host.
- Subagent calls are identified by `agent_id`.
- Antigravity has no SessionStart, so injection happens on the first PreInvocation.
- Hook command lines contain no bash, so they work natively on Windows.

## 5. Architecture
```
Host (Claude/Codex/Gemini/Antigravity/Cursor/Copilot)
  hooks ─► uac hook <host> <event> ─► adapter ─► NormalizedEvent ─► append events ─► exit (<50ms)
  MCP   ─► uac mcp (stdio)         ─► core API
  shell ─► uac <cmd>               ─► core API
                                     │
core: store · policy · redact · rank · budget · packer · git        (no LLM client: see §7a)
                                     │
~/.uac/uac.db (node:sqlite, WAL)      <repo>/.context/PROJECT.md (generated)
uac view ─► node:http + viewer.html (on demand, 127.0.0.1, token in the URL)
```
- **Compression happens inside the host's own session, via a subagent** (decision 2026-09-24). UAC makes no API calls and needs no key. There's no worker process and no jobs queue.
- The stack is Node 22.13+ / 24, TypeScript, and esbuild producing a single `dist/uac.mjs`.
- The only dependency is `@modelcontextprotocol/sdk`, bundled in.

## 6. Data model
```sql
projects(id, root UNIQUE, name, git_remote, created_at)
sessions(id, project_id, agent /*claude|codex|gemini|antigravity|cursor|copilot*/, host_session_id,
  branch, worktree, start_commit, parent_session_id, loaded_pack JSON,
  capture TEXT /*ask|on|paused|off*/, status /*active|paused|ended*/,
  saved_event_id /* last event covered by a save; events after it = unsaved */,
  transcript_path, transcript_offset, started_at, ended_at, title)
events(id, session_id, ts, kind /*prompt|tool|tool_fail|assistant|subagent|compact|note*/,
  tool, target, body, agent_id, redacted INT)                     -- HISTORY (retention policy)
checkpoints(id, session_id, ts, trigger /*pause|precompact|stop|manual*/,
  goal, state_working, state_broken, files JSON, next_steps JSON, note_for_next_dev)
summaries(id, session_id, level /*session|rollup*/, title, body, cost_usd, tokens_in, tokens_out)
memories(id /*uac-xxxx*/, project_id NULL /*NULL = user scope*/, scope /*user|project|branch|session*/,
  branch NULL, type /*fact|decision|constraint|lesson|requirement|preference|warning|idea|task|architecture*/,
  title, body, why, status /*candidate|proposed|active|stale|conflict|superseded|archived*/,
  importance REAL, confidence REAL, pinned INT,
  source /*user|llm*/, source_agent, source_session, source_commit, files JSON,
  review_when TEXT NULL /* YAGNI trigger */, valid_from, invalid_at, expires_at,
  last_verified_at, created_at, updated_at)                        -- MEMORY
memory_versions(memory_id, version, body, changed_by, reason, ts)
memory_relations(a, b, rel /*supersedes|contradicts|depends_on|derived_from|related_to*/)
packs(id /*pk-xxxx*/, project_id, name, goal, budget_tokens, created_by_session, created_at)
pack_items(pack_id, item_type /*memory|summary|checkpoint*/, item_id, ord)
retrievals(id, session_id, goal, item_ids JSON, reasons JSON, tokens, latency_ms, ts)  -- explainability + economics
settings(scope, key, value)
-- FTS5 external-content tables + triggers on memories, summaries, checkpoints
```
- Ideas, tasks and requirements are **memory types, not extra tables**: one table, one search index.
- Tasks stay minimal (a title, a status, and the checkpoint they came from). Beads can be used if a real task tracker is needed.

## 7. Session flow
**Start (SessionStart; on Antigravity, the first PreInvocation)**
1. The hook resolves the project, branch and commit. If a previous session has unsaved events, the menu starts with one of two things:
   - automatic mode: "first spawn `uac-compressor` for session S".
   - manual mode: "ask the user whether to save session S".
2. It injects a menu of at most ~6K characters:
   - The last checkpoint's "note for next dev" and next steps.
   - Counts: active memories, **proposed items awaiting review**, **stale**, **conflicts**, open tasks.
   - The last 5 sessions (showing the agent, e.g. Claude or Codex).
   - Packs.
   - Budget tiers: Minimal ~1k / Relevant ~4k / Deep ~10k / **Fork** (project memories only, no session state) / Choose / None.
3. The injected instruction tells the model to ask **two questions**:
   - Load which tier or pack?
   - Capture this session: on / off / decide later?
4. The model then calls `uac_bootstrap(goal=<first prompt>, tier)`. On a `compact` start, the same pack is re-injected.

**During the session**
- `capture=on`:
  - Prompts and tool name + target are appended (after redaction and `.ctxignore`).
  - `tool_fail` is recorded.
  - Subagents follow the policy (default: final message only).
- `paused`: a checkpoint is written, then nothing more is recorded.
- Inline `#uac pause`, `#uac resume`, `#uac off`.

### 7a. Saving: in-session subagent compression (no extra API call)

**Triggers**
- `/uac save` and `/uac stop`: the command file tells the model to spawn the subagent.
- `/uac pause` does the same and then sets capture to paused.
- **Automatic mode:** the **Stop hook** fires once there are at least N unsaved events (default 40).
  - It returns `{"decision":"block","reason":"UAC: spawn uac-compressor to save context, then finish."}` so the model does one more step.
  - Loop guard: when the input has `stop_hook_active: true`, the hook exits and does nothing.
- **PreCompact** writes the ≤2 KB tiered snapshot deterministically, with no LLM. The subagent then runs on the next Stop.
- **SessionEnd** can't make the model do anything. It only marks the session unsaved, and the next SessionStart picks it up (§7 step 1).

**The `uac-compressor` subagent**
- For Claude Code it's `agents/uac-compressor.md` with `model: haiku`, so it runs on your plan quota at the cheapest tier.
- On hosts without subagents (e.g. Antigravity), the main model does the same steps itself.
- Steps:
  1. `uac_digest(session)`: the server returns the unsaved events, already pre-filtered and redacted, with YAGNI pruning (no stack traces, test output or failed attempts), chunked to fit.
  2. The subagent writes one `uac_save` call: summary, checkpoint fields, and candidates (type, title, body, why, files, confidence).
  3. The server answers with **similar existing memories** for each candidate, found by FTS.
  4. The subagent decides ADD / UPDATE / SUPERSEDE / CONFLICT / NOOP and calls `uac_propose` or `uac_update`.
  5. The subagent returns one line to the main agent: "saved: 1 summary, 6 proposals, 1 conflict". This keeps the main context clean.

**Modes** (decision 2026-09-24: both, chosen per project)
- **manual:** nothing is captured until you say so. Nothing is saved without `/uac save`. Every proposal waits for review.
- **automatic:**
  - Capture is on and saves happen at the Stop threshold.
  - `auto_accept` types (decision, architecture, lesson) become `active`. Everything else waits for review.
  - Conflicts are always reviewed, and `never` types are never stored.
- Proposal TTL and the rate limit apply in both modes.

**Trade-offs of this choice**
- There's no separate background model, so the host must be running for a save to happen. SessionEnd plus the next SessionStart covers the gap.
- Compression uses a little of the session's quota, which Haiku keeps small.

**Branch promotion**: `branch`-scoped memories are promoted to `project` scope when `git branch --merged` includes that branch. If the branch is deleted without being merged, they're archived.

## 8. Retrieval, ranking and budget
```
score = 1.0*bm25_norm + 0.8*file_overlap(git diff/status) + 0.5*scope_match(branch>project>user)
      + 0.4*importance*decay(age; half-life 23d; exempt pinned|decision|lesson|constraint|requirement)
      + 0.3*confidence − 1.0*(status in stale|conflict)
```
- **Per-tier allocation:**
  - checkpoint/next steps 20%
  - must-not-violate (requirements and constraints) 15%
  - decisions 20%
  - architecture 15%
  - relevant lessons and warnings 20%
  - recent sessions 10%
- Measure and drop until the result fits.
- Every pack is logged in `retrievals` with a reason for each item, which is where `uac_why(id)` gets its answer.
- The weights are plain constants in `rank.ts`. They'll be tuned against the eval harness, not configured.

## 9. MCP tools
| Tool | Who / notes |
|---|---|
| `uac_bootstrap(goal, tier\|budget, pack?)` | Start of session |
| `uac_search(query, type?, scope?, limit)` → index | |
| `uac_get(ids)` | |
| `uac_timeline(anchor, before, after)` | |
| `uac_why(id)` | Explainability |
| `uac_propose(type, title, body, why, files, confidence)` | Default agent write path |
| `uac_update(id, body, reason, evidence)` | Policy decides whether it's applied directly or becomes a proposal |
| `uac_invalidate(id, reason, superseded_by?)` | |
| `uac_checkpoint(goal, working, broken, next, note)` | |
| `uac_digest(session)` / `uac_save(summary, checkpoint, candidates)` | Used by the `uac-compressor` subagent only |
| `uac_capture(state)` | on / paused / off |
| `uac_pack(create\|list, …)` / `uac_handoff(target)` | |
| `uac_review()` | Lists proposals and conflicts; the model walks the user through them using AskUserQuestion or elicitation |

- 12 tools, not 30.
- Hard delete is **user-only**: CLI, viewer, or `uac forget` from a command.

## 10. Skills and commands
- **`CONTEXT_PROTOCOL.md`**: one host-neutral skill that is also copied into AGENTS.md and GEMINI.md. It covers:
  - At start: bootstrap, don't trust memory blindly, verify critical facts against the code.
  - During work: propose decisions, constraints and lessons, but not tool noise.
  - At the end: checkpoint and handoff.
  - GPT's DO / DON'T list.
- **Task skills:**
  - `uac-init-knowledge`: holistic survey by a strong model, written as typed memories each with a `source_commit`.
  - `uac-refresh`: re-verify stale items.
  - `uac-review`: walk through proposals and conflicts.
  - `uac-handoff`.
  - `uac-brainstorm`: output is always type `idea`.
  - `uac-yagni`: the verdict is stored as type `decision` with `review_when`, and a bootstrap re-surfaces it once the trigger condition is met.
- **Commands:** `/uac start|pause|resume|stop|status|save|load|review|view|handoff|forget|doctor|refresh|init`

## 11. Viewer (phase 3, not 5)
- **Tabs:**
  - Overview (the health metrics below)
  - Sessions, grouped by agent
  - Memories: filter by type, scope and status; inline edit; version history with revert
  - Review queue: accept / reject / edit / resolve conflicts
  - Checkpoints
  - Packs
  - Retrieval log with the "why" for each item
  - Settings / policy
  - Live capture toggle
- **Memory health:**
  - Counts of fresh / stale / conflict / proposed
  - Compression ratio
  - Average bootstrap size in tokens
  - Tokens saved (estimated: raw transcript tokens vs pack tokens)
  - Monthly compression cost

## 12. Policy (`.uac/policy.yml` in the repo, overrides the global file)
```yaml
mode: manual              # manual | automatic
capture: { default: ask, prompts: true, tools: names_and_targets, subagents: final_message }
auto_accept: [decision, architecture, lesson]   # only used in automatic mode
never: [secrets, raw_tool_output]
proposals: { ttl_days: 7, max_per_session: 20 }
budget_tiers: { minimal: 1000, relevant: 4000, deep: 10000 }
compress: { stop_threshold_events: 40, subagent_model: haiku }   # in-session subagent, no API key
retention: { events_days: 30 }
```
`.ctxignore` uses gitignore syntax. Its defaults are `.env*`, `*.pem`, `*.key`, `secrets/**`.

## 13. Eval harness (built with the core, not later)
- `test/eval/*.json` contains scripted scenarios: session 1 facts, then a session 2 query, then the expected memory ids.
- `uac eval` reports recall@5, precision, stale-hit rate, pack tokens and latency.
- It runs in CI. The ranking weights and any later move to vectors must beat the baseline.

## 14. Phases
| # | Deliverable | Done when |
|---|---|---|
| P0 | Store, schema, FTS probe, policy, redact, `uac` CLI, eval harness skeleton | node:test + `uac eval` pass on Windows |
| P1 | Claude Code adapter: menu, 3 consents, capture states, checkpoints, Stop-hook save trigger with loop guard | Pause and resume work; checkpoints are written |
| P2 | `uac-compressor` subagent + `uac_digest`/`uac_save` → reconcile → proposals (TTL, rate limit), unsaved-session pickup | A real session gives ≤20 sensible proposals with no extra API call |
| P3 | MCP (12 tools) + protocol skill + viewer (review queue, edit, history) | The user reviews and edits; the next session's bootstrap reflects it |
| P4 | Ranking, budget tiers, packs, handoff, `uac_why`, file-overlap boost | Recall@5 ≥ baseline; a parallel session loads a pack |
| P5 | Git: branch scope, promotion on merge, staleness, `uac refresh`, PROJECT.md export | The feature-branch scenario works end to end |
| P6 | Adapters: Codex, Gemini, Antigravity, Cursor, Copilot + idempotent `uac install` | A Claude-written memory is recalled in Codex, and the reverse |
| P7 | YAGNI and brainstorm skills, failure lessons, rollup, doctor, health, importers (claude-mem, claude-remember, CLAUDE.md) | — |

## 15. Explicitly deferred
- Vectors: the upgrade path is Porter+trigram RRF first. Vectors come only if the eval still shows a recall gap after that.
- A graph DB, a resident daemon, Fastify, and better-sqlite3.
- Cloud or multi-machine sync. claude-context-manager's bearer-token proxy is the pattern if it's ever needed.
- Code indexing.
- Two-way markdown sync.

## 16. Decisions (2026-09-24)
1. **Modes:** both `manual` and `automatic`, chosen per project. The first session in a project asks which one. Until you answer, it behaves as `manual`, which is the safe default.
2. **Compression:** done inside the session by the `uac-compressor` subagent (Haiku). No extra API call and no key (§7a).
3. **`.context/PROJECT.md`** is committed to git.
4. **Policy:** both files are supported. `.uac/policy.local.yml` is gitignored, created by default, and overrides the committed team file `.uac/policy.yml`, which is optional.
5. **Name:** **Universal Agent Context (UAC)**.
   - CLI and prefix: `uac`. Package and marketplace name: `universal-agent-context`.
   - On Windows, "UAC" also means User Account Control, so use the full name wherever people will search for it.

## 17. VS Code extension: ships alongside the CLI (same core, one more interface)
**First, what hooks can already do.** Start, pause and stop are possible without an extension:
- `/uac start|pause|resume|stop`.
- Inline `#uac pause` in any prompt. The UserPromptSubmit hook flips the state instantly, with no LLM involved.
- The model asking via AskUserQuestion.

What a hook can't do is open its **own** popup. The extension fills exactly that gap.

**What the extension adds**
- **Status bar:** `● UAC rec` / `❚❚ paused` / `○ off`. Click to toggle. It writes `sessions.capture`, and hooks read it on the next event.
- **QuickPick at session start:** when a new session row appears for this workspace, show the Load tier / pack / Fork / None choices, then the Capture on/off choice. The choice is stored. `uac_bootstrap` returns it, so the model skips its own questions. If the popup is ignored, the model asks as usual.
- **Tree view:** Memories by type, a **Review queue** with a badge count, Sessions by agent, Packs.
- **Webview:** reuses `viewer.html` unchanged (edit, history, conflicts).
- **Notifications:** "6 proposals to review".

**How it's built**
- The extension talks to the `uac` CLI (`--json`) or to the `uac view` HTTP API. It doesn't open SQLite itself: VS Code's Electron Node may not ship `node:sqlite`, and this keeps a single code path.
- It watches the WAL file's mtime, or polls every second, to notice new sessions.
- With several parallel sessions in one workspace, the QuickPick lists them.

**Reach**
- Works in VS Code and in VS Code-based editors: Cursor, Windsurf, Antigravity. Publish to both the Marketplace and Open VSX.
- Doesn't help in a plain terminal or in JetBrains. That's why it's an **accelerator, never a requirement**: capture still comes from hooks, and access still comes from MCP.

**Shipping: CLI and extension together, one core**
```
src/ (core, hooks, MCP, viewer)  ──build──►  uac binary (per OS)  +  uac.mjs
                                                 │
extension/ (~300 LOC UI shell)  ──bundles──►  the same binary (one VSIX per platform)
```
- **One source of logic.** The extension has no storage or ranking code of its own. It calls the bundled `uac` (`--json`) and hosts `viewer.html` in a webview.
- **The extension is also the easiest installer.** On first run it offers to run `uac install claude|codex|gemini|…` to register hooks and MCP. So installing only the extension still gives full capture in a terminal CLI.
- **Terminal and JetBrains users** install the binary or the `.mjs` directly and get everything except the popups.
- **Phase:** P3.5, right after the viewer, because it reuses it.

## 19. Storage availability and packaging
The engine is SQLite. What can be missing is the **driver**, not SQLite itself.
- **Drivers, in order:**
  1. `node:sqlite` (built in)
  2. `better-sqlite3` (optional, prebuilt)
  3. **JSONL spool:** hooks append to `~/.uac/spool/<session>.jsonl` when no driver loads or the database is locked. The spool is imported on the next `uac` run.
  - Hooks never block and never lose events.
- **Driver interface:** `db.ts` exposes `exec`, `prepare().run/all/get` and `transaction`. That's the whole API surface, so swapping drivers is trivial.
- **Packaging:**
  - A **single-executable `uac` per OS** (Node single-executable application, SQLite built in). Nothing to install, and it works for users of the native Claude Code installer or Codex, who may have no Node.
  - Plus `uac.mjs` for people who already have Node 22.13+.
- **Not doing:** JSON or markdown files as the main store. They lose parallel writes and can't search.
  - WASM SQLite (sql.js) loads the whole file into memory, so it has the same lost-write problem. It's kept only as a possible read-only fallback for the webview, and only if ever needed.
- **Verify in P0:**
  - FTS5 is present in the single-executable build on Windows, macOS and Linux. Fall back to `LIKE` search if not.
  - How big the binary is (it bundles the whole Node runtime).

## 18. Future separate project: database MCP server (parked)
> Not part of UAC. Recorded now so it isn't lost. Start it after UAC P3.

**Step 0: don't build it yet; test what already exists against your database list.**
| Existing | Verified | Covers |
|---|---|---|
| [googleapis/mcp-toolbox](https://github.com/googleapis/mcp-toolbox) | 16.5k★, Apache-2.0, pushed 2026-09-24 | Many databases; tools are declared in YAML; prebuilt tools |
| [bytebase/dbhub](https://github.com/bytebase/dbhub) | 3.5k★, MIT, pushed 2026-09-21 | Postgres, MySQL, **SQL Server, Oracle**, MariaDB, SQLite; designed to keep token use low |

**Only if both fall short, build a thin gateway:**
- **Tools:**
  - `db_connections`
  - `db_schema(conn, filter)`: progressive. Tables first, columns on demand.
  - `db_query(conn, sql, limit)`: read-only.
  - `db_explain`
  - `db_execute`: writes. Needs an allowlist plus user confirmation via elicitation.
  - `db_saved_query`
- **Safety:**
  - A read-only database user by default.
  - The SQL parser allows only SELECT/WITH.
  - Row and time limits.
  - Credentials from environment variables or the OS keychain, never from config files.
  - An audit log and PII masking.
- **Link to UAC:** schema summaries and query lessons are stored as UAC memories (types `architecture` and `lesson`), so agents don't re-explore the schema every session.
- **Questions for later:** which databases (SQL Server / Oracle / Postgres?), and what exactly the pain is: juggling connections, discovering the schema, safety, or the context cost of big results?
