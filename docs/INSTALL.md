# Installing UAC

UAC = one local SQLite store + hooks + an MCP server. Every host (Claude Code, Gemini CLI, Codex, Cursor, Copilot CLI, Antigravity, VS Code) talks to the same store, so a session saved in one can be continued in another.

Commands below use `uac` as short for `node <repo>/plugin/bin/uac.mjs`. Optional alias:
- PowerShell: `function uac { node "D:\path\to\Universal_Agent_Context\plugin\bin\uac.mjs" @args }` (add to `$PROFILE`)
- bash/zsh: `alias uac='node ~/src/Universal_Agent_Context/plugin/bin/uac.mjs'`

## 1. Requirements

- **Node ≥ 22.13** (for the built-in `node:sqlite`). Check: `node -v`.
- **No npm packages.** Nothing to `npm install`.
- `git` (for branch tracking and freshness checks).
- The DB is created on first use:
  - Windows: `%USERPROFILE%\.uac\uac.db`
  - macOS/Linux: `~/.uac/uac.db`
  - Override with the `UAC_HOME` environment variable.

## 2. Get the code

```
git clone https://github.com/Maheshlee007/Universal_Agent_Context.git
cd Universal_Agent_Context
```
Pick a permanent location. Hooks and MCP configs point at this path; if you move it, re-run the install.

## 3. One command for everything

```
node plugin/bin/uac.mjs install            # detect hosts, install for each
node plugin/bin/uac.mjs install --dry-run  # show what would be written
node plugin/bin/uac.mjs install <host>     # one host: claude|gemini|codex|cursor|copilot|antigravity
```
It detects Claude Code, Gemini CLI, Codex, Copilot CLI (CLI on PATH), Cursor (`cursor` on PATH or `~/.cursor`), Antigravity (`~/.gemini/config`) and VS Code (`code` on PATH), and installs for each one found. For VS Code it installs the `.vsix` in `extension/`, so build that first (section 5). It's safe to re-run: existing UAC entries are replaced, everything else in those files is kept.

| Host | What it writes | Undo |
|---|---|---|
| Claude Code | Runs `claude plugin marketplace add <repo>/plugin` + `claude plugin install universal-agent-context@uac` | `claude plugin uninstall universal-agent-context@uac`, `claude plugin marketplace remove uac` |
| Gemini CLI | `~/.gemini/settings.json`: `hooks.*` entries + `mcpServers.uac` | Delete hook entries whose command contains `uac.mjs" hook` and `mcpServers.uac` |
| Codex | `~/.codex/hooks.json` (hooks), `~/.codex/config.toml` (`[mcp_servers.uac]`) | Delete the UAC hook entries and the `[mcp_servers.uac]` table |
| Cursor | `~/.cursor/hooks.json` (hooks), `~/.cursor/mcp.json` (`mcpServers.uac`) | Delete the UAC hook entries and `mcpServers.uac` |
| Copilot CLI | `~/.copilot/hooks/uac.json` (own file), `~/.copilot/mcp-config.json` (`mcpServers.uac`); `$COPILOT_HOME` if set | Delete `hooks/uac.json` and `mcpServers.uac` |
| Antigravity | `~/.gemini/config/hooks.json` (`"uac"` group), `~/.gemini/config/mcp_config.json` (`mcpServers.uac`) | Delete the `"uac"` key and `mcpServers.uac` |
| VS Code | `code --install-extension extension/<name>.vsix --force` (section 5) | `code --uninstall-extension uac-dev.universal-agent-context` |

`~` is `%USERPROFILE%` on Windows. Restart the host after installing.

## 4. Claude Code

`uac install claude` registers the `plugin/` folder as a local marketplace named `uac` (`plugin/.claude-plugin/marketplace.json`) and installs the plugin from it. Claude copies only `plugin/` into its plugin cache (about 260 KB). There are two alternatives that give the same result: register the repo root (`claude plugin marketplace add <repo>`; the root marketplace points at `./plugin`), or register GitHub (`claude plugin marketplace add Maheshlee007/Universal_Agent_Context`). You get hooks, the MCP server, skills, the `uac-compressor` subagent and the command.

- **Command:** plugin commands are namespaced: `/universal-agent-context:uac <arg>` (e.g. `/universal-agent-context:uac save`).
- **Inline (recommended):** type `#uac on`, `#uac save`, `#uac continue 2`… anywhere in a prompt. The hook handles it without the model.
- **Update after `git pull`:** Claude only re-copies when the version changes (bump `version` in `plugin/.claude-plugin/plugin.json` if you changed the code yourself). Re-run `node plugin/bin/uac.mjs install claude`: it runs `claude plugin marketplace update uac` and `claude plugin update universal-agent-context@uac` for you.
- **Reload after an update:** open Claude Code sessions keep the old hooks and MCP server. Type `/reload-plugins` in each one (or restart it; in VS Code, "Reload Window"). New sessions use the new version. A plugin can't run `/reload-plugins` itself, so when versions differ the start context tells the agent to ask you. `uac doctor` shows the versions of the CLI, hooks, MCP server and installed plugin.
- **Install never downgrades:** the `uac` marketplace can be registered from this clone or from the VS Code extension's bundled copy. If the registered source is a newer version at another path, `uac install` keeps it and prints `kept the registered UAC <version>`. Install from the newer copy, or remove the marketplace first, to switch.
- Check: `claude plugin list` shows `universal-agent-context@uac`; `/mcp` shows `uac` connected.

## 5. VS Code extension

Build the VSIX (from the repo root):
```
cd extension
node scripts/bundle-cli.mjs
npx @vscode/vsce package --allow-missing-repository --skip-license
code --install-extension universal-agent-context-<version>.vsix
```
`bundle-cli.mjs` copies the whole `plugin/` (CLI, hooks, skills, agents, manifests) into the extension, so it carries its own CLI, and "UAC: Install for detected tools" works from the extension alone. After an extension update, it re-runs the install automatically so hook paths follow the new version folder, then offers **Reload Window** so open Claude Code sessions pick it up. It still needs Node ≥ 22.13 on PATH (or set `uac.nodePath`; `uac.cliPath` points it at another CLI).

What you get:
- **Status bar:** recording state; click to toggle.
- **Activity bar (UAC):** Sessions (numbered cards, "Continue from this" for the next session), Knowledge, Review (conflicts and low-confidence items).
- **Dashboard:** the `uac view` web UI inside a webview.
- **Command palette:** `UAC: …` (toggle recording, choose next-session context, open viewer, review, install hooks for agents).

**Cursor / Windsurf / Antigravity** (VS Code forks): install from Open VSX if it's published there; otherwise run "Extensions: Install from VSIX…" and pick the same `.vsix`. The extension is only UI; the agent itself still needs its host install (section 6).

## 6. Gemini CLI, Codex, Cursor, Copilot CLI, Antigravity

```
node plugin/bin/uac.mjs install gemini      # or codex | cursor | copilot | antigravity
```
**Automatic after install:** hooks inject the start context, record the session (per mode), handle `#uac …` controls and ask for a save at the end. The MCP server gives the model the `uac_*` tools.

**Manual (recommended):** paste [PROTOCOL.md](PROTOCOL.md) into the host's rules file (`GEMINI.md`, `AGENTS.md`, `.cursor/rules`, `.github/copilot-instructions.md`) so the model knows how to verify memories and save. Hosts have no subagents, so the model saves inline (`uac_digest` → `uac_save`).

Host quirks:
- **Codex:** new or changed hooks must be trusted. Run `/hooks` in Codex and approve the UAC hooks, otherwise they don't run.
- **Antigravity:** no SessionStart hook. The start context is injected on the first prompt instead. Hooks and MCP are global (`~/.gemini/config/`).
- **Copilot CLI:** UAC writes its own `~/.copilot/hooks/uac.json`. The prompt hook can't inject text, so the start context arrives via `sessionStart` and replies to `#uac …` controls aren't shown (the control itself is still applied).
- **Cursor:** same as Copilot: `beforeSubmitPrompt` can't inject, so the context comes from `sessionStart`; `#uac` controls apply silently.
- **Gemini CLI:** hooks and MCP both live in `~/.gemini/settings.json`.

## 7. Any MCP-only tool

For a tool with MCP but no hooks, add the server to its MCP config:
```json
{
  "mcpServers": {
    "uac": { "command": "node", "args": ["<repo>/plugin/bin/uac.mjs", "mcp"] }
  }
}
```
Then paste [PROTOCOL.md](PROTOCOL.md) into its rules file. Without hooks nothing is injected or recorded automatically: the model calls `uac_bootstrap` at start and saves at the end, per the protocol. No MCP at all: the model can use the CLI (`node <repo>/plugin/bin/uac.mjs … --json`).

## 8. Verify it works

1. `uac doctor`: shows the Node version, DB path and size, integrity, FTS5, WAL size and the last hook errors. Everything should be green / empty.
2. Start a session in your host inside a git repo. You should see a `# UAC · <project> · branch …` header in the context, or, on the first run in a project, one question: automatic / manual / off.
3. Type `#uac on` (manual mode) and do some work.
4. Type `#uac save` (Claude: or `/universal-agent-context:uac save`). You get one line: `UAC saved: "<title>" · …`.
5. `uac sessions`: the session is listed with its card title. `uac view` opens the dashboard.

## 9. Troubleshooting

- **"database is locked":** UAC sets `busy_timeout` (5 s) before enabling WAL. If it persists, a stale process holds the DB: close old `uac view` / `uac mcp` node processes (Task Manager, or `Get-Process node`), then retry.
- **Large `uac.db-wal` file:** it's truncated on each save and at session end. To force it now, close all UAC processes and run `uac doctor` or save a session.
- **Hook errors:** hooks never break your host; failures go to `~/.uac/hook-errors.log`. `uac doctor` shows the last 5 lines.
- **MCP "Connection closed":** the host couldn't start `node … uac.mjs mcp`. Check `node -v` ≥ 22.13 in the host's PATH, that the path in the MCP config exists (re-run `uac install` after moving the repo), and run `node <repo>/plugin/bin/uac.mjs doctor` by hand to see the error. In Claude, `/mcp` shows the server status.
- **Backup:** `uac backup` writes a consistent copy (`VACUUM INTO`) to `~/.uac/backups/uac-<timestamp>.db`. Do this before any reset, and copy the backup out of `~/.uac` first.
- **Reset:** `uac backup`, move the backup out of `~/.uac`, close all hosts and UAC processes, then delete `~/.uac` (Windows: `%USERPROFILE%\.uac`). It's recreated on next use.

## 10. Uninstall

1. Per host, undo the entries from the table in section 3 (Claude: `claude plugin uninstall universal-agent-context@uac` and `claude plugin marketplace remove uac`).
2. VS Code: uninstall the extension from the Extensions view.
3. Remove the pasted UAC section from `AGENTS.md` / `GEMINI.md` / rules files.
4. Optional: `uac backup` (move the file out of `~/.uac`), then delete `~/.uac` to remove all stored data, and delete the repo.
