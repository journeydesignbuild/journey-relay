module.exports = (win, app) => {
  const js = (c) => win.webContents.executeJavaScript(c);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  win.webContents.on('did-finish-load', async () => {
    await sleep(2000);
    await js(`
      modMsg('q', 'Q1 · CLAUDE asks:\\nShould PR #11 ship tonight?');
      modMsg('you', 'not tonight, tomorrow morning');
      modMsg('tool', 'Recorded your answer');
      modMsg('ai', 'Got it. Your answer goes to both sides with the next pass.');
      modMsg('sys', 'Passed AI 1 → AI 2 + your answer.');
      true`);
    // numbered list via Shift+Enter
    const r = await js(`(() => {
      const mi = $('#modInput'); mi.focus();
      mi.value = '1. first item'; mi.selectionStart = mi.selectionEnd = mi.value.length;
      const se = () => mi.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
      se(); mi.setRangeText('second item', mi.selectionStart, mi.selectionEnd, 'end'); se();
      const afterThird = mi.value;
      se(); // empty "3. " ends the list
      const ended = mi.value;
      mi.value = Array.from({ length: 14 }, (_, k) => 'line ' + (k + 1)).join('\\n'); window.__growMod();
      return { afterThird, ended, height: mi.offsetHeight, scroll: getComputedStyle(mi).overflowY };
    })()`);
    console.log('list: ' + JSON.stringify(r));
    await js(`$('#modInput').value = '1. first item\\n2. second item\\n3. third'; window.__growMod(); true`);
    await sleep(500);
    const img = await win.capturePage(); require('fs').writeFileSync('/tmp/jp-ui.png', img.toPNG());
    app.quit();
  });
};
