// Codex CLI adapter.
// Verified 2026-09-24 against https://learn.chatgpt.com/docs/hooks :
//   events SessionStart/UserPromptSubmit/PostToolUse/SubagentStop/PreCompact/Stop/SessionEnd;
//   stdin session_id, cwd, transcript_path, source, prompt, tool_name, tool_input, tool_response,
//   agent_id, last_assistant_message, stop_hook_active;
//   output hookSpecificOutput.{hookEventName, additionalContext} (SessionStart, UserPromptSubmit, PostToolUse),
//   Stop/SubagentStop continue via {decision:'block', reason}; systemMessage shown to user.
//   Hooks file ~/.codex/hooks.json (Claude-style nesting); hooks are on by default ([features] hooks).
// UNVERIFIED: MCP config as `[mcp_servers.uac]` command/args in ~/.codex/config.toml (the hooks page does not cover it; from Codex MCP docs/memory).
// UNVERIFIED: Codex has no PostToolUseFailure event, so tool failures arrive as ordinary 'tool' events.
import path from 'node:path';
import { home, hookCmd, mcpServer, editJson, editText, mergeNested } from './_shared.mjs';

export const events = {
  SessionStart: 'start',
  UserPromptSubmit: 'prompt',
  PostToolUse: 'tool',
  SubagentStop: 'subagent_stop',
  PreCompact: 'precompact',
  Stop: 'stop',
  SessionEnd: 'end',
};

const CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PostToolUse']);
const hostName = Object.fromEntries(Object.entries(events).map(([k, v]) => [v, k]));

export function normalize(hostEvent, input = {}) {
  return {
    host: 'codex',
    event: events[hostEvent],
    session_id: input.session_id,
    cwd: input.cwd,
    transcript_path: input.transcript_path,
    source: input.source,
    prompt: input.prompt,
    tool: input.tool_name,
    tool_input: input.tool_input,
    tool_response: input.tool_response,
    agent_id: input.agent_id,
    last_message: input.last_assistant_message,
    stop_hook_active: input.stop_hook_active,
  };
}

export function format(ev, result = {}) {
  const name = hostName[ev.event];
  const out = {};
  if (result.block && (ev.event === 'stop' || ev.event === 'subagent_stop')) {
    out.decision = 'block';
    out.reason = result.block;
  }
  if (result.context && CONTEXT_EVENTS.has(name)) {
    out.hookSpecificOutput = { hookEventName: name, additionalContext: result.context };
  }
  if (result.message) out.systemMessage = result.message;
  return Object.keys(out).length ? out : null;
}

export function install({ root, uacCmd, dryRun }) {
  const dir = path.join(home(), '.codex');
  const hooksFile = editJson(path.join(dir, 'hooks.json'), (cfg) => {
    cfg.hooks ||= {};
    for (const ev of Object.keys(events)) mergeNested(cfg.hooks, ev, hookCmd({ root, uacCmd }, 'codex', ev));
  }, dryRun);

  const { command, args } = mcpServer({ root, uacCmd });
  // JSON string escaping is valid TOML basic-string escaping.
  const block = `[mcp_servers.uac]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args).replace(/,/g, ', ')}\n`;
  const toml = editText(path.join(dir, 'config.toml'), (before) => {
    const text = before || '';
    // Replace our table up to the next table header (or EOF); never touch other tables.
    const re = /^\[mcp_servers\.uac\]\r?\n[^]*?(?=^\[|(?![^]))/m;
    if (re.test(text)) return text.replace(re, block);
    return text + (text && !text.endsWith('\n') ? '\n' : '') + (text ? '\n' : '') + block;
  }, dryRun);

  return { files: [hooksFile, toml] };
}
