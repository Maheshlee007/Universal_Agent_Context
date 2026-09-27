// GitHub Copilot CLI adapter.
// Verified 2026-09-24 against https://docs.github.com/en/copilot/reference/hooks-reference :
//   events sessionStart/userPromptSubmitted/postToolUse/postToolUseFailure/subagentStop/preCompact/agentStop/sessionEnd;
//   camelCase stdin sessionId, cwd, timestamp, source, initialPrompt, prompt, toolName, toolArgs,
//   toolResult{resultType,textResultForLlm}, error, transcriptPath, agentId, response, stop_hook_active;
//   output top-level additionalContext (sessionStart, postToolUse, postToolUseFailure);
//   agentStop {decision:'block', reason} forces another turn; userPromptSubmitted output is dropped;
//   user hooks dir ~/.copilot/hooks/*.json ({version:1, hooks:{event:[{type:'command', bash, powershell, timeoutSec}]}}).
// UNVERIFIED: subagentStop honours {decision:'block'} like agentStop.
// UNVERIFIED: toolArgs may arrive as a JSON string (older CLI builds); parsed if so.
// UNVERIFIED: MCP config ~/.copilot/mcp-config.json {"mcpServers": {uac: {type:'local', command, args, tools:['*']}}} (from GitHub "add MCP servers" docs, not the hooks page).
import path from 'node:path';
import { home, hookCmd, mcpServer, editJson } from './_shared.mjs';

export const events = {
  sessionStart: 'start',
  userPromptSubmitted: 'prompt',
  postToolUse: 'tool',
  postToolUseFailure: 'tool_fail',
  subagentStop: 'subagent_stop',
  preCompact: 'precompact',
  agentStop: 'stop',
  sessionEnd: 'end',
};

const parse = (v) => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
};

export function normalize(hostEvent, input = {}) {
  const event = events[hostEvent];
  return {
    host: 'copilot',
    event,
    session_id: input.sessionId,
    cwd: input.cwd,
    transcript_path: input.transcriptPath,
    source: input.source,
    prompt: input.prompt ?? input.initialPrompt,
    tool: input.toolName,
    tool_input: parse(input.toolArgs),
    tool_response: event === 'tool_fail' ? input.error : input.toolResult?.textResultForLlm ?? input.toolResult,
    agent_id: input.agentId,
    last_message: input.response,
    stop_hook_active: input.stop_hook_active,
  };
}

export function format(ev, result = {}) {
  const out = {};
  if (result.context && ['start', 'tool', 'tool_fail'].includes(ev.event)) out.additionalContext = result.context;
  if (result.block && (ev.event === 'stop' || ev.event === 'subagent_stop')) {
    out.decision = 'block';
    out.reason = result.block;
  }
  return Object.keys(out).length ? out : null;
}

export function install({ root, uacCmd, dryRun }) {
  const dir = process.env.UAC_TEST_HOME || !process.env.COPILOT_HOME
    ? path.join(home(), '.copilot')
    : process.env.COPILOT_HOME;
  // Our own file in the hooks dir: other hook files are never touched.
  const hooks = editJson(path.join(dir, 'hooks', 'uac.json'), (cfg) => {
    cfg.version = 1;
    cfg.hooks = {};
    for (const ev of Object.keys(events)) {
      const cmd = hookCmd({ root, uacCmd }, 'copilot', ev);
      cfg.hooks[ev] = [{ type: 'command', bash: cmd, powershell: cmd, timeoutSec: 10 }];
    }
  }, dryRun);
  const mcp = editJson(path.join(dir, 'mcp-config.json'), (cfg) => {
    cfg.mcpServers = { ...cfg.mcpServers, uac: { type: 'local', ...mcpServer({ root, uacCmd }), tools: ['*'] } };
  }, dryRun);
  return { files: [hooks, mcp] };
}
