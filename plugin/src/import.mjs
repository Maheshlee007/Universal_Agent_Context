// Recover a session that ran without recording, from the host's own transcript (only when the user asks).
// Claude Code JSONL is supported; other hosts' transcripts are read best-effort (plain user/assistant text).
import fs from 'node:fs';
import * as S from './store.mjs';
import { run, get } from './db.mjs';
import { target } from './util.mjs';

const text = (content) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : '';

export function importTranscript(s, { before } = {}) {
  if (!s?.transcript_path || !fs.existsSync(s.transcript_path)) throw new Error(`no transcript on disk for session ${s?.id}`);
  const seen = new Set();
  let added = 0;
  const lines = fs.readFileSync(s.transcript_path, 'utf8').split('\n');
  // replace unsaved events with the full transcript, but skip what an earlier LLM save already summarized
  const after = get(`SELECT MAX(created_at) AS t FROM summaries WHERE session_id = ? AND quality = 'llm'`, s.id)?.t;
  run(`DELETE FROM events WHERE session_id = ? AND id > ?`, s.id, s.saved_event_id);
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.uuid && seen.has(e.uuid)) continue; // resumed sessions re-serialize entries
    if (e.uuid) seen.add(e.uuid);
    if (e.isSidechain || e.isMeta || e.isCompactSummary) continue;
    if (before && e.timestamp && e.timestamp >= before) continue;
    if (after && e.timestamp && e.timestamp <= after) continue;
    const msg = e.message || e;
    const role = e.type || msg.role;
    if (role === 'user') {
      const t = text(msg.content);
      if (t && !t.startsWith('<') && !/^\[UAC/.test(t)) { S.addEvent(s, 'prompt', { body: t }); added++; }
    } else if (role === 'assistant' && Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c.type === 'tool_use' && !/uac_/.test(c.name)) { S.addEvent(s, 'tool', { tool: c.name, target: JSON.stringify(target(c.input) ?? '').replace(/^"|"$/g, '') }); added++; }
        if (c.type === 'text' && c.text?.length > 40) { S.addEvent(s, 'assistant', { body: c.text }); added++; }
      }
    } else if (role === 'assistant' && typeof msg.content === 'string') { S.addEvent(s, 'assistant', { body: msg.content }); added++; }
  }
  return { session_id: s.id, events_imported: added };
}
