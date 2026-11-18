// Self-test: two fake chat sites + mock Claude API. Run with JP_SELFTEST=1.
const http = require('http');

const PAGE = `<!doctype html><html><body>
<div id="thread"></div>
<textarea id="box" rows="3" cols="60"></textarea><button id="send">Send</button><input type="file" id="up" multiple>
<style>.msg{white-space:pre-wrap;margin:6px;padding:6px;border:1px solid #ccc;font:12px monospace}</style>
<script>
const NAME = location.port === '8001' ? 'ALPHA' : 'BETA';
const OTHER = NAME === 'ALPHA' ? 'BETA' : 'ALPHA';
let n = 0; window.received = []; window.files = []; let broke = false;
document.getElementById('up').addEventListener('change', async (e) => { for (const f of e.target.files) window.files.push({ name: f.name, type: f.type, text: await f.text() }); });
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
    const fileBlock = (NAME === 'ALPHA' && n === 2) ? '\\nFILE START: calc.html\\nhtml\\nCopy code\\n<!doctype html>\\n<p>12\\' 6 3/8\\"</p>\\nFILE END\\n' : '';
    text = NAME + ' RESPONSE ' + num + ' START\\nDraft ' + n + ' from ' + NAME + ur + fileBlock + '\\n' + NAME + ' RESPONSE ' + num + ' END\\n\\n' + NAME + ' REQUESTS ' + OTHER + '\\nPlease review draft ' + n + '.\\n\\nUSER REQUEST\\n' + q + '\\n\\n' + (n >= 3 ? 'SESSION COMPLETE\\n' : '') + 'END OF TURN';
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
    const chat = () => js(`[...document.querySelectorAll('#modChat .m')].map(m => m.className.replace('m ', '') + ': ' + m.textContent.replace(/\\n/g, ' / ').slice(0, 150))`);
    try {
      await sleep(1500);
      await js(`
        settings.adapters['localhost:8001'] = { name: 'a', input: '#box', reply: '.bot', send: '#send', busy: '' };
        settings.adapters['localhost:8002'] = { name: 'b', input: '#box', reply: '.bot', send: '', busy: '' };
        settings.apiKey = 'test'; settings.apiBase = 'http://localhost:8003'; settings.fallbackSec = 4; settings.driveFolder = '/tmp/fakedrive/My Drive';
        saveSettings();
        panes[0].wv.loadURL('http://localhost:8001'); panes[1].wv.loadURL('http://localhost:8002');
        panes[0].nameInput.value = 'ALPHA'; panes[1].nameInput.value = 'BETA';
        true`);
      await sleep(3000);
      step('relay on? ' + await js('R.on') + ' | button=' + await js(`$('#relayBtn').textContent + ' / ' + $('#relayState').textContent`));
      // Justin types into AI 1 himself
      await js(`typeAndSend(panes[0], 'Write a one-line slogan for a concrete company'); true`);
      for (let k = 0; k < 120; k++) { if (await js('questions.length > 0')) break; await sleep(500); }
      step('question: ' + await js('questions.map(q => q.text).join(" | ")'));
      await js(`moderatorSend('budget is 40k'); true`);
      for (let k = 0; k < 20; k++) { if (await js(`!!document.querySelector('.m.approve:not(.ok):not(.no) .ap-ok')`)) break; await sleep(250); }
      step('approval card: ' + await js(`(document.querySelector('.m.approve .ap-title')||{}).textContent`));
      await js(`document.querySelector('.m.approve .ap-ok').click(); true`);
      await js(`setInterval(() => { const b = document.querySelector('.m.approve:not(.ok):not(.no) .ap-ok'); if (b) b.click(); }, 300); true`);
      for (let k = 0; k < 400; k++) { if (!(await js('R.on'))) break; await sleep(500); }
      step('relay after run: on=' + await js('R.on') + ' turns=' + await js('R.turn'));
      console.log('=== CHAT ===\n' + (await chat()).join('\n'));
      await sleep(2500);
      console.log('summary: ' + await js(`$('#summary').textContent`) + ' | session bar: ' + await js(`$('#sessionName').textContent + ' · ' + $('#sessionDate').textContent`) + ' | busy line: ' + await js(`$('#busyLine').textContent`));
      console.log('drive tree: ' + require('child_process').execSync('cd "/tmp/fakedrive/My Drive" && find . -type f | sort').toString().trim().replace(/\n/g, ' | '));
      console.log('STATUS.md:\n' + require('fs').readFileSync('/tmp/fakedrive/My Drive/Journey Relay/STATUS.md', 'utf8'));
      console.log('BETA files: ' + JSON.stringify(await js(`panes[1].wv.executeJavaScript('window.files')`)));
      const recvA = await js(`panes[0].wv.executeJavaScript('window.received')`);
      const recvB = await js(`panes[1].wv.executeJavaScript('window.received')`);
      console.log('=== ALPHA received ===\n' + recvA.map((t, i) => `#${i + 1}: ` + t.replace(/\n/g, ' / ').slice(0, 160) + ' … ' + t.replace(/\n/g, ' / ').slice(-90)).join('\n'));
      console.log('=== BETA received ===\n' + recvB.map((t, i) => `#${i + 1}: ` + t.replace(/\n/g, ' / ').slice(0, 160) + ' … ' + t.replace(/\n/g, ' / ').slice(-90)).join('\n'));
      // Pick up via the moderator tool: send BETA's last reply to ALPHA
      const before = recvA.length;
      const res = await js(`runTool('relay_latest', { from_pane: 2 })`);
      await sleep(2000);
      console.log('pick-up result: ' + JSON.stringify(res) + ' | ALPHA got ' + ((await js(`panes[0].wv.executeJavaScript('window.received.length')`)) - before) + ' new message(s)');
      // Restart restore
      await sleep(1500);
      await js(`(async () => { const l = await window.api.listSessions(); R.seen = ['', '']; logEntries.length = 0; chatLog.length = 0; const j = await window.api.loadSession(l[0].id); applySession(j, false); return true; })()`);
      console.log('restored: seen set=' + await js('R.seen.map(x => !!x).join(",")') + ' log=' + await js('logEntries.length'));
    } catch (e) {
      console.log('SELFTEST ERROR', e);
    }
    try { await js('window.__setMenu(true); true'); await sleep(300); const im2 = await win.capturePage(); require('fs').writeFileSync('/tmp/jp-menu.png', im2.toPNG()); await js('window.__setMenu(false); true'); await sleep(300); } catch (e) { console.log('menu shot failed', e); }
    try { const img = await win.capturePage(); require('fs').writeFileSync('/tmp/jp-shot.png', img.toPNG()); } catch (e) { console.log('shot failed', e); }
    app.quit();
  });
};
