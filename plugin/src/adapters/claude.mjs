// Claude Code adapter. Docs: https://code.claude.com/docs/en/hooks
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { semverCmp } from '../util.mjs';

export const events = {
  SessionStart: 'start', UserPromptSubmit: 'prompt', PostToolUse: 'tool', PostToolUseFailure: 'tool_fail',
  SubagentStop: 'subagent_stop', PreCompact: 'precompact', Stop: 'stop', SessionEnd: 'end',
};

export function normalize(hostEvent, i) {
  const event = events[hostEvent || i.hook_event_name];
  if (!event) return null;
  return {
    host: 'claude', event, session_id: i.session_id, cwd: i.cwd || process.cwd(), transcript_path: i.transcript_path,
    source: i.source, prompt: i.prompt, tool: i.tool_name, tool_input: i.tool_input,
    tool_response: i.tool_response ?? i.error, agent_id: i.agent_id, agent_type: i.agent_type,
    last_message: i.last_assistant_message, stop_hook_active: !!i.stop_hook_active,
    model: typeof i.model === 'string' ? i.model : i.model?.id ?? i.model?.display_name,
  };
}

export function format(ev, r) {
  const out = {};
  if (r.context && (ev.event === 'start' || ev.event === 'prompt'))
    out.hookSpecificOutput = { hookEventName: ev.event === 'start' ? 'SessionStart' : 'UserPromptSubmit', additionalContext: r.context };
  // Stop and SubagentStop both accept decision "block" (the agent continues with `reason` as its next instruction)
  if (r.block && (ev.event === 'stop' || ev.event === 'subagent_stop')) { out.decision = 'block'; out.reason = r.block; }
  if (r.message) out.systemMessage = r.message;
  return Object.keys(out).length ? out : null;
}

// Claude Code loads UAC as a plugin (hooks/hooks.json + .mcp.json + skills + agents) from a local marketplace.
// The "uac" marketplace is a directory source; both the dev tree and the VS Code extension's bundle can register it.
// Never repoint it at an OLDER copy (that silently downgraded hooks/MCP when an older extension re-ran install).
function registeredSource() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(process.env.UAC_TEST_HOME || os.homedir(), '.claude', 'plugins', 'known_marketplaces.json'), 'utf8'));
    const dir = j.uac?.source?.path || j.uac?.installLocation;
    const v = dir && JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).version;
    return dir ? { dir, version: v } : null;
  } catch { return null; }
}
const RELOAD = 'Open Claude Code sessions keep the old UAC until you type /reload-plugins (or restart them); new sessions use the new one.';

export function install({ root, dryRun }) {
  const own = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version; } catch { return null; } })();
  const reg = registeredSource();
  if (reg && own && path.resolve(reg.dir) !== path.resolve(root) && semverCmp(reg.version, own) > 0)
    return { files: [], commands: [], note: `kept the registered UAC ${reg.version} (${reg.dir}); this copy is older (${own}), not installed` };
  const cmds = [
    ['plugin', 'marketplace', 'add', root],
    ['plugin', 'install', 'universal-agent-context@uac'],
  ];
  if (dryRun) return { files: [], commands: cmds.map((c) => `claude ${c.join(' ')}`) };
  cmds.push(['plugin', 'marketplace', 'update', 'uac']); // refresh an already-registered local copy
  cmds.push(cmds.splice(1, 1)[0]);                      // install after the marketplace refresh
  cmds.push(['plugin', 'update', 'universal-agent-context@uac']); // an existing install otherwise keeps recording the old version
  const win = process.platform === 'win32';             // claude is a .cmd shim on Windows → needs a shell, so quote args
  const results = cmds.map((c) => {
    const r = spawnSync('claude', win ? c.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : c, { encoding: 'utf8', shell: win, timeout: 60000 });
    return { cmd: `claude ${c.join(' ')}`, status: r.status, out: (r.stdout + r.stderr).trim() };
  });
  return { files: [], commands: results, note: RELOAD };
}
