// Recover a session that ran without recording, from the host's own transcript (only when the user asks).
// Claude Code JSONL is supported; other hosts' transcripts are read best-effort (plain user/assistant text).
// The transcript is also the raw log of a saved session: UAC deletes its own events on save, the host keeps the original.
import fs from 'node:fs';
import * as S from './store.mjs';
import { run, get } from './db.mjs';
import { target, redact } from './util.mjs';

const text = (content) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : '';

// Transcript → [{ts, kind, tool?, target?, body?}] (user prompts, tool calls, assistant text; no sidechains/meta).
export function readTranscript(file, { before, after } = {}) {
  if (!file || !fs.existsSync(file)) throw new Error('no transcript on disk for this session (the host deleted it or never wrote one)');
  const seen = new Set(), out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.uuid && seen.has(e.uuid)) continue; // resumed sessions re-serialize entries
    if (e.uuid) seen.add(e.uuid);
    if (e.isSidechain || e.isMeta || e.isCompactSummary) continue;
    if (before && e.timestamp && e.timestamp >= before) continue;
    if (after && e.timestamp && e.timestamp <= after) continue;
    const msg = e.message || e, role = e.type || msg.role, ts = e.timestamp;
    if (role === 'user') {
      const t = text(msg.content);
      if (t && !t.startsWith('<') && !/^\[UAC/.test(t)) out.push({ ts, kind: 'prompt', body: t });
    } else if (role === 'assistant' && Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c.type === 'tool_use' && !/uac_/.test(c.name)) out.push({ ts, kind: 'tool', tool: c.name, target: JSON.stringify(target(c.input) ?? '').replace(/^"|"$/g, '') });
        if (c.type === 'text' && c.text?.length > 40) out.push({ ts, kind: 'assistant', body: c.text });
      }
    } else if (role === 'assistant' && typeof msg.content === 'string') out.push({ ts, kind: 'assistant', body: msg.content });
  }
  return out;
}

// Raw log for `uac session <n> --raw` / uac_get {raw:true}: redacted, newest last, capped.
export const rawLog = (s, limit = 400) => readTranscript(s.transcript_path).slice(-limit)
  .map((e) => ({ ...e, body: e.body && redact(e.body.slice(0, 2000)), target: e.target && redact(e.target) }));

export function importTranscript(s, { before } = {}) {
  if (!s?.transcript_path) throw new Error(`no transcript on disk for session ${s?.id}`);
  // replace unsaved events with the full transcript, but skip what an earlier LLM save already summarized
  const after = get(`SELECT MAX(created_at) AS t FROM summaries WHERE session_id = ? AND quality = 'llm'`, s.id)?.t;
  const entries = readTranscript(s.transcript_path, { before, after });
  run(`DELETE FROM events WHERE session_id = ? AND id > ?`, s.id, s.saved_event_id);
  for (const { kind, tool, target: t, body } of entries) S.addEvent(s, kind, { tool, target: t, body });
  return { session_id: s.id, events_imported: entries.length };
}
