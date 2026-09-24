// Gemini CLI adapter.
// Verified 2026-09-24 against https://geminicli.com/docs/hooks/reference/ :
//   events SessionStart/BeforeAgent/AfterTool/PreCompress/AfterAgent/SessionEnd;
//   stdin session_id, transcript_path, cwd, hook_event_name, source, prompt, tool_name, tool_input,
//   tool_response, prompt_response, stop_hook_active;
//   output hookSpecificOutput.additionalContext (SessionStart, BeforeAgent, AfterTool);
//   AfterAgent retry via {decision:'deny', reason}; systemMessage shown to user.
//   Hooks live under "hooks" in ~/.gemini/settings.json (Claude-style nesting).
// UNVERIFIED: MCP entry as settings.json "mcpServers": {uac: {command, args}} (not on the hooks page; from Gemini CLI MCP docs/memory).
// UNVERIFIED: a failed tool is detected via tool_response.error (Gemini has no separate failure event).
// UNVERIFIED: hookEventName inside hookSpecificOutput (the reference omits it; added for Claude-compat, should be ignored if unknown).
import path from 'node:path';
import { home, hookCmd, mcpServer, editJson, mergeNested } from './_shared.mjs';

export const events = {
  SessionStart: 'start',
  BeforeAgent: 'prompt',
  AfterTool: 'tool',
  PreCompress: 'precompact',
  AfterAgent: 'stop',
  SessionEnd: 'end',
};

const hostName = Object.fromEntries(Object.entries(events).map(([k, v]) => [v, k]));
const CONTEXT_EVENTS = new Set(['start', 'prompt', 'tool', 'tool_fail']);

export function normalize(hostEvent, input = {}) {
  let event = events[hostEvent];
  if (event === 'tool' && input.tool_response?.error) event = 'tool_fail';
  return {
    host: 'gemini',
    event,
    session_id: input.session_id,
    cwd: input.cwd,
    transcript_path: input.transcript_path,
    source: input.source,
    prompt: input.prompt,
    tool: input.tool_name,
    tool_input: input.tool_input,
    tool_response: input.tool_response,
    agent_id: input.agent_id,
    last_message: input.prompt_response,
    stop_hook_active: input.stop_hook_active,
  };
}

export function format(ev, result = {}) {
  const out = {};
  if (result.block && ev.event === 'stop') {
    out.decision = 'deny';
    out.reason = result.block;
  }
  if (result.context && CONTEXT_EVENTS.has(ev.event)) {
    out.hookSpecificOutput = { hookEventName: hostName[ev.event] || 'AfterTool', additionalContext: result.context };
  }
  if (result.message) out.systemMessage = result.message;
  return Object.keys(out).length ? out : null;
}

export function install({ root, uacCmd, dryRun }) {
  const file = editJson(path.join(home(), '.gemini', 'settings.json'), (cfg) => {
    cfg.hooks ||= {};
    for (const ev of Object.keys(events)) mergeNested(cfg.hooks, ev, hookCmd({ root, uacCmd }, 'gemini', ev));
    cfg.mcpServers = { ...cfg.mcpServers, uac: mcpServer({ root }) };
  }, dryRun);
  return { files: [file] };
}
