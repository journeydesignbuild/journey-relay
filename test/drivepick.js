module.exports = (win, app) => {
  const js = (c) => win.webContents.executeJavaScript(c);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  win.webContents.on('did-finish-load', async () => {
    await sleep(2000);
    const roots = await js('window.api.driveList()');
    console.log('roots: ' + JSON.stringify(roots.map((r) => r.path)));
    await js('openSettings(); true'); await sleep(800);
    console.log('options: ' + await js(`[...document.querySelectorAll('#sDrive option')].map(o => o.textContent).join(' || ')`));
    await js(`$('#sDrive').value = ${JSON.stringify(roots.find((r) => r.path.endsWith('/home2/My Drive')).path)}; $('#settingsForm').requestSubmit(); true`);
    await sleep(1500);
    console.log('saved driveFolder: ' + await js('settings.driveFolder') + ' | info: ' + JSON.stringify(await js('window.api.driveInfo()')));
    console.log('copied session exists: ' + require('fs').existsSync('/tmp/home2/My Drive/Journey Relay/_sessions/x1.json'));
    console.log('listed: ' + JSON.stringify((await js('window.api.listSessions()')).map((x) => x.title)));
    console.log('note: ' + await js(`[...document.querySelectorAll('#modChat .m')].map(m => m.textContent).filter(t => /Switched/.test(t)).join(' | ')`));
    app.quit();
  });
};
