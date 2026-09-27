import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = 'D:/fake root/uac';

const fixtures = {
  codex: {
    hostEvent: 'PostToolUse',
    input: { session_id: 's1', cwd: '/w', transcript_path: '/t.jsonl', hook_event_name: 'PostToolUse',
      tool_name: 'shell', tool_input: { command: 'ls' }, tool_response: 'ok' },
    expect: { host: 'codex', event: 'tool', session_id: 's1', cwd: '/w', transcript_path: '/t.jsonl', tool: 'shell', tool_input: { command: 'ls' }, tool_response: 'ok' },
    context: (o) => o.hookSpecificOutput.additionalContext,
    stop: ['Stop', (o) => o.decision === 'block' && o.reason],
    seed: ['.codex/hooks.json', { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] } }],
  },
  gemini: {
    hostEvent: 'BeforeAgent',
    input: { session_id: 'g1', cwd: '/w', transcript_path: '/t', prompt: 'hi' },
    expect: { host: 'gemini', event: 'prompt', session_id: 'g1', cwd: '/w', transcript_path: '/t', prompt: 'hi' },
    context: (o) => o.hookSpecificOutput.additionalContext,
    stop: ['AfterAgent', (o) => o.decision === 'deny' && o.reason],
    seed: ['.gemini/settings.json', { theme: 'x', hooks: { BeforeAgent: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] } }],
  },
  antigravity: {
    hostEvent: 'PreInvocation',
    input: { invocationNum: 1, initialNumSteps: 0, conversationId: 'a1', workspacePaths: ['/w'], transcriptPath: '/t' },
    expect: { host: 'antigravity', event: 'prompt', session_id: 'a1', cwd: '/w', transcript_path: '/t' },
    context: (o) => o.injectSteps[0].userMessage,
    stop: ['Stop', (o) => o.decision === 'continue' && o.reason],
    seed: ['.gemini/config/hooks.json', { 'my-linter': { PostToolUse: [{ hooks: [{ type: 'command', command: 'lint.sh' }] }] } }],
  },
  cursor: {
    hostEvent: 'sessionStart',
    input: { conversation_id: 'c1', session_id: 'c1', workspace_roots: ['/w'], transcript_path: null, hook_event_name: 'sessionStart' },
    expect: { host: 'cursor', event: 'start', session_id: 'c1', cwd: '/w', source: 'startup' },
    context: (o) => o.additional_context,
    stop: ['stop', (o) => o.followup_message],
    seed: ['.cursor/hooks.json', { version: 1, hooks: { stop: [{ command: 'mine.sh' }] } }],
  },
  copilot: {
    hostEvent: 'sessionStart',
    input: { sessionId: 'p1', timestamp: 1, cwd: '/w', source: 'new', initialPrompt: 'go' },
    expect: { host: 'copilot', event: 'start', session_id: 'p1', cwd: '/w', source: 'new', prompt: 'go' },
    context: (o) => o.additionalContext,
    stop: ['agentStop', (o) => o.decision === 'block' && o.reason],
    seed: ['.copilot/hooks/mine.json', { version: 1, hooks: {} }],
  },
};

const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

for (const [host, fx] of Object.entries(fixtures)) {
  test(`${host} adapter`, async () => {
    const a = await import(`../plugin/src/adapters/${host}.mjs`);
    assert.equal(a.events[fx.hostEvent], fx.expect.event);

    const ev = a.normalize(fx.hostEvent, fx.input);
    assert.deepEqual(defined(ev), fx.expect);

    assert.equal(fx.context(a.format(ev, { context: 'CTX' })), 'CTX');
    assert.equal(a.format(ev, {}), null);
    const stopEv = a.normalize(fx.stop[0], {});
    assert.equal(stopEv.event, 'stop');
    assert.equal(fx.stop[1](a.format(stopEv, { block: 'keep going' })), 'keep going');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `uac-${host}-`));
    process.env.UAC_TEST_HOME = tmp;
    try {
      const seedFile = path.join(tmp, fx.seed[0]);
      fs.mkdirSync(path.dirname(seedFile), { recursive: true });
      fs.writeFileSync(seedFile, JSON.stringify(fx.seed[1]));

      const dry = a.install({ root, dryRun: true });
      assert.ok(dry.files.every((f) => !f.before || f.before === fs.readFileSync(f.path, 'utf8')));
      assert.ok(dry.files.some((f) => !fs.existsSync(f.path) || f.before !== f.after), 'dry run wrote nothing');

      const first = a.install({ root });
      const snap = first.files.map((f) => fs.readFileSync(f.path, 'utf8'));
      const second = a.install({ root });
      assert.deepEqual(second.files.map((f) => fs.readFileSync(f.path, 'utf8')), snap, 'install is idempotent');
      assert.ok(second.files.every((f) => f.before === f.after));

      const all = snap.join('\n');
      assert.match(all, new RegExp(`uac\\.mjs\\\\?" hook ${host} ${fx.hostEvent}`));
      assert.match(all, /uac\.mjs"[,\s]*"mcp"/);
      // foreign hooks survive
      const seedAfter = fs.readFileSync(seedFile, 'utf8');
      for (const s of ['mine.sh', 'lint.sh', '"theme"']) if (JSON.stringify(fx.seed[1]).includes(s)) assert.ok(seedAfter.includes(s), s);
    } finally {
      delete process.env.UAC_TEST_HOME;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}
