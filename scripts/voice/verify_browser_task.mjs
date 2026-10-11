import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

/** Actual native child/model and actual PWA viewer. A fixture-only gate pauses
 * the child's second model step to make concurrent speech deterministic. It does
 * not replace its tool choice, browser execution or returned page pixels.
 */
export async function verifyBrowserTask({ page, ctx, sessionId, task }) {
  await page.evaluate(async url => {
    globalThis.audioTrackId = document.querySelector('audio').srcObject.getAudioTracks()[0].id;
    await globalThis.voice.sendText(`Delegate this browser test to the smarter background assistant now: open ${url}, click the Run browser check button exactly once, then verify the visible Lantern browser check complete message. Leave the browser open. Acknowledge briefly and do not wait for the task.`);
  }, task.url);
  const until = Date.now() + 60_000;
  let child;
  while (!(child = ctx.agents.list().find(agent => agent.id !== sessionId))) {
    assert.ok(Date.now() < until, 'Luna must admit a real background task'); await delay(100);
  }
  await page.evaluate(id => globalThis.browserViewer.update(true, new Map([[id, 'Lantern browser task']])), child.id);
  try { await page.getByRole('button', { name: 'Expand task browser', exact: true }).waitFor({ timeout: 60_000 }); }
  catch (error) {
    const trace = child.session.snapshotEvents().filter(event => ['assistant/message', 'tool/result', 'turn/end'].includes(event.type)).map(event =>
      event.type === 'assistant/message' ? { type: event.type, content: event.data.message?.content?.filter(block => ['text', 'tool-call'].includes(block.type)) } : event);
    console.error('Synthetic child browser trace', JSON.stringify(trace).slice(-12000));
    throw error;
  }
  await page.waitForFunction(() => {
    const image = document.querySelector('[data-hub-browser-view] img'); return image?.complete && image.naturalWidth > 0 && !image.hidden;
  }, null, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Expand task browser', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-hub-browser-dialog] img')?.naturalWidth > 0);
  await page.evaluate(() => {
    globalThis.browserPixel = () => {
      const image = document.querySelector('[data-hub-browser-dialog] img');
      if (!image?.complete || !image.naturalWidth || image.hidden) return [];
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return [...context.getImageData(30, image.naturalHeight - 40, 1, 1).data];
    };
  });
  const before = await page.evaluate(() => globalThis.browserPixel());
  assert.ok(before.slice(0, 3).every(value => value > 230), 'PWA must show actual pre-action white page');
  await ctx.agents.get(sessionId).whenIdle();
  await page.evaluate(async () => {
    globalThis.spoken = []; globalThis.replyAudible = false; globalThis.expectedReply = 'browser'; globalThis.audibleWithBrowser = false;
    await globalThis.voice.sendText('Keep talking with me while the background task runs. Say browser work is running in one short sentence, without calling tools or waiting for it.');
  });
  await page.waitForFunction(() => globalThis.audibleWithBrowser || globalThis.errors.length, null, { timeout: 45_000 });
  assert.deepEqual(await page.evaluate(() => globalThis.errors), []);
  assert.equal(await page.evaluate(() => globalThis.audibleWithBrowser), true);
  assert.equal(await page.locator('[data-hub-browser-dialog] img').isVisible(), true);
  // Record the actual live browser while the child still owns it. Native child
  // teardown releases its browser; a completed task is not a retained live tab.
  if (task.screenshot) await page.screenshot({ path: task.screenshot, fullPage: true });
  task.release();
  await page.waitForFunction(() => {
    const [r, g, b] = globalThis.browserPixel(); return g > 120 && r < 90 && b < 160 && g > r * 1.5;
  }, null, { timeout: 60_000 });
  await child.whenIdle();
  const events = child.session.snapshotEvents();
  assert.ok(events.some(event => event.type === 'turn/end' && event.data.reason?.kind === 'completed'));
  assert.match(JSON.stringify(events), /browser_open/); assert.match(JSON.stringify(events), /browser_click/);
  assert.match(JSON.stringify(events), /Lantern browser check complete/);
  await ctx.agents.get(sessionId).whenIdle();
  await page.evaluate(async () => {
    globalThis.spoken = []; globalThis.audibleWithBrowser = false; globalThis.expectedReply = 'browser';
    await globalThis.voice.sendText('Say the word browser and a short acknowledgement, without tools, now that the background task has finished.');
  });
  await page.waitForFunction(() => globalThis.audibleWithBrowser || globalThis.errors.length, null, { timeout: 45_000 });
  assert.deepEqual(await page.evaluate(() => globalThis.errors), []);
  assert.equal(await page.evaluate(() => globalThis.audibleWithBrowser), true);
  assert.equal(await page.evaluate(() => document.querySelector('audio').srcObject.getAudioTracks()[0].id === globalThis.audioTrackId), true);
  await page.locator('[data-hub-browser-dialog]').getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(await page.evaluate(() => globalThis.peers.some(peer => peer.connectionState === 'connected')), true);
  assert.equal(await page.evaluate(() => document.querySelector('audio').srcObject.getAudioTracks()[0].id === globalThis.audioTrackId), true);
  console.log('PASS: actual Luna delegation -> stronger native model browser open/click/verification -> real Electron pixels change white-to-green in PWA; real local TTS alongside a visible pending-task browser and after completion; Close preserves audio track and RTC. Completed native task releases its browser, not a retained live tab.');
}
