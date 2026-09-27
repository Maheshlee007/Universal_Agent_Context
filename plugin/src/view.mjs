// Local viewer: node:http + viewer/viewer.html, JSON API per docs/CONTRACT.md. Bound to 127.0.0.1, token-protected.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sea from 'node:sea';
import { all, get, run, P } from './db.mjs';
import * as S from './store.mjs';
import * as K from './pack.mjs';

// single-executable build embeds viewer.html as an asset; plain node reads it from disk
const readHtml = () => sea.isSea() ? sea.getAsset('viewer.html', 'utf8')
  : fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'viewer', 'viewer.html'));

const sessionsOf = (pid) => all(`SELECT s.id, s.agent, s.branch, s.capture, s.status, s.started_at, s.ended_at, s.title,
    (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id) AS events,
    (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.id > s.saved_event_id) AS unsaved
  FROM sessions s WHERE s.project_id = ? ORDER BY s.started_at DESC LIMIT 200`, pid);

function health(pid) {
  const r = all('SELECT tokens FROM retrievals WHERE project_id = ?', pid);
  const sums = get('SELECT COALESCE(SUM(raw_chars),0) AS raw, COALESCE(SUM(LENGTH(body)),0) AS packed FROM summaries WHERE project_id = ?', pid);
  return {
    counts: S.counts(pid),
    sessions: get('SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?', pid).n,
    events: get('SELECT COUNT(*) AS n FROM events e JOIN sessions s ON s.id = e.session_id WHERE s.project_id = ?', pid).n,
    avg_pack_tokens: r.length ? Math.round(r.reduce((a, x) => a + x.tokens, 0) / r.length) : 0,
    raw_chars: sums.raw, pack_chars: sums.packed,
  };
}

const routes = [
  ['GET', /^\/api\/projects$/, () => all('SELECT id, root, name, mode FROM projects ORDER BY name')],
  ['GET', /^\/api\/sessions$/, (q) => sessionsOf(q.project)],
  ['PUT', /^\/api\/sessions\/([^/]+)\/capture$/, (q, b, id) => { S.setCapture(id, b.state); return { ok: true }; }],
  ['DELETE', /^\/api\/sessions\/([^/]+)$/, (q, b, id) => {
    run('DELETE FROM events WHERE session_id = ?', id); run('DELETE FROM sessions WHERE id = ?', id); return { ok: true };
  }],
  ['GET', /^\/api\/memories$/, (q) => {
    const rows = q.q ? S.search(q.project, q.q, { type: q.type || undefined, status: q.status || undefined, limit: 200 })
      : all(`SELECT * FROM memories WHERE (project_id = ? OR project_id IS NULL) ${q.status ? 'AND status = ?' : ''} ${q.type ? 'AND type = ?' : ''}
          ORDER BY pinned DESC, updated_at DESC LIMIT 500`, ...[q.project, q.status, q.type].filter(Boolean)).map(S.hydrate);
    return rows;
  }],
  ['GET', /^\/api\/memories\/([^/]+)$/, (q, b, id) => {
    const m = S.memory(id);
    if (!m) throw Object.assign(new Error('not found'), { code: 404 });
    return { ...m, versions: all('SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY version DESC', id),
      relations: all('SELECT * FROM memory_relations WHERE a = ? OR b = ?', id, id) };
  }],
  ['PUT', /^\/api\/memories\/([^/]+)$/, (q, b, id) => after(S.updateMemory(id, b, { by: 'user', reason: b.reason || 'edited in viewer' }))],
  ['POST', /^\/api\/memories\/([^/]+)\/resolve$/, (q, b, id) => after(S.resolve(id, b.action, b.body))],
  ['DELETE', /^\/api\/memories\/([^/]+)$/, (q, b, id) => {
    const m = S.memory(id);
    run('DELETE FROM memories WHERE id = ?', id); run('DELETE FROM memory_versions WHERE memory_id = ?', id);
    run('DELETE FROM memory_relations WHERE a = ? OR b = ?', id, id);
    if (m) after(m);
    return { ok: true };
  }],
  ['GET', /^\/api\/review$/, (q) => S.review(q.project)],
  ['GET', /^\/api\/checkpoints$/, (q) => all('SELECT * FROM checkpoints WHERE project_id = ? ORDER BY ts DESC LIMIT 200', q.project)
    .map((c) => ({ ...c, files: P(c.files, []), next_steps: P(c.next_steps, []) }))],
  ['GET', /^\/api\/summaries$/, (q) => all('SELECT * FROM summaries WHERE project_id = ? ORDER BY created_at DESC LIMIT 200', q.project)],
  ['GET', /^\/api\/sessions\/([^/]+)$/, (q, b, id) => S.sessionDetail(id) || (() => { throw Object.assign(new Error('not found'), { code: 404 }); })()],
  ['GET', /^\/api\/packs$/, (q) => K.listPacks(q.project)],
  ['POST', /^\/api\/packs$/, (q, b) => {
    if (!Array.isArray(b.ids) || !b.ids.length) throw new Error('ids required');
    return K.createPack(S.project(q.project), null, b);
  }],
  ['DELETE', /^\/api\/packs\/([^/]+)$/, (q, b, id) => {
    const k = get('SELECT project_id FROM packs WHERE id = ?', id);
    if (k && S.nextPack(k.project_id) === id) S.setNextPack(k.project_id, null);
    run('DELETE FROM packs WHERE id = ?', id); return { ok: true };
  }],
  ['GET', /^\/api\/next$/, (q) => ({ pack: S.nextPack(q.project) })],
  ['PUT', /^\/api\/next$/, (q, b) => ({ pack: S.setNextPack(q.project, b.pack || null) })],
  ['GET', /^\/api\/retrievals$/, (q) => all('SELECT * FROM retrievals WHERE project_id = ? ORDER BY id DESC LIMIT 100', q.project)
    .map((r) => ({ ...r, item_ids: P(r.item_ids, []), reasons: P(r.reasons, {}) }))],
  ['GET', /^\/api\/health$/, (q) => health(q.project)],
  ['GET', /^\/api\/settings$/, (q) => ({ mode: S.project(q.project)?.mode ?? null })],
  ['PUT', /^\/api\/settings$/, (q, b) => { S.setMode(q.project, b.mode); return { mode: b.mode }; }],
];

// keep .context/PROJECT.md in sync after user edits
function after(m) {
  if (m?.project_id) { const p = S.project(m.project_id); if (p) try { S.exportProjectMd(p); } catch {} }
  return m;
}

export function startViewer({ port = 0, token = crypto.randomBytes(12).toString('hex') } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    if (!url.pathname.startsWith('/api/')) {
      if (url.pathname !== '/' && url.pathname !== '/index.html') return send(404, 'not found', 'text/plain');
      try { return send(200, readHtml(), 'text/html; charset=utf-8'); } catch { return send(500, 'viewer.html missing', 'text/plain'); }
    }
    if ((req.headers['x-uac-token'] || url.searchParams.get('t')) !== token) return send(401, { error: 'bad token' });
    const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
    if (!route) return send(404, { error: 'no route' });
    let body = {};
    if (req.method === 'PUT' || req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { error: 'bad json' }); }
    }
    try {
      send(200, route[2](Object.fromEntries(url.searchParams), body, ...(url.pathname.match(route[1]).slice(1).map(decodeURIComponent))));
    } catch (e) { send(e.code === 404 ? 404 : 400, { error: e.message }); }
  });
  return new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new Error(`port ${port} is in use (try --port 0)`) : e));
    server.listen(port, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/?t=${token}` }));
  });
}
