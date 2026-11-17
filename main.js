// Journey Relay — main process
const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

// Look like regular Chrome so sites allow sign-in
app.userAgentFallback = app.userAgentFallback
  .replace(/\sElectron\/\S+/, '')
  .replace(/\s\S+\/[\d.]+(?= Chrome\/)/, '');

const FRAMEWORK = `RELAY RULES — follow exactly in every reply.
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
- Always finish with END OF TURN.`;

const DEFAULTS = {
  apiKey: '',
  apiBase: 'https://api.anthropic.com',
  modModel: 'claude-sonnet-5-5',
  sumModel: 'claude-haiku-5-5',
  urls: ['https://chatgpt.com', 'https://claude.ai'],
  names: ['', ''],
  adapters: {},
  framework: FRAMEWORK,
  stableSec: 2,
  fallbackSec: 90,
  timeoutMin: 60,
  updateRepo: 'journeydesignbuild/journey-relay',
  githubToken: ''
};

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    title: 'Journey Relay',
    backgroundColor: '#0F1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  });
  win.loadFile('index.html');
  if (process.env.JP_SELFTEST) win.webContents.on('console-message', (_e, _l, m) => { if (String(m).startsWith('[dbg]')) console.log(m); });
  if (process.env.JP_SELFTEST) require(path.join(__dirname, 'test', 'selftest.js'))(win, app);
}

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
ipcMain.handle('app:info', () => ({ version: localManifest().version, platform: `${process.platform} ${process.arch}`, electron: process.versions.electron }));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
