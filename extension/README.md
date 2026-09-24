# Universal Agent Context (UAC) for VS Code

A thin UI over the local `uac` CLI. Memory lives in `~/.uac/uac.db`, and the extension never opens it directly.

- **Status bar:** `● UAC rec` / `❚❚ UAC paused` / `○ UAC off` / `UAC ask`. Click to toggle capture.
- **Session start:** when an agent session is waiting for a choice (capture `ask`), you pick the context tier (Minimal / Relevant / Deep / Fork / None) and whether to capture.
- **Activity bar:** Memories (grouped by type), Review (with a badge), Sessions.
- **Viewer:** `uac view` shown in a webview.
- **Commands:** `UAC: Toggle/Pause/Resume/Stop Capture`, `Choose Session Context`, `Open Viewer`, `Review Proposals`, `Install Hooks for Agents`.

## Requirements
Node 22.13 or later on your PATH (it needs `node:sqlite`). Set `uac.nodePath` if node is elsewhere.

By default the extension runs the CLI bundled at `cli/bin/uac.mjs`. Set `uac.cliPath` to use a different one.

## Build
```
node scripts/bundle-cli.mjs    # copies ../bin ../src ../viewer into cli/ (also runs on vscode:prepublish)
npx @vscode/vsce package --allow-missing-repository --skip-license
```
