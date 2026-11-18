// Acceptance tests for the delivery ledger. Run: JP_SELFTEST=acceptance electron .
// Two fake chat sites: ALPHA (ChatGPT-like, message ids) and BETA (Claude-like, ticking "N minutes ago" footer).
const http = require('http');
const fs = require('fs');
const path = require('path');

const PAGE = fs.readFileSync(path.join(__dirname, 'fake.html'), 'utf8');
function servePage(port) { http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); }).listen(port); }

module.exports = (win, app) => {
  servePage(8001); servePage(8002);
  const js = (code) => win.webContents.executeJavaScript(code);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const site = (i, code) => js(`panes[${i}].wv.executeJavaScript(${JSON.stringify(code)})`);
  const recv = (i) => site(i, 'window.received.length');
  const lastRecv = (i) => site(i, 'window.received[window.received.length - 1] || ""');
  const waitFor = async (code, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await js(code)) return true; await sleep(400); } return false; };
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
  const settle = () => js('!R.busy && !ticking');

  win.webContents.on('did-finish-load', async () => {
    try {
      await sleep(1500);
      await js(`
        settings.adapters['localhost:8001'] = { name: 'a', input: '#box', reply: '.bot', send: '#send', busy: '#stop', user: '.user' };
        settings.adapters['localhost:8002'] = { name: 'b', input: '#box', reply: '.bot', send: '', busy: '#stop', user: '.user' };
        settings.fallbackSec = 6; settings.stableSec = 2; settings.driveFolder = '/tmp/fakedrive/My Drive';
        saveSettings();
        panes[0].wv.loadURL('http://localhost:8001'); panes[1].wv.loadURL('http://localhost:8002');
        panes[0].nameInput.value = 'ALPHA'; panes[1].nameInput.value = 'BETA';
        $('#maxTurns').value = 200;
        true`);
      await sleep(2500);
      await js('setRelay(true); true');
      await sleep(2500);

      // ---- 1. Deliver one message once ----
      await site(0, `post(protocol('001', 'Start the work'))`);
      await waitFor('!!inflight() && inflight().state === "awaiting"', 30000);
      await sleep(8000);
      const b1 = await recv(1);
      const st1 = await js('JSON.stringify((({state, queuedAt, awaitingAt}) => ({state, q: !!queuedAt, a: !!awaitingAt}))(inflight()))');
      check('1. Deliver one message once', b1 === 1, `BETA received ${b1}; ledger ${st1}`);

      // ---- 8. Exact RESPONSE 015 scenario: same message, only the "N minutes ago" footer keeps changing ----
      await site(1, `post(protocol('015', 'PR #11 at ae2157c is ready for review. All tests pass.'))`);
      await waitFor('R.ledger.some(e => e.from === 1 && e.num === "015" && e.state === "awaiting")', 40000);
      await sleep(20000); // footer ticks ~20 times ("47 minutes ago" ...)
      const a015 = await site(0, `window.received.filter(t => t.includes('BETA RESPONSE 015 START')).length`);
      const cap015 = await js(`logEntries.filter(e => e.kind === 'reply' && e.who === 'AI 2' && /RESPONSE 015 START/.test(e.text)).length`);
      check('8a. RESPONSE 015 with a ticking timestamp is delivered once', a015 === 1, `ALPHA got it ${a015}x; captured ${cap015}x`);
      check('5. Duplicate capture of the same source message is rejected', cap015 === 1, `captured ${cap015}x over 20 timestamp changes`);

      // ---- 6. Revised message that reuses a response number is preserved (delivered), 8b. loop guard ----
      await site(0, `post(protocol('002', 'Two findings: add a test, fix rounding.'))`);
      await waitFor('R.ledger.some(e => e.from === 0 && e.num === "002" && e.state === "awaiting")', 40000);
      await sleep(10000); // BETA's older 015 keeps changing its timestamp the whole time
      const still = await js(`JSON.stringify((({from, num, state}) => ({from, num, state}))(inflight()))`);
      const notMistaken = await js(`inflight().from === 0 && inflight().num === '002' && inflight().state === 'awaiting'`);
      check('9. Previous reply (ticking timestamp) not mistaken for the new answer', notMistaken, `still waiting: ${still}`);
      await site(1, `post(protocol('015', 'REVISED: PR #11 at 9f1c2d0 fixes both findings.'))`);
      await waitFor(`R.ledger.filter(e => e.from === 1 && e.num === "015").length === 2 && R.ledger.filter(e => e.from === 1 && e.num === "015")[1].state === "awaiting"`, 40000);
      const rev = await site(0, `window.received.filter(t => t.includes('REVISED: PR #11 at 9f1c2d0')).length`);
      check('6. Revised message with the same response number is delivered', rev === 1, `ALPHA got the revision ${rev}x`);
      await site(0, `post(protocol('003', 'Looks good. One nit.'))`);
      await waitFor('R.ledger.some(e => e.from === 0 && e.num === "003" && e.state === "awaiting")', 40000);
      await site(1, `post(protocol('015', 'REVISED AGAIN: PR #11 at 77aa01b.'))`);
      await waitFor('!R.on', 40000);
      const loopHeld = await js(`R.held.some(h => h.num === '015') && /possible loop/.test(R.blocker)`);
      const v3 = await site(0, `window.received.filter(t => t.includes('REVISED AGAIN')).length`);
      check('8b. Repeated RESPONSE 015 loop is detected and paused with an explanation', loopHeld && v3 === 0, `blocker: "${(await js('R.blocker')).slice(0, 110)}"; third version sent ${v3}x`);

      // ---- 7. Side conversation is not forwarded ----
      await js(`R.held = []; setRelay(true); true`);
      await sleep(2500);
      const bBefore = await recv(1);
      await site(0, `post('Side answer: 4. (no relay markers here)')`);
      await sleep(14000);
      const bAfter = await recv(1);
      const sideNote = await js(`chatLog.some(m => /side conversation and not forwarded/.test(m.text))`);
      check('7. Side conversation is not forwarded', bAfter === bBefore && sideNote, `BETA ${bBefore}→${bAfter}`);

      // ---- 2. Retry after a lost acknowledgment without submitting twice ----
      await site(1, `cfg.lag = 9000; true`); // BETA shows the message (and clears its box) only after 9 s
      const b2 = await recv(1);
      await site(0, `post(protocol('004', 'Please also update the README.'))`);
      await waitFor('R.ledger.some(e => e.from === 0 && e.num === "004")', 30000);
      const sawUncertain = await waitFor('R.ledger.some(e => e.from === 0 && e.num === "004" && !!e.uncertainAt)', 30000);
      await waitFor('R.ledger.some(e => e.from === 0 && e.num === "004" && e.state === "awaiting")', 40000);
      await sleep(4000);
      const b2a = await recv(1);
      check('2. Lost acknowledgment: checked first, submitted once', sawUncertain && b2a === b2 + 1, `went uncertain: ${sawUncertain}; BETA ${b2}→${b2a}`);
      await site(1, `cfg.lag = 0; true`);

      // ---- 3. Restart after submission but before success was recorded ----
      // BETA answers 004, which is relayed to ALPHA; then pretend the app died right after pressing send.
      await site(1, `post(protocol('016', 'Done: README updated in 5e6f7a8.'))`);
      await waitFor('R.ledger.some(e => e.from === 1 && e.num === "016" && e.state === "awaiting")', 40000);
      const a3 = await recv(0);
      await js(`(async () => { const e = inflight(); e.state = 'queued'; delete e.awaitingAt; R.turn--; await saveNow(); return true; })()`);
      await js(`(async () => { R.on = false; const l = await window.api.listSessions(); const j = await window.api.loadSession(l[0].id); applySession(j, false); setRelay(true); return inflight() && inflight().state; })()`);
      await waitFor('inflight() && inflight().state === "awaiting"', 40000);
      await sleep(4000);
      const a3a = await recv(0);
      const noteArrived = await js(`chatLog.some(m => /had arrived\\. Not resending/.test(m.text))`);
      check('3. Restart mid-delivery: destination checked, not resubmitted', a3a === a3 && noteArrived, `ALPHA ${a3}→${a3a}`);

      // ---- 4. Slow / streaming response: the old reply is not captured ----
      await site(0, `cfg.slow = true; post(protocol('005', 'Final check: everything verified end to end, with a long streamed answer that pauses midway.'))`);
      await sleep(4000);
      const midState = await js('JSON.stringify({ busy: working[0], inflightTo: inflight() && inflight().to })');
      await waitFor('R.ledger.some(e => e.from === 0 && e.num === "005" && e.state === "awaiting")', 60000);
      await sleep(3000);
      const got005 = await site(1, `window.received.filter(t => t.includes('ALPHA RESPONSE 005 START')).map(t => t.includes('pauses midway') && t.includes('ALPHA REQUESTS BETA'))`);
      const stale = await site(1, `window.received.filter(t => t.includes('ALPHA RESPONSE 003')).length`);
      check('4. Slow streaming reply captured complete, once; old reply not resent', got005.length === 1 && got005[0] === true && stale === 1, `mid-stream: ${midState}; 005 deliveries ${JSON.stringify(got005)}; old 003 copies ${stale}`);

      // ---- overall ----
      const states = await js(`R.ledger.map(e => e.state).join(',')`);
      console.log('Ledger states: ' + states);
      console.log('Delivery line: ' + await js(`$('#deliveryLine').textContent`));
      console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
    } catch (e) {
      console.log('ACCEPTANCE ERROR', e);
    }
    app.quit();
  });
};
