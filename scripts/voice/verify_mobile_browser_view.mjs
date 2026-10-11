// Deterministic PWA states in actual Chrome/WebKit. Native compositor and IPC
// are exercised separately by tests/agent-browser-runtime.cjs --pwa-view.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
const { outputFiles } = await build({ loader: { '.css': 'text' }, stdin: {
  contents: 'export {createMobileBrowserView} from "./packages/harness-overlay/src/client/host/mobile-browser-view.ts"',
  resolveDir: process.cwd(), loader: 'ts',
}, bundle: true, write: false, format: 'esm', platform: 'browser' });
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': req.url === '/viewer.js' ? 'text/javascript' : 'text/html' });
  res.end(req.url === '/viewer.js' ? outputFiles[0].text : '<!doctype html><html data-minke-mobile-web><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;background:#101425;color:white;font:16px system-ui}</style><audio id="voice"></audio></html>');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const { chromium, webkit } = createRequire(import.meta.url)(process.argv[2]);
let browser, mode = 'unavailable', requests = 0, jpeg;
const tab = { sessionId: 'owned-browser', ownerSessionId: 'hidden-voice', title: 'Fixture page', url: 'https://example.com', status: 'ready', owner: 'agent' };
try {
  browser = process.argv.includes('--webkit') ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/hub/browser-view', async route => {
    requests++;
    const query = route.request().postDataJSON();
    if (mode === 'unavailable') return route.fulfill({ status: 503, json: { error: 'browser-unavailable' } });
    if (query.type === 'list') return route.fulfill({ json: mode === 'empty' ? [] : [tab] });
    assert.equal(query.ownerSessionId, tab.ownerSessionId);
    assert.equal(query.sessionId, tab.sessionId);
    return route.fulfill({ json: { tab, capturedAt: Date.now(), width: 200, height: 200, mimeType: 'image/jpeg', data: jpeg } });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  jpeg = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 200; const ctx = c.getContext('2d'); ctx.fillStyle = '#2563eb'; ctx.fillRect(0, 0, 200, 200); return c.toDataURL('image/jpeg').split(',')[1]; });
  await page.evaluate(async () => {
    const { createMobileBrowserView } = await import('/viewer.js');
    window.viewer = createMobileBrowserView(document); document.body.append(viewer.panel);
    window.voiceElement = document.querySelector('audio');
    viewer.update(true, new Map(), 'hidden-voice');
  });
  const panel = page.locator('[data-hub-browser-view]'), status = panel.locator('[role=status]');
  await status.getByText('Browser view unavailable. Reconnecting…', { exact: true }).waitFor();
  assert.ok(await panel.isVisible(), 'Initial failure is not silently hidden during voice');
  assert.ok(await panel.locator('button').isHidden(), 'Failure does not leave an empty preview card');
  mode = 'ready';
  await page.waitForFunction(() => document.querySelector('[data-hub-browser-view] img').naturalWidth > 0);
  assert.match(await panel.textContent(), /Voice conversation/);
  assert.ok(await panel.isVisible(), 'Voice browser appears without a Recents entry');
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 600 });
    await panel.getByRole('button', { name: 'Expand task browser' }).click();
    await page.waitForFunction(() => document.querySelector('dialog img').naturalWidth > 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    assert.ok(await page.evaluate(() => voiceElement === document.querySelector('audio')), 'Viewer does not recreate the audio owner');
  }
  await panel.getByRole('button', { name: 'Expand task browser' }).click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.mouse.move(8, 200); await page.mouse.down(); await page.mouse.move(180, 202, { steps: 12 }); await page.mouse.up();
  await page.waitForFunction(() => !document.querySelector('dialog').open);
  mode = 'unavailable';
  await status.getByText('Browser view unavailable. Reconnecting…', { exact: true }).waitFor();
  assert.equal(await panel.locator('img').getAttribute('src'), null, 'Failure clears old pixels');
  mode = 'empty';
  await page.waitForFunction(() => document.querySelector('[data-hub-browser-view]').hidden);
  mode = 'ready';
  await page.waitForFunction(() => document.querySelector('[data-hub-browser-view] img').naturalWidth > 0);
  await page.evaluate(() => viewer.update(false, new Map()));
  await page.waitForTimeout(150);
  const stopped = requests; await page.waitForTimeout(1200);
  assert.equal(requests, stopped, 'Leaving Home stops polling when viewer is closed');
  await page.evaluate(() => viewer.dispose());
  assert.equal(await page.locator('dialog').count(), 0);
  assert.equal(await page.locator('[data-hub-widget-back-edge]').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: initial 503 disclosure, hidden voice owner, real JPEG decode, 320/390/430 layout, expand/close/swipe, audio ownership, failed-frame purge, empty-state hiding, reconnect, polling/disposal');
} finally { await browser?.close(); server.close(); }
