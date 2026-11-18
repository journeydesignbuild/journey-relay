// Journey Relay — main process
const { app, BrowserWindow, ipcMain, clipboard, Menu, WebContentsView, shell } = require('electron');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Look like regular Chrome so sites allow sign-in
app.userAgentFallback = app.userAgentFallback
  .replace(/\sElectron\/\S+/, '')
  .replace(/\s\S+\/[\d.]+(?= Chrome\/)/, '');

const FRAMEWORK = `RELAY RULES — follow exactly in every reply.
You are {ME}, working with {OTHER} (another AI) and Justin (the user).
Your replies are copied word-for-word to {OTHER}, and {OTHER}'s replies are copied to you.
{OTHER} only receives the text of your reply, plus any files you share with a file block.

Format EVERY reply exactly like this, in plain text:

{ME} RESPONSE 001 START
(your work)
{ME} RESPONSE 001 END

{ME} REQUESTS {OTHER}
(what you need from {OTHER} next, usually a review. Write NONE if the work is done.)

USER REQUEST
(questions or clarifications for Justin. Write NONE if nothing.)

END OF TURN

Sharing files:
To share a file (code, HTML, CSV, a document), put the COMPLETE file inside a file block, inside your response:
FILE START: filename.ext
(entire file contents)
FILE END
The app saves it to Justin's Google Drive and attaches it for {OTHER}. Files {OTHER} shares arrive as attachments.

Rules:
- Number your responses 001, 002, 003 and so on, counting up each reply.
- Do NOT use downloads, canvas, artifacts or links: {OTHER} cannot see them. Use file blocks instead.
- Text under USER RESPONSE is Justin's answer to an earlier question. Use it.
- If you are only waiting for Justin and need nothing from {OTHER}, write NONE under {ME} REQUESTS {OTHER}. The relay then pauses until Justin answers. Don't send "nothing to do" messages back and forth.
- When the task is finished and you agree with {OTHER}, write SESSION COMPLETE on its own line right before END OF TURN.
- Always finish with END OF TURN.`;
const OLD_FRAMEWORKS = [`RELAY RULES — follow exactly in every reply.
You are {ME}, working with {OTHER} (another AI) and Justin (the user).
Your replies are copied word-for-word to {OTHER}, and {OTHER}'s replies are copied to you.
{OTHER} only receives the text of your reply, plus any files you share with a file block.

Format EVERY reply exactly like this, in plain text:

{ME} RESPONSE 001 START
(your work)
{ME} RESPONSE 001 END

{ME} REQUESTS {OTHER}
(what you need from {OTHER} next, usually a review. Write NONE if the work is done.)

USER REQUEST
(questions or clarifications for Justin. Write NONE if nothing.)

END OF TURN

Sharing files:
To share a file (code, HTML, CSV, a document), put the COMPLETE file inside a file block, inside your response:
FILE START: filename.ext
(entire file contents)
FILE END
The app saves it to Justin's Google Drive and attaches it for {OTHER}. Files {OTHER} shares arrive as attachments.

Rules:
- Number your responses 001, 002, 003 and so on, counting up each reply.
- Do NOT use downloads, canvas, artifacts or links: {OTHER} cannot see them. Use file blocks instead.
- Text under USER RESPONSE is Justin's answer to an earlier question. Use it.
- When the task is finished and you agree with {OTHER}, write SESSION COMPLETE on its own line right before END OF TURN.
- Always finish with END OF TURN.`, `RELAY RULES — follow exactly in every reply.
You are {ME}, working with {OTHER} (another AI) and Justin (the user).
Your replies are copied word-for-word to {OTHER}, and {OTHER}'s replies are copied to you.
{OTHER} only receives the text of your reply.

Format EVERY reply exactly like this, in plain text:

{ME} RESPONSE 001 START
(your work)
{ME} RESPONSE 001 END

{ME} REQUESTS {OTHER}
(what you need from {OTHER} next, usually a review. Write NONE if the work is done.)

USER REQUEST
(questions or clarifications for Justin. Write NONE if nothing.)

END OF TURN

Rules:
- Number your responses 001, 002, 003 and so on, counting up each reply.
- Put ALL content directly in the reply text, including complete code. Do NOT use files, downloads, canvas, artifacts, attachments or links: {OTHER} cannot see them.
- Text under USER RESPONSE is Justin's answer to an earlier question. Use it.
- When the task is finished and you agree with {OTHER}, write SESSION COMPLETE on its own line right before END OF TURN.
- Always finish with END OF TURN.`, `RELAY RULES — follow exactly in every reply.
You are {ME}, working with {OTHER} (another AI) and Justin (the user).
Your replies are copied word-for-word to {OTHER}, and {OTHER}'s replies are copied to you.

Format EVERY reply exactly like this, in plain text:

{ME} RESPONSE ### START
(your work)
{ME} RESPONSE ### END

{ME} REQUESTS {OTHER}
(what you need from {OTHER} next, usually a review. Write NONE if the work is done.)

USER REQUEST
(questions or clarifications for Justin. Write NONE if nothing.)

END OF TURN

Rules:
- Number your responses 001, 002, 003 and so on, in order.
- Text under USER RESPONSE is Justin's answer to an earlier question. Use it.
- When the task is finished and you agree with {OTHER}, write SESSION COMPLETE on its own line right before END OF TURN.
- Always finish with END OF TURN.`];

const DEFAULTS = {
  apiKey: '',
  apiBase: 'https://api.anthropic.com',
  modModel: 'claude-opus-5-5',
  sumModel: 'claude-haiku-5-5',
  urls: ['https://chatgpt.com', 'https://claude.ai'],
  names: ['', ''],
  adapters: {},
  framework: FRAMEWORK,
  stableSec: 2,
  fallbackSec: 90,
  timeoutMin: 60,
  updateRepo: 'journeydesignbuild/journey-relay',
  githubToken: '',
  auto: true,
  driveFolder: ''
};

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    const s = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
    if (OLD_FRAMEWORKS.includes(s.framework)) s.framework = FRAMEWORK; // untouched old rules -> new default
    for (const k of Object.keys(s.adapters || {})) { const ad = s.adapters[k]; if (ad && /^#(_?r_|:r|radix-|headlessui-)/i.test(ad.send || '')) ad.send = ''; } // auto-generated ids change every page load
    if (!s.opusMigrated) { s.modModel = 'claude-opus-5-5'; s.opusMigrated = true; } // moderator moved to Opus 5.5
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

let firstWindow = true;
function createWindow(fresh = false) {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    title: 'Journey Relay',
    backgroundColor: '#0F1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  setupPanes(win);
  win.loadFile('index.html', fresh ? { query: { fresh: '1' } } : undefined);
  if (process.env.JP_SELFTEST && firstWindow) {
    win.webContents.on('console-message', (_e, _l, m) => { if (String(m).startsWith('[dbg]')) console.log(m); });
    const t = path.join(__dirname, 'test', `${process.env.JP_SELFTEST}.js`);
    require(fs.existsSync(t) ? t : path.join(__dirname, 'test', 'selftest.js'))(win, app);
  }
  firstWindow = false;
  return win;
}

// ---------- Panes: two native browser views per window (smooth like Chrome) ----------
const panesByWindow = new Map(); // renderer webContents id -> [view, view]
function setupPanes(win) {
  const ownerId = win.webContents.id;
  const views = [0, 1].map((i) => {
    const v = new WebContentsView({ webPreferences: { partition: 'persist:journey', contextIsolation: true, nodeIntegration: false, sandbox: true } });
    v.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    win.contentView.addChildView(v);
    const wc = v.webContents;
    const send = (type, data = {}) => { if (!win.isDestroyed()) win.webContents.send('pane:event', { i, type, ...data }); };
    const nav = () => send('nav', { url: wc.getURL(), canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() });
    wc.on('dom-ready', () => { nav(); send('dom-ready'); });
    wc.on('did-navigate', nav);
    wc.on('did-navigate-in-page', nav);
    wc.on('console-message', (e, _level, message) => send('console', { message: message ?? e.message }));
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => { if (isMainFrame) send('fail', { code, desc, url }); });
    wc.on('render-process-gone', () => send('gone'));
    wc.setWindowOpenHandler(() => ({ action: 'allow' })); // sign-in popups
    return v;
  });
  panesByWindow.set(ownerId, views);
  win.on('closed', () => { panesByWindow.delete(ownerId); views.forEach((v) => { try { v.webContents.close(); } catch {} }); });
}
ipcMain.handle('pane:call', async (e, i, method, args = []) => {
  const views = panesByWindow.get(e.sender.id);
  const v = views && views[i];
  if (!v) throw new Error('pane not found');
  const wc = v.webContents;
  switch (method) {
    case 'load': return wc.loadURL(args[0]).then(() => true, () => false);
    case 'exec': return wc.executeJavaScript(args[0], true);
    case 'back': if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); return true;
    case 'forward': if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); return true;
    case 'reload': wc.reload(); return true;
    case 'focus': { const w = BrowserWindow.fromWebContents(e.sender); if (w && w.isFocused()) wc.focus(); return true; } // never pull typing away from another window
    case 'input': wc.sendInputEvent(args[0]); return true;
    case 'insertText': await wc.insertText(args[0]); return true;
    case 'bounds': v.setBounds(args[0]); return true;
    case 'visible': v.setVisible(!!args[0]); return true;
  }
  throw new Error('unknown pane method ' + method);
});

const menuTemplate = [
  { label: 'File', submenu: [
    { label: 'New relay window', accelerator: 'CmdOrCtrl+N', click: () => createWindow(true) },
    { type: 'separator' },
    { role: 'close' },
    { role: 'quit' }
  ] },
  { role: 'editMenu' },
  { role: 'viewMenu' },
  { role: 'windowMenu' }
];
ipcMain.handle('host:focus', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w && !w.isDestroyed() && w.isFocused()) w.webContents.focus(); return true; });
ipcMain.handle('window:new', () => { createWindow(true); return true; });

// Embedded sites get no Node access and no preload
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (_ev, webPreferences) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
  });
});

ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:defaults', () => ({ ...DEFAULTS }));
ipcMain.handle('settings:save', (_e, s) => { saveSettings(s); return true; });
ipcMain.handle('clip:read', () => clipboard.readText());
ipcMain.handle('clip:write', (_e, t) => { clipboard.writeText(String(t ?? '')); return true; });

ipcMain.handle('claude:call', async (_e, body) => {
  const s = loadSettings();
  if (!s.apiKey) return { error: 'No API key yet. Open ⚙ Settings and paste your Anthropic API key.' };
  try {
    const res = await fetch(`${s.apiBase.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': s.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) return { error: data?.error?.message || `API error ${res.status}` };
    return { data };
  } catch (err) {
    return { error: String(err.message || err) };
  }
});

// ---------- Updates from GitHub ----------
const localManifest = () => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8')); } catch { return { version: '0.0.0', files: [] }; } };
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
async function ghFile(file) {
  const s = loadSettings();
  const headers = { Accept: 'application/vnd.github.raw', 'User-Agent': 'journey-relay' };
  if (s.githubToken) headers.Authorization = `Bearer ${s.githubToken}`;
  const res = await fetch(`${process.env.JP_UPDATE_BASE || 'https://api.github.com'}/repos/${s.updateRepo}/contents/${file}?ref=main`, { headers, cache: 'no-store' });
  if (!res.ok) throw new Error(res.status === 404 ? 'Update repo not found (or it is private and needs a token in Settings).' : `GitHub error ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
ipcMain.handle('update:check', async () => {
  const cur = localManifest().version;
  try {
    const remote = JSON.parse((await ghFile('manifest.json')).toString('utf8'));
    return { current: cur, latest: remote.version, available: newer(remote.version, cur), notes: remote.notes || '' };
  } catch (e) { return { current: cur, error: e.message }; }
});
ipcMain.handle('update:apply', async () => {
  try {
    const remote = JSON.parse((await ghFile('manifest.json')).toString('utf8'));
    const files = [...new Set([...(remote.files || []), 'manifest.json'])].filter((f) => !f.includes('..') && !path.isAbsolute(f));
    const got = {};
    for (const f of files) got[f] = await ghFile(f); // download everything first
    for (const f of files) {
      const dest = path.join(__dirname, f);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest + '.new', got[f]);
      fs.renameSync(dest + '.new', dest);
    }
    if (!process.env.JP_NO_RELAUNCH) setTimeout(() => { app.relaunch(); app.exit(0); }, 400);
    return { ok: true, version: remote.version };
  } catch (e) { return { error: e.message }; }
});
// ---------- Sessions (autosaved, one file per run) ----------
// ---------- Google Drive (through the Google Drive for desktop folder; no sign-in needed) ----------
function findDriveRoot() {
  const s = loadSettings();
  const cands = [];
  if (s.driveFolder) cands.push(s.driveFolder);
  if (process.platform === 'win32') for (const L of 'DEFGHIJKLMNOPQRSTUVWXYZ') cands.push(`${L}:\\My Drive`);
  const home = os.homedir();
  if (process.platform === 'darwin') {
    const cs = path.join(home, 'Library', 'CloudStorage');
    try { fs.readdirSync(cs).filter((n) => n.startsWith('GoogleDrive-')).forEach((n) => cands.push(path.join(cs, n, 'My Drive'))); } catch {}
  }
  cands.push(path.join(home, 'Google Drive', 'My Drive'), path.join(home, 'My Drive'), path.join(home, 'Google Drive'));
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  if (s.driveFolder && isDir(s.driveFolder)) return s.driveFolder;
  const found = cands.filter(isDir);
  // A new computer: pick the drive that already has your synced relay settings, then any with relay sessions
  return found.find((p) => fs.existsSync(path.join(p, 'Journey Relay', '_settings.json')))
    || found.find((p) => fs.existsSync(path.join(p, 'Journey Relay', '_sessions')))
    || found[0] || null;
}
const cleanName = (n) => String(n || 'file.txt').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'file.txt';
function uniquePath(dir, name) {
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  let candidate = name, n = 2;
  while (fs.existsSync(path.join(dir, candidate))) candidate = `${base} (${n++})${ext}`;
  return candidate;
}
function relayDir(folder) {
  const root = findDriveRoot();
  const baseDir = root ? path.join(root, 'Journey Relay') : path.join(app.getPath('documents'), 'Journey Relay');
  return { dir: path.join(baseDir, cleanName(folder)), onDrive: !!root, root };
}
ipcMain.handle('drive:info', () => { const r = findDriveRoot(); return { found: !!r, root: r }; });
// Every Google Drive for desktop "My Drive" on this computer (one per signed-in account)
function allDriveRoots() {
  const out = [];
  if (process.platform === 'win32') for (const L of 'DEFGHIJKLMNOPQRSTUVWXYZ') out.push(`${L}:\\My Drive`);
  const home = os.homedir();
  if (process.platform === 'darwin') {
    const cs = path.join(home, 'Library', 'CloudStorage');
    try { fs.readdirSync(cs).filter((n) => n.startsWith('GoogleDrive-')).forEach((n) => out.push(path.join(cs, n, 'My Drive'))); } catch {}
  }
  out.push(path.join(home, 'Google Drive', 'My Drive'), path.join(home, 'My Drive'));
  return out.filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }).map((p) => {
    let sample = [];
    try { sample = fs.readdirSync(p).filter((n) => !n.startsWith('.')).slice(0, 4); } catch {}
    return { path: p, sample };
  });
}
ipcMain.handle('drive:list', () => allDriveRoots());
// Switching accounts: copy the relay's sessions and files to the new Drive (never overwriting)
ipcMain.handle('drive:move', (_e, { from, to }) => {
  try {
    const src = path.join(from, 'Journey Relay'), dst = path.join(to, 'Journey Relay');
    if (!from || !to || from === to || !fs.existsSync(src)) return { copied: false };
    fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false });
    return { copied: true };
  } catch (err) { return { copied: false, error: String(err.message || err) }; }
});
ipcMain.handle('drive:save', (_e, { folder, name, content }) => {
  try {
    const { dir, onDrive } = relayDir(folder);
    fs.mkdirSync(dir, { recursive: true });
    const finalName = uniquePath(dir, cleanName(name));
    fs.writeFileSync(path.join(dir, finalName), String(content ?? ''), 'utf8');
    // Local backup: Google Drive can refuse a file (account rules) and remove it; this copy stays on the PC
    try {
      const bak = path.join(app.getPath('userData'), 'files', cleanName(folder));
      fs.mkdirSync(bak, { recursive: true });
      fs.writeFileSync(path.join(bak, finalName), String(content ?? ''), 'utf8');
    } catch {}
    return { ok: true, name: finalName, abs: path.join(dir, finalName), rel: `${onDrive ? 'My Drive/' : 'Documents/'}Journey Relay/${cleanName(folder)}/${finalName}`, onDrive };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle('files:openBackup', () => { const d = path.join(app.getPath('userData'), 'files'); fs.mkdirSync(d, { recursive: true }); return shell.openPath(d); });
ipcMain.handle('drive:open', (_e, folder) => {
  const { dir } = relayDir(folder || '');
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});
// Sessions live in Google Drive (My Drive/Journey Relay/_sessions) when Drive for desktop is installed,
// so another computer can pick them up. Older local sessions are still listed.
const localSessionsDir = () => path.join(app.getPath('userData'), 'sessions');
const driveSessionsDir = () => { const r = findDriveRoot(); return r ? path.join(r, 'Journey Relay', '_sessions') : null; };
const safeId = (id) => String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
function readSessionFile(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function sessionFiles() {
  const out = new Map(); // id -> { file, updated }
  for (const dir of [localSessionsDir(), driveSessionsDir()].filter(Boolean)) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch {}
    for (const n of names) {
      const j = readSessionFile(path.join(dir, n));
      if (!j || !j.id) continue;
      const cur = out.get(j.id);
      if (!cur || String(j.updated) > String(cur.j.updated)) out.set(j.id, { file: path.join(dir, n), j });
    }
  }
  return out;
}
ipcMain.handle('sessions:list', () => [...sessionFiles().values()].map(({ j }) => ({
  id: j.id, created: j.created, updated: j.updated, title: String(j.title || j.task || '').slice(0, 90), task: String(j.task || '').slice(0, 90),
  activeOn: j.activeOn || null
})).sort((a, b) => String(b.updated).localeCompare(String(a.updated))));
ipcMain.handle('sessions:load', (_e, id) => { const hit = sessionFiles().get(safeId(id)); return hit ? hit.j : null; });
ipcMain.handle('sessions:save', (_e, obj) => {
  if (!obj || !safeId(obj.id)) return false;
  obj.activeOn = { host: os.hostname(), at: new Date().toISOString() };
  const data = JSON.stringify(obj);
  for (const dir of [driveSessionsDir() || localSessionsDir()]) {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, safeId(obj.id) + '.json');
    fs.writeFileSync(f + '.tmp', data);
    fs.renameSync(f + '.tmp', f);
  }
  return true;
});
ipcMain.handle('app:host', () => os.hostname());

// ---------- Settings sync through Drive; API key locked with your relay password (AES-256-GCM) ----------
const SYNC_FIELDS = ['adapters', 'names', 'framework', 'modModel', 'sumModel', 'stableSec', 'fallbackSec', 'timeoutMin', 'auto', 'updateRepo', 'urls'];
const syncFile = () => { const r = findDriveRoot(); return r ? path.join(r, 'Journey Relay', '_settings.json') : null; };
const deriveKey = (password, saltHex) => crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 32);
function encryptJson(obj, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { iv: iv.toString('hex'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('hex') };
}
function decryptJson(blob, key) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'hex'));
  d.setAuthTag(Buffer.from(blob.tag, 'hex'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]).toString('utf8'));
}
const readSync = () => { const f = syncFile(); if (!f) return null; try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
ipcMain.handle('sync:push', (_e, { password } = {}) => {
  const s = loadSettings();
  const f = syncFile();
  if (!f) return { ok: false, error: 'Google Drive not found' };
  const existing = readSync() || {};
  const pub = {};
  SYNC_FIELDS.forEach((k) => { pub[k] = s[k]; });
  let salt = existing.salt || null, secrets = existing.secrets || null;
  let keyHex = s.syncKey && s.syncSalt && s.syncSalt === existing.salt ? s.syncKey : null;
  if (password) { salt = crypto.randomBytes(16).toString('hex'); keyHex = deriveKey(password, salt).toString('hex'); }
  if (keyHex && salt) secrets = encryptJson({ apiKey: s.apiKey || '', githubToken: s.githubToken || '' }, Buffer.from(keyHex, 'hex'));
  const out = { v: 1, updatedAt: new Date().toISOString(), from: os.hostname(), settings: pub, salt, secrets };
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f + '.tmp', JSON.stringify(out, null, 2));
    fs.renameSync(f + '.tmp', f);
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
  const local = { syncedAt: out.updatedAt };
  if (keyHex) { local.syncKey = keyHex; local.syncSalt = salt; }
  saveSettings({ ...s, ...local });
  return { ok: true, ...local, keySynced: !!secrets, file: f };
});
ipcMain.handle('sync:pull', () => {
  const d = readSync();
  if (!d) return { found: false };
  const s = loadSettings();
  let applied = false;
  if (d.settings && (!s.syncedAt || String(d.updatedAt) > String(s.syncedAt))) {
    SYNC_FIELDS.forEach((k) => { if (d.settings[k] !== undefined) s[k] = d.settings[k]; });
    s.syncedAt = d.updatedAt;
    applied = true;
  }
  let needsSignIn = false;
  if (d.secrets && d.salt) {
    if (s.syncKey && s.syncSalt === d.salt) {
      try { const sec = decryptJson(d.secrets, Buffer.from(s.syncKey, 'hex')); if (sec.apiKey) s.apiKey = sec.apiKey; if (sec.githubToken) s.githubToken = sec.githubToken; } catch { needsSignIn = true; }
    } else needsSignIn = true;
  }
  saveSettings(s);
  return { found: true, applied, needsSignIn, from: d.from, updatedAt: d.updatedAt, hasKey: !!d.secrets };
});
ipcMain.handle('sync:signin', (_e, password) => {
  const d = readSync();
  if (!d || !d.secrets || !d.salt) return { ok: false, error: 'No synced key found in Google Drive.' };
  const key = deriveKey(password, d.salt);
  try {
    const sec = decryptJson(d.secrets, key);
    const s = loadSettings();
    if (sec.apiKey) s.apiKey = sec.apiKey;
    if (sec.githubToken) s.githubToken = sec.githubToken;
    s.syncKey = key.toString('hex'); s.syncSalt = d.salt;
    saveSettings(s);
    return { ok: true };
  } catch { return { ok: false, error: 'Wrong password.' }; }
});

// Live status: My Drive/Journey Relay/STATUS.md, readable from a phone or by Claude through the Drive connector
const statusByWindow = new Map();
function writeStatusFile() {
  const root = findDriveRoot();
  const dir = root ? path.join(root, 'Journey Relay') : path.join(app.getPath('documents'), 'Journey Relay');
  const list = [...statusByWindow.values()];
  const busyAny = list.some((x) => x.busy);
  const now = new Date();
  const lines = [
    '# Journey Relay status',
    '',
    `Updated: ${now.toLocaleString()} on ${os.hostname()}`,
    `Overall: ${list.length ? (busyAny ? 'BUSY: hands off the chats' : 'IDLE: safe to type') : 'App closed'}`,
    ''
  ];
  list.forEach((x, k) => {
    lines.push(`## Window ${k + 1}: ${x.session || 'Untitled session'}`, '',
      `- Relay: ${x.relay}`,
      `- Right now: ${x.phase}`,
      `- Safe to type in the chats: ${x.busy ? 'NO' : 'YES'}`,
      `- AI 1: ${x.ai1} · AI 2: ${x.ai2}`,
      `- Turn: ${x.turn}`,
      `- Open questions for Justin: ${x.questions || 'none'}`,
      `- Where we are: ${x.summary || '(no summary yet)'}`,
      `- Delivery: ${x.delivery || '-'}`,
      `- Last activity: ${x.last || '-'}`, '');
  });
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'STATUS.md'), lines.join('\n'));
    fs.writeFileSync(path.join(dir, '_status.json'), JSON.stringify({ updated: now.toISOString(), host: os.hostname(), windows: list }, null, 2));
  } catch {}
}
ipcMain.handle('status:update', (e, st) => {
  const id = e.sender.id;
  if (!statusByWindow.has(id)) e.sender.once('destroyed', () => { statusByWindow.delete(id); writeStatusFile(); });
  statusByWindow.set(id, st);
  writeStatusFile();
  return true;
});

ipcMain.handle('app:info', () => ({ version: localManifest().version, platform: `${process.platform} ${process.arch}`, electron: process.versions.electron }));

app.whenReady().then(() => { Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate)); createWindow(false); });
app.on('window-all-closed', () => { statusByWindow.clear(); writeStatusFile(); if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(false); });
