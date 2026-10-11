'use strict';
// Opt-in real-provider voice verifier with a real private Electron browser parent.
// Only an owned loopback fixture is reachable from its temporary partitions.
const assert = require('node:assert/strict');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { fork } = require('node:child_process');
const { createServer } = require('node:http');
const { mkdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve, dirname, basename } = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const root = resolve(__dirname, '..');
app.on('window-all-closed', () => {});
async function run() {
  const temp = process.env.HUB_VOICE_BROWSER_FIXTURE_ROOT;
  assert.ok(temp && dirname(resolve(temp)) === resolve(tmpdir()) && basename(temp).startsWith('hub-voice-browser-parent-'), 'Run via scripts/voice/verify_browser_model.mjs with its owned temporary root');
  await mkdir(join(temp, 'electron'));
  app.setPath('userData', join(temp, 'electron'));
  let child, channel, runtime, window, binding, attachTimer, deadline, attaching = false, clickCount = 0;
  const server = createServer((request, response) => {
    if (request.url === '/completed' && request.method === 'POST') { clickCount++; response.end('ok'); return; }
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><title>Lantern browser check</title><style>body{background:white;color:black;font:24px sans-serif;min-height:900px}button{font:inherit;padding:20px}</style>
      <h1>Lantern test page</h1><p id="state">Ready</p><button onclick="this.disabled=true;document.body.style.background='rgb(40,180,100)';document.querySelector('#state').textContent='Lantern browser check complete';fetch('/completed',{method:'POST'})">Run browser check</button>`);
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
    await app.whenReady();
    const code = buildSync({ bundle: true, external: ['electron'], platform: 'node', format: 'cjs', write: false,
      alias: { '@minke/harness-overlay': join(root, 'packages/harness-overlay/src') },
      stdin: { resolveDir: root, loader: 'ts', contents: `export {AgentBrowserRuntime} from './desktop/main/agent-browser/index.ts';` },
    }).outputFiles[0].text;
    const compiled = new Module(__filename + '.bundle', module); compiled.filename = __filename; compiled.paths = module.paths; compiled._compile(code, __filename);
    runtime = new compiled.exports.AgentBrowserRuntime({
      sessionFromPartition(partition, options) {
        const isolated = session.fromPartition(partition, options);
        isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(fixtureUrl) && details.url !== 'about:blank' }));
        isolated.on('will-download', event => event.preventDefault());
        return isolated;
      }, guestAttachTimeoutMs: 8000, cdpCommandTimeoutMs: 8000,
    });
    window = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: true } });
    binding = runtime.bindWindowProjection(ipcMain, window.webContents, () => true);
    window.webContents.on('will-attach-webview', (event, preferences, params) => { if (runtime.secureWebview(preferences, params) !== 'secured') event.preventDefault(); });
    window.webContents.on('did-attach-webview', (_event, guest) => { if (!runtime.attachGuest(window.webContents, guest)) guest.close({ waitForBeforeUnload: false }); });
    await window.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><style>html,body,webview{margin:0;width:100%;height:100%}webview{display:flex}</style><body></body>'));
    const attached = new Set();
    attachTimer = setInterval(async () => {
      if (attaching || window.isDestroyed()) return;
      attaching = true;
      try {
        for (const projection of runtime.projections()) if (projection.status === 'pending' && !attached.has(projection.partition)) {
          attached.add(projection.partition);
          await window.webContents.executeJavaScript(`(()=>{const view=document.createElement('webview');view.setAttribute('src','about:blank');view.setAttribute('partition',${JSON.stringify(projection.partition)});view.setAttribute('webpreferences','contextIsolation=yes,nodeIntegration=no,sandbox=yes,webSecurity=yes');document.body.append(view)})()`);
        }
      } catch (error) { console.error('Owned browser attachment failed:', error.message); child?.kill(); }
      finally { attaching = false; }
    }, 50);
    const args = process.argv.slice(2).filter(arg => arg !== '--');
    child = fork(join(root, 'scripts/voice/verify_model.mjs'), [...args, '--browser-task', fixtureUrl], { execPath: 'node', cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    child.stdout.on('data', data => process.stdout.write(data)); child.stderr.on('data', data => process.stderr.write(data));
    child.on('message', message => { if (message?.operation) console.log(JSON.stringify({ nativeBrowserOperation: message.operation, owner: message.ownerSessionId })); });
    channel = runtime.bindChild(child);
    deadline = setTimeout(() => { console.error('Voice/browser fixture deadline'); child.kill(); }, 360_000);
    const codeExit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(codeExit, 0, 'Native voice/browser child failed');
    assert.equal(clickCount, 1, 'The actual model must click the real page exactly once');
    assert.equal(window.isVisible(), false, 'Watching the browser must not surface a desktop window');
    console.log('PASS: actual model browser action in owned Electron webview, private process IPC, no unrelated websites/tabs and no desktop focus change');
  } finally {
    clearInterval(attachTimer); clearTimeout(deadline);
    if (child && child.exitCode === null) {
      child.kill(); await new Promise(resolve => { const timer = setTimeout(resolve, 4000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    }
    channel?.dispose(); binding?.dispose(); runtime?.dispose(); if (window && !window.isDestroyed()) window.destroy();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(dirname(resolve(temp)), resolve(tmpdir())); assert.ok(basename(temp).startsWith('hub-voice-browser-parent-'));
    // The Node launcher removes this exact profile only AFTER Electron exits;
    // Chromium can retain cache handles until then even after window.destroy().
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => app.exit(process.exitCode ?? 0));
