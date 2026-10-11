'use strict';
// Owned integration fixture: real Node IPC + HTTP, no live HUB profile or keys.
const http = require('node:http');
const Module = require('node:module');
const { join } = require('node:path');
const { buildSync } = require('esbuild');
const root = join(__dirname, '..');
const code = buildSync({ bundle: true, platform: 'node', format: 'cjs', write: false,
  stdin: { resolveDir: root, loader: 'ts', contents: `
    export { BrowserViewClient, createBrowserViewHandler } from './packages/harness-overlay/src/host/browser-view.ts';
    export { createAgentBrowserRequest } from './packages/harness-overlay/src/agent-browser-contract.ts';
  ` },
}).outputFiles[0].text;
const compiled = new Module(__filename + '.bundle', module);
compiled.filename = __filename; compiled.paths = module.paths; compiled._compile(code, compiled.filename);
const { BrowserViewClient, createBrowserViewHandler, createAgentBrowserRequest } = compiled.exports;
let server, client, requests = 0, paused = false;
process.on('disconnect', () => { client?.dispose(); server?.close(); process.exit(0); });
process.on('message', async message => {
  if (message?.type === 'viewer-fixture-paused') { paused = message.paused === true; return; }
  if (message?.type !== 'init-viewer-fixture') return;
  try {
    // Register the owning task through the real existing browser channel. A
    // read-only native snapshot verifies that pair; it creates no extra tab.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { process.off('message', reply); reject(new Error('Owner admission timed out')); }, 8000);
      function reply(value) {
        if (value?.requestId !== 9001) return;
        clearTimeout(timer); process.off('message', reply);
        if (value.type === 'response') resolve(); else reject(new Error('Owner admission failed'));
      }
      process.on('message', reply);
      process.send(createAgentBrowserRequest(9001, message.owner, 'snapshot', { sessionId: message.browserId }));
    });
    client = new BrowserViewClient();
    const handler = createBrowserViewHandler({ query(query, signal) { requests++; process.send({ type: 'viewer-request-count', count: requests }); if (paused) return Promise.reject(new Error('Fixture disconnected')); return client.query(query, signal); } }, request => request.headers['x-hub-browser-view'] === '1' ? undefined : 401);
    server = http.createServer((request, response) => {
      if (request.url === '/api/hub/browser-view') { void handler(request, response); return; }
      response.setHeader('content-type', 'text/html');
      response.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;background:#101425;color:#fff;font-family:Arial}</style><audio></audio><script>${message.script}</script>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    process.send({ type: 'viewer-ready', port: server.address().port });
  } catch (error) { process.send({ type: 'viewer-failed', error: String(error) }); process.exitCode = 1; }
});
