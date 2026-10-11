// Actual staged web application and authenticated routes, not a hand-built DOM
// or mocked SDK. No microphone gesture, model invocation or personal profile.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';

export async function verifyPackagedUi({ origin, cookie, playwright, screenshot }) {
  const { chromium } = createRequire(import.meta.url)(playwright);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let activePage;
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'dark' });
    const separator = cookie.indexOf('=');
    await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: origin }]);
    const page = await context.newPage(); activePage = page; const errors = []; const downloads = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().includes('/api/hub/voice/client.js')) downloads.push(request.url()); });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-hub-voice-hub] [data-voice-start]:not(:disabled)').waitFor({ timeout: 60_000 });
    // The disposable profile has no credentials. Dismiss the real first-launch
    // prompt via its supported UI; never seed a fake API key to bypass it.
    const later = page.getByRole('button', { name: 'Configure later', exact: true });
    await later.waitFor({ timeout: 30_000 });
    await later.click();
    await later.waitFor({ state: 'hidden' });
    assert.equal(downloads.length, 0, 'Voice SDK must remain lazy on actual PWA startup');
    assert.equal(await page.locator('[data-phase="hero"]').count(), 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (screenshot) {
      assert.ok(isAbsolute(screenshot));
      await page.screenshot({ path: screenshot, fullPage: true });
    }
    // Trusted browser input exercises the actual edge gesture and pointer capture.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 387, y: 400 }] });
    for (const x of [365, 320, 260, 190, 100, 35]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: 400 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const drawer = page.locator('[data-minke-mobile-right-drawer][aria-hidden="false"]');
    await drawer.waitFor();
    await drawer.locator('[data-hub-graph-tile]').click();
    const graph = page.locator('[data-hub-graph-dialog][open]');
    await graph.waitFor({ timeout: 30_000 });
    await graph.getByRole('button', { name: 'Close', exact: true }).click();
    await drawer.waitFor();
    await drawer.getByRole('button', { name: 'Open Settings', exact: true }).click();
    await page.locator('[data-minke-mobile-settings-open]').waitFor();
    assert.equal(downloads.length, 0, 'Utilities must not download voice SDK');
    assert.deepEqual(errors, []);
    console.log('PASS: actual staged PWA boot, connected Home hubs, lazy voice SDK, no horizontal overflow, real right-edge swipe, knowledge graph open/close and Settings');
    await cdp.detach();
    await context.close();
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } }); activePage = desktop;
    await desktop.context().addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: origin }]);
    await desktop.goto(origin, { waitUntil: 'domcontentloaded' });
    await desktop.locator('[data-slot="conversation.composer.bar"]').waitFor({ timeout: 60_000 });
    assert.equal(await desktop.locator('[data-hub-voice-hub]').count(), 0, 'Mobile hubs must not replace desktop UI');
    console.log('PASS: staged web app at desktop width retains native composer without mobile voice hubs');
  } catch (error) {
    if (activePage && !activePage.isClosed()) {
      console.error('Isolated packaged UI failure:', (await activePage.locator('body').innerText()).slice(0, 4000));
      if (screenshot && isAbsolute(screenshot)) await activePage.screenshot({ path: screenshot, fullPage: true });
    }
    throw error;
  } finally { await browser.close(); }
}
