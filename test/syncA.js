module.exports = (win, app) => {
  const js = (c) => win.webContents.executeJavaScript(c);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  win.webContents.on('did-finish-load', async () => {
    await sleep(2000);
    await js(`settings.apiKey = 'sk-ant-TESTKEY-12345'; settings.adapters['example.com'] = { name: 'x', input: '#i', reply: '.r', send: '', busy: '' }; settings.names = ['CHATGPT', 'CLAUDE']; true`);
    await js(`window.api.saveSettings(settings)`);
    const r = await js(`pushSync('correct horse')`);
    console.log('A push: ' + JSON.stringify({ ok: r.ok, keySynced: r.keySynced, file: r.file }));
    const raw = require('fs').readFileSync(r.file, 'utf8');
    console.log('A drive file has plaintext key: ' + raw.includes('TESTKEY') + ' | has adapters: ' + raw.includes('example.com') + ' | has syncKey: ' + raw.includes('syncKey'));
    app.quit();
  });
};
