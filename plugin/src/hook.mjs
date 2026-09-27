// Host-neutral hook handling. Fast path: append-only, no LLM, no network.
import fs from 'node:fs';
import path from 'node:path';
import { run, home, spool, now, checkpointWal } from './db.mjs';
import * as S from './store.mjs';
import * as K from './pack.mjs';
import { clip, redact, target, enableGitCache } from './util.mjs';
import { adapters } from './adapters/index.mjs';
import { importTranscript } from './import.mjs';

export { target };
const SKIP_TOOLS = /^(TodoWrite|ToolSearch|TaskList|TaskGet|TaskOutput)$|^mcp__.*uac__uac_/;
// #uac on|off|pause|resume|save [n]|stop|fresh|deep|import|continue <n…>|msg <text>|name <title>|rollup [n…]
// Only at the start of the message or of a line: "#uac save <n>" quoted inside docs/pasted text must not fire.
// "uac: save" is the same as "#uac save": Claude Code intercepts messages that START with "#" (memory shortcut).
const CONTROL = /(^|\n)(?:#uac\s+|uac:\s*)(on|off|pause|resume|save|stop|fresh|deep|import|continue|msg|name|rollup)\b([^\n]*)/i;
const saveInstruction = (sid) =>
  `[UAC] Save requested. Spawn the uac-compressor subagent (Agent/Task tool, subagent_type "uac-compressor") with the prompt "session_id=${sid}". If subagents are unavailable, do its steps yourself: uac_digest → uac_save. Then continue.`;
const str = (v) => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));

function control(s, p, cmd, rest) {
  switch (cmd) {
    case 'on': case 'resume': S.setCapture(s.id, 'on'); return '[UAC] Recording on.';
    case 'off': S.setCapture(s.id, 'off'); return '[UAC] Recording off for this session.';
    case 'pause': K.precompactSnapshot(s); S.setCapture(s.id, 'paused'); return '[UAC] Recording paused (checkpoint written).';
    case 'save': { // "#uac save" = this session; "#uac save 3" = session #3 (e.g. one that ended unsaved, or a rollup)
      const ref = rest.split(/[\s,]+/).filter(Boolean)[0];
      const id = ref ? S.resolveSessionRefs(p.id, [ref])[0] : s.id;
      if (!id) return `[UAC] No session "${ref}". Type "#uac continue" to see the numbers.`;
      return saveInstruction(id);
    }
    case 'name': S.renameSession(s.id, rest); return `[UAC] Session named "${rest.trim()}".`;
    case 'rollup': {
      const refs = rest.split(/[\s,]+/).filter(Boolean);
      const r = K.rollup(p, refs.length ? { refs } : { all: true, branch: p.branch });
      return `[UAC] ${r.how} Do it now: spawn uac-compressor with "session_id=${r.session_id}".`;
    }
    case 'stop': S.setCapture(s.id, 'off'); return `${saveInstruction(s.id)}\n[UAC] Recording stops after this save.`;
    case 'fresh': return `[UAC] Reloaded with project knowledge only (no session state):\n\n${K.bootstrap(S.session(s.id), p, { fresh: true }).text}`;
    case 'deep': return `[UAC] Deeper context:\n\n${K.bootstrap(S.session(s.id), p, { depth: 'deep', sessions: (JSON.parse(s.loaded || '{}').sessions) || [] }).text}`;
    case 'continue': {
      const refs = rest.split(/[\s,]+/).filter(Boolean);
      if (!refs.length) return `[UAC] Usage: #uac continue <n> [n…]. ${S.listSessions(p.id, { limit: 8 }).filter((x) => x.card || x.events).map((x) => `#${x.n} ${K.sessionLabel(x, 40)}`).join(' · ')}`;
      return `[UAC] Continuing from session(s) ${refs.join(', ')}:\n\n${K.bootstrap(S.session(s.id), p, { sessions: refs }).text}`;
    }
    case 'import': {
      const r = importTranscript(S.session(s.id));
      S.setCapture(s.id, 'on');
      return `[UAC] Imported ${r.events_imported} events from this session's transcript; recording is on now.`;
    }
    case 'msg': {
      const m = /^\s*(?:to\s+(all|branch:\S+|session:\S+)\s+)?([\s\S]+)$/i.exec(rest);
      if (!m?.[2]?.trim()) return '[UAC] Usage: #uac msg [to branch:<name>] <text>';
      S.postMessage(s, p, m[2].trim(), m[1] || 'all');
      return `[UAC] Message posted to ${m[1] || 'all'} sessions of this project.`;
    }
  }
  return null;
}

export function handle(ev) {
  if (process.env.UAC_DISABLE || S.isScratch(ev.cwd)) return {};
  if (ev.event === 'end') {
    const s = S.session(ev.session_id);
    if (!s) return {};
    run(`UPDATE sessions SET status = 'ended', ended_at = ? WHERE id = ?`, now(), s.id);
    if (S.unsavedCount(s) >= 3 && s.quality !== 'llm') K.autoCard(S.session(s.id)); // nothing is lost if nobody saved
    checkpointWal();
    return {};
  }
  const { s, created } = S.ensureSession(ev);
  const p = ev.event === 'start' || created ? S.projectFor(ev.cwd) : S.project(s.project_id);

  switch (ev.event) {
    case 'start':
      return { context: K.startContext(s, p, { source: ev.source }) };

    case 'prompt': {
      const out = [];
      // hosts without SessionStart (Antigravity), or a SessionStart the host timed out: the first prompt delivers the start context
      const needStart = created || (!s.ctx_at && !S.unsavedCount(s) && ev.source !== 'compact');
      if (needStart) out.push(K.startContext(s, p));
      const m = CONTROL.exec(ev.prompt || '');
      if (m) {
        let r;
        try { r = control(s, p, m[2].toLowerCase(), (m[3] || '').trim()); } catch (e) { r = `[UAC] ${e.message}`; }
        if (r) out.push(r);
      }
      const cur = S.session(s.id);
      const text = (ev.prompt || '').replace(CONTROL, ' ').trim();
      if (text && cur.capture === 'on') {
        S.addEvent(cur, 'prompt', { body: text });
        if (!cur.title) S.renameSession(cur.id, clip(redact(text.split('\n')[0]), 60)); // named at start; the compressor improves it on save
      }
      if (text && cur.capture === 'ask') S.addEvent(cur, 'pending', { body: text }); // kept only if the user opts in
      if (!created && p.mode !== 'off') {
        const msgs = S.unreadMessages(cur);
        if (msgs.length) {
          out.push(`[UAC] Message(s) from other sessions:\n${msgs.map((x) => `- from ${x.from_agent}${x.from_branch ? ` on \`${x.from_branch}\`` : ''}: ${x.text}`).join('\n')}`);
          S.markRead(cur, msgs);
        }
      }
      return out.length ? { context: out.join('\n\n'), start: needStart } : {};
    }

    case 'tool':
    case 'tool_fail': {
      if (s.capture !== 'on' || !ev.tool || SKIP_TOOLS.test(ev.tool)) return {};
      if (ev.agent_id) return {}; // subagent internals: final message (subagent_stop) + git diff cover them
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
  enableGitCache();
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
    // mark the start context as delivered; if the host killed us before this (timeout), the first prompt re-injects it
    if (result?.context && (ev.event === 'start' || result.start)) run('UPDATE sessions SET ctx_at = ? WHERE id = ?', now(), ev.session_id);
  } catch (e) {
    try {
      fs.mkdirSync(home(), { recursive: true }); // the error may happen before the DB (and its folder) was created
      fs.appendFileSync(path.join(home(), 'hook-errors.log'), `${now()} ${host}/${hostEvent}: ${e.stack}\n`);
    } catch {}
  }
}
