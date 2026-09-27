// SQLite store: schema, FTS5 probe, JSONL spool fallback.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const home = () => process.env.UAC_HOME || path.join(os.homedir(), '.uac');
export const now = () => new Date().toISOString();
export const uid = (prefix) => `${prefix}-${crypto.randomBytes(3).toString('hex')}`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, root TEXT UNIQUE, name TEXT, git_remote TEXT,
  mode TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, project_id TEXT, agent TEXT, branch TEXT, start_commit TEXT,
  capture TEXT DEFAULT 'ask', status TEXT DEFAULT 'active', saved_event_id INTEGER DEFAULT 0,
  loaded TEXT, choice TEXT, transcript_path TEXT, started_at TEXT, ended_at TEXT, title TEXT);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ts TEXT, kind TEXT,
  tool TEXT, target TEXT, body TEXT, agent_id TEXT);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, id);
CREATE TABLE IF NOT EXISTS checkpoints(id TEXT PRIMARY KEY, session_id TEXT, project_id TEXT, ts TEXT, trigger TEXT,
  goal TEXT, working TEXT, broken TEXT, files TEXT, next_steps TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS summaries(id TEXT PRIMARY KEY, session_id TEXT, project_id TEXT, title TEXT, body TEXT,
  raw_chars INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, project_id TEXT, scope TEXT DEFAULT 'project', branch TEXT,
  type TEXT, title TEXT, body TEXT, why TEXT, status TEXT, importance REAL DEFAULT 0.5, confidence REAL DEFAULT 0.7,
  pinned INTEGER DEFAULT 0, source TEXT, source_agent TEXT, source_session TEXT, source_commit TEXT, files TEXT,
  review_when TEXT, valid_from TEXT, invalid_at TEXT, last_verified_at TEXT, created_at TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS memories_project ON memories(project_id, status);
CREATE TABLE IF NOT EXISTS memory_versions(memory_id TEXT, version INTEGER, title TEXT, body TEXT, changed_by TEXT,
  reason TEXT, ts TEXT);
CREATE TABLE IF NOT EXISTS memory_relations(a TEXT, b TEXT, rel TEXT, PRIMARY KEY(a, b, rel));
CREATE TABLE IF NOT EXISTS packs(id TEXT PRIMARY KEY, project_id TEXT, name TEXT, goal TEXT, budget_tokens INTEGER,
  item_ids TEXT, created_by_session TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS retrievals(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, project_id TEXT, goal TEXT,
  item_ids TEXT, reasons TEXT, tokens INTEGER, ts TEXT);
CREATE TABLE IF NOT EXISTS settings(scope TEXT, key TEXT, value TEXT, PRIMARY KEY(scope, key));
`;

const FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(title, body, why, content='memories', tokenize='porter unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS memories_tri USING fts5(title, body, content='memories', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, body, why) VALUES (new.rowid, new.title, new.body, new.why);
  INSERT INTO memories_tri(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, body, why) VALUES ('delete', old.rowid, old.title, old.body, old.why);
  INSERT INTO memories_tri(memories_tri, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF title, body, why ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, body, why) VALUES ('delete', old.rowid, old.title, old.body, old.why);
  INSERT INTO memories_tri(memories_tri, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO memories_fts(rowid, title, body, why) VALUES (new.rowid, new.title, new.body, new.why);
  INSERT INTO memories_tri(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
`;

let db;
export let hasFts = false;

export function open() {
  if (db) return db;
  fs.mkdirSync(home(), { recursive: true });
  db = new DatabaseSync(path.join(home(), 'uac.db'));
  // busy_timeout MUST come first: switching to WAL itself needs a lock ("database is locked" at SessionStart otherwise)
  db.exec('PRAGMA busy_timeout=5000;');
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
  db.exec(SCHEMA);
  migrate();
  try { db.exec(FTS); hasFts = true; } catch { hasFts = false; } // system SQLite without FTS5 → LIKE search
  drainSpool();
  return db;
}

// v0.3 columns/tables. ADD COLUMN is idempotent here (duplicate-column errors are ignored).
const V3_COLUMNS = [
  ['sessions', 'model TEXT'], ['sessions', 'quality TEXT'],
  ['memories', 'anchors TEXT'], ['memories', 'muted INTEGER DEFAULT 0'], ['memories', 'source_model TEXT'],
  ['memories', 'resolved_by TEXT'], ['memories', 'resolved_at TEXT'], ['memories', 'verified_commit TEXT'],
  ['checkpoints', 'superseded_by TEXT'], ['summaries', 'quality TEXT'], ['summaries', 'model TEXT'],
];
function migrate() {
  for (const [t, col] of V3_COLUMNS) { try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${col}`); } catch { /* exists */ } }
  db.exec(`CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, project_id TEXT, from_session TEXT, from_agent TEXT,
      from_branch TEXT, recipient TEXT, text TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS message_reads(message_id TEXT, session_id TEXT, PRIMARY KEY(message_id, session_id));`);
}

// Keep the -wal file from growing forever (called after saves and at session end).
export function checkpointWal() { try { open().exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* busy: next time */ } }

// node:sqlite rejects undefined and booleans: normalise once here for every caller.
const b = (p) => p.map((v) => (v === undefined ? null : v === true ? 1 : v === false ? 0 : v));
export const all = (sql, ...p) => open().prepare(sql).all(...b(p));
export const get = (sql, ...p) => open().prepare(sql).get(...b(p));
export const run = (sql, ...p) => open().prepare(sql).run(...b(p));
export function tx(fn) {
  const d = open();
  d.exec('BEGIN IMMEDIATE');
  try { const r = fn(); d.exec('COMMIT'); return r; } catch (e) { d.exec('ROLLBACK'); throw e; }
}

// Spool: when the DB is locked or unopenable, hooks append here; drained on next open().
const spoolFile = () => path.join(home(), 'spool.jsonl');
export function spool(entry) {
  fs.mkdirSync(home(), { recursive: true });
  fs.appendFileSync(spoolFile(), JSON.stringify(entry) + '\n');
}
function drainSpool() {
  const f = spoolFile();
  if (!fs.existsSync(f)) return;
  const tmp = f + '.draining';
  try { fs.renameSync(f, tmp); } catch { return; }
  for (const line of fs.readFileSync(tmp, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      db.prepare('INSERT INTO events(session_id, ts, kind, tool, target, body, agent_id) VALUES (?,?,?,?,?,?,?)')
        .run(...b([e.session_id, e.ts, e.kind, e.tool, e.target, e.body, e.agent_id]));
    } catch { /* drop malformed line */ }
  }
  fs.unlinkSync(tmp);
}

export const J = (v) => (v == null ? null : JSON.stringify(v));
export const P = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
