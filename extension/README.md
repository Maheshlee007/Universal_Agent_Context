# Universal Agent Context (UAC) for VS Code

A thin UI over the local `uac` CLI. Memory lives in `~/.uac/uac.db`, and the extension never opens it directly.
Context loads automatically at session start (the hook does it), so the extension asks no questions.

- **Status bar:** `● UAC rec` (recording) / `○ UAC` (context loaded, not recording) / `UAC off` (mode off). Click for actions: start/stop recording, save now (type `#uac save` in chat), continue from session…, open dashboard, mode, delete empty sessions.
- **Sessions:** `#n title` with branch/agent. Right-click: Continue from this, Open in dashboard, Delete. Title bar: Continue from session…, Delete empty sessions.
- **Knowledge:** project memories grouped by type, with freshness (✓ verified, ⚠ changed, ✗ missing). **Review:** only items that need a decision.
- **Messages:** new messages from other sessions show as notifications. `UAC: Send message to other sessions`.
- **Dashboard:** `uac view` shown in a webview.
- `UAC: Install for detected tools` runs `uac install` for every supported tool found.

## Requirements
Node 22.13 or later on your PATH (it needs `node:sqlite`). Set `uac.nodePath` if node is elsewhere.

By default the extension runs the CLI bundled at `cli/bin/uac.mjs`. Set `uac.cliPath` to use a different one.

## Build
```
node scripts/bundle-cli.mjs    # copies ../plugin/{bin,src,viewer} into cli/ (also runs on vscode:prepublish)
npx @vscode/vsce package --allow-missing-repository --skip-license
```
