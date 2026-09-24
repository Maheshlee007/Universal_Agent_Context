// UAC VS Code extension: a thin UI shell over the `uac` CLI (--json). No storage code here.
const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');

let ext, statusItem, viewerProc, viewerUrlP, panel;
let current = null;              // last `uac status` result
let lastProposed = -1, lastSig = '', busy = false, asking = false;
const seen = new Set();          // session ids we already prompted for
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

const fail = (e) => vscode.window.showErrorMessage(`UAC: ${e.message || e}`);

// ---------- status bar + polling ----------
function render(st, err) {
  if (err) {
    statusItem.text = '$(warning) UAC';
    statusItem.tooltip = `UAC CLI not reachable: ${err.message}\nCheck uac.nodePath / uac.cliPath.`;
    return;
  }
  const cap = st?.session?.capture;
  statusItem.text = cap === 'on' ? '● UAC rec' : cap === 'paused' ? '❚❚ UAC paused' : cap === 'ask' ? 'UAC ask' : '○ UAC off';
  const c = st?.counts || {};
  statusItem.tooltip = `UAC · ${st?.project?.name || 'no project'} (${st?.project?.mode || '?'} mode)\n` +
    `session: ${st?.session?.id || 'none'}\n${c.active ?? 0} active · ${c.proposed ?? 0} proposed · ${c.conflict ?? 0} conflicts\nClick to toggle capture`;
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const st = await uac(['status']);
    current = st;
    render(st);
    const c = st?.counts || {};
    const proposed = c.proposed ?? 0;
    if (lastProposed >= 0 && proposed > lastProposed) {
      vscode.window.showInformationMessage(`UAC: ${proposed} proposal${proposed === 1 ? '' : 's'} to review`, 'Review')
        .then((a) => a && vscode.commands.executeCommand('uac.review'));
    }
    lastProposed = proposed;
    if (trees.review) trees.review.view.badge = proposed + (c.conflict ?? 0)
      ? { value: proposed + (c.conflict ?? 0), tooltip: `${proposed} proposed, ${c.conflict ?? 0} conflicts` } : undefined;
    const sig = JSON.stringify([c, st?.session]);
    if (sig !== lastSig) { lastSig = sig; refreshTrees(); }
    await checkNewSessions();
  } catch (e) {
    render(null, e);
  } finally { busy = false; }
}

// ---------- session-start QuickPick ----------
async function checkNewSessions() {
  if (asking) return;
  const list = await uac(['sessions', '--active']);
  if (!Array.isArray(list)) return;
  const fresh = list.filter((s) => s.capture === 'ask' && !seen.has(s.id));
  if (!fresh.length) return;
  fresh.forEach((s) => seen.add(s.id));   // prompt once; if ignored, the model asks as usual
  await chooseFlow(fresh);
}

const sessionLabel = (s) => ({ label: s.title || s.id, description: `${s.agent || '?'} · ${s.capture}`, detail: `started ${s.started_at || '?'} · ${s.id}`, s });

async function chooseFlow(sessions) {
  if (asking) return;
  asking = true;
  try {
    let s = sessions[0];
    if (sessions.length > 1) {
      const pick = await vscode.window.showQuickPick(sessions.map(sessionLabel), { title: 'UAC: which session?', ignoreFocusOut: true });
      if (!pick) return;
      s = pick.s;
    }
    const tier = await vscode.window.showQuickPick([
      { label: 'Minimal', description: '~1k tokens', v: 'minimal' },
      { label: 'Relevant', description: '~4k tokens', v: 'relevant' },
      { label: 'Deep', description: '~10k tokens', v: 'deep' },
      { label: 'Fork', description: 'continue from the last session', v: 'fork' },
      { label: 'None', description: 'start clean', v: 'none' },
    ], { title: `UAC: load context for ${s.agent || 'session'} ${s.title || s.id}`, ignoreFocusOut: true });
    if (!tier) return;
    const capture = await vscode.window.showQuickPick([
      { label: '● Capture on', v: 'on' },
      { label: '○ Capture off', v: 'off' },
    ], { title: 'UAC: capture this session?', ignoreFocusOut: true });
    if (!capture) return;
    await uac(['choose', '--tier', tier.v, '--capture', capture.v, '--session', s.id]);
    vscode.window.setStatusBarMessage(`UAC: ${tier.label} context, capture ${capture.v}`, 4000);
    lastSig = ''; tick();
  } catch (e) { fail(e); } finally { asking = false; }
}

// ---------- capture commands ----------
async function setCapture(state) {
  try {
    const sid = current?.session?.id;
    await uac(['capture', state, ...(sid ? ['--session', sid] : [])]);
    lastSig = ''; await tick();
  } catch (e) { fail(e); }
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

async function openViewer(hash) {
  try {
    const url = (await viewerUrl()) + (typeof hash === 'string' && hash ? `#${hash}` : '');
    if (!panel) {
      panel = vscode.window.createWebviewPanel('uac.viewer', 'UAC Viewer', vscode.ViewColumn.Active,
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

function memoryItem(m) {
  const t = new vscode.TreeItem(m.title || m.id);
  t.description = m.status === 'active' ? m.type : `${m.type} · ${m.status}`;
  t.tooltip = `${m.title}\n${m.type} · ${m.status} · ${m.id}`;
  t.iconPath = new vscode.ThemeIcon(m.status === 'conflict' ? 'warning' : m.status === 'proposed' ? 'lightbulb' : 'note');
  t.command = { command: 'uac.openViewer', title: 'Open', arguments: ['memories'] };
  return t;
}

const searchAll = async () => { const r = await uac(['search', '']); return Array.isArray(r) ? r : []; };

async function loadMemories() {
  const groups = {};
  for (const m of await searchAll()) (groups[m.type || 'other'] ||= []).push(m);
  const keys = Object.keys(groups).sort();
  if (!keys.length) return [new vscode.TreeItem('No memories yet')];
  return keys.map((k) => {
    const t = new vscode.TreeItem(k, vscode.TreeItemCollapsibleState.Collapsed);
    t.description = String(groups[k].length);
    t.iconPath = new vscode.ThemeIcon('folder');
    t.children = groups[k].map(memoryItem);
    return t;
  });
}

async function loadReview() {
  const items = (await searchAll()).filter((m) => m.status === 'proposed' || m.status === 'conflict');
  return items.length ? items.map(memoryItem) : [new vscode.TreeItem('Nothing to review')];
}

async function loadSessions() {
  const list = await uac(['sessions']);
  if (!Array.isArray(list) || !list.length) return [new vscode.TreeItem('No sessions yet')];
  return list.map((s) => {
    const t = new vscode.TreeItem(s.title || s.id);
    t.description = `${s.agent || '?'} · ${s.capture}${s.unsaved ? ` · ${s.unsaved} unsaved` : ''}`;
    t.tooltip = `${s.id}\n${s.status} · started ${s.started_at}`;
    t.iconPath = new vscode.ThemeIcon(s.capture === 'on' ? 'record' : s.capture === 'paused' ? 'debug-pause' : 'circle-outline');
    if (s.status === 'active') t.command = { command: 'uac.chooseContext', title: 'Choose context', arguments: [s] };
    return t;
  });
}

function refreshTrees() { Object.values(trees).forEach((t) => t.refresh()); }

// ---------- install ----------
const HOSTS = ['claude', 'codex', 'gemini', 'antigravity', 'cursor', 'copilot'];
async function install() {
  const picks = await vscode.window.showQuickPick(HOSTS, { canPickMany: true, title: 'UAC: register hooks + MCP for which agents?' });
  if (!picks?.length) return;
  for (const h of picks) {
    try { await uac(['install', h]); vscode.window.showInformationMessage(`UAC: installed for ${h}`); }
    catch (e) { fail(new Error(`${h}: ${e.message}`)); }
  }
}

// ---------- lifecycle ----------
function activate(context) {
  ext = context;
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = 'uac.toggleCapture';
  statusItem.text = '○ UAC';
  statusItem.show();

  for (const [key, load] of [['memories', loadMemories], ['review', loadReview], ['sessions', loadSessions]]) {
    const tree = new Tree(load);
    tree.view = vscode.window.createTreeView(`uac.${key}`, { treeDataProvider: tree });
    trees[key] = tree;
    context.subscriptions.push(tree.view);
  }

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('uac.toggleCapture', () => setCapture(current?.session?.capture === 'on' ? 'paused' : 'on'));
  reg('uac.pause', () => setCapture('paused'));
  reg('uac.resume', () => setCapture('on'));
  reg('uac.stop', () => setCapture('off'));
  reg('uac.chooseContext', async (s) => {
    if (s?.id) return chooseFlow([s]);
    try {
      const list = await uac(['sessions', '--active']);
      if (!Array.isArray(list) || !list.length) return vscode.window.showInformationMessage('UAC: no active sessions in this workspace');
      chooseFlow(list);
    } catch (e) { fail(e); }
  });
  reg('uac.openViewer', (hash) => openViewer(hash));
  reg('uac.review', () => openViewer('review'));
  reg('uac.refresh', () => { lastSig = ''; refreshTrees(); tick(); });
  reg('uac.install', install);

  const timer = setInterval(tick, 3000);
  context.subscriptions.push(statusItem, { dispose: () => clearInterval(timer) },
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('uac') && vscode.commands.executeCommand('uac.refresh')));
  tick();

  if (!context.globalState.get('uac.offeredInstall')) {
    context.globalState.update('uac.offeredInstall', true);
    vscode.window.showInformationMessage('UAC: register capture hooks + MCP for your coding agents?', 'Install…')
      .then((a) => a && install());
  }
}

function deactivate() {
  if (viewerProc) { try { viewerProc.kill(); } catch {} viewerProc = undefined; }
}

module.exports = { activate, deactivate };
