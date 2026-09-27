// Copies the core CLI (../bin, ../src, ../viewer) into extension/cli/ so the VSIX ships it.
// Missing folders are skipped, so packaging works before the CLI exists.
import { cpSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ext = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(ext, 'cli');
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const dir of ['bin', 'src', 'viewer']) {
  const from = join(ext, '..', 'plugin', dir);
  if (existsSync(from)) { cpSync(from, join(out, dir), { recursive: true }); console.log('bundled', dir); }
  else console.warn('skipped (missing)', dir);
}
