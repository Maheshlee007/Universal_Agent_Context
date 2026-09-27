// Static adapter registry (no computed imports, so the single-executable bundle can inline them).
import * as claude from './claude.mjs';
import * as codex from './codex.mjs';
import * as gemini from './gemini.mjs';
import * as antigravity from './antigravity.mjs';
import * as cursor from './cursor.mjs';
import * as copilot from './copilot.mjs';
export const adapters = { claude, codex, gemini, antigravity, cursor, copilot };
