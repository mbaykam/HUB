// Actual native tool/storage + product UI. Only the audio transport is replaced
// by a narrow test fixture forwarding real native events; no mic/provider call.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { createVoiceWeb } from "../../packages/harness-overlay/src/host/voice-web.ts";

export async function verifySaveBrowser({ root, playwright, history, sessionId, promote }) {
  const token = randomUUID(); let origin, promotions = 0;
  const web = createVoiceWeb({ history, reject: request => request.headers.cookie === `hub-test=${token}` ? undefined : 401,
    async open() { throw new Error("Test transport does not open audio"); }, async close() {} });
  const { outputFiles } = await build({ loader: { ".css": "text" }, stdin: { contents: `
    export {installMobileHubs} from './packages/harness-overlay/src/client/host/mobile-hubs.ts';
    export {installMobileVoiceHistory} from './packages/harness-overlay/src/client/host/mobile-voice-history.ts';
    export {installMobileConversationVisibility} from './packages/harness-overlay/src/client/host/mobile-conversation-visibility.ts';
    export {VoiceHistoryClient} from './packages/harness-overlay/src/client/host/voice-history.ts';`, resolveDir: root, loader: "ts" }, bundle: true, format: "esm", platform: "browser", write: false });
  const server = createServer((request, response) => { void (async () => {
    if (request.headers.cookie !== `hub-test=${token}`) { response.writeHead(401); response.end(); return; }
    if (request.url === "/ui.js") { response.writeHead(200, { "content-type": "text/javascript" }); response.end(outputFiles[0].text); return; }
    if (request.url === "/test/save" && request.method === "POST") {
      assert.equal(request.headers.origin, origin); assert.equal(request.headers["x-test-save"], "1");
      promotions++; const events = await promote();
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(events)); return;
    }
    if (request.url === "/api/hub/voice/status") { response.writeHead(200, { "content-type": "application/json" }); response.end('{"enabled":true}'); return; }
    if (request.url === "/api/hub/voice/client.js") {
      response.writeHead(200, { "content-type": "text/javascript" }); response.end(`export function createVoiceClient(options) {
        return { async start() { options.onSession(${JSON.stringify(sessionId)}); options.onState('listening'); },
          async sendText() { const events = await (await fetch('/test/save', {method:'POST', headers:{'x-test-save':'1'}})).json(); for (const event of events) options.onActivity(event); },
          async stop() { options.onState('idle'); }, mute() {}, async play() {} };
      }`); return;
    }
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" }); response.end(`<!doctype html><html data-minke-mobile-web><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HUB save acceptance</title>
        <style>body{background:#11131c;color:#eee;font:16px system-ui;margin:16px} [hidden]{display:none!important}</style>
        <main data-slot="conversation"><div data-phase="hero"><div data-composer-seat><div><div data-slot="conversation.composer.bar"></div></div></div></div></main><aside></aside>
        <script type="module">
          import {installMobileHubs,installMobileVoiceHistory,installMobileConversationVisibility,VoiceHistoryClient} from '/ui.js';
          const snapshot = {phase:'ready',current:undefined,byId:{[${JSON.stringify(sessionId)}]:{id:${JSON.stringify(sessionId)},title:'Save verification',origin:'root'}}};
          const list={getSnapshot:()=>snapshot,subscribe:()=>()=>{}};
          const ctx={sessions:{list,clear(){},open(){}},connection:{state:{getSnapshot:()=>'connected',subscribe:()=>()=>{}}}};
          const client = new VoiceHistoryClient((url,init)=>fetch(url,init));
          const nav={registerNavigationHiddenSessions(source){globalThis.visibility=source;return()=>{}}};
          globalThis.cleanup=[installMobileHubs(ctx),installMobileVoiceHistory(document.querySelector('aside'),document,ctx.sessions,()=>{},client),installMobileConversationVisibility(ctx,nav,document,client)];
          globalThis.originalAudio=document.querySelector('audio');
        </script></html>`); return;
    }
    if (request.url?.startsWith("/api/hub/voice/history")) { await web.handler(request, response); return; }
    response.writeHead(404); response.end();
  })().catch(error => { response.destroy(error); }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); origin = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = createRequire(import.meta.url)(playwright); let browser;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await page.context().addCookies([{ name: "hub-test", value: token, url: origin }]);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(id => globalThis.visibility?.getSnapshot().includes(id), sessionId).catch(error => { throw new Error(`Save UI did not mount: ${JSON.stringify(errors)}`, { cause: error }); });
    await page.locator("[data-hub-voice-history] summary").click();
    const row = page.locator(`[data-voice-history-id="${sessionId}"]`);
    await row.waitFor(); assert.equal(await row.locator("button:last-child").isDisabled(), false);
    await page.locator("[data-voice-start]").click();
    await page.locator("[data-voice-shared-form] textarea").fill("Please save this whole voice conversation as a normal chat.");
    await page.locator("[data-voice-shared-form] button").click();
    await row.getByText("Saved", { exact: true }).waitFor();
    await page.waitForFunction(id => !globalThis.visibility.getSnapshot().includes(id), sessionId);
    assert.equal(promotions, 1); assert.equal(history.view(sessionId).saved, true);
    assert.equal(await page.evaluate(() => document.querySelector("audio") === globalThis.originalAudio), true);
    await page.getByRole("button", { name: "End voice", exact: true }).click();
    await page.reload(); await page.locator("[data-hub-voice-history] summary").click();
    await row.getByText("Saved", { exact: true }).waitFor();
    assert.equal(await row.locator("button:last-child").isDisabled(), true);
    assert.deepEqual(errors, []);
    console.log("PASS: actual native Save events refresh the product browser archive and navigation visibility without reload; persisted promotion survives reload, audio element retained");
  } finally { await browser?.close(); await web.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
