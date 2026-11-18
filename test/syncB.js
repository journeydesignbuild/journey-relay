module.exports = (win, app) => {
  const js = (c) => win.webContents.executeJavaScript(c);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  win.webContents.on('did-finish-load', async () => {
    await sleep(2500);
    console.log('B before sign-in: dialog open=' + await js(`$('#signin').open`) + ' apiKey=' + JSON.stringify(await js('settings.apiKey')) + ' adapters synced=' + await js(`!!settings.adapters['example.com']`) + ' names=' + await js('JSON.stringify(settings.names)'));
    await js(`$('#signinPw').value = 'wrong'; $('#signinForm').requestSubmit(); true`); await sleep(1500);
    console.log('B wrong password: ' + await js(`$('#signinErr').textContent`) + ' | apiKey=' + JSON.stringify(await js('settings.apiKey')));
    await js(`$('#signinPw').value = 'correct horse'; $('#signinForm').requestSubmit(); true`); await sleep(1500);
    console.log('B right password: dialog open=' + await js(`$('#signin').open`) + ' apiKey=' + JSON.stringify(await js('settings.apiKey')));
    app.quit();
  });
};
