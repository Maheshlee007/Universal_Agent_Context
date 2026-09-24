// Host-neutral hook handling. Fast path: append-only, no LLM, no network.
import fs from 'node:fs';
import path from 'node:path';
import { run, home, spool, now } from './db.mjs';
import * as S from './store.mjs';
import * as K from './pack.mjs';
import { clip, redact } from './util.mjs';
import { adapters } from './adapters/index.mjs';

const SKIP_TOOLS = /^(TodoWrite|ToolSearch|TaskList|TaskGet|TaskOutput)$|^mcp__.*uac__uac_/;
const CONTROL = /(^|\s)#uac\s+(pause|resume|on|off|save|stop)\b/i;
const saveInstruction = (sid) =>
  `[UAC] Save requested. Spawn the uac-compressor subagent (Agent/Task tool, subagent_type "uac-compressor") with the prompt "session_id=${sid}". If subagents are unavailable, do its steps yourself: uac_digest → uac_save. Then continue.`;

export function target(input = {}) {
  if (typeof input !== 'object' || !input) return null;
  return input.file_path ?? input.path ?? input.notebook_path ?? input.command ?? input.pattern ?? input.url ?? input.query ?? input.description ?? null;
}
const str = (v) => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));

export function handle(ev) {
  if (process.env.UAC_DISABLE) return {};
  if (ev.event === 'end') { run(`UPDATE sessions SET status = 'ended', ended_at = ? WHERE id = ?`, now(), ev.session_id); return {}; }
  const { s, created } = S.ensureSession(ev);
  const p = ev.event === 'start' || created ? S.projectFor(ev.cwd) : S.project(s.project_id);

  switch (ev.event) {
    case 'start':
      return { context: K.menu(s, p, { source: ev.source }) };

    case 'prompt': {
      const out = [];
      if (created) out.push(K.menu(s, p)); // hosts without SessionStart (Antigravity): first prompt acts as start
      const m = CONTROL.exec(ev.prompt || '');
      if (m) {
        const cmd = m[2].toLowerCase();
        if (cmd === 'pause') { K.precompactSnapshot(s); S.setCapture(s.id, 'paused'); out.push('[UAC] Capture paused (checkpoint written).'); }
        if (cmd === 'resume' || cmd === 'on') { S.setCapture(s.id, 'on'); out.push('[UAC] Capture on.'); }
        if (cmd === 'off') { S.setCapture(s.id, 'off'); out.push('[UAC] Capture off for this session.'); }
        if (cmd === 'save' || cmd === 'stop') out.push(saveInstruction(s.id));
        if (cmd === 'stop') { S.setCapture(s.id, 'off'); out.push('[UAC] Capture stopped after this save.'); }
      }
      const cur = S.session(s.id);
      const text = (ev.prompt || '').replace(CONTROL, ' ').trim();
      if (text && cur.capture === 'on') S.addEvent(cur, 'prompt', { body: text });
      if (text && cur.capture === 'ask') S.addEvent(cur, 'pending', { body: text }); // kept only if the user opts in
      return out.length ? { context: out.join('\n\n') } : {};
    }

    case 'tool':
    case 'tool_fail': {
      if (s.capture !== 'on' || !ev.tool || SKIP_TOOLS.test(ev.tool)) return {};
      if (ev.agent_id) return {}; // subagent internals: only their final message is kept (subagent_stop)
      S.addEvent(s, ev.event, { tool: ev.tool, target: str(target(ev.tool_input)), body: clip(str(ev.tool_response), ev.event === 'tool_fail' ? 600 : 200) });
      return {};
    }

    case 'subagent_stop':
      if (s.capture === 'on' && ev.last_message && !/uac-compressor/.test(ev.agent_type || ''))
        S.addEvent(s, 'subagent', { body: ev.last_message, agent_id: ev.agent_id });
      return {};

    case 'precompact':
      if (s.capture === 'on') K.precompactSnapshot(s);
      return {};

    case 'stop':
      if (s.capture === 'on' && ev.last_message && !ev.stop_hook_active) S.addEvent(s, 'assistant', { body: clip(ev.last_message, 1200) });
      if (s.capture === 'on' && p.mode === 'automatic' && !ev.stop_hook_active && S.unsavedCount(s) >= K.STOP_THRESHOLD)
        return { block: saveInstruction(s.id) };
      return {};
  }
  return {};
}

// Entry used by `uac hook <host> <event>`: never throws, never blocks the host on errors.
export async function main(host, hostEvent) {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let ev;
  try {
    const adapter = adapters[host];
    if (!adapter) throw new Error(`unknown host ${host}`);
    const input = raw ? JSON.parse(raw) : {};
    ev = adapter.normalize(hostEvent, input);
    if (!ev || !ev.event) return;
    let result;
    try { result = handle(ev); }
    catch (e) {
      if (/locked|busy/i.test(e.message) && ['prompt', 'tool', 'tool_fail'].includes(ev.event)) // DB busy → spool, lose nothing
        spool({ session_id: ev.session_id, ts: now(), kind: ev.event === 'prompt' ? 'prompt' : ev.event, tool: ev.tool,
          target: clip(redact(str(target(ev.tool_input))), 300), body: clip(redact(ev.event === 'prompt' ? ev.prompt : str(ev.tool_response)), 2000) });
      throw e;
    }
    const out = adapter.format(ev, result || {});
    if (out != null) process.stdout.write(typeof out === 'string' ? out : JSON.stringify(out));
  } catch (e) {
    try { fs.appendFileSync(path.join(home(), 'hook-errors.log'), `${now()} ${host}/${hostEvent}: ${e.stack}\n`); } catch {}
  }
}
