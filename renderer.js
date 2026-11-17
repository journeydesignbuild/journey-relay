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
    input: '#prompt-textarea', reply: '[data-message-author-role="assistant"]',
    send: 'button[data-testid="send-button"], #composer-submit-button', busy: 'button[data-testid="stop-button"]' },
  { hosts: ['claude.ai'], name: 'Claude', ai: 'CLAUDE',
    input: '[data-testid="chat-input"], div[contenteditable="true"].ProseMirror', reply: '.font-claude-response, .font-claude-message',
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
const R = {
  running: false, paused: false, stopReq: false, auto: false, turn: 0, phase: 'Idle',
  pending: null, task: '', introduced: [false, false], complete: [false, false],
  queued: [[], []], resumeFrom: null, lastFrom: null
};

// ---------- Helpers ----------
const hostOf = (url) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; } };
const curUrl = (p) => { try { return p.wv.getURL(); } catch { return ''; } };
const presetFor = (host) => { const h = host.replace(/:\d+$/, ''); return PRESETS.find((x) => x.hosts.some((k) => h === k || h.endsWith('.' + k))); };
function adapterFor(p) {
  const h = hostOf(curUrl(p));
  if (!h) return null;
  const t = settings.adapters[h];
  const pr = presetFor(h);
  if (t && (!pr || t.override)) return { ...t, ai: t.ai || (pr && pr.ai), source: 'taught' };
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
const label = (i) => `Web${i + 1}`;
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
      if (n.id && !/\d{3,}|:/.test(n.id)) { parts.unshift('#' + CSS.escape(n.id)); break; }
      const par = n.parentElement;
      if (par) { const sib = [...par.children].filter((x) => x.tagName === n.tagName); if (sib.length > 1) p += `:nth-of-type(${sib.indexOf(n) + 1})`; }
      parts.unshift(p);
      n = par;
    }
    return parts.join(' > ');
  };
  const uniq = (el) => {
    if (el.id && !/\d{3,}|:/.test(el.id)) { const s = '#' + CSS.escape(el.id); if (count(s) === 1) return s; }
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
function buildPanes() {
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
      <div class="pane-body">
        <div class="banner hidden"><span class="msg"></span><button class="skip mini">Skip</button><button class="cancel mini">Cancel</button></div>
      </div>`;
    host.appendChild(sec);
    const wv = document.createElement('webview');
    wv.setAttribute('partition', 'persist:journey');
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('src', settings.urls[i] || 'https://www.google.com');
    $('.pane-body', sec).prepend(wv);
    const p = { i, label: label(i), sec, wv, url: $('.url', sec), nameInput: $('.ainame', sec), site: $('.site', sec), banner: $('.banner', sec), pick: null };
    panes.push(p);
    p.nameInput.value = settings.names[i] || '';
    p.nameInput.addEventListener('change', () => { settings.names[i] = p.nameInput.value.trim().toUpperCase(); p.nameInput.value = settings.names[i]; saveSettings(); });
    wv.addEventListener('dom-ready', () => refreshPane(p));
    wv.addEventListener('did-navigate', () => refreshPane(p));
    wv.addEventListener('did-navigate-in-page', () => refreshPane(p));
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
  });
}
function refreshPane(p) {
  const u = curUrl(p);
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
}
const hideBanner = (p) => p.banner.classList.add('hidden');

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
  if (R.running && !R.paused) { note('Pause the relay before teaching a site.', true); return; }
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
function pressEnter(wv) {
  wv.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  wv.sendInputEvent({ type: 'char', keyCode: '\r' });
  wv.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
}
async function typeAndSend(p, text) {
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
  if (a.send) for (let k = 0; k < 5 && !clicked; k++) { clicked = await run(p, pgClickSend, a.send); if (!clicked) await sleep(400); }
  if (!clicked) { p.wv.focus(); await run(p, pgFocusInput, a.input, false); pressEnter(p.wv); }
  await sleep(1500);
  const left = norm(await run(p, pgInputText, a.input));
  if (window.__dbg) console.log('[dbg] sent to ' + p.label + ' | boxes: ' + JSON.stringify(await Promise.all(panes.map((q) => run(q, pgInputText, '#box')))));
  if (left && norm(text).startsWith(left.slice(0, 40))) { p.wv.focus(); await run(p, pgFocusInput, a.input, false); pressEnter(p.wv); }
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
async function sendAndWait(i, text, abortable = true) {
  const p = panes[i]; const a = adapterFor(p);
  if (!a) throw new Error(`${p.label} isn't set up for this site. Click Teach.`);
  const before = await run(p, pgRead, a.reply, a.busy || '');
  setPhase(`Sending to ${p.label}`);
  await typeAndSend(p, text);
  setPhase(`Waiting for ${p.label}`);
  const out = await waitForReply(p, before, text, abortable);
  setPhase(R.running ? 'Running' : 'Idle');
  return out;
}

// ---------- Marker protocol ----------
function parseTurn(raw) {
  const t = String(raw || '').replace(/\r/g, '');
  const start = /([A-Z0-9][A-Z0-9_\-]*(?: [A-Z0-9][A-Z0-9_\-]*){0,2}) RESPONSE (\d{1,4}|#{1,4}|[A-Z0-9-]{1,8}) START\b/d.exec(t);
  if (!start) return null;
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
    name: start[1], num: start[2], payload,
    response: body.replace(/[A-Z0-9_\- ]*$/, '').trim(),
    requests, userRequest, complete, hasEnd: !!eot
  };
}
function intro(i) {
  return settings.framework.replaceAll('{ME}', aiName(i)).replaceAll('{OTHER}', aiName(1 - i)) + '\n\nTASK:\n' + R.task;
}

// ---------- Relay engine ----------
async function gate() {
  while (R.paused && !R.stopReq) await sleep(250);
  if (R.stopReq) throw new Stop();
}
function approve(from, to, text) {
  return new Promise((resolve, reject) => {
    R.pending = { from, to, resolve, reject };
    $('#pendingLabel').textContent = `${label(from)} → ${label(to)}`;
    const ta = $('#pendingText');
    ta.value = text; ta.readOnly = true;
    $('#editBtn').textContent = 'Edit';
    $('#pending').classList.remove('hidden');
    refreshPendingNote();
    setPhase('Your move: Pass or Automate');
    updateControls();
  });
}
function passPending() {
  const pd = R.pending;
  if (!pd) return;
  R.pending = null;
  hidePending();
  pd.resolve($('#pendingText').value);
  updateControls();
}
function hidePending() { $('#pending').classList.add('hidden'); }
function refreshPendingNote() {
  const el = $('#pendingNote');
  if (!R.pending || !R.queued[R.pending.to].length) { el.classList.add('hidden'); return; }
  el.textContent = `+ Your answer will be attached as USER RESPONSE (${R.queued[R.pending.to].length}).`;
  el.classList.remove('hidden');
}
function setAuto(v) {
  R.auto = v;
  if (v && R.pending) passPending();
  updateControls();
}
function setPaused(v) { if (!R.running) return; R.paused = v; updateControls(); }
function stopRelay() {
  if (!R.running) return;
  R.stopReq = true; R.paused = false;
  if (R.pending) { const pd = R.pending; R.pending = null; hidePending(); pd.reject(new Stop()); }
  updateControls();
}

async function handleReply(i, text) {
  let p = parseTurn(text);
  if (!p) {
    addLog({ who: label(i), text, kind: 'reply', turn: R.turn });
    note(`${label(i)} didn't use the relay format. Asking it to resend.`, true);
    const fix = `Your last reply did not follow the RELAY RULES. Resend the same content in the required format: start with "${aiName(i)} RESPONSE <number> START" and finish with "END OF TURN".`;
    addLog({ who: 'App', to: label(i), text: fix, kind: 'fix' });
    text = await sendAndWait(i, fix);
    p = parseTurn(text);
    if (!p) {
      addLog({ who: label(i), text, kind: 'reply', turn: R.turn });
      R.paused = true; updateControls();
      note(`${label(i)} still isn't following the format. Paused. Fix it in that site, then Resume.`, true);
      await gate();
      text = await readLatest(i);
      p = parseTurn(text) || { name: aiName(i), num: '?', payload: text, response: text, requests: '', userRequest: '', complete: false, hasEnd: false };
    }
  }
  addLog({ who: label(i), text, kind: 'reply', turn: R.turn, num: p.num });
  R.lastFrom = i;
  R.complete[i] = !!p.complete;
  if (p.userRequest && !isNone(p.userRequest)) addQuestion(i, p.num, p.userRequest);
  if (R.turn > 0 && R.turn % 2 === 0) summarizeSoon();
  return p;
}

async function runRelay(task, startIdx, resume = false) {
  if (R.running) return 'Relay is already running.';
  if (resume) {
    if (!R.task || R.lastFrom === null) { note('Nothing to continue yet. Type a task and click Start.', true); return 'Nothing to continue.'; }
  } else {
    task = String(task || '').trim();
    if (!task) { note('Type a task first.', true); return 'No task given.'; }
  }
  for (const i of [0, 1]) if (!adapterFor(panes[i])) { note(`${label(i)} isn't set up for this site. Click Teach.`, true); return `${label(i)} not set up.`; }
  if (resume) Object.assign(R, { running: true, paused: false, stopReq: false, turn: 0, pending: null, complete: [false, false], resumeFrom: null });
  else Object.assign(R, { running: true, paused: false, stopReq: false, turn: 0, pending: null, task, introduced: [false, false], complete: [false, false], queued: [[], []], resumeFrom: null, lastFrom: null });
  if (!resume) $('#task').value = task;
  updateControls();
  try {
    let from, parsed, reply;
    if (resume) {
      from = R.lastFrom;
      parsed = parseTurn(await readLatest(from));
      if (!parsed) throw new Error(`${label(from)}'s latest reply isn't in the relay format, so there's nothing to pass on.`);
      note(`Continuing from ${label(from)}${R.queued[1 - from].length ? ' with your answer' : ''}.`);
    } else {
      from = startIdx;
      const first = intro(from);
      R.introduced[from] = true;
      addLog({ who: 'You', to: label(from), text: first, kind: 'setup' });
      reply = await sendAndWait(from, first);
      parsed = await handleReply(from, reply);
    }
    while (R.turn < maxTurns()) {
      await gate();
      if (R.resumeFrom !== null) {
        from = R.resumeFrom; R.resumeFrom = null;
        parsed = parseTurn(await readLatest(from)) || parsed;
      }
      if (R.complete[0] && R.complete[1]) { note('Both sides wrote SESSION COMPLETE. Done.'); break; }
      const to = 1 - from;
      let out = parsed.payload;
      if (!R.introduced[to]) out = intro(to) + `\n\nBelow is ${aiName(from)}'s first reply.\n\n` + out;
      if (!R.auto) { out = await approve(from, to, out); await gate(); }
      R.introduced[to] = true;
      const answers = R.queued[to].splice(0);
      if (answers.length) out += '\n\nUSER RESPONSE\n' + answers.join('\n\n');
      note(`Passed ${label(from)} → ${label(to)}${answers.length ? ' + your answer' : ''}.`);
      reply = await sendAndWait(to, out);
      R.turn++;
      updateControls();
      parsed = await handleReply(to, reply);
      from = to;
      if (R.auto) await sleep(800);
    }
    if (R.turn >= maxTurns()) note(`Hit max turns (${maxTurns()}). Stopped.`);
  } catch (e) {
    if (e instanceof Stop) note('Stopped.');
    else note('Error: ' + e.message, true);
  } finally {
    R.running = false; R.paused = false; R.stopReq = false; R.pending = null;
    hidePending();
    setPhase('Idle');
    updateControls();
    summarizeSoon();
  }
  return 'Relay ended.';
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
  if ($('#pauseOnQ').checked && R.running) { R.paused = true; updateControls(); note(`Paused for ${q.ai}'s question.`); }
}
function renderQuestions() {}

// ---------- Log ----------
function addLog(e) {
  e.time = new Date();
  logEntries.push(e);
}
function note(msg, warn) {
  if (warn) recordError(msg);
  modMsg(warn ? 'sys warn' : 'sys', msg);
}
function transcript(maxChars = 40000, per = 4000) {
  const lines = logEntries.map((e) => {
    let head;
    if (e.kind === 'setup') return `[You started the task with ${e.to}]\nTask: ${R.task}`;
    if (e.kind === 'reply') head = `[${e.turn ? 'Turn ' + e.turn + ' · ' : ''}${e.who} (${aiName(e.who === 'Web1' ? 0 : 1)})]`;
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
  R.phase = t;
  const el = $('#phase');
  el.textContent = R.paused ? 'Paused' : t;
  el.className = 'phase ' + (R.running ? 'live' : 'idle');
}
function updateControls() {
  $('#startBtn').disabled = R.running;
  const canResume = !R.running && !!R.task && R.lastFrom !== null;
  $('#contBtn').classList.toggle('hidden', !canResume);
  $('#startBtn').textContent = canResume ? 'New run' : 'Start';
  $('#pauseBtn').disabled = !R.running;
  $('#stopBtn').disabled = !R.running;
  $('#pauseBtn').textContent = R.paused ? 'Resume' : 'Pause';
  for (const b of [$('#autoBtn'), $('#pendingAutoBtn')]) { b.textContent = R.auto ? 'Auto: ON' : 'Automate'; b.classList.toggle('on', R.auto); }
  $('#turnInfo').textContent = R.running ? `Turn ${R.turn} of ${maxTurns()} · ${R.auto ? 'automatic' : 'manual'}` : '';
  setPhase(R.running ? (R.pending ? 'Your move: Pass or Automate' : R.phase) : 'Idle');
}

// ---------- Summary ----------
let sumTimer = null, sumBusy = false, sumAgain = false;
function summarizeSoon() {
  if (sumBusy) { sumAgain = true; return; }
  clearTimeout(sumTimer);
  sumTimer = setTimeout(summarize, 600);
}
async function summarize() {
  if (!logEntries.some((e) => e.kind === 'reply')) return;
  if (!settings.apiKey) { $('#summary').textContent = 'Add an Anthropic API key in ⚙ Settings to get the summary.'; return; }
  sumBusy = true;
  $('#sumState').textContent = 'updating…';
  const res = await window.api.call({
    model: settings.sumModel, max_tokens: 250,
    system: 'Two AI assistants are working on a task for Justin; the app relays their replies between them. Write a short, plain statement of where things stand right now: 1 to 3 sentences, no headings, no bullets, no preamble. He reads it at a glance on the go.',
    messages: [{ role: 'user', content: `Task: ${R.task || '(none)'}\n\nOpen questions for Justin: ${questions.filter((q) => !q.answered).map((q) => 'Q' + q.id + ' ' + short(q.text, 120)).join(' | ') || 'none'}\n\nTranscript:\n${transcript(40000, 4000)}` }]
  });
  sumBusy = false;
  $('#sumState').textContent = res.error ? 'summary error' : '';
  if (res.error) recordError('Summary API: ' + res.error);
  if (!res.error) {
    summaryText = res.data.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    renderSummary();
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
      to: { type: 'string', enum: ['both', 'web1', 'web2'], description: 'Default both' },
      deliver_now: { type: 'boolean', description: 'Type it into the site(s) right away. Only works when the relay is not running.' }
    }, required: ['answer'] } },
  { name: 'relay_control',
    description: 'Control the relay. start (new run with a task), continue (pick up the finished/stopped session where it left off, carrying queued answers), pause, resume, stop, automate (auto-pass every hop), manual (approve each hop), pass (send the hop waiting for approval).',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['start', 'continue', 'pause', 'resume', 'stop', 'automate', 'manual', 'pass'] },
      task: { type: 'string' }, start_pane: { type: 'integer', enum: [1, 2] }
    }, required: ['action'] } },
  { name: 'read_pane', description: 'Read the latest reply currently shown in a pane.',
    input_schema: { type: 'object', properties: { pane: { type: 'integer', enum: [1, 2] } }, required: ['pane'] } },
  { name: 'send_to_pane',
    description: 'Type your own separate message into a pane and send it (not part of the word-for-word relay). Only when the relay is stopped or paused. Waits for the reply.',
    input_schema: { type: 'object', properties: { pane: { type: 'integer', enum: [1, 2] }, text: { type: 'string' } }, required: ['pane', 'text'] } },
  { name: 'edit_pending', description: 'Replace the text of the hop waiting for approval. Only when Justin asks you to change it.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'set_options', description: 'Change relay options.',
    input_schema: { type: 'object', properties: { max_turns: { type: 'integer' }, pause_on_question: { type: 'boolean' } } } }
];

function relayStatus() {
  if (!R.running) return `idle (last session: ${R.turn} turns)`;
  return `${R.paused ? 'paused' : R.pending ? 'waiting for Justin to pass the next hop' : R.phase}, turn ${R.turn} of ${maxTurns()}, ${R.auto ? 'automatic' : 'manual'} mode`;
}
function modSystem() {
  const openQ = questions.filter((q) => !q.answered);
  const doneQ = questions.filter((q) => q.answered);
  return `You are the moderator inside "Journey Relay", Justin's desktop app that relays a conversation between two AI chat websites.
Web1 = ${aiName(0)} (${curUrl(panes[0])}). Web2 = ${aiName(1)} (${curUrl(panes[1])}).

How it works: each AI replies in a fixed format (NAME RESPONSE ### START / END, a NAME REQUESTS OTHER block, a USER REQUEST block, END OF TURN). The app copies the RESPONSE and REQUESTS blocks word-for-word to the other AI. Questions from USER REQUEST blocks are shown to Justin in this chat (as Q1, Q2…) and listed below.

Your job: Justin messages you here, usually on the go. Keep replies short and plain.
- Justin answers questions loosely: right away, later, several at once, or in passing. When a message answers something, call answer_questions with a clear standalone answer, the matching question_ids, and to="both" unless he says otherwise. Do not use deliver_now unless he asks to send it without continuing the relay.
- If the relay is idle (finished or stopped) and Justin answers a question or says to keep going, record the answer and then call relay_control continue so the work picks up where it left off with his answer attached.
- Never change relayed text unless Justin asks (edit_pending).
- Control the relay when he asks (start, pause, resume, stop, automate, manual, pass).
- When he asks where things stand, answer from the summary and transcript.
- Push back when the two AIs loop, drift off task, or miss something, and tell him.

Relay: ${relayStatus()}
Task: ${R.task || '(none yet)'}
Answers waiting to be delivered: Web1 ${R.queued[0].length}, Web2 ${R.queued[1].length}
${R.pending ? `Hop waiting for approval (${label(R.pending.from)} → ${label(R.pending.to)}):\n${short($('#pendingText').value, 1500)}\n` : ''}
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
      const targets = to === 'both' ? [0, 1] : [to === 'web1' ? 0 : 1];
      const ids = Array.isArray(x.question_ids) ? x.question_ids : [];
      targets.forEach((i) => R.queued[i].push(x.answer));
      ids.forEach((id) => { const q = questions.find((q) => q.id === id); if (q) q.answered = true; });
      renderQuestions(); refreshPendingNote();
      addLog({ who: 'You', to: targets.map(label).join(' + '), text: x.answer, kind: 'answer' });
      if (x.deliver_now) {
        if (R.running) return { queued: true, note: 'Relay is running, so it goes out with the next hop to each side.' };
        for (const i of targets) {
          const t = R.queued[i].splice(0);
          if (t.length) await typeAndSend(panes[i], 'USER RESPONSE\n' + t.join('\n\n'));
        }
        return { delivered: true, to: targets.map(label) };
      }
      return { queued: true, delivers: 'with the next message each target AI receives', resolved: ids };
    }
    case 'relay_control': {
      switch (x.action) {
        case 'start':
          if (R.running) return { error: 'Already running' };
          runRelay(x.task || $('#task').value, x.start_pane ? x.start_pane - 1 : +$('#startFrom').value);
          return { started: true };
        case 'continue':
          if (R.running) return { error: 'Already running' };
          runRelay('', 0, true);
          return { continuing: true };
        case 'pause': if (!R.running) return { error: 'Not running' }; setPaused(true); return { paused: true };
        case 'resume': if (!R.running) return { error: 'Not running' }; setPaused(false); return { resumed: true };
        case 'stop': stopRelay(); return { stopped: true };
        case 'automate': setAuto(true); return { automate: true };
        case 'manual': setAuto(false); return { manual: true };
        case 'pass': if (!R.pending) return { error: 'Nothing is waiting for approval' }; passPending(); return { passed: true };
      }
      return { error: 'Unknown action' };
    }
    case 'read_pane': {
      const p = P(x.pane); const a = adapterFor(p);
      if (!a) return { error: `${p.label} isn't set up. Ask Justin to click Teach.` };
      const r = await run(p, pgRead, a.reply, '');
      return { pane: p.label, reply_count: r.count, latest_reply: (r.text || '').slice(0, 10000) };
    }
    case 'send_to_pane': {
      if (R.running && !R.paused) return { error: 'The relay is running. Pause it first (relay_control pause).' };
      const p = P(x.pane);
      addLog({ who: 'Moderator', to: p.label, text: x.text, kind: 'moderator' });
      const reply = await sendAndWait(p.i, x.text, false);
      addLog({ who: p.label, text: reply, kind: 'reply', turn: 0 });
      if (R.running) R.resumeFrom = p.i;
      summarizeSoon();
      return { reply: reply.slice(0, 10000) };
    }
    case 'edit_pending':
      if (!R.pending) return { error: 'Nothing is waiting for approval' };
      $('#pendingText').value = x.text;
      return { ok: true };
    case 'set_options':
      if (x.max_turns) $('#maxTurns').value = x.max_turns;
      if (typeof x.pause_on_question === 'boolean') $('#pauseOnQ').checked = x.pause_on_question;
      updateControls();
      return { ok: true, max_turns: maxTurns(), pause_on_question: $('#pauseOnQ').checked };
  }
  return { error: 'Unknown tool' };
}

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
function trimmedHistory() {
  let h = modHistory.slice(-40);
  while (h.length && !(h[0].role === 'user' && typeof h[0].content === 'string')) h = h.slice(1);
  return h;
}
const TOOL_LABEL = { answer_questions: 'Recorded your answer', relay_control: 'Relay', read_pane: 'Read pane', send_to_pane: 'Sent message to pane', edit_pending: 'Edited the pending hop', set_options: 'Updated options' };
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
  const lines = [`# Journey Relay session — ${new Date().toLocaleString()}`, '', `**Task:** ${R.task || '(none)'}`, `**Web1:** ${aiName(0)} · **Web2:** ${aiName(1)}`, ''];
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
  if (R.running) { note('Stop the relay before starting a new session.', true); return; }
  logEntries.length = 0; questions.length = 0; summaryText = ''; modHistory.length = 0;
  R.turn = 0; R.task = ''; R.queued = [[], []]; R.lastFrom = null; R.introduced = [false, false];
  updateControls();
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
  lines.push('', `Relay: ${relayStatus()} · task: ${short(R.task, 120) || '(none)'}`);
  lines.push(`Questions: ${questions.length} (${questions.filter((q) => !q.answered).length} open) · queued answers: Web1 ${R.queued[0].length}, Web2 ${R.queued[1].length}`);
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
  if (R.running) { note('Stop the relay before updating.', true); return; }
  const b = $('#updateBtn');
  b.disabled = true; b.textContent = 'Updating…';
  const r = await window.api.applyUpdate();
  if (r.error) { note('Update failed: ' + r.error, true); b.disabled = false; b.textContent = 'Retry update'; }
  else b.textContent = `Restarting on v${r.version}…`;
}

// ---------- Wire up ----------
async function init() {
  settings = await window.api.getSettings();
  settings.adapters = settings.adapters || {};
  settings.names = settings.names || ['', ''];
  buildPanes();
  $('#startBtn').onclick = () => runRelay($('#task').value, +$('#startFrom').value);
  $('#contBtn').onclick = () => runRelay('', 0, true);
  $('#autoBtn').onclick = () => setAuto(!R.auto);
  $('#pendingAutoBtn').onclick = () => setAuto(!R.auto);
  $('#pauseBtn').onclick = () => setPaused(!R.paused);
  $('#stopBtn').onclick = stopRelay;
  $('#passBtn').onclick = passPending;
  $('#editBtn').onclick = () => { const ta = $('#pendingText'); ta.readOnly = !ta.readOnly; $('#editBtn').textContent = ta.readOnly ? 'Edit' : 'Lock'; if (!ta.readOnly) ta.focus(); };
  $('#maxTurns').onchange = updateControls;
  $('#settingsBtn').onclick = openSettings;
  $('#settingsForm').addEventListener('submit', submitSettings);
  $('#cancelSettings').onclick = () => $('#settings').close();
  $('#resetFramework').onclick = async () => { const d = await window.api.getDefaults(); $('#sFramework').value = d.framework; };
  $('#copySummary').onclick = async () => { await window.api.clipWrite(summaryText || $('#summary').innerText); $('#sumState').textContent = 'copied'; setTimeout(() => ($('#sumState').textContent = ''), 1500); };
  $('#exportBtn').onclick = exportTranscript;
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
  updateControls();
  checkUpdate(true);
  setInterval(() => checkUpdate(true), 30 * 60 * 1000);
}
init();
