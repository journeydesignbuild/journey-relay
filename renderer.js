'use strict';
/* Journey Relay — renderer: panes, relay engine, questions, summary, moderator agent */

const $ = (s, r = document) => r.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const short = (s, n = 140) => { s = norm(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
class Stop extends Error { constructor() { super('stopped'); } }

// ---------- Site presets (best effort; use Teach if a site changes) ----------
const PRESETS = [
  { hosts: ['chatgpt.com', 'chat.openai.com'], name: 'ChatGPT', ai: 'CHATGPT',
    input: '#prompt-textarea, div[aria-label="Work with ChatGPT"]', reply: '[data-message-author-role="assistant"]',
    send: 'button[data-testid="send-button"], #composer-submit-button', busy: 'button[data-testid="stop-button"]' },
  { hosts: ['claude.ai'], name: 'Claude', ai: 'CLAUDE',
    input: '[data-testid="chat-input"], div[contenteditable="true"].ProseMirror', reply: 'div[data-testid="assistant-message"], .font-claude-response, .font-claude-message',
    send: 'button[aria-label="Send message"], button[aria-label="Send Message"]', busy: '[data-is-streaming="true"], button[aria-label="Stop response"]' },
  { hosts: ['gemini.google.com'], name: 'Gemini', ai: 'GEMINI',
    input: 'rich-textarea .ql-editor, div[contenteditable="true"]', reply: 'model-response message-content, message-content',
    send: 'button.send-button, button[aria-label="Send message"]', busy: 'button[aria-label="Stop response"]' },
  { hosts: ['grok.com'], name: 'Grok', ai: 'GROK',
    input: 'textarea, div[contenteditable="true"]', reply: '.message-bubble', send: 'button[type="submit"]', busy: '' }
];

// ---------- Error capture (for the debug report) ----------
const errors = [];
function recordError(msg) {
  errors.push(`${new Date().toLocaleTimeString()}  ${String(msg).slice(0, 500)}`);
  if (errors.length > 40) errors.shift();
}
window.addEventListener('error', (e) => recordError('JS error: ' + (e.message || e.error)));
window.addEventListener('unhandledrejection', (e) => recordError('Unhandled: ' + (e.reason && e.reason.message || e.reason)));

// ---------- State ----------
let settings = null;
const panes = [];
const logEntries = [];
const questions = [];
let summaryText = '';
// The relay is one switch. ON: whenever either AI finishes a reply, it's copied to the other.
const R = {
  on: false, busy: false, turn: 0, phase: 'Off',
  task: '', introduced: [false, false], complete: [false, false],
  queued: [[], []], lastFrom: null,
  seen: ['', ''],          // last reply already handled in each pane (so old replies aren't re-sent)
  rebase: [false, false],  // pane switched to a different chat: re-read its starting point
  lastSent: ['', ''],      // start of what we last pasted into each pane (ignore it if it shows up as a "reply")
  pending: null            // legacy (manual Pass mode removed)
};
const stab = [null, null];

// ---------- Helpers ----------
const hostOf = (url) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; } };
const curUrl = (p) => { try { return p.wv.getURL(); } catch { return ''; } };
const presetFor = (host) => { const h = host.replace(/:\d+$/, ''); return PRESETS.find((x) => x.hosts.some((k) => h === k || h.endsWith('.' + k))); };
function adapterFor(p) {
  const h = hostOf(curUrl(p));
  if (!h) return null;
  const t = settings.adapters[h];
  const pr = presetFor(h);
  if (t && (!pr || t.override)) return { ...t, ai: t.ai || (pr && pr.ai), busy: t.busy || (pr && pr.busy) || '', source: 'taught' };
  return pr ? { ...pr, source: 'preset' } : null;
}
function defaultAiName(i) {
  const a = adapterFor(panes[i]);
  if (a && a.ai) return a.ai;
  const h = hostOf(curUrl(panes[i])).replace(/:\d+$/, '');
  const parts = h.split('.');
  const core = parts.length > 1 ? parts[parts.length - 2] : parts[0];
  return (core || `WEB${i + 1}`).toUpperCase().replace(/[^A-Z0-9]/g, '') || `WEB${i + 1}`;
}
const aiName = (i) => (panes[i].nameInput.value || '').trim().toUpperCase().replace(/[^A-Z0-9 _-]/g, '') || defaultAiName(i);
const label = (i) => `AI ${i + 1}`;
const paneIdx = (who) => (/2$/.test(String(who)) ? 1 : 0); // works for old 'Web1/Web2' entries too
const maxTurns = () => Math.max(1, parseInt($('#maxTurns').value, 10) || 20);
const isNone = (s) => { const v = norm(s).replace(/[*_`'".:]/g, '').trim(); return !v || /^NONE\b/i.test(v) || /^N\/?A$/i.test(v); };

function run(p, fn, ...args) {
  const code = `(${fn.toString()})(${args.map((a) => JSON.stringify(a ?? null)).join(',')})`;
  return p.wv.executeJavaScript(code, true);
}

// ---------- Functions that run INSIDE the websites (self-contained) ----------
function pgRead(sel, busySel) {
  const vis = (e) => e.getClientRects().length > 0;
  let els;
  try { els = [...document.querySelectorAll(sel)].filter(vis); } catch (e) { return { error: 'bad selector', count: 0, text: '', busy: false }; }
  const last = els[els.length - 1];
  let busy = false;
  if (busySel) { try { busy = [...document.querySelectorAll(busySel)].some(vis); } catch (e) {} }
  // generic signs that the AI is still working (stop buttons, streaming flags)
  if (!busy) {
    try {
      busy = [...document.querySelectorAll('[data-testid="stop-button"], [data-is-streaming="true"], button[aria-label*="Stop" i], button[aria-label*="Cancel response" i]')].some(vis);
    } catch (e) {}
  }
  return { count: els.length, text: last ? (last.innerText || '').trim() : '', busy };
}
function pgFocusInput(sel, clear) {
  const vis = (e) => e.getClientRects().length > 0;
  let els;
  try { els = [...document.querySelectorAll(sel)].filter(vis); } catch (e) { return { ok: false, error: 'bad input selector' }; }
  let el = els[els.length - 1];
  if (!el) return { ok: false, error: 'input box not found on the page' };
  if (!/^(TEXTAREA|INPUT)$/.test(el.tagName) && !el.isContentEditable) {
    const inner = el.querySelector('textarea, [contenteditable="true"]');
    if (inner) el = inner;
  }
  el.scrollIntoView({ block: 'nearest' });
  el.focus();
  const isField = /^(TEXTAREA|INPUT)$/.test(el.tagName);
  if (clear) {
    if (isField) {
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      d.set.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const r = document.createRange(); r.selectNodeContents(el);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      document.execCommand('delete');
    }
  } else if (!isField) {
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  return { ok: true };
}
function pgInputText(sel) {
  const vis = (e) => e.getClientRects().length > 0;
  let els;
  try { els = [...document.querySelectorAll(sel)].filter(vis); } catch (e) { return ''; }
  let el = els[els.length - 1];
  if (!el) return '';
  if (!/^(TEXTAREA|INPUT)$/.test(el.tagName) && !el.isContentEditable) {
    const inner = el.querySelector('textarea, [contenteditable="true"]');
    if (inner) el = inner;
  }
  return /^(TEXTAREA|INPUT)$/.test(el.tagName) ? el.value : (el.innerText || '');
}
function pgTypeFallback(sel, text) {
  const vis = (e) => e.getClientRects().length > 0;
  let el = [...document.querySelectorAll(sel)].filter(vis).pop();
  if (!el) return false;
  if (!/^(TEXTAREA|INPUT)$/.test(el.tagName) && !el.isContentEditable) {
    const inner = el.querySelector('textarea, [contenteditable="true"]');
    if (inner) el = inner;
  }
  el.focus();
  if (/^(TEXTAREA|INPUT)$/.test(el.tagName)) {
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    d.set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    document.execCommand('insertText', false, text);
  }
  return true;
}
function pgPaste(sel, text) {
  const vis = (e) => e.getClientRects().length > 0;
  let el;
  try { el = [...document.querySelectorAll(sel)].filter(vis).pop(); } catch (e) { return { ok: false }; }
  if (!el) return { ok: false };
  if (!/^(TEXTAREA|INPUT)$/.test(el.tagName) && !el.isContentEditable) {
    const inner = el.querySelector('textarea, [contenteditable="true"]');
    if (inner) el = inner;
  }
  el.focus();
  if (/^(TEXTAREA|INPUT)$/.test(el.tagName)) {
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    d.set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true, how: 'set' };
  }
  // Rich editors (ChatGPT, Claude, Gemini…) handle a paste event like a real Ctrl+V
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  if (!ev.defaultPrevented && !(el.innerText || '').trim()) {
    document.execCommand('insertText', false, text);
    return { ok: true, how: 'insertText' };
  }
  return { ok: true, how: 'paste' };
}
function pgAttach(name, content, type) {
  const inputs = [...document.querySelectorAll('input[type="file"]')];
  if (!inputs.length) return { ok: false, error: 'no file upload box on the page' };
  const lower = name.toLowerCase();
  const fits = (i) => {
    const acc = (i.accept || '').split(',').map((a) => a.trim().toLowerCase()).filter(Boolean);
    if (!acc.length || acc.includes('*') || acc.includes('*/*')) return true;
    return acc.some((a) => (a.startsWith('.') && lower.endsWith(a)) || a === type || (a.endsWith('/*') && type.startsWith(a.slice(0, -1))));
  };
  const inp = inputs.filter(fits).pop() || inputs[inputs.length - 1];
  const dt = new DataTransfer();
  dt.items.add(new File([content], name, { type }));
  inp.files = dt.files;
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
}
function pgClickSend(sel) {
  if (!sel) return false;
  const vis = (e) => e.getClientRects().length > 0;
  let els;
  try { els = [...document.querySelectorAll(sel)].filter(vis).filter((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true'); } catch (e) { return false; }
  const b = els[els.length - 1];
  if (!b) return false;
  b.click();
  return true;
}
function pgCheck(inSel, repSel) {
  const vis = (e) => e.getClientRects().length > 0;
  const q = (s) => { try { return [...document.querySelectorAll(s)].filter(vis); } catch (e) { return []; } };
  const reps = q(repSel);
  const last = reps[reps.length - 1];
  return { input: q(inSel).length > 0, count: reps.length, latest: last ? (last.innerText || '').trim() : '' };
}
function pgPickStop() { if (window.__jpPick) window.__jpPick.cleanup(); return true; }
function pgPick(kind) {
  if (window.__jpPick) window.__jpPick.cleanup();
  const out = (o) => console.log('__JP_PICK__' + JSON.stringify(o));
  const count = (s) => { try { return document.querySelectorAll(s).length; } catch (e) { return 0; } };
  const okCls = (c) => /^[A-Za-z_][\w-]*$/.test(c) && !/\d{3,}/.test(c) && c.length < 40
    && !/(focus|active|hover|select|open|visible|hidden|disabled|empty|placeholder)/i.test(c)
    && !/[-_](?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*[a-z])[A-Za-z0-9]{5,8}$/.test(c);
  const tag = (el) => el.tagName.toLowerCase();
  const q = (v) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const txt = (el) => (el.innerText || '').trim();
  const attrSels = (el) => {
    const res = [];
    for (const a of ['data-testid', 'data-message-author-role', 'data-role', 'data-author', 'aria-label', 'name', 'placeholder', 'role', 'contenteditable', 'type']) {
      const v = el.getAttribute(a);
      if (v != null && v.length && v.length < 60 && !/\d{3,}/.test(v)) res.push(`${tag(el)}[${a}="${q(v)}"]`);
    }
    return res;
  };
  const clsSel = (el) => { const c = [...el.classList].filter(okCls); return c.length ? tag(el) + c.map((x) => '.' + CSS.escape(x)).join('') : ''; };
  const path = (el) => {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && n !== document.body && parts.length < 10) {
      let p = tag(n);
      if (stableId(n.id)) { parts.unshift('#' + CSS.escape(n.id)); break; }
      const par = n.parentElement;
      if (par) { const sib = [...par.children].filter((x) => x.tagName === n.tagName); if (sib.length > 1) p += `:nth-of-type(${sib.indexOf(n) + 1})`; }
      parts.unshift(p);
      n = par;
    }
    return parts.join(' > ');
  };
  const stableId = (id) => id && !/\d{3,}|:/.test(id) && !/^_?r_|^:r|^radix-|^headlessui-|^react-|^mui-|^[a-z]{1,3}_[a-z0-9]{1,4}_?$/i.test(id) && id.length > 3;
  const uniq = (el) => {
    if (stableId(el.id)) { const s = '#' + CSS.escape(el.id); if (count(s) === 1) return s; }
    for (const s of attrSels(el)) if (count(s) === 1) return s;
    const c = clsSel(el);
    if (c && count(c) >= 1 && count(c) <= 3) return c;
    for (const s of attrSels(el)) if (count(s) >= 1 && count(s) <= 3) return s;
    return path(el);
  };
  const group = (el) => {
    const chain = [];
    for (let n = el; n && n !== document.body && chain.length < 40; n = n.parentElement) chain.push(n);
    for (const n of chain) {
      for (const s of attrSels(n).filter((s) => s.includes('[data-'))) {
        const c = count(s);
        if (txt(n).length > 10 && ((c >= 2 && c < 300) || (c === 1 && /message|response|author|turn|answer|reply/i.test(s)))) return s;
      }
    }
    const sibs = (n, s) => (n.parentElement ? [...n.parentElement.children].filter((x) => x !== n && x.matches(s)).length : 0);
    for (const n of chain) { const s = clsSel(n); if (!s || txt(n).length < 10) continue; const c = count(s); if (c >= 2 && c < 300 && sibs(n, s) === 0) return s; }
    for (const n of chain) { const s = clsSel(n); if (!s || txt(n).length < 10) continue; const c = count(s); if (c >= 2 && c < 300) return s; }
    return uniq(el);
  };
  const resolve = (el) => {
    if (kind === 'input') return el.closest('textarea, input, [contenteditable="true"], [contenteditable=""], [role="textbox"]') || el;
    if (kind === 'send') return el.closest('button, [role="button"], input[type="submit"]') || el;
    return el;
  };
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #F08A3C;background:rgba(240,138,60,.15);border-radius:4px';
  document.documentElement.appendChild(box);
  const block = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
  const onMove = (e) => {
    const el = resolve(e.target); const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  };
  let cleanup;
  const onClick = (e) => {
    block(e);
    const el = resolve(e.target);
    cleanup();
    const selector = kind === 'reply' ? group(el) : uniq(el);
    let all = [];
    try { all = [...document.querySelectorAll(selector)]; } catch (x) {}
    const last = all[all.length - 1];
    out({ selector, count: all.length, preview: last ? txt(last).slice(0, 200) : '' });
  };
  const onKey = (e) => { if (e.key === 'Escape') { block(e); cleanup(); out({ cancel: true }); } };
  const evs = ['mousedown', 'mouseup', 'pointerdown', 'pointerup'];
  cleanup = () => {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('click', onClick, true);
    evs.forEach((t) => window.removeEventListener(t, block, true));
    window.removeEventListener('keydown', onKey, true);
    box.remove();
    window.__jpPick = null;
  };
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('click', onClick, true);
  evs.forEach((t) => window.addEventListener(t, block, true));
  window.addEventListener('keydown', onKey, true);
  window.__jpPick = { cleanup };
  return true;
}

// ---------- Panes ----------
// Each pane is a native browser view owned by the main process. This small stand-in
// gives the rest of the app the same calls it used before.
function makePaneView(i) {
  const listeners = {};
  return {
    _url: '', _back: false, _fwd: false,
    getURL() { return this._url; },
    canGoBack() { return this._back; },
    canGoForward() { return this._fwd; },
    goBack() { window.api.pane(i, 'back'); },
    goForward() { window.api.pane(i, 'forward'); },
    reload() { window.api.pane(i, 'reload'); },
    loadURL(u) { this._url = u; return window.api.pane(i, 'load', [u]); },
    executeJavaScript(code) { return window.api.pane(i, 'exec', [code]); },
    focus() { window.api.pane(i, 'focus'); },
    sendInputEvent(ev) { return window.api.pane(i, 'input', [ev]); },
    insertText(t) { return window.api.pane(i, 'insertText', [t]); },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    _emit(type, ev) { (listeners[type] || []).forEach((f) => f(ev)); }
  };
}
window.api.onPaneEvent((d) => {
  const p = panes[d.i];
  if (!p) return;
  const wv = p.wv;
  if (d.type === 'nav') { wv._url = d.url; wv._back = d.canGoBack; wv._fwd = d.canGoForward; wv._emit('did-navigate', d); }
  else if (d.type === 'dom-ready') wv._emit('dom-ready', {});
  else if (d.type === 'console') wv._emit('console-message', { message: d.message });
  else if (d.type === 'fail') wv._emit('did-fail-load', { errorCode: d.code, errorDescription: d.desc, validatedURL: d.url });
  else if (d.type === 'gone') wv._emit('render-process-gone', {});
});
let panesHidden = false;
function syncPaneBounds() {
  panes.forEach((p) => {
    const r = $('.pane-body', p.sec).getBoundingClientRect();
    window.api.pane(p.i, 'bounds', [{ x: Math.round(r.left), y: Math.round(r.top), width: Math.max(0, Math.round(r.width)), height: Math.max(0, Math.round(r.height)) }]);
  });
}
function setPanesVisible(v) {
  panesHidden = !v;
  panes.forEach((p) => window.api.pane(p.i, 'visible', [v]));
}
function buildPanes(startUrls) {
  const host = $('#panes');
  [0, 1].forEach((i) => {
    const sec = document.createElement('section');
    sec.className = 'pane';
    sec.innerHTML = `
      <div class="pane-bar">
        <span class="tag">${label(i)}</span>
        <button class="nav back" title="Back" aria-label="Back">‹</button>
        <button class="nav fwd" title="Forward" aria-label="Forward">›</button>
        <button class="nav reload" title="Reload" aria-label="Reload">⟳</button>
        <input class="url" aria-label="${label(i)} address" spellcheck="false" />
        <input class="ainame" aria-label="${label(i)} AI name" title="Name this AI uses in the relay markers" />
        <span class="site">…</span>
        <button class="teach">Teach</button>
        <button class="test">Test</button>
      </div>
      <div class="banner hidden"><span class="msg"></span><button class="skip mini">Skip</button><button class="cancel mini">Cancel</button></div>
      <div class="pane-body"></div>`;
    host.appendChild(sec);
    const wv = makePaneView(i);
    const su = startUrls && /^https?:/.test(startUrls[i] || '') ? startUrls[i] : settings.urls[i];
    const p = { i, label: label(i), sec, wv, url: $('.url', sec), nameInput: $('.ainame', sec), site: $('.site', sec), banner: $('.banner', sec), pick: null };
    panes.push(p);
    p.nameInput.value = settings.names[i] || '';
    p.nameInput.addEventListener('change', () => { settings.names[i] = p.nameInput.value.trim().toUpperCase(); p.nameInput.value = settings.names[i]; saveSettings(); });
    wv.addEventListener('dom-ready', () => refreshPane(p));
    wv.addEventListener('did-navigate', () => refreshPane(p));
    wv.addEventListener('console-message', (e) => onConsole(p, e.message));
    wv.addEventListener('did-fail-load', (e) => { if (e.errorCode !== -3) recordError(`${label(i)} failed to load ${e.validatedURL}: ${e.errorDescription}`); });
    wv.addEventListener('render-process-gone', () => recordError(`${label(i)} page crashed`));
    $('.back', sec).onclick = () => { if (wv.canGoBack()) wv.goBack(); };
    $('.fwd', sec).onclick = () => { if (wv.canGoForward()) wv.goForward(); };
    $('.reload', sec).onclick = () => wv.reload();
    p.url.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      let u = p.url.value.trim();
      if (!/^https?:\/\//i.test(u)) u = (u.includes('.') && !u.includes(' ')) ? 'https://' + u : 'https://www.google.com/search?q=' + encodeURIComponent(u);
      wv.loadURL(u);
      p.url.blur();
    });
    $('.teach', sec).onclick = () => teach(p);
    p.site.title = 'Right-click to forget a taught setup';
    p.site.oncontextmenu = async (e) => { e.preventDefault(); const h = hostOf(curUrl(p)); if (settings.adapters[h] && confirm(`Forget the taught setup for ${h}?`)) { delete settings.adapters[h]; await saveSettings(); refreshPane(p); note(`${p.label}: back to the built-in setup.`); } };
    $('.test', sec).onclick = () => testPane(p);
    $('.skip', sec).onclick = () => { if (p.pick) { const pk = p.pick; p.pick = null; run(p, pgPickStop).catch(() => {}); pk.resolve(null); } };
    $('.cancel', sec).onclick = () => { if (p.pick) { const pk = p.pick; p.pick = null; run(p, pgPickStop).catch(() => {}); pk.reject(new Error('cancel')); } else hideBanner(p); };
    wv.loadURL(su || 'https://www.google.com');
    new ResizeObserver(syncPaneBounds).observe($('.pane-body', sec));
  });
}
const chatPath = (u) => { try { const x = new URL(u); return x.host + x.pathname; } catch { return ''; } };
function refreshPane(p) {
  const u = curUrl(p);
  const path = chatPath(u);
  // moved from one chat to a different one (not a brand-new chat getting its first URL)
  if (p.lastPath && path && path !== p.lastPath && /\/(c|chat|app)\/[\w-]{8,}/.test(p.lastPath)) paneChatChanged(p.i);
  if (path) p.lastPath = path;
  if (R.task) autosave();
  if (document.activeElement !== p.url) p.url.value = u;
  const a = adapterFor(p);
  p.site.textContent = a ? (a.source === 'taught' ? 'Taught ✓' : `${a.name} ✓`) : 'Not set up';
  p.site.className = 'site ' + (a ? 'ok' : 'warn');
  p.nameInput.placeholder = defaultAiName(p.i);
}
function showBanner(p, html, { skip = false, cancel = true } = {}) {
  $('.msg', p.banner).innerHTML = html;
  $('.skip', p.banner).classList.toggle('hidden', !skip);
  $('.cancel', p.banner).classList.toggle('hidden', !cancel);
  p.banner.classList.remove('hidden');
  syncPaneBounds();
}
const hideBanner = (p) => { p.banner.classList.add('hidden'); syncPaneBounds(); };

// ---------- Teach mode ----------
function onConsole(p, msg) {
  if (!msg || !msg.startsWith('__JP_PICK__') || !p.pick) return;
  let data; try { data = JSON.parse(msg.slice(11)); } catch { return; }
  const pk = p.pick; p.pick = null;
  if (data.cancel) pk.reject(new Error('cancel')); else pk.resolve(data);
}
function pick(p, kind, html, allowSkip) {
  return new Promise((resolve, reject) => {
    p.pick = { resolve, reject };
    showBanner(p, html, { skip: allowSkip, cancel: true });
    run(p, pgPick, kind).catch((err) => { p.pick = null; reject(err); });
  });
}
async function teach(p) {
  if (R.on) { note('Turn the relay off before teaching a site.', true); return; }
  const h = hostOf(curUrl(p));
  if (!h) return;
  if (presetFor(h) && !confirm(`${presetFor(h).name} already has a built-in setup. Only teach it if Test fails. Teach anyway?`)) return;
  try {
    const inp = await pick(p, 'input', '<b>1/3</b> Click the box where you <b>type</b> messages. (Esc to cancel)', false);
    const rep = await pick(p, 'reply', `<b>2/3</b> Click inside the AI's latest <b>reply</b>. Works best with 2+ replies on screen.`, false);
    const snd = await pick(p, 'send', `Found ${rep.count} repl${rep.count === 1 ? 'y' : 'ies'}. Latest: “${esc(short(rep.preview, 70))}”<br><b>3/3</b> Click the <b>send</b> button, or Skip to use the Enter key.`, true);
    settings.adapters[h] = { name: h, input: inp.selector, reply: rep.selector, send: snd ? snd.selector : '', busy: '', override: !!presetFor(h) };
    await saveSettings();
    refreshPane(p);
    showBanner(p, `✓ Saved for ${esc(h)}. Click Test to double-check.`, { cancel: false });
    setTimeout(() => hideBanner(p), 3500);
  } catch (e) {
    run(p, pgPickStop).catch(() => {});
    hideBanner(p);
    if (e.message !== 'cancel') note(`${p.label} teach failed: ${e.message}`, true);
  }
}
async function testPane(p) {
  const a = adapterFor(p);
  if (!a) { note(`${p.label}: this site isn't set up. Click Teach.`, true); return; }
  try {
    const r = await run(p, pgCheck, a.input, a.reply);
    note(`${p.label} test: input box ${r.input ? 'found ✓' : 'NOT found ✗'} · ${r.count} repl${r.count === 1 ? 'y' : 'ies'} · latest: “${short(r.latest, 80)}”`, !r.input || !r.count);
  } catch (e) { note(`${p.label} test failed: ${e.message}`, true); }
}

// ---------- Typing into a site and waiting for its reply ----------
async function pressEnter(wv) {
  await wv.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  await wv.sendInputEvent({ type: 'char', keyCode: '\r' });
  await wv.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
}
async function typeAndSend(p, text, sendTries = 5) {
  const a = adapterFor(p);
  if (!a || !a.input) throw new Error(`${p.label} isn't set up for this site. Click Teach.`);
  const f = await run(p, pgFocusInput, a.input, true);
  if (!f.ok) throw new Error(`${p.label}: ${f.error}`);
  await sleep(150);
  // Literal paste, aimed at this site's own input box
  const r = await run(p, pgPaste, a.input, text);
  if (!r.ok) throw new Error(`${p.label}: couldn't paste into the input box`);
  await sleep(600);
  let clicked = false;
  if (a.send) for (let k = 0; k < sendTries && !clicked; k++) { clicked = await run(p, pgClickSend, a.send); if (!clicked) await sleep(500); }
  if (!clicked) { p.wv.focus(); await run(p, pgFocusInput, a.input, false); await pressEnter(p.wv); }
  await sleep(1500);
  const left = norm(await run(p, pgInputText, a.input));
  if (window.__dbg) console.log('[dbg] sent to ' + p.label + ' | boxes: ' + JSON.stringify(await Promise.all(panes.map((q) => run(q, pgInputText, '#box')))));
  if (left && norm(text).startsWith(left.slice(0, 40))) { p.wv.focus(); await run(p, pgFocusInput, a.input, false); await pressEnter(p.wv); }
  if (document.activeElement && /^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName)) window.api.hostFocus(); // give typing back to you
}
async function waitForReply(p, before, sent, abortable) {
  const a = adapterFor(p);
  const stable = (settings.stableSec || 2) * 1000;
  const fallback = (settings.fallbackSec || 12) * 1000;
  const limitMin = settings.timeoutMin || 8;
  const sentHead = norm(sent).slice(0, 60);
  const t0 = Date.now();
  let last = null, since = 0;
  for (;;) {
    if (abortable && R.stopReq) throw new Stop();
    if (Date.now() - t0 > limitMin * 60000) throw new Error(`${p.label} didn't finish replying within ${limitMin} min.`);
    await sleep(800);
    let r;
    try { r = await run(p, pgRead, a.reply, a.busy || ''); } catch { continue; }
    const t = r.text || '';
    const fresh = t && (r.count > before.count || t !== before.text) && !(sentHead && norm(t).startsWith(sentHead));
    if (!fresh || r.busy) { last = null; continue; }
    if (t !== last) { last = t; since = Date.now(); continue; }
    const done = /\bEND OF TURN\b/.test(t);
    if (Date.now() - since >= (done ? stable : fallback)) return t;
  }
}
async function readLatest(i) {
  const p = panes[i]; const a = adapterFor(p);
  if (!a) return '';
  const r = await run(p, pgRead, a.reply, '');
  return r.text || '';
}
async function sendAndWait(i, text, abortable = true, files = []) {
  const p = panes[i]; const a = adapterFor(p);
  if (!a) throw new Error(`${p.label} isn't set up for this site. Click Teach.`);
  const before = await run(p, pgRead, a.reply, a.busy || '');
  setPhase(`Sending to ${p.label}`);
  for (const f of files) {
    const r = await run(p, pgAttach, f.name, f.content, mimeFor(f.name));
    if (!r.ok) throw new Error(`${p.label}: couldn't attach ${f.name} (${r.error})`);
    await sleep(2500); // let the site finish uploading
  }
  await typeAndSend(p, text, files.length ? 40 : 5);
  setPhase(`Waiting for ${p.label}`);
  const out = await waitForReply(p, before, text, abortable);
  setPhase(R.on ? R.phase : 'Off');
  return out;
}

// ---------- Marker protocol ----------
function parseTurn(raw) {
  const t = String(raw || '').replace(/\r/g, '');
  const starts = [...t.matchAll(/([A-Z0-9][A-Z0-9_\-]*(?: [A-Z0-9][A-Z0-9_\-]*){0,2}) RESPONSE (\d{1,4}|#{1,4}|[A-Z0-9-]{1,8}) START\b/dg)];
  if (!starts.length) return null;
  const ends = [...t.matchAll(/RESPONSE (?:\d{1,4}|#{1,4}|[A-Z0-9-]{1,8}) END\b/g)];
  const lastEnd = ends.length ? ends[ends.length - 1].index : Infinity;
  const before = starts.filter((m) => m.index < lastEnd);
  const start = (before.length ? before : starts)[(before.length ? before : starts).length - 1];
  const from = start.indices[1][0];
  const after = start.index + start[0].length;
  const endRe = /RESPONSE (?:\d{1,4}|#{1,4}|[A-Z0-9-]{1,8}) END\b/g;
  endRe.lastIndex = after;
  const end = endRe.exec(t);
  const respEnd = end ? end.index + end[0].length : -1;
  const body = end ? t.slice(after, end.index) : t.slice(after);
  const tailOff = respEnd >= 0 ? respEnd : after;
  const tail = t.slice(tailOff);
  const ur = /(^|\n)[ \t>*#_`]*USER REQUESTS?\b[ \t*_`:]*/.exec(tail);
  const eot = /\bEND OF TURN\b/.exec(tail);
  const urStart = ur ? ur.index + ur[1].length : -1;
  const cut = ur ? tailOff + urStart : (eot ? tailOff + eot.index : t.length);
  const complete = /\bSESSION COMPLETE\b/.test(tail);
  let payload = t.slice(from, cut).replace(/\bSESSION COMPLETE\b/g, '').trimEnd();
  if (complete) payload += '\n\nSESSION COMPLETE';
  // File blocks become attachments: pull them out and leave a placeholder
  const files = [];
  payload = payload.replace(/FILE START:?[ \t]*([^\n]*)\n([\s\S]*?)\n[ \t>*_`]*FILE END\b/g, (_m, name, body) => {
    files.push({ name: fileName(name), content: cleanFileBody(body) });
    return `\u0000FILE${files.length - 1}\u0000`;
  });
  const rq = /(^|\n)[ \t>*#_`]*[A-Z0-9][A-Z0-9_\- ]*? REQUESTS [A-Z0-9][A-Z0-9_\- ]*?[ \t*_`:]*(?=\n|$)/.exec(tail);
  const rqEnd = ur ? urStart : (eot ? eot.index : tail.length);
  const requests = rq && rq.index < rqEnd ? tail.slice(rq.index + rq[0].length, rqEnd).trim() : '';
  let userRequest = '';
  if (ur) {
    const s = ur.index + ur[0].length;
    const e = eot && eot.index > s ? eot.index : tail.length;
    userRequest = tail.slice(s, e).replace(/\bSESSION COMPLETE\b/g, '').trim();
  }
  return {
    name: start[1], num: start[2], payload, files,
    response: body.replace(/[A-Z0-9_\- ]*$/, '').trim(),
    requests, userRequest, complete, hasEnd: !!eot
  };
}
// ---------- Files ----------
function fileName(n) {
  const v = String(n || '').replace(/[*_`]/g, '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '-');
  return v || 'file.txt';
}
function cleanFileBody(b) {
  let lines = String(b).replace(/\r/g, '').split('\n');
  // drop chat-site UI labels that innerText picks up at the top of code boxes ("html", "Copy code"…) and code fences
  for (let k = 0; k < 3 && lines.length; k++) {
    const l = lines[0].trim();
    if (/^```/.test(l) || /^(copy( code)?|copy|edit|run|download|[a-z0-9+#.-]{1,12})$/i.test(l) && !/[<{(;=]/.test(l)) lines.shift(); else break;
  }
  while (lines.length && /^(```|copy( code)?)$/i.test(lines[lines.length - 1].trim())) lines.pop();
  return lines.join('\n').trim() + '\n';
}
function mimeFor(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return ({ html: 'text/html', htm: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json', csv: 'text/csv', md: 'text/markdown', xml: 'application/xml', svg: 'image/svg+xml', py: 'text/x-python', ts: 'text/plain' })[ext] || 'text/plain';
}
function sessionDriveFolder() {
  if (!session) startNewSession();
  if (!session.driveFolder) {
    const d = new Date(session.created || Date.now()), z = (n) => String(n).padStart(2, '0');
    session.driveFolder = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}${z(d.getMinutes())} ${short(sessionTitle(), 40).replace(/[<>:"/\\|?*…]/g, '').trim()}`.trim();
    autosave();
  }
  return session.driveFolder;
}
async function saveReplyFiles(i, p) {
  for (const f of p.files || []) {
    const r = await window.api.driveSave({ folder: sessionDriveFolder(), name: `${String(p.num).replace(/#/g, '')}-${aiName(i)}-${f.name}`, content: f.content });
    if (r.ok) { f.saved = r; note(`Saved ${r.name} → ${r.onDrive ? 'Google Drive' : 'Documents (Drive for desktop not found)'}`); }
    else { f.saved = null; note(`Couldn't save ${f.name}: ${r.error}`, true); }
  }
}
// Build the outgoing text + attachments for a hop
function hopContent(parsed) {
  const files = (parsed.files || []).map((f) => ({ name: f.saved ? f.saved.name : f.name, content: f.content, saved: f.saved }));
  const text = parsed.payload.replace(/\u0000FILE(\d+)\u0000/g, (_m, k) => {
    const f = files[+k];
    return f ? `[File attached: ${f.name}${f.saved ? ' · saved in ' + f.saved.rel : ''}]` : '';
  });
  return { text, files };
}

function intro(i) {
  const rules = settings.framework.replaceAll('{ME}', aiName(i)).replaceAll('{OTHER}', aiName(1 - i));
  return R.task ? rules + '\n\nTASK:\n' + R.task : rules;
}

// ---------- Relay engine ----------
function refreshPendingNote() {}
function hidePending() {}

function setRelay(on, why) {
  if (on === R.on) { updateControls(); return; }
  R.on = on;
  if (on) {
    R.turn = 0; R.complete = [false, false]; stab[0] = stab[1] = null;
    for (const i of [0, 1]) if (!R.seen[i]) R.rebase[i] = true; // fresh: start from whatever is on screen now
    note(why || 'Relay on. Replies from either AI are copied to the other.');
  } else { note(why || 'Relay off.'); summarizeSoon(); }
  if (settings.auto !== on && !why) { settings.auto = on; saveSettings(); } // remember your choice (not auto-stops)
  updateControls();
  autosave();
}

// A reply counts as finished only if END OF TURN is the last thing in it (allowing a few chars of site UI)
const endsWithEot = (t) => { const k = t.lastIndexOf('END OF TURN'); return k >= 0 && t.slice(k + 11).trim().length <= 40; };

// Watch both panes; relay any reply that's finished and new
let ticking = false; // one check at a time, so a reply can never be sent twice
const working = [false, false];
const lastText = ['', ''];
async function tick() {
  if (R.busy || ticking) return;
  ticking = true;
  try { await tickOnce(); } finally { ticking = false; }
}
async function tickOnce() {
  const stableMs = Math.max(3, settings.stableSec || 2) * 1000;
  const fallbackMs = (settings.fallbackSec || 90) * 1000;
  for (const i of [0, 1]) {
    const p = panes[i]; const a = adapterFor(p);
    if (!a) continue;
    let r;
    try { r = await run(p, pgRead, a.reply, a.busy || ''); } catch { continue; }
    const t = r.text || '';
    const w = !!r.busy || (t !== lastText[i] && !!lastText[i]);
    lastText[i] = t;
    if (w !== working[i]) { working[i] = w; refreshBusy(); }
    if (!R.on) continue;
    if (R.rebase[i]) { R.seen[i] = norm(t); R.rebase[i] = false; stab[i] = null; continue; }
    if (!t || r.busy) { if (r.busy && t && norm(t) !== R.seen[i]) setPhase(`${label(i)} is working…`); stab[i] = null; continue; }
    const n = norm(t);
    if (n === R.seen[i]) continue;
    if (R.lastSent[i] && n.startsWith(R.lastSent[i])) { R.seen[i] = n; continue; } // our own paste echoed back
    if (!stab[i] || stab[i].t !== t) { stab[i] = { t, since: Date.now() }; setPhase(`${label(i)} is replying…`); continue; }
    const waitMs = endsWithEot(t) ? stableMs : fallbackMs;
    if (Date.now() - stab[i].since < waitMs) continue;
    // Final check: make sure the AI really is done (no new text, nothing running) before relaying
    setPhase(`Checking ${label(i)} is done…`);
    await sleep(3000);
    let r2;
    try { r2 = await run(p, pgRead, a.reply, a.busy || ''); } catch { continue; }
    if (r2.busy || r2.text !== t || r2.count !== r.count) { stab[i] = null; continue; }
    R.seen[i] = n; stab[i] = null;
    await relayFrom(i, t);
    return;
  }
  if (R.on && !R.busy) setPhase(working[0] || working[1] ? `${label(working[0] ? 0 : 1)} is working…` : 'On · waiting for a reply');
}

// "Safe to type" vs "Busy" + the live STATUS.md in Drive
const isBusy = () => R.busy || working[0] || working[1];
function refreshBusy() {
  const el = $('#busyLine');
  if (!el) return;
  const b = isBusy();
  const who = working[0] && working[1] ? 'Both AIs are working' : working[0] ? `${label(0)} (${aiName(0)}) is working` : working[1] ? `${label(1)} (${aiName(1)}) is working` : 'The relay is sending';
  el.textContent = b ? `Busy · ${who}. Hands off the chats.` : 'Safe to type in the chats.';
  el.className = 'busy-line ' + (b ? 'busy' : 'idle');
  pushStatus();
}
let statusTimer = null;
function pushStatus() {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    const openQ = questions.filter((q) => !q.answered);
    const lastNote = [...chatLog].reverse().find((m) => m.kind === 'sys' || m.kind === 'sys warn');
    window.api.statusUpdate({
      session: session ? sessionTitle() : (R.task || 'Untitled session'),
      relay: R.on ? 'ON' : 'OFF',
      phase: R.on ? R.phase : (isBusy() ? 'Relay off, but an AI is working' : 'Relay off'),
      busy: isBusy(),
      ai1: aiName(0), ai2: aiName(1),
      turn: R.on ? `${R.turn} of ${maxTurns()}` : '-',
      questions: openQ.map((q) => `Q${q.id} (${q.ai}): ${short(q.text, 140)}`).join(' | '),
      summary: short(summaryText, 400),
      last: lastNote ? `${short(lastNote.text, 120)} (${new Date().toLocaleTimeString()})` : ''
    });
  }, 1500);
}

// Copy one finished reply from pane i to the other pane
async function relayFrom(i, text, opts = {}) {
  R.busy = true;
  updateControls();
  try {
    const parsed = parseTurn(text);
    // Replies without the markers are passed through as they are
    const p = parsed || { name: aiName(i), num: '', payload: text.trim(), files: [], response: text, requests: '', userRequest: '', complete: false, hasEnd: false };
    addLog({ who: label(i), text, kind: 'reply', turn: R.turn, num: p.num });
    if (p.files && p.files.length) await saveReplyFiles(i, p);
    R.lastFrom = i;
    R.complete[i] = !!p.complete;
    const qBefore = questions.length;
    if (p.userRequest && !isNone(p.userRequest)) addQuestion(i, p.num, p.userRequest);
    if (!opts.force) {
      if (R.complete[0] && R.complete[1]) { setRelay(false, 'Both AIs wrote SESSION COMPLETE. Relay off.'); summarizeSoon(); return; }
      if (R.turn >= maxTurns()) { setRelay(false, `Reached ${maxTurns()} turns. Relay off. Turn it on to keep going.`); summarizeSoon(); return; }
      if ($('#pauseOnQ').checked && questions.length > qBefore) { setRelay(false, 'Relay off so you can answer the question. Turn it on when ready.'); return; }
    }
    const to = 1 - i;
    const hop = hopContent(p);
    let out = hop.text;
    if (!R.introduced[to]) out = intro(to) + `\n\nBelow is ${aiName(i)}'s latest reply.\n\n` + out;
    const answers = R.queued[to].splice(0);
    if (answers.length) out += '\n\nUSER RESPONSE\n' + answers.join('\n\n');
    await sendOnly(to, out, hop.files);
    R.introduced[to] = true;
    R.turn++;
    hopsSinceSummary++;
    if (hopsSinceSummary >= 2 || !summaryText) summarizeSoon();
    note(`Passed ${label(i)} → ${label(to)}${answers.length ? ' + your answer' : ''}${hop.files.length ? ` + ${hop.files.length} file${hop.files.length > 1 ? 's' : ''}` : ''}.`);
  } catch (e) {
    note('Error: ' + e.message, true);
    if (R.on) setRelay(false, 'Relay off because of the error above. Fix it and turn the relay back on.');
  } finally {
    R.busy = false;
    updateControls();
    autosave();
  }
}

// Paste text (and attach files) into pane i and send it. Doesn't wait for the reply: the watcher catches it.
async function sendOnly(i, text, files = []) {
  const p = panes[i]; const a = adapterFor(p);
  if (!a) throw new Error(`${p.label} isn't set up for this site. Click Teach.`);
  // don't interrupt an AI that's still working
  const limit = Date.now() + (settings.timeoutMin || 60) * 60000;
  for (;;) {
    const r = await run(p, pgRead, a.reply, a.busy || '');
    if (!r.busy) break;
    if (Date.now() > limit) throw new Error(`${p.label} was still busy, so nothing was sent.`);
    setPhase(`Waiting for ${p.label} to finish before sending`);
    await sleep(1500);
  }
  setPhase(`Sending to ${p.label}`);
  for (const f of files) {
    const r = await run(p, pgAttach, f.name, f.content, mimeFor(f.name));
    if (!r.ok) throw new Error(`${p.label}: couldn't attach ${f.name} (${r.error})`);
    await sleep(2500);
  }
  R.lastSent[i] = norm(text).slice(0, 60);
  await typeAndSend(p, text, files.length ? 40 : 5);
}

// Called when a pane moves to a different chat: start fresh there
function paneChatChanged(i) {
  R.rebase[i] = true;
  R.introduced[i] = false;
  stab[i] = null;
  autosave();
}

// ---------- Questions ----------
function similarText(a, b) {
  const words = (x) => new Set(norm(x).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(' ').filter((w) => w.length > 2));
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return false;
  let hit = 0; A.forEach((w) => { if (B.has(w)) hit++; });
  return hit / Math.min(A.size, B.size) >= 0.6;
}
function addQuestion(i, num, text) {
  const dup = questions.find((q) => !q.answered && q.from === i && similarText(q.text, text));
  if (dup) { dup.text = text; dup.num = num; return; } // same question asked again: don't repeat it
  const q = { id: questions.length + 1, from: i, ai: aiName(i), num, text, answered: false };
  questions.push(q);
  modMsg('q', `Q${q.id} · ${q.ai} asks:\n${text}`);

}
function renderQuestions() {}

// ---------- Log ----------
function addLog(e) {
  e.time = new Date();
  logEntries.push(e);
  autosave();
}
function note(msg, warn) {
  if (warn) recordError(msg);
  modMsg(warn ? 'sys warn' : 'sys', msg);
}
function transcript(maxChars = 40000, per = 4000) {
  const lines = logEntries.map((e) => {
    let head;
    if (e.kind === 'setup') return `[You started the task with ${e.to}]\nTask: ${R.task}`;
    if (e.kind === 'reply') head = `[${e.turn ? 'Turn ' + e.turn + ' · ' : ''}${e.who} (${aiName(paneIdx(e.who))})]`;
    else head = `[${e.who}${e.to ? ' → ' + e.to : ''}]`;
    const t = e.text.length > per ? e.text.slice(0, per) + ' …[truncated]' : e.text;
    return `${head}\n${t}`;
  });
  let out = lines.join('\n\n');
  if (out.length > maxChars) out = '…[earlier turns omitted]\n\n' + out.slice(-maxChars);
  return out;
}

// ---------- Status ----------
function setPhase(t) {
  const changed = R.phase !== t;
  R.phase = t;
  if (changed) setTimeout(refreshBusy, 0);
  const el = $('#phase');
  el.textContent = R.on ? t : 'Off';
  el.className = 'phase ' + (R.on ? 'live' : 'idle');
  const rp = $('#relayPhase');
  if (rp) rp.textContent = R.on ? `${t} · turn ${R.turn} of ${maxTurns()}` : "Replies aren't being copied.";
}
function updateControls() {
  const b = $('#relayBtn');
  b.textContent = R.on ? 'Stop' : 'Start';
  b.classList.toggle('stop', R.on);
  $('#relayState').textContent = R.on ? 'Relay ON' : 'Relay OFF';
  $('#relayDot').classList.toggle('on', R.on);
  $('.relaycard').classList.toggle('on', R.on);
  $('#turnInfo').textContent = R.on ? `Turn ${R.turn} of ${maxTurns()}` : '';
  setPhase(R.on ? (R.busy ? R.phase : 'On · waiting for a reply') : 'Off');
}

// ---------- Summary ----------
let sumTimer = null, sumBusy = false, sumAgain = false, hopsSinceSummary = 0;
function summarizeSoon() {
  if (sumBusy) { sumAgain = true; return; }
  clearTimeout(sumTimer);
  sumTimer = setTimeout(summarize, 600);
}
async function summarize() {
  if (!logEntries.some((e) => e.kind === 'reply')) { $('#summary').textContent = 'Nothing yet. This updates after every 2 passes.'; return; }
  if (!settings.apiKey) { $('#summary').textContent = 'Add an Anthropic API key in ⚙ Settings to get the summary.'; return; }
  sumBusy = true;
  $('#sumState').textContent = 'updating…';
  const res = await window.api.call({
    model: settings.sumModel, max_tokens: 250,
    system: 'Two AI assistants are working on a task for Justin; the app relays their replies between them. Write a short, plain statement of where things stand right now: 1 to 3 sentences, no headings, no bullets, no preamble. He reads it at a glance on the go.',
    messages: [{ role: 'user', content: `Task: ${R.task || '(none)'}\n\nOpen questions for Justin: ${questions.filter((q) => !q.answered).map((q) => 'Q' + q.id + ' ' + short(q.text, 120)).join(' | ') || 'none'}\n\nTranscript:\n${transcript(40000, 4000)}` }]
  });
  sumBusy = false;
  $('#sumState').textContent = '';
  if (res.error) { recordError('Summary API: ' + res.error); $('#summary').textContent = `Couldn't update the summary: ${res.error}`; }
  else hopsSinceSummary = 0;
  if (!res.error) {
    summaryText = res.data.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    renderSummary();
    autosave();
  }
  if (sumAgain) { sumAgain = false; summarizeSoon(); }
}
function renderSummary() {
  const el = $('#summary');
  el.textContent = summaryText || 'Nothing yet.';
  el.classList.toggle('muted', !summaryText);
}

// ---------- Moderator agent ----------
const MOD_TOOLS = [
  { name: 'answer_questions',
    description: "Record Justin's answer. It is attached as a USER RESPONSE block to the next message each target AI receives. Write the answer so it stands on its own (briefly restate what it answers). Mark which questions it resolves.",
    input_schema: { type: 'object', properties: {
      answer: { type: 'string', description: "Justin's answer, written clearly" },
      question_ids: { type: 'array', items: { type: 'integer' }, description: 'Ids of the questions this resolves (Q numbers), if any' },
      to: { type: 'string', enum: ['both', 'ai1', 'ai2'], description: 'Default both' },
      deliver_now: { type: 'boolean', description: 'Type it into the site(s) right away. Only works when the relay is not running.' }
    }, required: ['answer'] } },
  { name: 'relay_control',
    description: 'Turn the relay on (replies from either AI get copied to the other) or off.',
    input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['on', 'off'] } }, required: ['action'] } },
  { name: 'relay_latest',
    description: "Pick up a conversation: copy the latest reply currently in one pane over to the other AI right now (with the relay rules if that AI hasn't had them). Use when Justin wants to restart or nudge things, e.g. 'send Claude's last reply to ChatGPT'. Checks first that the source AI has finished working.",
    input_schema: { type: 'object', properties: { from_pane: { type: 'integer', enum: [1, 2] } }, required: ['from_pane'] } },
  { name: 'check_panes', description: "Check whether each AI is idle or still working (stop button, streaming, text still changing), and whether its latest reply ends with END OF TURN. Use before acting, and when Justin asks if something is stuck.",
    input_schema: { type: 'object', properties: {} } },
  { name: 'read_pane', description: 'Read the latest reply currently shown in a pane.',
    input_schema: { type: 'object', properties: { pane: { type: 'integer', enum: [1, 2] } }, required: ['pane'] } },
  { name: 'send_to_pane',
    description: "Type your own separate message into a pane and send it (not part of the word-for-word relay). Waits until that AI is idle. Its reply is then handled like any other reply.",
    input_schema: { type: 'object', properties: { pane: { type: 'integer', enum: [1, 2] }, text: { type: 'string' } }, required: ['pane', 'text'] } },
  { name: 'set_options', description: 'Change relay options.',
    input_schema: { type: 'object', properties: { max_turns: { type: 'integer' }, pause_on_question: { type: 'boolean' } } } }
];

function relayStatus() {
  return R.on ? `ON (${R.phase}), turn ${R.turn} of ${maxTurns()}` : 'OFF';
}
async function paneState(i) {
  const p = panes[i]; const a = adapterFor(p);
  if (!a) return { pane: label(i), ai: aiName(i), setup: false };
  const r1 = await run(p, pgRead, a.reply, a.busy || '');
  await sleep(2000);
  const r2 = await run(p, pgRead, a.reply, a.busy || '');
  const changing = r1.text !== r2.text || r1.count !== r2.count;
  return { pane: label(i), ai: aiName(i), working: !!(r2.busy || changing), stop_button_or_streaming: !!r2.busy, text_still_changing: changing, latest_ends_with_END_OF_TURN: endsWithEot(r2.text || ''), already_relayed: norm(r2.text) === R.seen[i] };
}
function modSystem() {
  const openQ = questions.filter((q) => !q.answered);
  const doneQ = questions.filter((q) => q.answered);
  return `You are the moderator inside "Journey Relay", Justin's desktop app that relays a conversation between two AI chat websites.
AI 1 = ${aiName(0)} (${curUrl(panes[0])}). AI 2 = ${aiName(1)} (${curUrl(panes[1])}).

How it works: the relay is one switch. When it's ON, every finished reply from either AI is copied to the other AI (it only counts as finished when END OF TURN is the last thing in it and the page shows no sign of the AI still working). Justin can also type into either chat himself at any time. Each AI gets the relay rules once, with its first relayed message. Each AI replies in a fixed format (NAME RESPONSE ### START / END, a NAME REQUESTS OTHER block, a USER REQUEST block, END OF TURN). The app copies the RESPONSE and REQUESTS blocks word-for-word to the other AI. Questions from USER REQUEST blocks are shown to Justin in this chat (as Q1, Q2…) and listed below.

Your job: Justin messages you here, usually on the go. Keep replies short and plain.
- Justin answers questions loosely: right away, later, several at once, or in passing. When a message answers something, call answer_questions with a clear standalone answer, the matching question_ids, and to="both" unless he says otherwise. Do not use deliver_now unless he asks to send it without continuing the relay.
- Answers ride along with the next message each AI receives. If the relay is OFF and Justin wants things moving again, turn it on; if nothing new is coming (both AIs are waiting), use relay_latest to send the last reply across so his answer goes out with it.
- To pick up a conversation, use relay_latest from the side that spoke last.
- Before sending anything or saying an AI is done, call check_panes. Never send to an AI that is still working, even if it already wrote END OF TURN.
- Anything you send to the AIs (answers, your own messages, edits, a new task) shows Justin an approval card with the exact text, and nothing goes out until he clicks Send (he may edit it first). Just call the tool; don't ask for permission in text first. If he declines, ask what he'd like instead.
- Turn the relay on or off when he asks.
- When he asks where things stand, answer from the summary and transcript.
- Push back when the two AIs loop, drift off task, or miss something, and tell him.

Relay: ${relayStatus()}
Safe for Justin to type in the chats: ${isBusy() ? 'NO (an AI is working or the relay is sending)' : 'yes'}
Goal: ${R.task || '(none set)'}
Answers waiting to be delivered: AI 1 ${R.queued[0].length}, AI 2 ${R.queued[1].length}

Open questions:
${openQ.map((q) => `Q${q.id} [${q.ai}, response ${q.num}]: ${q.text}`).join('\n') || '(none)'}
Answered:
${doneQ.map((q) => `Q${q.id}: ${short(q.text, 100)}`).join('\n') || '(none)'}

Status summary:
${summaryText || '(none yet)'}

Transcript (latest last):
${transcript(30000, 3000) || '(empty)'}`;
}

async function runTool(name, x) {
  const P = (n) => { const p = panes[(n | 0) - 1]; if (!p) throw new Error('pane must be 1 or 2'); return p; };
  switch (name) {
    case 'answer_questions': {
      const to = x.to || 'both';
      const targets = to === 'both' ? [0, 1] : [/1$/.test(to) ? 0 : 1];
      const ids = Array.isArray(x.question_ids) ? x.question_ids : [];
      const ok = await askApproval(`Your answer → ${targets.map((i) => `${label(i)} (${aiName(i)})`).join(' + ')}`, x.answer);
      if (!ok.ok) return DECLINED;
      x.answer = ok.text;
      targets.forEach((i) => R.queued[i].push(x.answer));
      ids.forEach((id) => { const q = questions.find((q) => q.id === id); if (q) q.answered = true; });
      renderQuestions(); refreshPendingNote(); autosave();
      addLog({ who: 'You', to: targets.map(label).join(' + '), text: x.answer, kind: 'answer' });
      if (x.deliver_now) {
        if (R.on) return { queued: true, note: 'The relay is on, so it goes out with the next message to each side.' };
        for (const i of targets) {
          const t = R.queued[i].splice(0);
          if (t.length) await sendOnly(i, 'USER RESPONSE\n' + t.join('\n\n'));
        }
        return { delivered: true, to: targets.map(label) };
      }
      return { queued: true, delivers: 'with the next message each target AI receives', resolved: ids, edited_by_justin: ok.edited ? ok.text : undefined };
    }
    case 'relay_control':
      setRelay(x.action === 'on');
      return { relay: R.on ? 'on' : 'off' };
    case 'check_panes':
      return { relay: relayStatus(), panes: await Promise.all([0, 1].map(paneState)) };
    case 'relay_latest': {
      const from = (x.from_pane | 0) - 1;
      if (from !== 0 && from !== 1) return { error: 'from_pane must be 1 or 2' };
      if (R.busy) return { error: 'The relay is busy sending. Try again in a moment.' };
      const st = await paneState(from);
      if (st.working) return { error: `${label(from)} (${aiName(from)}) is still working. Wait until it's done.`, state: st };
      const text = await readLatest(from);
      if (!text) return { error: `${label(from)} has no reply on screen.` };
      const ok = await askApproval(`Send ${label(from)}'s latest reply → ${label(1 - from)} (${aiName(1 - from)})`, text);
      if (!ok.ok) return DECLINED;
      R.seen[from] = norm(text);
      await relayFrom(from, ok.text, { force: true });
      return { sent: true, to: label(1 - from) };
    }
    case 'read_pane': {
      const p = P(x.pane); const a = adapterFor(p);
      if (!a) return { error: `${p.label} isn't set up. Ask Justin to click Teach.` };
      const r = await run(p, pgRead, a.reply, '');
      return { pane: p.label, reply_count: r.count, latest_reply: (r.text || '').slice(0, 10000) };
    }
    case 'send_to_pane': {
      const p = P(x.pane);
      const ok = await askApproval(`Message → ${p.label} (${aiName(p.i)})`, x.text);
      if (!ok.ok) return DECLINED;
      addLog({ who: 'Moderator', to: p.label, text: ok.text, kind: 'moderator' });
      await sendOnly(p.i, ok.text);
      return { sent: true, note: R.on ? 'Its reply will be relayed like any other.' : 'The relay is off, so its reply stays in that chat.' };
    }
    case 'set_options':
      if (x.max_turns) $('#maxTurns').value = x.max_turns;
      if (typeof x.pause_on_question === 'boolean') $('#pauseOnQ').checked = x.pause_on_question;
      updateControls();
      return { ok: true, max_turns: maxTurns(), pause_on_question: $('#pauseOnQ').checked };
  }
  return { error: 'Unknown tool' };
}

// Anything the moderator wants to send to the AIs waits for Justin's OK here
function askApproval(title, text) {
  return new Promise((resolve) => {
    const box = $('#modChat');
    const empty = $('.empty', box); if (empty) empty.remove();
    const d = document.createElement('div');
    d.className = 'm approve';
    d.innerHTML = `<div class="ap-title"></div><textarea class="ap-text" rows="4"></textarea><div class="row btns"><button class="primary ap-ok">Send</button><button class="ap-no">Don't send</button></div>`;
    $('.ap-title', d).textContent = title;
    const ta = $('.ap-text', d);
    ta.value = text;
    ta.rows = Math.min(12, Math.max(3, text.split('\n').length + 1));
    box.appendChild(d);
    box.scrollTop = 1e9;
    const done = (ok) => {
      const finalText = ta.value;
      // collapse to a one-line record; click it to see the text
      d.innerHTML = '<details><summary class="ap-title"></summary><div class="ap-body"></div></details>';
      $('.ap-title', d).textContent = `${ok ? 'Sent' : 'Not sent'} · ${title}`;
      $('.ap-body', d).textContent = finalText;
      d.classList.add(ok ? 'ok' : 'no');
      chatLog.push({ kind: 'tool', text: `${ok ? 'Approved' : 'Declined'}: ${title} — ${short(finalText, 200)}` });
      autosave();
      resolve(ok ? { ok: true, text: finalText, edited: finalText !== text } : { ok: false });
    };
    $('.ap-ok', d).onclick = () => done(true);
    $('.ap-no', d).onclick = () => done(false);
  });
}
const DECLINED = { declined: true, note: 'Justin chose not to send this. Ask him what he wants instead.' };

const modHistory = [];
let modBusy = false;
function md(s) {
  let h = esc(s);
  h = h.replace(/```([\s\S]*?)```/g, (_, c) => `<pre>${c.trim()}</pre>`);
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/^#{1,4} (.*)$/gm, '<b>$1</b>');
  h = h.replace(/^\s*[-•*] (.*)$/gm, '<li>$1</li>');
  h = h.replace(/(?:<li>.*<\/li>\n?)+/g, (m) => `<ul>${m.replace(/\n/g, '')}</ul>`);
  return h.replace(/\n/g, '<br>');
}
function modMsg(kind, text) {
  if (!restoring) { chatLog.push({ kind, text }); autosave(); }
  const box = $('#modChat');
  const empty = $('.empty', box); if (empty) empty.remove();
  const d = document.createElement('div');
  d.className = 'm ' + kind;
  if (kind === 'ai') d.innerHTML = md(text); else d.textContent = text;
  box.appendChild(d);
  box.scrollTop = 1e9;
}
function cleanHistory() {
  // Keep history valid: start on a plain user message, end on a finished assistant turn
  while (modHistory.length && modHistory[modHistory.length - 1].role === 'user') modHistory.pop();
  const last = modHistory[modHistory.length - 1];
  if (last && Array.isArray(last.content) && last.content.some((c) => c.type === 'tool_use')) modHistory.pop();
}
// Repair the moderator's history before every call: a restart, update or session switch in the
// middle of a tool call can leave a tool request without its result, which the API rejects.
function sanitizeHistory(h) {
  const out = [];
  for (let k = 0; k < h.length; k++) {
    const m = h[k];
    const isArr = Array.isArray(m.content);
    if (m.role === 'assistant' && isArr && m.content.some((c) => c.type === 'tool_use')) {
      const ids = m.content.filter((c) => c.type === 'tool_use').map((c) => c.id);
      const nx = h[k + 1];
      const paired = nx && nx.role === 'user' && Array.isArray(nx.content) && ids.every((id) => nx.content.some((c) => c.type === 'tool_result' && c.tool_use_id === id));
      if (paired) { out.push(m, nx); k++; continue; }
      const txt = m.content.filter((c) => c.type === 'text' && c.text);
      if (txt.length) out.push({ role: 'assistant', content: txt });
      continue;
    }
    if (m.role === 'user' && isArr && m.content.length && m.content.every((c) => c.type === 'tool_result')) continue; // orphaned results
    out.push(m);
  }
  const asArr = (c) => (typeof c === 'string' ? [{ type: 'text', text: c }] : c);
  const merged = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content = [...asArr(last.content), ...asArr(m.content)];
    else merged.push({ role: m.role, content: m.content });
  }
  while (merged.length && merged[0].role !== 'user') merged.shift();
  return merged;
}
function trimmedHistory() {
  return sanitizeHistory(modHistory.slice(-40));
}
const TOOL_LABEL = { answer_questions: 'Recorded your answer', relay_control: 'Relay', relay_latest: 'Picked up the conversation', check_panes: 'Checked both AIs', read_pane: 'Read pane', send_to_pane: 'Sent message to pane', set_options: 'Updated options' };
async function moderatorSend(text) {
  if (modBusy || !text.trim()) return;
  if (!settings.apiKey) { modMsg('err', 'Add an Anthropic API key in ⚙ Settings to use the moderator.'); return; }
  modBusy = true; $('#modSend').disabled = true;
  modMsg('you', text);
  modHistory.push({ role: 'user', content: text });
  try {
    for (let step = 0; step < 10; step++) {
      const res = await window.api.call({ model: settings.modModel, max_tokens: 1500, system: modSystem(), tools: MOD_TOOLS, messages: trimmedHistory() });
      if (res.error) { recordError('Moderator API: ' + res.error); modMsg('err', res.error); cleanHistory(); return; }
      const data = res.data;
      modHistory.push({ role: 'assistant', content: data.content });
      const said = data.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      if (said) modMsg('ai', said);
      const uses = data.content.filter((c) => c.type === 'tool_use');
      if (data.stop_reason !== 'tool_use' || !uses.length) return;
      const results = [];
      for (const u of uses) {
        modMsg('tool', TOOL_LABEL[u.name] === 'Relay' ? `Relay: ${u.input.action}` : (TOOL_LABEL[u.name] || u.name));
        let out;
        try { out = await runTool(u.name, u.input || {}); } catch (e) { out = { error: e.message }; }
        results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 12000) });
      }
      modHistory.push({ role: 'user', content: results });
    }
  } catch (e) {
    modMsg('err', e.message); cleanHistory();
  } finally {
    modBusy = false; $('#modSend').disabled = false;
  }
}

// ---------- Settings ----------
async function saveSettings() { await window.api.saveSettings(settings); }
function openSettings() {
  $('#sApiKey').value = settings.apiKey || '';
  $('#sModModel').value = settings.modModel;
  $('#sSumModel').value = settings.sumModel;
  $('#sUrl0').value = settings.urls[0] || '';
  $('#sUrl1').value = settings.urls[1] || '';
  $('#sStable').value = settings.stableSec;
  $('#sFallback').value = settings.fallbackSec;
  $('#sTimeout').value = settings.timeoutMin;
  $('#sFramework').value = settings.framework;
  $('#sAdapters').value = JSON.stringify(settings.adapters, null, 2);
  $('#sRepo').value = settings.updateRepo || '';
  $('#sToken').value = settings.githubToken || '';
  $('#settingsErr').textContent = '';
  setPanesVisible(false);
  $('#settings').showModal();
}
async function submitSettings(e) {
  e.preventDefault();
  let adapters;
  try { adapters = JSON.parse($('#sAdapters').value || '{}'); } catch { $('#settingsErr').textContent = 'Taught sites is not valid JSON.'; return; }
  Object.assign(settings, {
    apiKey: $('#sApiKey').value.trim(),
    modModel: $('#sModModel').value.trim() || settings.modModel,
    sumModel: $('#sSumModel').value.trim() || settings.sumModel,
    urls: [$('#sUrl0').value.trim(), $('#sUrl1').value.trim()],
    stableSec: +$('#sStable').value || 2,
    fallbackSec: +$('#sFallback').value || 12,
    timeoutMin: +$('#sTimeout').value || 8,
    framework: $('#sFramework').value.trim() || settings.framework,
    adapters,
    updateRepo: $('#sRepo').value.trim() || settings.updateRepo,
    githubToken: $('#sToken').value.trim()
  });
  await saveSettings();
  panes.forEach(refreshPane);
  $('#settings').close();
}

// ---------- Export / new session ----------
function exportTranscript() {
  const lines = [`# Journey Relay session — ${new Date().toLocaleString()}`, '', `**Task:** ${R.task || '(none)'}`, `**AI 1:** ${aiName(0)} · **AI 2:** ${aiName(1)}`, ''];
  if (summaryText) lines.push('## Summary', '', summaryText, '');
  if (questions.length) { lines.push('## Questions', ''); questions.forEach((q) => lines.push(`- Q${q.id} (${q.ai})${q.answered ? ' ✓' : ''}: ${q.text.replace(/\n/g, ' ')}`)); lines.push(''); }
  lines.push('## Transcript', '');
  logEntries.forEach((e) => lines.push(`### ${e.who}${e.to ? ' → ' + e.to : ''}${e.turn ? ' (turn ' + e.turn + ')' : ''} · ${e.time.toLocaleTimeString()}`, '', '```', e.text, '```', ''));
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `relay-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function newSession() {
  if (R.busy) { note('Wait a moment: the relay is sending.', true); return; }
  session = null; chatLog.length = 0; $('#task').value = '';
  logEntries.length = 0; questions.length = 0; summaryText = ''; modHistory.length = 0;
  R.turn = 0; R.task = ''; R.queued = [[], []]; R.lastFrom = null; R.introduced = [false, false];
  R.seen = ['', '']; R.rebase = [true, true];
  updateControls();
  refreshSessionList();
  renderSummary();
  $('#modChat').innerHTML = '<div class="empty">New session.</div>';
}

// ---------- Debug report ----------
async function debugReport() {
  const info = await window.api.info();
  const lines = [`JOURNEY RELAY DEBUG REPORT · v${info.version} · ${info.platform} · Electron ${info.electron} · ${new Date().toLocaleString()}`, ''];
  for (const p of panes) {
    const a = adapterFor(p);
    lines.push(`${p.label} (${aiName(p.i)}): ${curUrl(p)}`);
    lines.push(`  setup: ${a ? (a.source === 'taught' ? 'taught' : 'preset ' + a.name) : 'NOT SET UP'}`);
    if (a) {
      lines.push(`  selectors: input=${a.input} | reply=${a.reply} | send=${a.send || '(Enter)'} | busy=${a.busy || '-'}`);
      try {
        const r = await run(p, pgCheck, a.input, a.reply);
        lines.push(`  test: input ${r.input ? 'found' : 'NOT found'} · ${r.count} replies · latest: "${short(r.latest, 200)}"`);
        const parsed = parseTurn(r.latest);
        lines.push(`  latest reply format: ${parsed ? `OK (${parsed.name} ${parsed.num}${parsed.hasEnd ? ', END OF TURN' : ', no END OF TURN'})` : 'markers NOT found'}`);
      } catch (e) { lines.push('  test failed: ' + e.message); }
    }
  }
  const drv = await window.api.driveInfo();
  lines.push('', `Google Drive folder: ${drv.found ? drv.root : 'NOT FOUND (files go to Documents/Journey Relay)'} · session folder: ${session && session.driveFolder || '-'} · sessions saved ${drv.found ? 'in Drive (Journey Relay/_sessions)' : 'on this computer only'} · computer: ${myHost}`);
  lines.push(`Busy: ${isBusy() ? 'YES' : 'no'} (AI 1 working: ${working[0]}, AI 2 working: ${working[1]}, sending: ${R.busy})`);
  lines.push(`Relay: ${relayStatus()}
Safe for Justin to type in the chats: ${isBusy() ? 'NO (an AI is working or the relay is sending)' : 'yes'} · task: ${short(R.task, 120) || '(none)'}`);
  lines.push(`Questions: ${questions.length} (${questions.filter((q) => !q.answered).length} open) · queued answers: AI 1 ${R.queued[0].length}, AI 2 ${R.queued[1].length}`);
  lines.push(`Settings: stable ${settings.stableSec}s · no-marker ${settings.fallbackSec}s · timeout ${settings.timeoutMin}m · API key ${settings.apiKey ? 'set' : 'MISSING'} · models ${settings.modModel} / ${settings.sumModel}`);
  lines.push('', 'Recent errors:', ...(errors.length ? errors.slice(-20) : ['(none)']));
  lines.push('', 'Last log entries:', ...logEntries.slice(-8).map((e) => `  ${e.kind} · ${e.who}${e.to ? ' → ' + e.to : ''}: ${short(e.text, 160)}`));
  return lines.join('\n');
}

// ---------- Updates ----------
async function checkUpdate(silent) {
  const r = await window.api.checkUpdate();
  $('#version').textContent = 'v' + r.current;
  if (r.available) {
    const b = $('#updateBtn');
    b.textContent = `Update to v${r.latest}`;
    b.title = r.notes || '';
    b.classList.remove('hidden');
  } else if (!silent) {
    note(r.error ? `Update check: ${r.error}` : `You're on the latest version (v${r.current}).`, !!r.error);
  }
}
async function applyUpdate() {
  if (R.busy) { note('Wait a moment: the relay is sending.', true); return; }
  const b = $('#updateBtn');
  b.disabled = true; b.textContent = 'Updating…';
  const r = await window.api.applyUpdate();
  if (r.error) { note('Update failed: ' + r.error, true); b.disabled = false; b.textContent = 'Retry update'; }
  else b.textContent = `Restarting on v${r.version}…`;
}

// ---------- Sessions: autosaved with a date, restored on restart ----------
let session = null;          // { id, created }
let myHost = '';
const chatLog = [];          // moderator chat, for restoring
let restoring = false;
let saveTimer = null;
function makeSessionId() {
  const d = new Date(), z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}
function startNewSession() { session = { id: makeSessionId(), created: new Date().toISOString() }; }
function snapshot() {
  return {
    id: session.id, created: session.created, updated: new Date().toISOString(), driveFolder: session.driveFolder || '', name: session.name || '',
    title: short(sessionTitle(), 90), task: R.task, urls: panes.map(curUrl), introduced: R.introduced, lastFrom: R.lastFrom, queued: R.queued, seen: R.seen,
    questions, summaryText, chatLog: chatLog.slice(-300), modHistory: modHistory.slice(-60),
    logEntries: logEntries.map((e) => ({ ...e, time: e.time instanceof Date ? e.time.toISOString() : e.time }))
  };
}
const sessionTitle = () => (session && session.name) || R.task || (chatLog.find((m) => m.kind === 'you') || {}).text || 'Untitled';
const hasActivity = () => !!R.task || logEntries.length > 0 || chatLog.some((m) => m.kind === 'you');
function autosave(force) {
  if (restoring || (!force && !hasActivity())) return;
  if (!session) startNewSession();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => { await window.api.saveSession(snapshot()); refreshSessionList(); }, 700);
}
function sessionLabel(x) {
  const d = new Date(x.created || x.updated);
  const when = isNaN(d) ? x.id : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `${when} · ${short(x.title || x.task || 'Untitled', 50)}`;
}
async function refreshSessionList() {
  const list = await window.api.listSessions();
  const sel = $('#sessionSel');
  sel.innerHTML = '<option value="">New session</option>' + list.map((x) => `<option value="${esc(x.id)}">${esc(sessionLabel(x))}</option>`).join('');
  sel.value = session && list.some((x) => x.id === session.id) ? session.id : '';
  const cur = session && list.find((x) => x.id === session.id);
  document.title = cur ? `Journey Relay · ${sessionLabel(cur)}` : 'Journey Relay';
  updateSessionName();
}
function updateSessionName() {
  const el = $('#sessionName');
  if (!el) return;
  el.textContent = session || R.task ? sessionTitle() : 'New session';
  const d = session && new Date(session.created);
  $('#sessionDate').textContent = d && !isNaN(d) ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
}
function applySession(j, loadUrls) {
  restoring = true;
  session = { id: j.id, created: j.created, driveFolder: j.driveFolder || '', name: j.name || '' };
  R.task = j.task || ''; R.introduced = j.introduced || [false, false]; R.lastFrom = j.lastFrom ?? null;
  R.queued = j.queued || [[], []]; R.turn = 0; R.complete = [false, false];
  R.seen = j.seen || ['', '']; R.rebase = [!R.seen[0], !R.seen[1]];
  questions.length = 0; (j.questions || []).forEach((q) => questions.push(q));
  logEntries.length = 0; (j.logEntries || []).forEach((e) => logEntries.push({ ...e, time: new Date(e.time) }));
  summaryText = j.summaryText || ''; renderSummary();
  modHistory.length = 0; (j.modHistory || []).forEach((m) => modHistory.push(m));
  $('#modChat').innerHTML = '';
  chatLog.length = 0;
  (j.chatLog || []).forEach((m) => { modMsg(m.kind, m.text); chatLog.push(m); });
  if (!chatLog.length) $('#modChat').innerHTML = '<div class="empty">Session restored.</div>';
  $('#task').value = R.task;
  if (loadUrls) (j.urls || []).forEach((u, i) => { if (u && /^https?:/.test(u) && u !== curUrl(panes[i])) { try { panes[i].wv.loadURL(u); } catch {} } });
  restoring = false;
  updateControls();
  updateSessionName();
  if (!summaryText && logEntries.some((e) => e.kind === 'reply')) summarizeSoon();
}
function warnIfActiveElsewhere(j) {
  const a = j && j.activeOn;
  if (!a || !a.host || a.host === myHost) return;
  const mins = (Date.now() - new Date(a.at).getTime()) / 60000;
  if (mins < 5) note(`Heads up: this session was active on ${a.host} ${Math.max(1, Math.round(mins))} min ago. Using it on two computers at once can mix things up.`, true);
}
async function switchSession(id) {
  if (R.busy) { note('Wait a moment: the relay is sending.', true); refreshSessionList(); return; }
  if (!id) { newSession(); return; }
  const j = await window.api.loadSession(id);
  if (!j) { note('Could not open that session.', true); return; }
  applySession(j, true);
  warnIfActiveElsewhere(j);
  refreshSessionList();
}

// ---------- Wire up ----------
async function init() {
  settings = await window.api.getSettings();
  settings.adapters = settings.adapters || {};
  settings.names = settings.names || ['', ''];
  const fresh = new URLSearchParams(location.search).get('fresh') === '1';
  const list = fresh ? [] : await window.api.listSessions();
  const last = list.length ? await window.api.loadSession(list[0].id) : null;
  buildPanes(last && last.urls);
  if (last) applySession(last, false);
  myHost = await window.api.host();
  if (last) warnIfActiveElsewhere(last);
  $('#sessionSel').onchange = (e) => switchSession(e.target.value);
  // ☰ Relay menu (sits over the side panel only, so it never hides behind the site panes)
  const menu = $('#relayMenu'), menuBtn = $('#menuBtn');
  const setMenu = (open) => { menu.classList.toggle('hidden', !open); menuBtn.classList.toggle('open', open); menuBtn.setAttribute('aria-expanded', String(open)); if (open) $('#task').focus(); };
  menuBtn.onclick = () => setMenu(menu.classList.contains('hidden'));
  $('#menuClose').onclick = () => setMenu(false);
  $('#phase').onclick = () => setMenu(true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.classList.contains('hidden')) setMenu(false); });
  document.addEventListener('mousedown', (e) => { if (!menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== menuBtn) setMenu(false); });
  window.__setMenu = setMenu;
  $('#newWinBtn').onclick = () => window.api.newWindow();
  // Rename the current session
  const showRename = (on) => { $('#renameRow').classList.toggle('hidden', !on); if (on) { $('#renameInput').value = session ? sessionTitle() : (R.task || ''); $('#renameInput').focus(); $('#renameInput').select(); } };
  $('#renameBtn').onclick = () => showRename($('#renameRow').classList.contains('hidden'));
  $('#renameCancel').onclick = () => showRename(false);
  const doRename = async () => {
    const name = $('#renameInput').value.trim();
    if (!session) startNewSession();
    session.name = name;
    showRename(false);
    clearTimeout(saveTimer);
    await window.api.saveSession(snapshot());
    refreshSessionList();
  };
  $('#renameSave').onclick = doRename;
  $('#renameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doRename(); } if (e.key === 'Escape') { e.stopPropagation(); showRename(false); } });
  refreshSessionList();
  $('#relayBtn').onclick = () => setRelay(!R.on);
  $('#task').addEventListener('change', () => { R.task = $('#task').value.trim(); autosave(); });
  $('#maxTurns').onchange = updateControls;
  $('#settingsBtn').onclick = () => { window.__setMenu(false); openSettings(); };
  $('#settingsForm').addEventListener('submit', submitSettings);
  $('#settings').addEventListener('close', () => setPanesVisible(true));
  // Clicking anywhere in the app's own panels takes keyboard focus back from the site panes
  document.addEventListener('mousedown', () => window.api.hostFocus(), true);
  window.addEventListener('resize', syncPaneBounds);
  setTimeout(syncPaneBounds, 300);
  $('#cancelSettings').onclick = () => $('#settings').close();
  $('#resetFramework').onclick = async () => { const d = await window.api.getDefaults(); $('#sFramework').value = d.framework; };
  $('#copySummary').onclick = async () => { await window.api.clipWrite(summaryText || $('#summary').innerText); $('#sumState').textContent = 'copied'; setTimeout(() => ($('#sumState').textContent = ''), 1500); };
  $('#exportBtn').onclick = exportTranscript;
  $('#filesBtn').onclick = () => window.api.driveOpen(session ? sessionDriveFolder() : '');
  $('#sumNow').onclick = () => { hopsSinceSummary = 0; summarize(); };
  $('#sessionBar').onclick = () => window.__setMenu(true);
  $('#newBtn').onclick = newSession;
  $('#modForm').addEventListener('submit', (e) => { e.preventDefault(); const t = $('#modInput').value; $('#modInput').value = ''; moderatorSend(t); });
  $('#modInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#modForm').requestSubmit(); } });
  $('#debugBtn').onclick = async () => {
    const t = await debugReport();
    await window.api.clipWrite(t);
    const b = $('#debugBtn'); b.textContent = 'Copied: paste it to Claude'; setTimeout(() => (b.textContent = 'Copy debug report'), 2500);
  };
  $('#updateBtn').onclick = applyUpdate;
  $('#version').ondblclick = () => checkUpdate(false);
  setInterval(tick, 1200);
  setInterval(pushStatus, 60000); // heartbeat so STATUS.md shows the app is alive
  myHost = await window.api.host();
  window.api.driveInfo().then((d) => { if (!d.found) note('Google Drive for desktop wasn\'t found, so shared files will save to Documents/Journey Relay. Install Drive for desktop to save them to Drive.', true); });
  updateControls();
  if (settings.auto !== false) setTimeout(() => setRelay(true, 'Relay on. Replies from either AI are copied to the other.'), 1500);
  checkUpdate(true);
  setInterval(() => checkUpdate(true), 30 * 60 * 1000);
}
init();
