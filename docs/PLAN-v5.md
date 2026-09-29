# UAC v0.5 plan: uac-impromenets3.md + user asks + analysis (2026-09-29)

Inputs:
- `docs/uac-impromenets3.md`, feedback v2 from another LLM, which refers to v1 = `docs/UAC-improvements2.md`
- the user's asks: dashboard refresh, deleting and scrolling messages, dropping "recently auto-accepted", reloading after an update, removing bloat, rewriting the README
- a panel of three models (Fable, Sonnet, Opus), each reading it as an LLM consumer of the tool
- four agents that reproduced every issue against the v0.4.0 code
- a bloat audit

Premise: about 90% of UAC's readers are LLMs. Each change should make them act correctly with fewer tokens and fewer tool calls.

## A. Findings that reproduced (all against 0.4.0)

| # | Finding | Root cause | Fix |
|---|---|---|---|
| A1 | `uac_get "#2"` gives "unknown id" | The resolver only accepted bare digits | One resolver for everything: `#n`, `n`, the full id, or a 6+ char prefix, all within this project. The error lists the valid sessions |
| A2 | `#n` drifts (the same session was #2 and then #3) | `#n` was a position in a newest-first list. The current session is a phantom when the header is built and becomes #1 at its first prompt | `sessions.seq`: a per-project number assigned once, when the session becomes real. Numbers never move. The short id is printed next to every #n |
| A3 | No MCP tool lists sessions | Only `uac_timeline` existed: unnumbered, included phantoms, dumped full cards | `uac_sessions` replaces `uac_timeline`. One line per session: #n, short id, status, card, unsaved, raw yes/no, title |
| A4 | The start context never says what was left out | The "Loaded" line counted only what was loaded | One computed line: loaded / not loaded (other sessions, more knowledge) / wider (the exact calls), or "Nothing else stored" |
| A5 | A live or unsaved session is invisible to other sessions | The default card needed an LLM card; auto cards only came after SessionEnd or 6 h | Every other session with unsaved work gets a deterministic auto card at start. The default pick goes by last activity. Labels say "live" or "ended". A session with no SessionEnd counts as idle after 30 min |
| A6 | A session with no transcript is a dead entry | Lists never checked for the transcript | `raw` flag in lists; the "wider" line offers raw only where it exists. `uac_get raw` falls back to UAC's own kept events |
| A7 | Scope marker missing for user-scope non-preferences; a repo-specific preference became global | The render only tagged branch items; `type=preference` forced user scope | An explicit scope is honoured. Every user-scope item is tagged `[all projects]` |
| A8 | Anchor ambiguity: a subagent reopened a fixed memory against a different same-named file | ✗ gave no candidates; `uac_verify` "verified" even with the anchor missing | ✗ is split into "file missing" and "symbol not in file". A missing file lists same-named files with a DIFFERENT-files warning. `uac_verify` refuses while the anchor is missing |
| A9 | Compressor fails intermittently | The tools are deferred; ToolSearch was only an aside in the agent file. A failed run was never surfaced | Step 0 is a literal ToolSearch select. The spawn prompt carries it too. SubagentStop blocks a compressor whose reply doesn't start with "UAC saved:". The Stop hook asks for one retry when a requested save didn't land |
| A10 | `uac_save` with an empty or malformed card deleted all raw events | No validation before the deletes | Rejected with a precise error; nothing is written. The last 10 prompt/assistant events are kept after a save (not injected) |
| A11 | Near-duplicate knowledge piles up | Duplicates only came as pairs, only at save | Pairs are clustered. `uac_propose` refuses a near-duplicate and names the memory to update (`force:true` overrides). `uac doctor` counts duplicate pairs |
| A12 | Hooks and MCP on different versions; nothing says reload is needed | Hard-coded MCP version; the extension's `uac install` repointed the marketplace at its bundle | Each process reads its own plugin.json. Hooks and MCP stamp their version on the session they serve; a mismatch or an installed newer version adds one line "type /reload-plugins". Install never repoints to an older or equal copy at another path. The extension offers "Reload Window". `uac doctor` shows every version |
| A13 | Non-git subfolder became a new empty project | Exact-root match only | Nearest registered ancestor (never the home folder or a drive root). Read-only CLI commands don't register projects |
| A14 | Other projects' rows reachable by id; write tools modified them | By-id paths weren't scoped | Reads and writes scoped to the project (user-scope rows shared on purpose). Foreign candidate ids in a save are rejected |
| A15 | Compact or resume from a moved cwd loaded another project's context | The hook re-resolved the project from cwd for an existing session | An existing session always uses its own project |
| A16 | The start-context clip could cut off messages already marked read | Messages sat after the knowledge, and the clip cut the end | Messages go before the knowledge and are never clipped |
| A17 | Hooks silently did nothing in Temp/claude folders | Scratch filter | Still skipped, but the start context says so in one line. `UAC_ALLOW_SCRATCH=1` for tests |

## B. The user's asks
- **Dashboard:**
  - A Refresh button.
  - The Messages list refreshes itself every 5 s without touching the composer.
  - Delete a message (🗑, two-step).
  - A scrolling message list.
  - "Recently auto-accepted" removed: items accepted automatically carry a "new" pill in their group, where they can be edited.
- **Reload after an update:** A12. A plugin can't run `/reload-plugins` itself, so the session is told to ask the user, and the extension offers "Reload Window".
- **Bloat, 19 MCP tools cut to 13:**
  - Removed: `uac_pack` and the whole packs subsystem, the v0.2 tiers and `uac choose`, `uac_why` and the retrieval log, and `uac_checkpoint`.
  - `uac_timeline` is replaced by `uac_sessions`.
  - `uac_invalidate` is folded into `uac_update` (status superseded).
  - `uac_resolve` is folded into `uac_review`.
  - `uac_messages` is folded into `uac_message` (no text means read).
  - Also removed: the dashboard's "Advanced" section, the single-executable build (its dashboard hung and nobody shipped it), and dead helpers.
- **README:** rewritten end to end.

## C. Declined, with reasons
- **Injecting the last ~10 raw turns into every start:** every reader would pay about 1K tokens every session for a rare need. They are kept in the store (A10), and the card's "after this card" tail plus `raw:true` cover it.
- **Per-project database files:** SQLite isn't the risk; retrieval scoping was (A14). `uac backup` and PROJECT.md are the recovery path, and PROJECT.md now includes the last cards.
- **A periodic LLM merge pass over knowledge:** it could silently destroy distinct facts. Write-time dedup plus the save-time duplicates list catch the rest.
- **Automatic `/reload-plugins`:** a host slash command a plugin cannot run.
- **Merging "merge" into "rollup":** you asked for both.
- **Removing the brainstorm and YAGNI skills:** you asked for both.
