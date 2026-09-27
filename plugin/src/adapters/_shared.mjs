// Shared install helpers for host adapters. Zero deps.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const home = () => process.env.UAC_TEST_HOME || os.homedir();

// Matches any command UAC ever registered: `... uac.mjs" hook <host> <Event>` or `... uac.mjs" mcp`.
export const UAC_RE = /uac(\.mjs|\.exe)?["']?\s+(hook|mcp)\b/;

export const hookCmd = ({ root, uacCmd }, host, event) =>
  `${uacCmd || `node "${root}/bin/uac.mjs"`} hook ${host} ${event}`;

// single-executable build: uacCmd is the quoted exe path, run it directly
export const mcpServer = ({ root, uacCmd }) => uacCmd && !uacCmd.startsWith('node ')
  ? { command: uacCmd.replace(/^"|"$/g, ''), args: ['mcp'] }
  : { command: 'node', args: [`${root}/bin/uac.mjs`, 'mcp'] };

export function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Apply `edit(text|null) -> text` to a file. Returns {path, before, after}; writes only when changed and not dryRun.
export function editText(file, edit, dryRun) {
  const before = readText(file);
  const after = edit(before);
  if (!dryRun && after !== before) writeAtomic(file, after);
  return { path: file, before, after };
}

// JSON variant. A corrupt existing file throws (JSON.parse) rather than being overwritten.
export const editJson = (file, mutate, dryRun) =>
  editText(file, (before) => {
    const obj = before && before.trim() ? JSON.parse(before) : {};
    mutate(obj);
    return JSON.stringify(obj, null, 2) + '\n';
  }, dryRun);

// Claude-style nesting: hooks[Event] = [{matcher?, hooks:[{type:'command', command}]}].
// Drops previous uac entries (so a moved root is updated), keeps everything else, appends ours.
export function mergeNested(hooks, event, command, extra = {}) {
  const groups = [];
  for (const g of hooks[event] || []) {
    const kept = (g.hooks || []).filter((h) => !UAC_RE.test(h.command || ''));
    if (kept.length || !(g.hooks || []).length) groups.push({ ...g, hooks: kept });
  }
  groups.push({ hooks: [{ type: 'command', command, ...extra }] });
  hooks[event] = groups;
}
