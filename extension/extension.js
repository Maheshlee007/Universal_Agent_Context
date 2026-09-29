// UAC VS Code extension: a thin UI shell over the `uac` CLI (--json). No storage code here.
// v0.3: no session-start questions (the hook loads context itself); the UI is session-centric.
const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let ext, statusItem, viewerProc, viewerUrlP, panel;
let current = null;              // last `uac status` result
let lastProposed = -1, lastSig = '', busy = false;
let seenMsgs = null;             // message ids already shown (null = not seeded yet)
let emptyCount = 0, showRolled = false;
const trees = {};

const cfg = () => vscode.workspace.getConfiguration('uac');
const nodePath = () => cfg().get('nodePath') || 'node';
const cliPath = () => cfg().get('cliPath') || path.join(ext.extensionPath, 'cli', 'bin', 'uac.mjs');
const cwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
const cwdArgs = () => (cwd() ? ['--cwd', cwd()] : []);

// Run `uac <args> --json --cwd <ws>`; resolves parsed JSON (or raw text if the command printed non-JSON).
function uac(args) {
  return new Promise((resolve, reject) => {
    cp.execFile(nodePath(), [cliPath(), ...args, '--json', ...cwdArgs()],
      { timeout: 20000, maxBuffer: 32 << 20, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join(' ')));
        try { resolve(JSON.parse(stdout)); } catch { resolve(stdout.trim()); }
      });
  });
}
const list = async (args) => { const r = await uac(args); return Array.isArray(r) ? r : []; };

const fail = (e) => vscode.window.showErrorMessage(`UAC: ${e.message || e}`);
const kick = () => { lastSig = ''; tick(); };

function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!(s >= 0)) return '?';
  for (const [n, u] of [[86400, 'd'], [3600, 'h'], [60, 'm']]) if (s >= n) return `${Math.floor(s / n)}${u} ago`;
  return 'just now';
}
const sessTitle = (s) => `#${s.n ?? '-'} ${s.short || s.id.slice(0, 8)} ${s.card?.title || s.title || ''}`.trim();
const sessDesc = (s) => [s.branch, s.agent, ago(s.ended_at || s.started_at)].filter(Boolean).join(' · ');

// ---------- status bar + polling ----------
// The plugin version Claude Code has installed when it differs from this bundle (the file util.mjs reads; the extension
// must not import plugin code at load).
function claudeSkew() {
  try {
    const l = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8')).plugins?.['universal-agent-context@uac'] || [];
    const v = (l.find((x) => x.scope === 'user') || l[0])?.version;
    return v && v !== ext.extension.packageJSON.version ? v : null;
  } catch { return null; }
}
function render(st, err) {
  if (err) {
    statusItem.text = '$(warning) UAC';
    statusItem.tooltip = `UAC CLI not reachable: ${err.message}\nCheck uac.nodePath / uac.cliPath.`;
    return;
  }
  const mode = st?.project?.mode, cap = st?.session?.capture, v = ext.extension.packageJSON.version, inst = claudeSkew();
  statusItem.text = inst ? `$(warning) UAC ${v} ≠ Claude ${inst}` : mode === 'off' ? `UAC ${v} off` : cap === 'on' ? `● UAC ${v} rec` : `○ UAC ${v}`;
  const c = st?.counts || {};
  statusItem.tooltip = (inst ? `UAC ${v} (this extension) ≠ Claude Code plugin ${inst}. VS Code windows need Reload Window; open Claude Code sessions need /reload-plugins.\n` : '') +
    `UAC ${v} · ${st?.project?.name || 'no project'} (${mode || 'mode not set'})\n` +
    `session: ${st?.session?.id || 'none'} · recording ${cap === 'on' ? 'on' : 'off'}\n` +
    `${c.active ?? 0} active · ${c.proposed ?? 0} proposed · ${c.stale ?? 0} stale · ${c.conflict ?? 0} conflicts\n` +
    (emptyCount ? `${emptyCount} empty session${emptyCount === 1 ? '' : 's'} (click → Delete empty)\n` : '') + 'Click for actions';
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const st = await uac(['status']);
    current = st;
    render(st);
    const c = st?.counts || {};
    const proposed = c.proposed ?? 0, todo = proposed + (c.conflict ?? 0) + (c.stale ?? 0);
    if (lastProposed >= 0 && proposed > lastProposed) {
      vscode.window.showInformationMessage(`UAC: ${proposed} proposal${proposed === 1 ? '' : 's'} to review`, 'Review')
        .then((a) => a && openViewer('review'));
    }
    lastProposed = proposed;
    if (trees.review) trees.review.view.badge = todo ? { value: todo, tooltip: `${todo} items need a decision` } : undefined;
    const sig = JSON.stringify([c, st?.session, st?.project?.mode]);
    if (sig !== lastSig) {
      lastSig = sig; refreshTrees();
      try { emptyCount = (await list(['sessions'])).filter((s) => s.empty).length; render(st); } catch { /* keep last count */ }
    }
  } catch (e) {
    render(null, e);
  } finally { busy = false; }
}

// ---------- messages ----------
async function pollMessages() {
  let msgs;
  try { msgs = await list(['msgs']); } catch { return; }   // older CLI or transient error: stay quiet
  const fresh = msgs.filter((m) => m.id && !seenMsgs?.has(m.id));
  const first = !seenMsgs;
  seenMsgs ||= new Set();
  fresh.forEach((m) => seenMsgs.add(m.id));
  if (first) return;   // don't replay history on activation
  for (const m of fresh.filter((m) => !current?.session?.id || m.from_session !== current.session.id)) {
    const from = [m.from_agent, m.from_branch].filter(Boolean).join(' @ ') || 'another session';
    vscode.window.showInformationMessage(`UAC message from ${from}: ${m.text}`, 'Open')
      .then((a) => a && openViewer('messages'));
  }
}

async function sendMessage() {
  const text = await vscode.window.showInputBox({ title: 'UAC: message to other sessions', prompt: 'Text', ignoreFocusOut: true });
  if (!text) return;
  const b = current?.project?.branch;
  const to = await vscode.window.showQuickPick([
    { label: 'All sessions', v: 'all' },
    ...(b ? [{ label: `Sessions on branch ${b}`, v: `branch:${b}` }] : []),
  ], { title: 'UAC: send to', ignoreFocusOut: true });
  if (!to) return;
  try {
    const m = await uac(['msg', text, '--to', to.v]);
    if (m?.id) seenMsgs?.add(m.id);
    vscode.window.setStatusBarMessage(`UAC: message sent to ${to.v}`, 4000);
  } catch (e) { fail(e); }
}

// ---------- continue from session (next) ----------
async function continueFrom(ids) {
  try {
    if (!ids) {
      const sessions = await list(['sessions']);
      const items = [
        { label: 'Default (latest on this branch)', clear: true },
        ...sessions.map((s) => ({
          label: sessTitle(s), description: sessDesc(s),
          detail: s.card ? (s.card.body || s.card.title || '').split('\n')[0] : 'no card yet',
          picked: !!s.next, s,
        })),
      ];
      const picks = await vscode.window.showQuickPick(items, { canPickMany: true, title: 'UAC: continue from which sessions (next session loads their cards)?', ignoreFocusOut: true });
      if (!picks?.length) return;
      ids = picks.some((p) => p.clear) ? [] : picks.map((p) => p.s.id);
    }
    await uac(ids.length ? ['next', ...ids] : ['next', '--clear']);
    vscode.window.setStatusBarMessage(`UAC: next session → ${ids.length ? `${ids.length} session card(s)` : 'default'}`, 4000);
    refreshTrees();
  } catch (e) { fail(e); }
}

// ---------- delete ----------
async function deleteSession(s) {
  if (!s?.id) return;
  let detail = 'Delete session and its events/card/memories?';
  // `rm --dry-run` returns exact cascade counts without deleting.
  try {
    const i = (await uac(['rm', s.id, '--dry-run']))?.impact?.[0];
    if (i) detail = `This removes ${i.events} events, ${i.summaries} summaries, ${i.checkpoints} checkpoints and ${i.memories} memories created by this session.`;
  } catch { /* keep the generic text */ }
  const ok = await vscode.window.showWarningMessage(`Delete ${sessTitle(s)}?`, { modal: true, detail }, 'Delete');
  if (ok !== 'Delete') return;
  try { await uac(['rm', s.id, '--yes']); refreshTrees(); } catch (e) { fail(e); }
}

async function deleteEmpty() {
  try {
    const r = await uac(['rm', '--empty']);
    vscode.window.showInformationMessage(`UAC: removed ${r?.deleted ?? 0} empty session(s)`);
    refreshTrees();
  } catch (e) { fail(e); }
}

// ---------- rename / merge / roll up (v0.3.2) ----------
// `--opt=value` form: parses as a string even on CLI builds that don't declare the option.
async function renameSession(s) {
  if (!s?.id) return;
  const t = await vscode.window.showInputBox({ title: `UAC: rename ${sessTitle(s)}`, value: s.card?.title || s.title || '', ignoreFocusOut: true });
  if (!t?.trim()) return;
  try { await uac(['name', t.trim(), `--session=${s.id}`]); refreshTrees(); } catch (e) { fail(e); }
}

async function mergeSession(s) {
  if (!s?.id) return;
  try {
    const items = (await list(['sessions'])).filter((x) => x.id !== s.id && !x.rolled_into)
      .map((x) => ({ label: sessTitle(x), description: sessDesc(x), x }));
    const to = await vscode.window.showQuickPick(items, { title: `UAC: merge ${sessTitle(s)} into…`, ignoreFocusOut: true });
    if (!to) return;
    const ok = await vscode.window.showWarningMessage(`Merge ${sessTitle(s)} into ${sessTitle(to.x)}?`,
      { modal: true, detail: 'Its events, cards and memories move to the target; the emptied session is deleted.' }, 'Merge');
    if (ok !== 'Merge') return;
    await uac(['merge', s.id, `--into=${to.x.id}`]);
    refreshTrees();
  } catch (e) { fail(e); }
}

async function rollupSessions() {
  try {
    const b = current?.project?.branch;
    const sessions = (await list(['sessions'])).filter((x) => !x.rolled_into && !x.empty);
    const picks = await vscode.window.showQuickPick([
      ...(b ? [{ label: `$(git-branch) All on this branch (${b})`, all: true }] : []),
      ...sessions.map((x) => ({ label: sessTitle(x), description: sessDesc(x), x })),
    ], { canPickMany: true, title: 'UAC: roll up which sessions into one new card?', ignoreFocusOut: true });
    if (!picks?.length) return;
    const r = await uac(picks.some((p) => p.all) ? ['rollup', '--all', `--branch=${b}`] : ['rollup', ...picks.filter((p) => p.x).map((p) => p.x.id)]);
    refreshTrees();
    const n = r?.n ?? (await list(['sessions'])).find((x) => x.id === r?.session_id)?.n ?? r?.session_id ?? '<n>';
    vscode.window.showInformationMessage(r?.how ? `UAC: ${r.how} (or let automatic mode refine it)`
      : `UAC: Rollup session created. In your chat type: #uac save ${n} (or let automatic mode refine it)`);
  } catch (e) { fail(e); }
}

function setShowRolled(v) {
  showRolled = v;
  vscode.commands.executeCommand('setContext', 'uac.showRolled', v);
  trees.sessions?.refresh();
}

// ---------- status-bar menu ----------
async function setMode() {
  const m = await vscode.window.showQuickPick([
    { label: 'off', description: 'no context loaded, nothing recorded' },
    { label: 'manual', description: 'loads context; records only after #uac on' },
    { label: 'automatic', description: 'loads context and records' },
  ], { title: `UAC mode (now: ${current?.project?.mode || 'not set'})` });
  if (!m) return;
  try { await uac(['mode', m.label]); kick(); } catch (e) { fail(e); }
}

async function setCapture(state) {
  try {
    const sid = current?.session?.id;
    await uac(['capture', state, ...(sid ? ['--session', sid] : [])]);
    kick();
  } catch (e) { fail(e); }
}
const toggleCapture = () => setCapture(current?.session?.capture === 'on' ? 'off' : 'on');

async function menu() {
  const rec = current?.session?.capture === 'on';
  const inst = claudeSkew();
  const actions = [
    ...(inst ? [{ label: '$(refresh) Reload Window', description: `UAC ${ext.extension.packageJSON.version} ≠ Claude ${inst}`, run: () => vscode.commands.executeCommand('workbench.action.reloadWindow') }] : []),
    { label: rec ? '$(debug-stop) Stop recording' : '$(record) Start recording', run: toggleCapture },
    { label: '$(save) Save now', description: 'type #uac save in chat', run: () =>
      vscode.window.showInformationMessage('UAC: type "#uac save" in the agent chat. The agent runs the compressor; the extension cannot.') },
    { label: '$(debug-continue) Continue from session…', run: () => continueFrom() },
    { label: '$(fold) Roll up sessions…', run: rollupSessions },
    { label: '$(link-external) Open dashboard', run: () => openViewer() },
    { label: '$(settings-gear) Mode: off / manual / automatic', description: current?.project?.mode || 'not set', run: setMode },
    { label: '$(trash) Delete empty sessions', run: deleteEmpty },
  ];
  const a = await vscode.window.showQuickPick(actions, { title: 'UAC' });
  if (a) a.run();
}

// ---------- viewer ----------
function viewerUrl() {
  if (viewerUrlP) return viewerUrlP;
  viewerUrlP = new Promise((resolve, reject) => {
    const p = cp.spawn(nodePath(), [cliPath(), 'view', '--no-open', '--port', '0', ...cwdArgs()], { windowsHide: true });
    viewerProc = p;
    let buf = '', errBuf = '';
    const timer = setTimeout(() => { reject(new Error('viewer did not print its URL within 15s')); p.kill(); }, 15000);
    p.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/https?:\/\/[^\s"']+/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    });
    p.stderr.on('data', (d) => { errBuf += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`viewer exited (${code}) ${errBuf.trim().slice(-300)}`));
      viewerProc = undefined; viewerUrlP = undefined;
    });
  });
  viewerUrlP.catch(() => { viewerUrlP = undefined; });
  return viewerUrlP;
}

// Native confirm()/alert() are no-ops inside webviews; the viewer uses inline two-step buttons instead.
async function openViewer(hash) {
  try {
    const url = (await viewerUrl()) + (typeof hash === 'string' && hash ? `#${hash}` : '');
    if (!panel) {
      panel = vscode.window.createWebviewPanel('uac.viewer', 'UAC Dashboard', vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true });
      panel.iconPath = vscode.Uri.joinPath(ext.extensionUri, 'media', 'uac.svg');
      panel.onDidDispose(() => { panel = undefined; });
    } else panel.reveal();
    const esc = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    panel.webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:* http://localhost:*; style-src 'unsafe-inline';">
<style>html,body{margin:0;padding:0;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100vh;display:block}</style>
</head><body><iframe src="${esc}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"></iframe></body></html>`;
  } catch (e) { fail(e); }
}

// ---------- tree views ----------
class Tree {
  constructor(load) { this.load = load; this.ev = new vscode.EventEmitter(); this.onDidChangeTreeData = this.ev.event; }
  refresh() { this.ev.fire(); }
  getTreeItem(n) { return n; }
  async getChildren(n) {
    if (n) return n.children || [];
    try { return await this.load(); }
    catch (e) { const t = new vscode.TreeItem(`CLI error: ${e.message}`); t.iconPath = new vscode.ThemeIcon('warning'); return [t]; }
  }
}

const FRESH = { verified: '✓ ', changed: '⚠ ', missing: '✗ ' };
const needsDecision = (m) => ['proposed', 'conflict', 'stale'].includes(m.status) || ['changed', 'missing'].includes(m.freshness?.state);

function memoryItem(m) {
  const t = new vscode.TreeItem(`${FRESH[m.freshness?.state] || ''}${m.title || m.id}`);
  t.description = [m.status !== 'active' && m.status, m.pinned && 'pinned', m.muted && 'muted'].filter(Boolean).join(' · ');
  t.tooltip = `${m.title}\n${m.type} · ${m.status} · ${m.id}` +
    (m.freshness ? `\nfreshness: ${m.freshness.state}${m.freshness.commits_since ? ` (${m.freshness.commits_since} commits since)` : ''}` : '');
  t.iconPath = new vscode.ThemeIcon(m.status === 'conflict' ? 'warning' : m.status === 'proposed' ? 'lightbulb' : 'note');
  t.command = { command: 'uac.openViewer', title: 'Open', arguments: [`memories/${m.id}`] };
  return t;
}

const memories = () => list(['search', '']);

async function loadKnowledge() {
  const groups = {};
  for (const m of await memories()) (groups[m.type || 'other'] ||= []).push(m);
  const keys = Object.keys(groups).sort();
  if (!keys.length) return [new vscode.TreeItem('No project knowledge yet')];
  return keys.map((k) => {
    const t = new vscode.TreeItem(k, vscode.TreeItemCollapsibleState.Collapsed);
    t.description = String(groups[k].length);
    t.iconPath = new vscode.ThemeIcon('folder');
    t.children = groups[k].map(memoryItem);
    return t;
  });
}

async function loadReview() {
  const items = (await memories()).filter(needsDecision);
  return items.length ? items.map(memoryItem) : [new vscode.TreeItem('Nothing needs a decision')];
}

async function loadSessions() {
  const sessions = (await list(showRolled ? ['sessions', '--all'] : ['sessions'])).filter((s) => showRolled || !s.rolled_into);
  emptyCount = sessions.filter((s) => s.empty).length;
  if (!sessions.length) return [new vscode.TreeItem('No sessions yet')];
  return sessions.map((s) => {
    const t = new vscode.TreeItem(sessTitle(s));
    t.description = s.empty ? '(empty, can delete)'
      : [s.branch, s.agent, s.next && 'next', s.rolled_into && `rolled into ${s.rolled_into}`].filter(Boolean).join(' · ');
    t.tooltip = `${s.id}\n${s.status} · started ${s.started_at}${s.card ? `\n\n${s.card.body || ''}` : '\nno card yet'}`;
    t.iconPath = s.empty ? new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'))
      : new vscode.ThemeIcon(s.capture === 'on' ? 'record' : s.rolled_into ? 'fold' : s.card ? 'note' : 'circle-outline');
    t.contextValue = s.empty ? 'session.empty' : 'session';
    t.session = s;
    t.command = { command: 'uac.openViewer', title: 'Open session', arguments: [`sessions/${s.id}`] };
    return t;
  });
}

function refreshTrees() { Object.values(trees).forEach((t) => t.refresh()); }

// ---------- install ----------
async function install() {
  try {
    // { host: 'not found' | {ok:true, files, commands} | {ok:false, error} | string }
    const r = await uac(['install']);
    const detail = r && typeof r === 'object'
      ? Object.entries(r).map(([h, v]) => `${h}: ${typeof v === 'string' ? v : v?.ok ? `installed${v.files?.length ? ` (${v.files.join(', ')})` : ''}` : `failed: ${v?.error || '?'}`}`).join('\n')
      : String(r);
    vscode.window.showInformationMessage('UAC: install for detected tools', { modal: true, detail });
    ext.globalState.update('uac.installedVersion', ext.extension.packageJSON.version);
  } catch (e) { fail(e); }
}

// Hook/MCP entries point at this extension's versioned folder; after an update, re-point them silently.
async function reinstallIfUpdated(context) {
  const was = context.globalState.get('uac.installedVersion');
  const now = context.extension.packageJSON.version;
  if (!was || was === now) return;
  let r;
  try { r = await uac(['install']); context.globalState.update('uac.installedVersion', now); } catch { return; /* keep old paths; user can run UAC: Install */ }
  if (r?.claude?.kept) return; // a same-or-newer UAC was already registered for Claude Code: nothing changed there, no reload needed
  // running Claude Code sessions keep the old hooks/MCP server until reloaded: offer it instead of leaving them stale
  const a = await vscode.window.showInformationMessage(`UAC updated to ${now}. Reload the window so open Claude Code sessions use it (or type /reload-plugins in each).`, 'Reload Window');
  if (a) vscode.commands.executeCommand('workbench.action.reloadWindow');
}

// ---------- lifecycle ----------
function activate(context) {
  ext = context;
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = 'uac.menu';
  statusItem.text = `○ UAC ${context.extension.packageJSON.version}`;
  statusItem.show();

  for (const [key, load] of [['knowledge', loadKnowledge], ['review', loadReview], ['sessions', loadSessions]]) {
    const tree = new Tree(load);
    tree.view = vscode.window.createTreeView(`uac.${key}`, { treeDataProvider: tree });
    trees[key] = tree;
    context.subscriptions.push(tree.view);
  }

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('uac.menu', menu);
  reg('uac.toggleCapture', toggleCapture);
  reg('uac.setMode', setMode);
  reg('uac.continueFrom', (item) => continueFrom(item?.session ? [item.session.id] : undefined));
  reg('uac.openSession', (item) => item?.session && openViewer(`sessions/${item.session.id}`));
  reg('uac.deleteSession', (item) => deleteSession(item?.session));
  reg('uac.deleteEmpty', deleteEmpty);
  reg('uac.renameSession', (item) => renameSession(item?.session));
  reg('uac.mergeSession', (item) => mergeSession(item?.session));
  reg('uac.rollup', rollupSessions);
  reg('uac.showRolled', () => setShowRolled(true));
  reg('uac.hideRolled', () => setShowRolled(false));
  reg('uac.sendMessage', sendMessage);
  reg('uac.openViewer', (hash) => openViewer(hash));
  reg('uac.review', () => openViewer('review'));
  reg('uac.refresh', () => { refreshTrees(); kick(); });
  reg('uac.install', install);

  const timer = setInterval(tick, 3000);
  const msgTimer = setInterval(pollMessages, 10000);
  context.subscriptions.push(statusItem, { dispose: () => { clearInterval(timer); clearInterval(msgTimer); } },
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('uac') && vscode.commands.executeCommand('uac.refresh')));
  tick();
  pollMessages();
  reinstallIfUpdated(context);

  if (!context.globalState.get('uac.offeredInstall')) {
    context.globalState.update('uac.offeredInstall', true);
    vscode.window.showInformationMessage('UAC: register capture hooks + MCP for the coding tools on this machine?', 'Install')
      .then((a) => a && install());
  }
}

function deactivate() {
  if (viewerProc) { try { viewerProc.kill(); } catch {} viewerProc = undefined; }
}

module.exports = { activate, deactivate };
