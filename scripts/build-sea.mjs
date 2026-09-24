#!/usr/bin/env node
// Build a Node single-executable `uac` for the current OS: dist/uac(.exe).
// Usage: node scripts/build-sea.mjs [rootDir]   (rootDir defaults to the repo root)
// esbuild and postject come via `npx --yes` (build-time only, needs network on first run).
import { execFileSync } from 'node:child_process';
import { copyFileSync, writeFileSync, readFileSync, mkdirSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const win = process.platform === 'win32', mac = process.platform === 'darwin';
const exeName = win ? 'uac.exe' : 'uac';
// npx args use relative paths on purpose: npx is a .cmd on Windows (needs a shell) and the repo path has spaces.
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: root, shell: win && cmd === 'npx', ...opts });

mkdirSync(join(root, 'dist'), { recursive: true });

// 1. Bundle ESM -> one CJS file (a SEA main script must be CJS on Node 22). node:* stays external.
run('npx', ['--yes', 'esbuild', 'bin/uac.mjs', '--bundle', '--platform=node', '--format=cjs', '--target=node22',
  '--external:node:*', '--supported:dynamic-import=false', '--define:import.meta.url=__uac_url',
  '--outfile=dist/uac.cjs']);

// Prelude: import.meta.url shim, and drop the node:sqlite ExperimentalWarning (emitted via process.emitWarning).
const prelude = `"use strict";var __uac_url=require("node:url").pathToFileURL(__filename).href;
{const w=process.emitWarning;process.emitWarning=function(m,t,...r){if((t==="ExperimentalWarning"||t?.type==="ExperimentalWarning")&&/SQLite/.test(m?.message??m))return;return w.call(this,m,t,...r)}}
`;
const cjs = join(root, 'dist/uac.cjs');
writeFileSync(cjs, prelude + readFileSync(cjs, 'utf8').replace(/^#!.*\n/, ''));

// 2. SEA blob. The viewer is embedded as an asset: require('node:sea').getAsset('viewer.html', 'utf8').
const viewer = join(root, 'viewer/viewer.html');
const cfg = join(root, 'dist/sea-config.json');
writeFileSync(cfg, JSON.stringify({
  main: cjs, output: join(root, 'dist/uac.blob'),
  disableExperimentalSEAWarning: true, useCodeCache: true,
  assets: existsSync(viewer) ? { 'viewer.html': viewer } : {},
}, null, 2));
run(process.execPath, ['--experimental-sea-config', cfg]);

// 3. Copy this node binary and inject the blob.
const exe = join(root, 'dist', exeName);
rmSync(exe, { force: true });
copyFileSync(process.execPath, exe);
if (!win) chmodSync(exe, 0o755);
if (mac) run('codesign', ['--remove-signature', exe]);
if (win) { try { run('signtool', ['remove', '/s', exe], { stdio: 'ignore' }); } catch { /* no signtool: optional */ } }
run('npx', ['--yes', 'postject', `dist/${exeName}`, 'NODE_SEA_BLOB', 'dist/uac.blob',
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', '--overwrite',
  ...(mac ? ['--macho-segment-name', 'NODE_SEA'] : [])]);
if (mac) run('codesign', ['--sign', '-', exe]);
console.log(`built ${exe}`);
