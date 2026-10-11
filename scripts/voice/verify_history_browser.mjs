// Real Chrome UI against real native domain storage (caller owns an isolated
// cold DSH context). No production profile, microphone or model calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { createVoiceWeb } from '../../packages/harness-overlay/src/host/voice-web.ts';

export async function verifyHistoryBrowser({ history, observations, playwright, root }) {
  const token = randomUUID(); let origin;
  const list = { byId: Object.fromEntries(observations.map(observation => [observation.header.id, { title: observation.header.meta?.title || 'Voice conversation' }])) };
  const web = createVoiceWeb({ history,
    reject(request) { return request.headers.cookie !== `hub-test=${token}` ? 401 : request.headers.origin && request.headers.origin !== origin ? 403 : undefined; },
    async open() { throw new Error('This verifier must never start voice'); }, async close() {},
  });
  const { outputFiles } = await build({ loader: { '.css': 'text' }, entryPoints: [resolve(root, 'packages/harness-overlay/src/client/host/mobile-voice-history.ts')], bundle: true, format: 'esm', platform: 'browser', write: false });
  const server = createServer((request, response) => {
    if (request.url === '/ui.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(outputFiles[0].text); return; }
    if (request.url === '/test/native-list') {
      if (request.headers.cookie !== `hub-test=${token}`) { response.writeHead(401); response.end(); return; }
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(list)); return;
    }
    if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native HUB history verification</title><style>body{margin:20px;background:#10121c;color:#eee;font:16px system-ui}</style><main></main><script type="module">
        import {installMobileVoiceHistory} from '/ui.js';
        const snapshot = await (await fetch('/test/native-list')).json();
        globalThis.hubHistoryOpened = []; globalThis.hubHistoryClosed = 0;
        globalThis.dispose = installMobileVoiceHistory(document.querySelector('main'), document, {
          list: { getSnapshot: () => snapshot, subscribe: () => () => {} }, open(id) { globalThis.hubHistoryOpened.push(id); }
        }, () => { globalThis.hubHistoryClosed++; });
      </script>`); return;
    }
    void web.handler(request, response).catch(() => response.destroy());
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = createRequire(import.meta.url)(playwright);
  let browser;
  try {
    assert.equal((await fetch(origin + '/api/hub/voice/history')).status, 401);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.context().addCookies([{ name: 'hub-test', value: token, url: origin }]);
    await page.goto(origin);
    await page.waitForFunction(() => Boolean(globalThis.dispose) || Boolean(globalThis.hubHistoryTestError), null, { timeout: 10_000 }).catch(() => { throw new Error(`History UI did not mount: ${JSON.stringify(errors)}`); });
    assert.deepEqual(errors, []);
    assert.equal(await page.locator('article').count(), 0);
    await page.locator('summary').click();
    const id = history.snapshot().find(row => !row.saved).sessionId;
    const row = page.locator(`[data-voice-history-id="${id}"]`);
    await row.waitFor();
    await row.locator('[data-voice-history-open]').click();
    assert.deepEqual(await page.evaluate(() => globalThis.hubHistoryOpened), [id]);
    assert.equal(await page.evaluate(() => globalThis.hubHistoryClosed), 1);
    await row.getByRole('button', { name: /^Save .* to chats$/ }).click();
    await page.waitForFunction(id => document.querySelector(`[data-voice-history-id="${id}"] button:last-child`)?.textContent === 'Saved', id);
    assert.equal(history.view(id).saved, true, 'Actual durable native domain must acknowledge promotion');
    await page.reload(); await page.locator('summary').click();
    await row.getByText('Saved', { exact: true }).waitFor();
    assert.equal(await row.locator('button:last-child').isDisabled(), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log('PASS: actual Chrome Voice History reads cold native metadata, routes the exact native ID in one tap, persists Save via the real host handler, and survives reload');
  } finally {
    await browser?.close(); await web.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
