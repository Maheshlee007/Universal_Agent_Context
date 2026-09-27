#!/usr/bin/env node
// Universal Agent Context (UAC) entry point.
// node:sqlite prints an ExperimentalWarning on Node 22; silence it so hook/MCP stdout stays clean.
// (No top-level await: the single-executable build bundles this file as CommonJS.)
const emit = process.emitWarning;
process.emitWarning = (w, ...a) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...a));

import('../src/cli.mjs')
  .then(({ main }) => main(process.argv.slice(2)))
  .catch((e) => { console.error(`uac: ${e.message}`); process.exitCode = 1; });
