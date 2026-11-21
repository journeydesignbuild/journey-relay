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

      // ---- 10. Site suggestions after END OF TURN ("Create a doc"…) are ignored: no hang ----
      await js('settings.fallbackSec = 120; true');
      const t10 = Date.now();
      await site(1, `post(protocol('017', 'Final summary of the work.') + '\\n\\nCreate a doc\\nCreate a spreadsheet\\nSuggested next step: turn this into a project plan with milestones, owners and dates for the team.')`);
      const ok10 = await waitFor('R.ledger.some(e => e.from === 1 && e.num === "017" && e.state === "awaiting")', 60000);
      const secs = Math.round((Date.now() - t10) / 1000);
      const leaked = await site(0, `window.received.filter(t => t.includes('Create a spreadsheet')).length`);
      check('10. Text after END OF TURN ignored: relayed promptly, suggestions not forwarded', ok10 && secs < 30 && leaked === 0, `relayed after ${secs}s (fallback would be 120s); suggestion text forwarded ${leaked}x`);

      // ---- 11. Waiting on Justin: the answer to the in-flight delivery asks nothing of the other AI ----
      await js('if (!R.on) setRelay(true); true'); await sleep(2500);
      const fl11 = await js('JSON.stringify(R.inflight && { to: R.inflight.to, state: R.inflight.state })');
      const w = (await js('R.inflight ? R.inflight.to : 0')) | 0; const o = w === 0 ? 1 : 0;
      const b11 = await recv(o);
      let auto11 = null;
      await js('window.__autoMod = (i, p) => { window.__autoArgs = { i, num: p.num, q: p.userRequest }; }; true');
      await js('R.preapproved = [{ id: 1, text: "Yes, release PR #12.", covers: "release PR #12", to: "either" }]; true');
      await site(w, `post(protocol('${w === 0 ? '006' : '018'}', 'PR #12 is cleared. Waiting for your go.', { request: 'NONE', question: 'OK to release PR #12?' }))`);
      const off11 = await waitFor('!R.on', 40000);
      await sleep(3000);
      const b11b = await recv(o);
      const waitNote = await js(`chatLog.some(m => /Waiting for you/.test(m.text))`);
      const wo = await js('JSON.stringify(R.waitingOn)');
      auto11 = await js('JSON.stringify(window.__autoArgs || null)');
      check('11. Waiting on Justin: not forwarded, relay pauses with "Waiting for you"', off11 && b11b === b11 && waitNote && /"from":/.test(wo), `inflight ${fl11}; other side ${b11}→${b11b}; waitingOn=${wo}`);

      // ---- 12. Pre-approved next step: moderator path sends it to the asker with no card, once ----
      const a12 = await recv(w);
      const r12 = await js(`runTool('answer_questions', { answer: 'x', to: 'ai${w + 1}', use_preapproval: 1, deliver_now: true }).then(r => JSON.stringify(r))`);
      await sleep(4000);
      const a12b = await recv(w);
      const left = await js('R.preapproved.length');
      const again = await js(`runTool('answer_questions', { answer: 'x', to: 'ai${w + 1}', use_preapproval: 1, deliver_now: true }).then(r => JSON.stringify(r))`);
      check('12. Pre-approval: auto-check triggered, sent to the asker once, then used up', /"i":/.test(auto11 || '') && /delivered/.test(r12) && a12b === a12 + 1 && left === 0 && /error/.test(again), `auto=${auto11}; ${r12}; asker ${a12}→${a12b}; second try ${again}`);
      await js('delete window.__autoMod; true');

      // ---- 13. Empty box after the latest reply: still reads the real reply ----
      const r13 = await js(`run(panes[0], pgRead, '.bot', '#stop', '.user')`);
      await site(0, 'postEmpty(); true');
      const r13b = await js(`run(panes[0], pgRead, '.bot', '#stop', '.user')`);
      check('13. Empty reply box at the end is skipped', r13b.text && r13b.text === r13.text, `before "${(r13.text || '').slice(0, 40)}" after "${(r13b.text || '').slice(0, 40)}"`);

      // ---- 14. Long text becomes an attachment chip: waits for it, sends once, moderator can read it ----
      await js('R.inflight = null; R.held = []; R.blocker = ""; if (R.on) setRelay(false); true');
      await site(0, 'cfg.chipOver = 2000; true');
      const a14 = await recv(0);
      const long = 'LONG ' + 'x'.repeat(5000);
      await js(`(async () => { const e = { id: 't14', from: 1, to: 0, conv: 'c', dest: 'd', hash: 'h14', num: '014', state: 'captured', capturedAt: nowIso(), attempts: 0, answers: 0, base: { count: 0, id: '', hash: '', userCount: (await readPane(0)).userCount }, headHash: hashText(norm(${JSON.stringify(long)}).slice(0, 120)), out: ${JSON.stringify(long)}, files: [] }; R.ledger.push(e); R.inflight = e.id; await submit(e); return true; })()`);
      await sleep(1500);
      const a14b = await recv(0);
      const st14 = await js(`(R.ledger.find(e => e.id === 't14') || {}).state`);
      const rs14 = await js(`runTool('read_sent', { pane: 1 }).then(r => (r.text || r.error || '').slice(0, 10))`);
      check('14. Attachment chip: waits for it to load, sends once, read_sent shows the text', a14b === a14 + 1 && st14 === 'awaiting' && rs14 === 'LONG xxxxx', `ALPHA ${a14}→${a14b}; state ${st14}; read_sent "${rs14}"`);

      // ---- 15. Chip never sends: blocked with a clear message, not marked arrived ----
      await js('R.inflight = null; R.blocker = ""; true');
      await site(0, 'cfg.chipStuck = true; true');
      const a15 = await recv(0);
      await js(`(async () => { const e = { id: 't15', from: 1, to: 0, conv: 'c', dest: 'd', hash: 'h15', num: '015', state: 'captured', capturedAt: nowIso(), attempts: 0, answers: 0, base: { count: 0, id: '', hash: '', userCount: (await readPane(0)).userCount }, headHash: 'zz', out: ${JSON.stringify(long + 'B')}, files: [] }; R.ledger.push(e); R.inflight = e.id; await submit(e); return true; })()`);
      const a15b = await recv(0);
      const st15 = await js(`(R.ledger.find(e => e.id === 't15') || {}).state`);
      const bl15 = await js('R.blocker');
      check('15. Stuck attachment: not marked arrived, blocker explains it', a15b === a15 && st15 === 'uncertain' && /still sitting/.test(bl15), `ALPHA ${a15}→${a15b}; state ${st15}; blocker "${(bl15 || '').slice(0, 70)}"`);
      await site(0, 'cfg.chipOver = 0; cfg.chipStuck = false; true');

      // ---- 16. An attachment in an older message isn't mistaken for a stuck one ----
      await site(0, 'if (chip) { chip.remove(); chip = null; } sendBtn().disabled = false; oldChip(); true');
      const c16 = await js(`run(panes[0], pgComposer, '#box', '.bot, .user')`);
      check('16. Old attachment in the chat is not counted as stuck in the input box', c16.chips === 0, JSON.stringify(c16));

      // ---- 17. Drive choice sticks even when another window saves old settings ----
      const d0 = await js('window.api.driveInfo().then(r => r.root)');
      await js(`window.api.driveSet('/tmp/fakedrive2/My Drive')`);
      await js(`window.api.saveSettings({ ...settings, driveFolder: '' })`); // a stale window saving
      const d17 = await js('window.api.driveInfo().then(r => r.root)');
      await js(`window.api.driveSet(${JSON.stringify('')})`);
      check('17. Drive choice survives a stale window saving settings', d17 === '/tmp/fakedrive2/My Drive', `before ${d0}; after stale save ${d17}`);

      // ---- 18. A Stop button outside the chat (task tracker) doesn't make the AI look busy ----
      await site(1, 'trackerStop(true); true');
      const r18 = await js(`run(panes[1], pgRead, '.bot', '#stop', '.user')`);
      await site(1, 'trackerStop(false); true');
      check('18. Stop button in a header/task tracker is ignored', r18.busy === false && (r18.busyIgnored || []).length > 0, JSON.stringify({ busy: r18.busy, why: r18.busyWhy, ignored: r18.busyIgnored }));

      // ---- 19. Message typed while the moderator is busy is kept, and closes an open approval card ----
      const r19 = await js(`(async () => {
        modBusy = true;
        const card = askApproval('Test card', 'hello');
        await moderatorSend('Q-24 Maruta');
        const res = await card;
        const out = { queued: modQueue.slice(), cardClosed: res.ok === false && res.why === 'new-message', pendingCleared: pendingApproval === null, note: JSON.stringify(declined(res)).slice(0, 60) };
        modQueue.length = 0; modBusy = false;
        return out;
      })()`);
      check('19. Moderator busy: new message queued (not lost) and open card closed', r19.queued[0] === 'Q-24 Maruta' && r19.cardClosed && r19.pendingCleared, JSON.stringify(r19));

      // ---- 20. Questions card: needed first, answered and replaced ones hidden ----
      const r20 = await js(`(async () => {
        const realKey = settings.apiKey; settings.apiKey = ''; // no API in tests: skip the tidy call
        questions.length = 0; R.held = []; R.waitingOn = null;
        addQuestion(1, '024', 'Justin: millwork, does Journey build it or Maruta Makes?');
        addQuestion(1, '025', 'Justin: do the fence, bench and water feature count inside the $180k landscape allowance?');
        addQuestion(0, '004', 'Approve the draft request to Bronte? It will not be sent without your OK.');
        addQuestion(1, '026', 'Justin: which of the six email drafts are approved?');
        R.waitingOn = { from: 1, num: '025' };
        qOpen = true; renderQuestions();
        const a = { title: $('#qTitle').textContent, items: [...document.querySelectorAll('#qList .qitem')].map(d => d.querySelector('.qtag').textContent + ' ' + d.querySelector('.qnum').textContent) };
        await runTool('update_questions', { ids: [3], status: 'dropped' });
        questions[0].answered = true; renderQuestions();
        const b = { title: $('#qTitle').textContent, items: [...document.querySelectorAll('#qList .qitem')].map(d => d.querySelector('.qtag').textContent + ' ' + d.querySelector('.qnum').textContent) };
        settings.apiKey = realKey;
        return { a, b };
      })()`);
      await sleep(300);
      try { const img = await win.capturePage(); require('fs').writeFileSync('/tmp/qcard.png', img.toPNG()); } catch (e) {}
      check('20. Questions card: needed first, answered/dropped hidden', /1 needed/.test(r20.a.title) && r20.a.items[0] === 'NEEDED Q2' && r20.a.items.length === 4 && r20.b.items.length === 2 && !r20.b.items.some(t => /Q1|Q3/.test(t)), JSON.stringify(r20));

      // ---- 21. Approval card: fits its text, never taller than the moderator chat, scrolls ----
      const r21 = await js(`(async () => {
        const short1 = askApproval('Short', 'one line');
        await new Promise(r => setTimeout(r, 100));
        const cards = document.querySelectorAll('.m.approve textarea');
        const s = cards[cards.length - 1].offsetHeight;
        pendingApproval(false); await short1;
        const long1 = askApproval('Long', Array.from({ length: 200 }, (_, k) => 'line ' + k).join('\\n'));
        await new Promise(r => setTimeout(r, 100));
        const t = [...document.querySelectorAll('.m.approve textarea')].pop();
        const out = { shortH: s, longH: t.offsetHeight, chatH: $('#modChat').clientHeight, scrolls: t.scrollHeight > t.clientHeight };
        const shot = 1;
        return out;
      })()`);
      try { const img = await win.capturePage(); require('fs').writeFileSync('/tmp/approve.png', img.toPNG()); } catch (e) {}
      await js('pendingApproval && pendingApproval(false); true');
      check('21. Approval card fits text, capped at the moderator height, scrolls', r21.shortH < 120 && r21.longH <= r21.chatH && r21.scrolls, JSON.stringify(r21));

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
