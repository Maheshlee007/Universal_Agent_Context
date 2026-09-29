// Local viewer: node:http + viewer/viewer.html, JSON API per docs/CONTRACT.md. Bound to 127.0.0.1, token-protected.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { all, get, run, P, home } from './db.mjs';
import * as S from './store.mjs';
import * as K from './pack.mjs';

const readHtml = () => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'viewer', 'viewer.html'));

const withFresh = (pid, rows) => {
  const pr = S.project(pid);
  if (!pr || !fs.existsSync(pr.root)) return rows;
  return S.freshness(S.projectFor(pr.root), rows);
};

function health(pid) {
  const sums = get('SELECT COALESCE(SUM(raw_chars),0) AS raw, COALESCE(SUM(LENGTH(body)),0) AS packed FROM summaries WHERE project_id = ?', pid);
  return {
    counts: S.counts(pid),
    sessions: get('SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?', pid).n,
    events: get('SELECT COUNT(*) AS n FROM events e JOIN sessions s ON s.id = e.session_id WHERE s.project_id = ?', pid).n,
    raw_chars: sums.raw, pack_chars: sums.packed, db: path.join(home(), 'uac.db'),
  };
}
const notFound = () => { throw Object.assign(new Error('not found'), { code: 404 }); };

const routes = [
  ['GET', /^\/api\/projects$/, () => S.listProjects()],
  ['POST', /^\/api\/projects\/merge$/, (q, b) => { S.mergeProjects(b.from, b.into); return { ok: true }; }],
  ['DELETE', /^\/api\/projects\/([^/]+)$/, (q, b, id) => { S.deleteProject(id); return { ok: true }; }],
  ['GET', /^\/api\/sessions$/, (q) => S.listSessions(q.project, { limit: 200, all: !!q.all })],
  ['POST', /^\/api\/sessions\/cleanup$/, (q) => ({ deleted: S.cleanupEmpty(q.project) })],
  ['POST', /^\/api\/sessions\/merge$/, (q, b) => {
    const pid = q.project || S.session(b.into)?.project_id;
    return K.mergeSessions(pid, b.ids || [], b.into);
  }],
  ['POST', /^\/api\/sessions\/rollup$/, (q, b) => {
    const pr = S.project(q.project) || notFound();
    return K.rollup(S.projectFor(pr.root), { refs: b.ids || [], all: !!b.all, branch: b.branch });
  }],
  ['PUT', /^\/api\/sessions\/([^/]+)$/, (q, b, id) => S.renameSession(id, b.title)],
  ['GET', /^\/api\/sessions\/([^/]+)\/impact$/, (q, b, id) => S.sessionImpact(id)],
  ['PUT', /^\/api\/sessions\/([^/]+)\/capture$/, (q, b, id) => { S.setCapture(id, b.state); return { ok: true }; }],
  ['GET', /^\/api\/sessions\/([^/]+)$/, (q, b, id) => S.sessionDetail(id) || notFound()],
  ['DELETE', /^\/api\/sessions\/([^/]+)$/, (q, b, id) => ({ ok: true, deleted: S.deleteSession(id) })],
  ['GET', /^\/api\/next$/, (q) => ({ sessions: S.nextSessions(q.project) })],
  ['PUT', /^\/api\/next$/, (q, b) => ({ sessions: b.sessions ? S.setNextSessions(q.project, S.resolveSessionRefs(q.project, b.sessions)) : S.nextSessions(q.project) })],
  ['GET', /^\/api\/memories$/, (q) => {
    const rows = q.q ? S.search(q.project, q.q, { type: q.type || undefined, status: q.status || undefined, limit: 200 })
      : all(`SELECT * FROM memories WHERE (project_id = ? OR project_id IS NULL) ${q.status ? 'AND status = ?' : ''} ${q.type ? 'AND type = ?' : ''}
          ORDER BY pinned DESC, updated_at DESC LIMIT 500`, ...[q.project, q.status, q.type].filter(Boolean)).map(S.hydrate);
    return withFresh(q.project, rows);
  }],
  ['GET', /^\/api\/memories\/([^/]+)$/, (q, b, id) => {
    const m = S.memory(id) || notFound();
    return { ...withFresh(m.project_id, [m])[0], versions: all('SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY version DESC', id),
      relations: all('SELECT * FROM memory_relations WHERE a = ? OR b = ?', id, id) };
  }],
  ['PUT', /^\/api\/memories\/([^/]+)$/, (q, b, id) => after(S.updateMemory(id, b, { by: 'user-dashboard', reason: b.reason || 'edited in dashboard' }))],
  ['POST', /^\/api\/memories\/([^/]+)\/verify$/, (q, b, id) => {
    const m = S.memory(id) || notFound();
    return after(S.verifyMemory(id, S.projectFor(S.project(m.project_id)?.root || process.cwd())));
  }],
  ['POST', /^\/api\/memories\/([^/]+)\/resolve$/, (q, b, id) => after(S.resolve(id, b.action, b.body, 'user-dashboard'))],
  ['DELETE', /^\/api\/memories\/([^/]+)$/, (q, b, id) => { after(S.deleteMemory(id)); return { ok: true }; }],
  ['GET', /^\/api\/review$/, (q) => S.review(q.project)],
  ['GET', /^\/api\/messages$/, (q) => S.listMessages(q.project)],
  ['DELETE', /^\/api\/messages\/([^/]+)$/, (q, b, id) => ({ ok: S.deleteMessage(id) })],
  ['POST', /^\/api\/messages$/, (q, b) => { const pr = S.project(q.project) || notFound(); return S.postMessage(null, pr, b.text, b.to || 'all'); }],
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
