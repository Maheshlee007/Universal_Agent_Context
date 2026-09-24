# Universal Agent Context (UAC)

UAC gives coding agents **memory across sessions, and across different agents**, and you stay in control of it.

- **Recording is opt-in.** At the start of each session you're asked whether to record it. You can pause, resume or stop at any time.
- **Compression uses your agent's own model.** A `uac-compressor` subagent (Haiku on Claude) summarizes the session. UAC needs no API key and makes no API calls of its own.
- **Durable knowledge is kept apart from history.** Decisions, constraints, lessons, requirements and architecture notes are stored as typed memories. They have a review queue, a version history, conflict detection, and staleness detection driven by git.
- **You choose what the next session gets.** Pick a size (Minimal ~1k, Relevant ~4k, Deep ~10k, Fork, None) or a hand-picked **pack**, from the dashboard, the VS Code extension or the CLI.
- **Parallel sessions:** one session can hand off to another (`uac_handoff`). "Fork" loads project knowledge without another session's working state.
- **Every session's contents are visible:** events, summaries, checkpoints, the memories it created, and what it loaded.
- **Local only.** Everything lives in one SQLite file (`~/.uac/uac.db`), and `.context/PROJECT.md` is regenerated for git.

> The design and its rationale are in [docs/PLAN-v2.md](docs/PLAN-v2.md). The implementation reference is [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements
Node.js **22.13 or later**, which includes the built-in `node:sqlite`. UAC has no npm dependencies.

If you'd rather not install Node, build the single-file executable instead: `node scripts/build-sea.mjs` produces `dist/uac.exe`, about 82 MB, with its own Node runtime and SQLite. Its hooks, CLI and MCP server work. The dashboard does not run inside the executable yet (see the [known issue](docs/ARCHITECTURE.md#verified-vs-not-verified-2026-09-24)).

Delete `dist/` before running `uac install claude`. Claude Code copies the whole plugin folder into its cache.

## Install

| Host | Command | Status |
|---|---|---|
| **Claude Code** | `node bin/uac.mjs install claude` (registers the local marketplace and installs the plugin: hooks, MCP, skills, `/uac` command, `uac-compressor` agent) | ✅ Live-tested end to end |
| **VS Code / Cursor / Windsurf / Antigravity (UI)** | `cd extension && npx @vscode/vsce package && code --install-extension universal-agent-context-0.1.0.vsix` | ✅ Packaged and installed; UI not clicked through |
| **Gemini CLI** | `node bin/uac.mjs install gemini` (`~/.gemini/settings.json`: hooks + `mcpServers.uac`) | ⚠ Install and hook output verified; a live run was blocked because headless `gemini -p` hangs on this machine even without UAC |
| **Codex CLI** | `node bin/uac.mjs install codex` (`~/.codex/hooks.json` + `config.toml` `[mcp_servers.uac]`) | ⚠ Unit and simulated payloads only (Codex isn't installed here). Codex asks you to trust new hooks via `/hooks` |
| **Antigravity (agent)** | `node bin/uac.mjs install antigravity` (`~/.gemini/config/hooks.json` + `mcp_config.json`) | ⚠ Unit and simulated payloads only. There's no SessionStart event, so the menu is injected at the first PreInvocation |
| **Cursor (agent)** | `node bin/uac.mjs install cursor` (`~/.cursor/hooks.json` + `mcp.json`) | ⚠ Unit and simulated payloads only |
| **Copilot CLI** | `node bin/uac.mjs install copilot` (`~/.copilot/hooks/uac.json` + `mcp-config.json`) | ⚠ Unit and simulated payloads only |
| Anything with MCP only | Add the MCP server `node <repo>/bin/uac.mjs mcp` and paste [docs/PROTOCOL.md](docs/PROTOCOL.md) into AGENTS.md / GEMINI.md | Works for reading and writing, but nothing is captured automatically |

- Add `--dry-run` to any `install` to see the config change before it's written.
- Installs are idempotent (safe to run twice) and never overwrite other tools' hooks.

## How to use it (Claude Code)

1. **Start a session.** UAC injects a short menu, and Claude asks you:
   - How much context to load: Minimal / Relevant / Deep / Fork / None / a pack.
   - Whether to record this session: on / off.
   - (Only the first time in a project) which mode: **manual** (save only when you ask, review everything) or **automatic** (saves by itself, and accepts decisions, architecture and lessons without review).
2. **While you work:**
   - `#uac pause`, `#uac resume`, `#uac off`, `#uac save`, `#uac stop` anywhere in a message take effect immediately.
   - Or use `/uac pause|resume|stop|save|status|review|view|handoff|mode ...`.
3. **Saving:**
   - `/uac save` (or, in automatic mode, the Stop hook after about 40 events) makes Claude spawn `uac-compressor`.
   - The compressor writes a summary, a checkpoint and memory candidates. Candidates are compared against existing memories and marked as new, update, supersede, conflict or no change.
4. **Review:** `/uac review` or the dashboard's Review tab. Accept, reject, or edit and accept.
5. **Next session:** the menu shows the last checkpoint ("note for next dev"), counts, recent sessions and packs. If a session was closed without saving, the next one offers to save it first.

### Choosing what the next session gets
- **Dashboard** (`uac view`, `/uac view`, or the VS Code panel):
  - Tick memories, summaries or checkpoints, then **Create pack + use for next session**.
  - Or, on the Packs tab, pick an existing pack with **Use for next session**.
- **VS Code:** run the command **UAC: Choose context for next session**.
- **CLI:** `uac pack --ids m-1,s-2 --name "auth handoff" --next`, or `uac next --pack p-xxxx` (`uac next --clear` goes back to asking).
- The choice applies **once**: the next session loads that pack automatically and the choice is cleared.

### Seeing what each session stored
- **Dashboard:** the Sessions tab. Click a session to see what it loaded, its summaries, checkpoints, the memories it created, and every captured event (filterable by kind).
- **CLI:** `uac session <id>`.

### Handing off to a parallel session
- In session A: `/uac handoff`, which creates a pack.
- In session B: pick that pack in the start menu, or call `uac_bootstrap {pack}`.
- Or give B a **Fork** start: project knowledge only, none of A's debugging state.

## CLI
```
uac status | doctor | sessions [--active] | session <id>
uac capture on|paused|off [--session ID]     uac mode manual|automatic
uac search <q> | get <id...> | review | accept <id> | reject <id> | edit <id> | forget <id>
uac packs | pack --ids a,b [--name N] [--next] | next [--pack P | --clear]
uac choose --tier T [--pack P] [--capture on|off]   (used by the VS Code extension)
uac view [--port N] [--no-open] | export | install <host> [--dry-run]
```
- Everything accepts `--json` and `--cwd DIR`.
- `uac` means `node <repo>/bin/uac.mjs` (or `npm link` it).

## MCP tools (server `uac`)
- **Session:** `uac_bootstrap`, `uac_capture`, `uac_checkpoint`
- **Read:** `uac_search`, `uac_get`, `uac_timeline`, `uac_why`
- **Write:** `uac_propose`, `uac_update`, `uac_invalidate`
- **Review:** `uac_review`, `uac_resolve`
- **Packs:** `uac_pack`, `uac_handoff`
- **Used by the compressor subagent:** `uac_digest`, `uac_save`

## Privacy
- **Before anything is stored:** secrets (API keys, JWTs, private keys, `password=`, credentials in URLs), emails and IP addresses are redacted, and `<private>…</private>` blocks are dropped.
- **`.uacignore`** (gitignore syntax) hides matching file paths. Defaults: `.env*`, `*.pem`, `*.key`, `**/secrets/**`, `**/credentials/**`.
- **Prompts typed before you opt in** are held as pending. They're kept if you turn recording on and deleted if you turn it off.
- **Deleting:** hard delete is user-only (`uac forget`, or the dashboard). Agents can only retire a memory (`uac_invalidate`).

## Tests
`npm test` runs 19 tests covering the end-to-end hook → capture → save → review → bootstrap → git → dashboard API → MCP flow, plus the adapter tests.
