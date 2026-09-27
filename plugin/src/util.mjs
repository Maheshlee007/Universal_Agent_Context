// Redaction, ignore globs, git helpers.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi,                    // scheme://user:PASS@
];
// key=value / key: value secrets. Code must survive: `verifyToken(token: string)`, `secret: env.JWT_SECRET`, `token = getToken()`.
const KEYVAL = /\b(password|passwd|pwd|secret|api[_-]?key|token|access[_-]?key)(\s*[:=]\s*)(["']?)([^\s"',;)}]{4,})/gi;
const CODE_VALUE = /^(string|number|boolean|null|undefined|any|unknown|object|void|never|true|false|[A-Z][A-Za-z0-9_]*(<.*)?|(process\.)?env\.\w+|\$\{.*|<.*|\w+\(.*|\w+\.\w+.*|\[REDACTED\])$/;
const PII = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
];

export function redact(text) {
  if (text == null) return text;
  let s = String(text).replace(/<private>[\s\S]*?<\/private>/gi, '[PRIVATE]');
  for (const re of SECRETS) s = s.replace(re, (m, keep) =>
    (typeof keep === 'string' && m.startsWith(keep) ? keep : '') + '[REDACTED]' + (m.endsWith('@') ? '@' : ''));
  s = s.replace(KEYVAL, (m, key, sep, q, val) => {
    if (CODE_VALUE.test(val)) return m;                                     // a type, env reference or call, not a secret
    if (!/^p(ass)?w/i.test(key) && val.length < 8) return m;                // token/secret values are long; passwords may not be
    return `${key}${sep}${q}[REDACTED]`;
  });
  for (const re of PII) s = s.replace(re, '[PII]');
  return s;
}

export const clip = (s, n) => (s == null ? s : (s = String(s)).length > n ? s.slice(0, n) + '…' : s);

// gitignore-style subset: *, **, ?, trailing / (dir), leading or inner / anchors; no negation.
export function globToRe(g) {
  const anchored = g.startsWith('/') || g.replace(/\/$/, '').includes('/');
  g = g.replace(/^\//, '');
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp((anchored ? '^' : '(?:^|/)') + re + '$', 'i');
}

const DEFAULT_IGNORE = ['.env*', '*.pem', '*.key', '**/secrets/**', '**/credentials/**', 'id_rsa*'];
const ignoreCache = new Map();
export function ignored(root, target) {
  if (!target || !root) return false;
  let res = ignoreCache.get(root);
  if (!res) {
    let lines = DEFAULT_IGNORE;
    try { lines = lines.concat(fs.readFileSync(path.join(root, '.uacignore'), 'utf8').split(/\r?\n/)); } catch {}
    res = lines.map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map(globToRe);
    ignoreCache.set(root, res);
  }
  const rel = path.relative(root, path.resolve(root, target)).split(path.sep).join('/');
  return res.some((re) => re.test(rel) || re.test(path.basename(rel)));
}

// Short-lived hook processes cache git answers (a SessionStart otherwise runs ~12 git commands).
let gitCache = null;
export const enableGitCache = () => { gitCache = new Map(); };
export function git(cwd, ...args) {
  const key = gitCache && [cwd, ...args].join('\u0000');
  if (key && gitCache.has(key)) return gitCache.get(key);
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 3000, windowsHide: true });
  const out = r.status === 0 ? r.stdout.trim() : '';
  if (key) gitCache.set(key, out);
  return out;
}

// Untrimmed stdout (file contents via `git show`), null on failure.
export function gitRaw(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 3000, windowsHide: true, maxBuffer: 16 << 20 });
  return r.status === 0 ? r.stdout : null;
}

export function gitInfo(cwd) {
  const [root, branch] = git(cwd, 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD').split(/\r?\n/);
  if (!root) return { root: path.resolve(cwd), branch: null, commit: null, remote: null };
  return {
    root: path.resolve(root),
    branch: branch && branch !== 'HEAD' ? branch : null,
    commit: git(cwd, 'rev-parse', '--short', 'HEAD') || null,
    remote: git(cwd, 'config', '--get', 'remote.origin.url') || null,
  };
}

export function defaultBranch(root) {
  const ref = git(root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  if (ref) return ref.replace(/^origin\//, '');
  for (const b of ['main', 'master', 'develop']) if (git(root, 'rev-parse', '--verify', '--quiet', b)) return b;
  return null;
}

export function changedFiles(root) {
  const out = git(root, 'status', '--porcelain');
  return out ? out.split('\n').map((l) => l.slice(3).trim().replace(/^"|"$/g, '')).filter(Boolean) : [];
}

export const tokens = (s) => Math.ceil((s || '').length / 4);

// The "what was touched" field of a tool call, across hosts' tool input shapes.
export function target(input = {}) {
  if (typeof input !== 'object' || !input) return null;
  return input.file_path ?? input.path ?? input.notebook_path ?? input.command ?? input.pattern ?? input.url ?? input.query ?? input.description ?? null;
}
