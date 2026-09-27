// Google Antigravity adapter.
// Verified 2026-09-24 against https://antigravity.google/docs/hooks and https://antigravity.google/docs/mcp/ :
//   events PreToolUse/PostToolUse/PreInvocation/PostInvocation/Stop (no SessionStart, no prompt hook);
//   common stdin conversationId, workspacePaths[], transcriptPath, artifactDirectoryPath, modelName;
//   PostToolUse adds toolCall{name,args}, stepIdx, error; PreInvocation adds invocationNum, initialNumSteps;
//   Stop adds executionNum, terminationReason, error, fullyIdle;
//   PreInvocation output {injectSteps:[{userMessage}|{ephemeralMessage}|{toolCall}]}; Stop output {decision:'continue', reason};
//   global hooks ~/.gemini/config/hooks.json as {"<name>": {enabled, <Event>: [{matcher?, hooks:[{type,command,timeout}]}]}};
//   global MCP ~/.gemini/config/mcp_config.json {"mcpServers": {name: {command, args}}}.
// PreInvocation -> 'prompt' (PLAN §4): the core treats an unseen session's first prompt as its start.
//   The prompt text is NOT in the payload (it lives in transcriptPath), so ev.prompt is undefined.
// UNVERIFIED: PreInvocation fires per model call (not per user turn), so 'prompt' events repeat within a turn.
// UNVERIFIED: userMessage vs ephemeralMessage persistence; userMessage chosen so the menu/pack stays in history.
// UNVERIFIED: omitting "matcher" on PostToolUse matches all tools.
// No way to show a user-only message, so result.message is dropped.
import path from 'node:path';
import { home, hookCmd, mcpServer, editJson } from './_shared.mjs';

export const events = {
  PreInvocation: 'prompt',
  PostToolUse: 'tool',
  Stop: 'stop',
};

export function normalize(hostEvent, input = {}) {
  let event = events[hostEvent];
  if (event === 'tool' && input.error) event = 'tool_fail';
  return {
    host: 'antigravity',
    event,
    session_id: input.conversationId,
    cwd: input.workspacePaths?.[0],
    transcript_path: input.transcriptPath,
    source: undefined,
    prompt: undefined,
    tool: input.toolCall?.name,
    tool_input: input.toolCall?.args,
    tool_response: input.error || undefined,
    agent_id: undefined,
    last_message: undefined,
    stop_hook_active: undefined,
  };
}

export function format(ev, result = {}) {
  if (ev.event === 'prompt' && result.context) return { injectSteps: [{ userMessage: result.context }] };
  if (ev.event === 'stop' && result.block) return { decision: 'continue', reason: result.block };
  return null;
}

export function install({ root, uacCmd, dryRun }) {
  const dir = path.join(home(), '.gemini', 'config');
  // Hooks are grouped under a named key, so ours is simply the "uac" group; other groups are untouched.
  const hooks = editJson(path.join(dir, 'hooks.json'), (cfg) => {
    const group = { enabled: true };
    for (const ev of Object.keys(events)) {
      group[ev] = [{ hooks: [{ type: 'command', command: hookCmd({ root, uacCmd }, 'antigravity', ev), timeout: 10 }] }];
    }
    cfg.uac = group;
  }, dryRun);
  const mcp = editJson(path.join(dir, 'mcp_config.json'), (cfg) => {
    cfg.mcpServers = { ...cfg.mcpServers, uac: mcpServer({ root }) };
  }, dryRun);
  return { files: [hooks, mcp] };
}
