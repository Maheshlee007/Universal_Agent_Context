// Cursor adapter.
// Verified 2026-09-24 against https://cursor.com/docs/hooks :
//   events sessionStart/beforeSubmitPrompt/postToolUse/postToolUseFailure/subagentStop/preCompact/stop/sessionEnd;
//   common stdin conversation_id, generation_id, hook_event_name, workspace_roots[], transcript_path;
//   sessionStart/sessionEnd add session_id; postToolUse tool_name, tool_input, tool_output;
//   postToolUseFailure error_message, failure_type; beforeSubmitPrompt prompt; subagentStop summary, status;
//   stop status, loop_count;
//   output additional_context (sessionStart, postToolUse, postToolUseFailure); followup_message (stop, subagentStop);
//   ~/.cursor/hooks.json {version:1, hooks:{event:[{command}]}}; MCP in ~/.cursor/mcp.json.
// UNVERIFIED: sessionStart.session_id equals conversation_id elsewhere; conversation_id is preferred as the session key.
// UNVERIFIED: postToolUseFailure carries tool_name/tool_input (the reference lists only the error fields).
// UNVERIFIED: MCP entry shape {"mcpServers": {uac: {command, args}}} (from Cursor MCP docs/memory).
// beforeSubmitPrompt cannot inject context; stop_hook_active is derived from loop_count > 0.
import path from 'node:path';
import { home, hookCmd, mcpServer, editJson, UAC_RE } from './_shared.mjs';

export const events = {
  sessionStart: 'start',
  beforeSubmitPrompt: 'prompt',
  postToolUse: 'tool',
  postToolUseFailure: 'tool_fail',
  subagentStop: 'subagent_stop',
  preCompact: 'precompact',
  stop: 'stop',
  sessionEnd: 'end',
};

export function normalize(hostEvent, input = {}) {
  const event = events[hostEvent];
  return {
    host: 'cursor',
    event,
    session_id: input.conversation_id || input.session_id,
    cwd: input.cwd || input.workspace_roots?.[0],
    transcript_path: input.transcript_path ?? undefined,
    source: event === 'start' ? 'startup' : undefined,
    prompt: input.prompt,
    tool: input.tool_name,
    tool_input: input.tool_input,
    tool_response: event === 'tool_fail' ? input.error_message : input.tool_output,
    agent_id: input.subagent_id,
    last_message: input.summary,
    stop_hook_active: input.loop_count == null ? undefined : input.loop_count > 0,
  };
}

export function format(ev, result = {}) {
  const out = {};
  if (result.context && ['start', 'tool', 'tool_fail'].includes(ev.event)) out.additional_context = result.context;
  if (result.block && (ev.event === 'stop' || ev.event === 'subagent_stop')) out.followup_message = result.block;
  if (result.message && ev.event === 'precompact') out.user_message = result.message;
  return Object.keys(out).length ? out : null;
}

export function install({ root, uacCmd, dryRun }) {
  const dir = path.join(home(), '.cursor');
  const hooks = editJson(path.join(dir, 'hooks.json'), (cfg) => {
    cfg.version ??= 1;
    cfg.hooks ||= {};
    for (const ev of Object.keys(events)) {
      const kept = (cfg.hooks[ev] || []).filter((h) => !UAC_RE.test(h.command || ''));
      cfg.hooks[ev] = [...kept, { command: hookCmd({ root, uacCmd }, 'cursor', ev) }];
    }
  }, dryRun);
  const mcp = editJson(path.join(dir, 'mcp.json'), (cfg) => {
    cfg.mcpServers = { ...cfg.mcpServers, uac: mcpServer({ root, uacCmd }) };
  }, dryRun);
  return { files: [hooks, mcp] };
}
