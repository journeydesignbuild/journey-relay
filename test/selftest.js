// Self-test: two fake chat sites + mock Claude API. Run with JP_SELFTEST=1.
const http = require('http');

const PAGE = `<!doctype html><html><body>
<div id="thread"></div>
<textarea id="box" rows="3" cols="60"></textarea><button id="send">Send</button>
<style>.msg{white-space:pre-wrap;margin:6px;padding:6px;border:1px solid #ccc;font:12px monospace}</style>
<script>
const NAME = location.port === '8001' ? 'ALPHA' : 'BETA';
const OTHER = NAME === 'ALPHA' ? 'BETA' : 'ALPHA';
let n = 0; window.received = []; let broke = false;
const box = document.getElementById('box'), thread = document.getElementById('thread');
function send() {
  const t = box.value; if (!t.trim()) return;
  box.value = ''; window.received.push(t);
  const u = document.createElement('div'); u.className = 'msg user'; u.textContent = t; thread.appendChild(u);
  setTimeout(() => reply(t), 500);
}
function reply(t) {
  let text;
  const isFix = t.includes('did not follow the RELAY RULES');
  if (NAME === 'BETA' && !broke && !isFix) { broke = true; text = 'oops I forgot the format, here is a plain answer'; }
  else {
    n++;
    const num = String(n).padStart(3, '0');
    const ur = t.includes('USER RESPONSE') ? ' [saw USER RESPONSE: ' + t.split('USER RESPONSE')[1].trim().slice(0, 40) + ']' : '';
    const q = (NAME === 'ALPHA' && n === 1) ? "What's the budget?" : 'NONE';
    text = NAME + ' RESPONSE ' + num + ' START\\nDraft ' + n + ' from ' + NAME + ur + '\\n' + NAME + ' RESPONSE ' + num + ' END\\n\\n' + NAME + ' REQUESTS ' + OTHER + '\\nPlease review draft ' + n + '.\\n\\nUSER REQUEST\\n' + q + '\\n\\n' + (n >= 3 ? 'SESSION COMPLETE\\n' : '') + 'END OF TURN';
  }
  const b = document.createElement('div'); b.className = 'msg bot'; thread.appendChild(b);
  let i = 0; const iv = setInterval(() => { i += 15; b.textContent = text.slice(0, i); if (i >= text.length) clearInterval(iv); }, 100);
}
document.getElementById('send').onclick = send;
box.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
</script></body></html>`;

function servePage(port) {
  http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); }).listen(port);
}

const apiLog = [];
function serveApi(port) {
  http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const b = JSON.parse(body || '{}');
      let out;
      if (!b.tools) {
        apiLog.push('summary');
        out = { content: [{ type: 'text', text: 'ALPHA and BETA are on draft 2; budget is answered.' }], stop_reason: 'end_turn' };
      } else {
        const last = b.messages[b.messages.length - 1];
        apiLog.push(typeof last.content === 'string' ? 'mod:user' : 'mod:tool_result');
        out = typeof last.content === 'string'
          ? { content: [{ type: 'text', text: 'Recording that.' }, { type: 'tool_use', id: 'tu1', name: 'answer_questions', input: { answer: 'Budget is $40k.', question_ids: [1], to: 'both' } }], stop_reason: 'tool_use' }
          : { content: [{ type: 'text', text: 'Done. It goes to both sides with the next hop.' }], stop_reason: 'end_turn' };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  }).listen(port);
}

module.exports = (win, app) => {
  servePage(8001); servePage(8002); serveApi(8003);
  const js = (code) => win.webContents.executeJavaScript(code);
  const step = (m) => console.log('[step] ' + m);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  win.webContents.on('did-finish-load', async () => {
    step('loaded');
    try {
      await sleep(1500);
      await js(`
        settings.adapters['localhost:8001'] = { name: 'a', input: '#box', reply: '.bot', send: '#send', busy: '' };
        settings.adapters['localhost:8002'] = { name: 'b', input: '#box', reply: '.bot', send: '', busy: '' };
        settings.apiKey = 'test'; settings.apiBase = 'http://localhost:8003'; settings.fallbackSec = 4;
        saveSettings();
        panes[0].wv.loadURL('http://localhost:8001'); panes[1].wv.loadURL('http://localhost:8002');
        panes[0].nameInput.value = 'ALPHA'; panes[1].nameInput.value = 'BETA';
        true`);
      step('panes loading');
      await sleep(2500);
      step('urls: ' + await js('panes.map(p => curUrl(p)).join(" ")'));
      await js('window.__dbg = true');
      js(`runRelay('Write a one-line slogan for a concrete company', 0)`);
      // Manual first hop: wait for the pending box, then pass and switch to Automate
      for (let k = 0; k < 60; k++) { if (await js('!!R.pending')) break; await sleep(500); }
      step('pending? ' + await js('!!R.pending') + ' phase=' + await js('R.phase'));
      const pendingText = await js(`$('#pendingText').value`);
      await js('passPending(); true');
      // Answer the question via the moderator once it appears
      for (let k = 0; k < 60; k++) { if (await js('questions.length > 0')) break; await sleep(500); }
      step('questions ' + await js('questions.length'));
      await js(`moderatorSend('budget is 40k'); true`);
      await sleep(1500);
      await js('setAuto(true); true');
      for (let k = 0; k < 240; k++) { if (!(await js('R.running'))) break; await sleep(500); }
      await sleep(1500);
      const result = await js(`({
        log: logEntries.map(e => e.kind + ' | ' + e.who + (e.to ? ' -> ' + e.to : '') + ' | ' + e.text.replace(/\\n/g, ' / ').slice(0, 110)),
        questions: questions.map(q => ({ id: q.id, ai: q.ai, text: q.text, answered: q.answered })),
        summary: summaryText,
        chat: [...document.querySelectorAll('#modChat .m')].map(m => m.className + ': ' + m.textContent.replace(/\\n/g, ' / ')),
        turn: R.turn
      })`);
      await sleep(1500);
      console.log('sessions: ' + JSON.stringify(await js('window.api.listSessions()')));
      await js(`(async () => { const l = await window.api.listSessions(); R.task = ''; R.lastFrom = null; questions.length = 0; logEntries.length = 0; chatLog.length = 0; const j = await window.api.loadSession(l[0].id); applySession(j, false); return true; })()`);
      console.log('restored: ' + await js('R.task + " | lastFrom=" + R.lastFrom + " | log=" + logEntries.length + " | chat=" + chatLog.length + " | sel=" + $("#sessionSel").options.length'));
      console.log('=== CONTINUE TEST ===');
      console.log('buttons: ' + await js(`$('#startBtn').textContent + ' / cont hidden=' + $('#contBtn').classList.contains('hidden')`));
      await js(`runTool('answer_questions', { answer: 'Use 12.531 ft.', to: 'both' })`);
      js(`runRelay('', 0, true)`);
      await sleep(1000);
      for (let k = 0; k < 120; k++) { if (!(await js('R.running'))) break; await sleep(500); }
      console.log('after continue: ' + JSON.stringify(await js(`[...document.querySelectorAll('#modChat .m.sys')].slice(-4).map(m => m.textContent)`)));
      await js('window.api.newWindow()'); await sleep(4000);
      const wins = require('electron').BrowserWindow.getAllWindows();
      const other = wins.find((w) => w !== win);
      console.log('windows: ' + wins.length + ' | second window task="' + (other ? await other.webContents.executeJavaScript('R.task') : 'n/a') + '" title=' + (other ? await other.webContents.executeJavaScript('document.title') : '') + ' | first title=' + await js('document.title'));
      if (other) other.close();
      const kids = win.contentView.children;
      console.log('views: ' + kids.length + ' bounds=' + JSON.stringify(kids.map((v) => v.getBounds())));
      const img0 = await kids[0].webContents.capturePage(); require('fs').writeFileSync('/tmp/jp-view0.png', img0.toPNG());
      const recvA = await js(`panes[0].wv.executeJavaScript('window.received')`);
      const recvB = await js(`panes[1].wv.executeJavaScript('window.received')`);
      console.log('=== PENDING (first hop, manual) ===\n' + pendingText.slice(-400));
      console.log('=== RESULT ===\n' + JSON.stringify(result, null, 2));
      console.log('=== ALPHA received ===\n' + recvA.map((t, i) => `#${i + 1}: ` + t.replace(/\n/g, ' / ').slice(-300)).join('\n'));
      console.log('=== BETA received ===\n' + recvB.map((t, i) => `#${i + 1}: ` + t.replace(/\n/g, ' / ').slice(-300)).join('\n'));
      console.log('=== API calls ===\n' + apiLog.join(', '));
    } catch (e) {
      console.log('SELFTEST ERROR', e);
    }
    try { await js('window.__setMenu(true); true'); await sleep(300); const im2 = await win.capturePage(); require('fs').writeFileSync('/tmp/jp-menu.png', im2.toPNG()); await js('window.__setMenu(false); true'); await sleep(300); } catch (e) { console.log('menu shot failed', e); }
    try { const img = await win.capturePage(); require('fs').writeFileSync('/tmp/jp-shot.png', img.toPNG()); } catch (e) { console.log('shot failed', e); }
    app.quit();
  });
};
