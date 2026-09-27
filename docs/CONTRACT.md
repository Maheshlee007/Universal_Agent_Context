# UAC internal contract (v0.1)

This file is the shared interface for everyone working on UAC. Change it only through the lead.

## Runtime
- Plain ESM JavaScript (`.mjs`). There is **no build step and there are zero npm dependencies**. Node ≥ 22.13 (22.19 on the dev box).
- `node:sqlite` is the store. The DB is `$UAC_HOME/uac.db`, where `UAC_HOME` defaults to `~/.uac`.
- The entry point is `bin/uac.mjs <command> [...args]`. Adding `--json` gives machine-readable output on stdout.

## CLI commands (bin/uac.mjs)
| Command | Output (with --json) |
|---|---|
| `uac status [--cwd DIR]` | `{project:{id,root,name,mode}, session:{id,capture,status}\|null, counts:{active,proposed,stale,conflict,tasks}, unsaved:[{session_id,events}]}` |
| `uac capture <on\|paused\|off> [--session ID] [--cwd DIR]` | `{ok:true, session_id, capture}` |
| `uac mode <manual\|automatic> [--cwd DIR]` | `{ok:true, mode}` |
| `uac choose --tier <minimal\|relevant\|deep\|fork\|none> [--pack ID] [--capture on\|off] [--session ID] [--cwd DIR]` | `{ok:true}`. Stores the start-of-session choice (made from the extension); `uac_bootstrap` picks it up |
| `uac sessions [--cwd DIR] [--active]` | `[{id,agent,capture,status,started_at,title,unsaved}]` |
| `uac search <query> [--cwd DIR]` | `[{id,type,title,status,score}]` |
| `uac view [--port N] [--no-open]` | Prints `UAC viewer: http://127.0.0.1:PORT/?t=TOKEN`. With --json: `{url}`. Keeps running |
| `uac install <claude\|codex\|gemini\|antigravity\|cursor\|copilot> [--dry-run]` | Registers hooks + MCP for that host, idempotently |
| `uac hook <host> <event>` | Hook entry point. Reads JSON from stdin and writes host-formatted JSON to stdout |
| `uac mcp` | MCP stdio server |

## Normalized hook event (the adapter produces this; `src/hook.mjs` consumes it)
```js
{ host, event: 'start'|'prompt'|'tool'|'tool_fail'|'subagent_stop'|'precompact'|'stop'|'end',
  session_id, cwd, transcript_path, source /* startup|resume|compact|clear */,
  prompt, tool, tool_input, tool_response, agent_id, last_message, stop_hook_active }
```
`handle(ev)` returns `{ context?: string, block?: string, message?: string }`:
- `context`: text to inject into the model's context.
- `block`: for `stop` only. The reason the model must continue.
- `message`: shown to the user.

The adapter formats that result into the host's output JSON.

## Adapter module shape (`src/adapters/<host>.mjs`)
```js
export const events = { SessionStart: 'start', ... }       // host event name -> normalized
export function normalize(hostEvent, input) { return {...normalizedEvent} }
export function format(normalizedEvent, result) { return object|null }   // stdout JSON (null = print nothing)
export function install({ root, uacCmd, dryRun }) { return { files:[{path, before, after}] } } // idempotent: merge, never clobber
```

## Viewer HTTP API (`src/view.mjs`)
- Every `/api/*` request needs the `?t=TOKEN` query parameter or the header `x-uac-token`.
- JSON in, JSON out.

| Method + path | Body / query | Returns |
|---|---|---|
| GET `/api/projects` | | `[{id,root,name,mode}]` |
| GET `/api/sessions?project=ID` | | `[{id,agent,branch,capture,status,started_at,ended_at,title,events,unsaved}]` |
| PUT `/api/sessions/:id/capture` | `{state}` | `{ok}` |
| DELETE `/api/sessions/:id` | | `{ok}` (also deletes its events) |
| GET `/api/memories?project=ID&status=&type=&q=` | | `[memory]` |
| GET `/api/memories/:id` | | `{...memory, versions:[...], relations:[...]}` |
| PUT `/api/memories/:id` | any of `{title,body,why,type,scope,importance,pinned,status}` | `memory` (creates a version, source becomes 'user') |
| POST `/api/memories/:id/resolve` | `{action:'accept'\|'reject', body?}` | `memory` |
| DELETE `/api/memories/:id` | | `{ok}` (hard delete) |
| GET `/api/review?project=ID` | | `{proposed:[memory], conflicts:[{memory, other}]}` |
| GET `/api/checkpoints?project=ID` | | `[checkpoint]` |
| GET `/api/summaries?project=ID` | | `[summary]` |
| GET `/api/packs?project=ID` | | `[pack]` |
| GET `/api/retrievals?project=ID` | | `[{id,session_id,goal,item_ids,reasons,tokens,ts}]` |
| GET `/api/health?project=ID` | | `{counts:{active,proposed,stale,conflict,superseded,archived}, sessions, events, avg_pack_tokens, raw_chars, pack_chars}` |
| GET/PUT `/api/settings?project=ID` | `{mode}` | `{mode}` |

**memory** = `{id, project_id, scope, branch, type, title, body, why, status, importance, confidence, pinned, source, source_agent, source_session, source_commit, files:[], review_when, created_at, updated_at}`

- **types:** fact, decision, constraint, lesson, requirement, preference, warning, idea, task, architecture
- **statuses:** proposed, active, stale, conflict, superseded, archived

## MCP tools (server name `uac`)
- **Session:** `uac_bootstrap`, `uac_capture`, `uac_checkpoint`
- **Read:** `uac_search`, `uac_get`, `uac_timeline`, `uac_why`
- **Write:** `uac_propose`, `uac_update`, `uac_invalidate`
- **Review:** `uac_review`, `uac_resolve`
- **Packs:** `uac_pack`, `uac_handoff`
- **Used by the compressor subagent:** `uac_digest`, `uac_save`

Most tools take an optional `session_id`. The SessionStart menu gives it to the model.

### MCP tool input schemas
- **Common rules:** `session_id` is optional wherever it appears. Without it, the server uses the most recent active session for the server's cwd project.
- **`uac_bootstrap`** `{session_id?, tier?: minimal|relevant|deep|fork|none, budget_tokens?, goal?, pack?}` returns a markdown context pack.
  - With no `tier`, it uses the extension choice if one was made, otherwise `relevant`.
- **`uac_capture`** `{session_id?, state: on|paused|off, mode?: manual|automatic}`
- **`uac_checkpoint`** `{session_id?, goal, working, broken, files?:[], next_steps?:[], note}`: `note` is "what I'd tell the next dev".
- **`uac_search`** `{query, type?, status?, limit?}` returns index lines: `id · type · status · title`.
- **`uac_get`** `{ids:[]}`
- **`uac_timeline`** `{session_id?, before?, after?}`: summaries and checkpoints around a session.
- **`uac_why`** `{id}`: why that item appeared in the last pack.
- **`uac_propose`** `{session_id?, type, title, body, why?, files?:[], confidence?:0..1, scope?: user|project|branch, review_when?}`
- **`uac_update`** `{id, body, title?, reason, evidence?}`
  - manual mode: creates a proposal that supersedes the old memory.
  - automatic mode: applies the change and records a version.
- **`uac_invalidate`** `{id, reason, superseded_by?}`
- **`uac_review`** `{}` lists proposed items and conflicts.
- **`uac_resolve`** `{id, action: accept|reject, body?}`
- **`uac_pack`** `{action: create|list, name?, ids?:[], goal?, budget_tokens?}`
- **`uac_handoff`** `{session_id?, name?}` creates a pack for a parallel or next session.
- **`uac_digest`** `{session_id, max_chars?}` returns `{session_id, goal, upto_event_id, events: "text", existing: [{id,type,title}]}`. The events are unsaved, pre-filtered and redacted.
- **`uac_save`** `{session_id, upto_event_id, summary:{title,body}, checkpoint:{goal,working,broken,files,next_steps,note}, candidates:[{op: add|update|supersede|conflict|noop, id?, type, title, body, why?, files?, confidence?}]}`

## v0.2 additions: choose the next session's context, and see what each session stored
Viewer API:
| Method + path | Body / query | Returns |
|---|---|---|
| GET `/api/sessions/:id` | | `{session, loaded:{tier,pack,goal}\|null, events:[{id,ts,kind,tool,target,body}], summaries:[...], checkpoints:[...], memories:[memory]}`. `memories` = those this session created. `events` = the last 500. |
| POST `/api/packs?project=ID` | `{name, ids:[...], goal?, budget_tokens?, next?:bool}` | `pack`. `ids` can be memory (m-), summary (s-) or checkpoint (c-) ids |
| DELETE `/api/packs/:id` | | `{ok}` |
| GET `/api/next?project=ID` | | `{pack: id\|null}` |
| PUT `/api/next?project=ID` | `{pack: id\|null}` | `{pack}`. Pre-selects a pack for the NEXT session of this project. It's one-shot: cleared once a session loads it |

In GET `/api/packs`, each pack now has `next: bool`.

CLI:
- `uac packs` → `[{id,name,goal,item_ids,next}]`
- `uac pack --ids a,b [--name N] [--next]` → creates a pack
- `uac next --pack P | --clear` → `{pack}`
- `uac session <id>` → same shape as GET `/api/sessions/:id`

---
# v0.3 contract (supersedes the conflicting parts above). Code now lives in plugin/ (plugin/bin, plugin/src, plugin/viewer)

## Model
- **Users pick SESSIONS, not memories or packs.** A session "card" is that session's latest summary plus its latest checkpoint.
- **Project knowledge** (memories) is always loaded in compact form and is never ticked by users. They can pin, mute, verify, edit or delete it.
- A successful LLM save deletes the session's raw events; the card replaces them.
- A deterministic "auto card" (quality='auto') is built without an LLM for sessions that ended unsaved. Their events are kept until an LLM save refines the card.
- **Modes per project:** `off` | `manual` (loads context, records only after `#uac on`) | `automatic` (loads + records). A null mode means first run: ask once.

## Viewer API changes / additions
| Method + path | Body | Returns |
|---|---|---|
| GET `/api/projects` | | `[{id,root,name,mode,git_remote,sessions,memories}]` |
| POST `/api/projects/merge` | `{from, into}` | `{ok}`. Moves everything from `from` into `into`, then deletes `from` |
| DELETE `/api/projects/:id` | | `{ok}`. Cascades everything |
| GET `/api/sessions?project=ID` | | `[{id, n, agent, model, branch, capture, status, started_at, ended_at, title, events, unsaved, card:{summary_id,title,body,quality,working,broken,next_steps,files,note}\|null, memories_created, next:bool}]`. `n` = 1-based index, newest first (same numbering as the CLI) |
| GET `/api/sessions/:id/impact` | | `{events, summaries, checkpoints, memories, retrievals}`: what a delete removes |
| DELETE `/api/sessions/:id` | | `{ok, deleted:{...counts}}`. **Cascade:** events, summaries, checkpoints, retrievals, and memories whose source_session is this session |
| POST `/api/sessions/cleanup?project=ID` | `{empty:true}` | `{deleted:n}`. Removes sessions with 0 events and no card |
| GET `/api/next?project=ID` | | `{sessions:[ids]}` |
| PUT `/api/next?project=ID` | `{sessions:[ids]}` (empty = default: latest card on the same branch) | `{sessions}`. One-shot, consumed by the next session start |
| GET `/api/memories?project=ID&status=&type=&q=&auto=1` | | `[memory]`. `auto=1` = accepted automatically in the last 7 days (for the "Recently auto-accepted" list) |
| PUT `/api/memories/:id` | adds `muted` (bool), `pinned` (bool) | memory |
| POST `/api/memories/:id/verify` | | memory (last_verified_at=now, verified_commit=HEAD) |
| POST `/api/memories/:id/resolve` | `{action, body?}` | memory. Server records resolved_by='user-dashboard' |
| GET `/api/messages?project=ID` | | `[{id, from_session, from_agent, from_branch, to, text, created_at, reads}]` |
| POST `/api/messages?project=ID` | `{text, to:'all'\|'branch:<name>'\|'session:<id>'}` | message |

**memory** gains: `anchors:[{file,symbol,line}]`, `muted`, `source_model`, `resolved_by`, `resolved_at`, `last_verified_at`, `verified_commit`, `freshness:{state:'verified'\|'changed'\|'missing'\|'unknown', commits_since:number}`.

Packs, retrievals and `/api/next` with a pack are kept for power users, but aren't in the main UI.

## CLI (numbered, no ids needed)
- `uac sessions`: numbered 1..n, newest first.
- `uac next 2 3` or `uac next --clear`
- `uac rm 4 5`, `uac rm --empty`, `uac rm <id>`
- `uac review`: interactive in a terminal: y accept / n reject / e edit in $EDITOR / s skip. Non-interactive with --json.
- `uac import [n|id]`: rebuild events from the host transcript of a session that wasn't captured.
- `uac msg "text" [--to all|branch:<b>|session:<id>]`, `uac msgs`
- `uac projects` / `uac projects merge <from> <into>` / `uac projects rm <id>`
- `uac backup`, `uac doctor` (path, sizes, integrity, fts5, wal)
- `uac install` with no host: detect and install for every host found. `uac install <host>` still works.
- `uac mode off|manual|automatic`

## Inline controls (UserPromptSubmit, every host, no LLM involved)
`#uac on | off | pause | resume | save | stop | fresh | continue <n…> | import | msg <text>`
- `fresh`: reload with project knowledge only.
- `continue 2 3`: load session cards 2 and 3.

## MCP changes
- **`uac_bootstrap`** `{session_id?, sessions?:[ids or numbers], packs?:[ids], goal?, depth?:'normal'|'deep'}`. Plural lists are merged. The old `tier` and `pack` fields are still accepted.
- **`uac_verify`** `{ids:[]}`: "still true", bumps last_verified_at without writing a version.
- **`uac_message`** `{session_id?, text, to?}` and **`uac_messages`** `{session_id?}`.
- **`uac_save`** adds `model` (the compressor's model id).
  - Candidates gain `anchors:[{file,symbol,line}]`, plus `op:'verify'` (with `id`) to confirm an existing memory.
- **`uac_digest`** adds `diff_stat` (git diff --stat since start_commit, including uncommitted changes) and `recheck:[{id,type,title,body,anchors}]`: stale memories whose files this session changed. The compressor must verify, update or invalidate each one.
- **`uac_handoff`** `{session_id?}` marks this session as the next session's context. Returns what to type in the other session (`#uac continue <n>`).

---
# v0.3.2 additions: naming, merging and rolling up sessions, empty-session hints, resume cost tip
- **Session name:**
  - Set automatically from the first recorded prompt (a short first line). The compressor replaces it with a specific title on save.
  - The user can rename: inline `#uac name <title>`, CLI `uac name "<title>" [--session n]`, API PUT `/api/sessions/:id {title}`.
- **Merge sessions** (several → one existing session): CLI `uac merge <n…> --into <n>`, API POST `/api/sessions/merge {ids:[…], into}` → `{ok, into, moved:{events,summaries,checkpoints,memories}}`.
  - Moves every row of `ids` into `into`, deletes the emptied sessions, and adds one `card` event per merged card, so the next save writes one combined card.
  - Builds a combined auto card immediately.
- **Roll up** (many sessions → ONE new card, e.g. "compress all sessions into one"): CLI `uac rollup [n…|--all] [--branch b]`, inline `#uac rollup [n…]`, API POST `/api/sessions/rollup {ids?:[…], all?:true, branch?}` → `{session_id, sources, how}`.
  - Creates a session `rollup-xxxxxx` (agent `uac`) whose events are the source cards, and gives it an auto card.
  - The sources get `rolled_into` and are hidden from default lists and start menus. They stay browsable: `uac sessions --all`, or the dashboard's "show rolled-up" toggle.
  - `how` says: spawn uac-compressor with `session_id=rollup-…` to write the single combined card.
- **Sessions list items** gain `empty` (bool: no events, no card, no memories), `rolled_into` (id|null) and `title` (always set when known).
- **`#uac save <n>`** saves a previous session (the model is told to spawn uac-compressor for that session id). The start context tells the user when the latest session ended without an LLM save.
- **Resume tip:** on SessionStart with source=resume and a large transcript, the context says roughly how many tokens the host reloaded, and that a new session with `#uac continue <n>` costs about 2K instead.
