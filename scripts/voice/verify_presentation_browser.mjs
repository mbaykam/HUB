import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { build } from "esbuild";
import { createVoiceWeb } from "../../packages/harness-overlay/src/host/voice-web.ts";
import { staticPresentation, interactivePresentation, calculatorPresentation } from "./presentation-fixtures.mjs";

export async function verifyPresentationBrowser({ root, playwright, runtime, sessionId, publish }) {
  const renderer = await readFile(resolve(root, "packages/harness-overlay/lib/presentation-renderer.js"), "utf8");
  const shell = (await build({ stdin: { contents: "export {createMobilePresentation} from './packages/harness-overlay/src/client/host/mobile-presentation.ts'", resolveDir: root, loader: "ts" }, bundle: true, write: false, format: "esm", platform: "browser", loader: { ".css": "text" } })).outputFiles[0].text;
  const callId = randomUUID(); let deniedRequests = 0;
  const web = createVoiceWeb({ reject: request => request.headers.cookie === "fixture=allowed" ? undefined : 401,
    async open() { return { callId, sessionId, sidecar: { done: new Promise(() => {}), async request() { return { status: 200, body: { status: "connected" } }; } } }; }, async close() {},
    presentations: { summary: id => runtime.summary(id), async document(id, visualId) { return runtime.document(id, visualId, renderer); } },
  });
  const server = createServer((request, response) => {
    if (request.url === "/") { response.setHeader("content-type", "text/html"); response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{background:#0e1324;color:white;font-family:system-ui}</style><audio></audio><h1>HUB</h1>'); return; }
    if (request.url === "/shell.js") { response.setHeader("content-type", "text/javascript"); response.end(shell); return; }
    if (request.url.startsWith("/leak")) { deniedRequests++; response.end("unexpected"); return; }
    void web.handler(request, response);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = createRequire(import.meta.url)(playwright); let browser;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.context().addCookies([{ name: "fixture", value: "allowed", url: base, httpOnly: true }]);
    await page.goto(base);
    await page.evaluate(async id => {
      const { createMobilePresentation } = await import("/shell.js");
      const response = await fetch('/api/hub/voice/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), requestedAt: Date.now() }) });
      if (!response.ok) throw new Error('Fixture voice lease unavailable: ' + response.status + ' ' + await response.text());
      globalThis.audioOwner = document.querySelector('audio'); globalThis.fixtureSecret = "parent-only-secret";
      localStorage.setItem('fixture-private', 'parent-only-secret');
      globalThis.presentations = createMobilePresentation(document); document.body.append(globalThis.presentations.button); globalThis.presentations.setCall(id);
    }, callId);
    await publish(staticPresentation);
    await page.waitForSelector("[data-hub-visual-dialog][open] iframe");
    const frame = () => page.frameLocator("[data-hub-visual-dialog] iframe");
    await frame().locator("body[data-ready=true]").waitFor();
    assert.equal(await frame().locator("h1").textContent(), "One conversation");
    assert.equal(await frame().locator("svg").count(), 1);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.waitForTimeout(1800);
    assert.equal(await page.locator("dialog[open]").count(), 0, "dismissed visual must not reopen every poll");
    await page.getByRole("button", { name: /Open visual/ }).click();
    await frame().locator("body[data-ready=true]").waitFor();
    assert.equal(await page.evaluate(() => globalThis.audioOwner === document.querySelector("audio")), true);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await publish(interactivePresentation);
    await frame().locator("body[data-ready=true]").waitFor();
    await frame().locator('input[type=range]').fill('9');
    await frame().getByText("Area: 81", { exact: true }).waitFor();
    const screenshotIndex = process.argv.indexOf('--presentation-screenshot');
    if (screenshotIndex >= 0) { const path = process.argv[screenshotIndex + 1]; assert.ok(isAbsolute(path)); await page.screenshot({ path }); }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const source = await page.locator("iframe").getAttribute("srcdoc");
    assert.match(source, /script-src 'sha256-/); assert.doesNotMatch(source, /unsafe-eval/);
    const inner = page.frames().find(item => item !== page.mainFrame());
    assert.equal(await inner.evaluate(() => { try { return parent.fixtureSecret; } catch { return "blocked"; } }), "blocked");
    assert.equal(await inner.evaluate(() => { try { return localStorage.getItem("fixture-private"); } catch { return "blocked"; } }), "blocked");
    assert.equal(await inner.evaluate(() => document.featurePolicy.allowsFeature('microphone')), false);
    assert.equal(await inner.evaluate(() => document.featurePolicy.allowsFeature('camera')), false);
    assert.equal(await inner.evaluate(() => { try { top.location.href = 'https://example.com/'; return 'allowed'; } catch { return 'blocked'; } }), 'blocked');
    assert.equal(await inner.evaluate(async url => { try { await fetch(url); return "allowed"; } catch { return "blocked"; } }, `${base}/leak-fetch`), "blocked");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await publish(calculatorPresentation);
    await frame().locator("body[data-ready=true]").waitFor();
    await frame().getByText("12", { exact: true }).waitFor();
    await frame().locator('select').selectOption('×');
    await frame().getByText("35", { exact: true }).waitFor();
    await frame().locator('input[type=number]').first().fill('9');
    await frame().getByText("45", { exact: true }).waitFor();
    await frame().locator('select').selectOption('+');
    await frame().getByText("14", { exact: true }).waitFor();
    await frame().locator('select').selectOption('÷');
    await frame().locator('input[type=number]').last().fill('0');
    await frame().getByText("Cannot divide by zero", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => globalThis.audioOwner === document.querySelector("audio")), true);
    console.log("PASS: calculator opens automatically and performs real input-driven arithmetic without replacing the audio owner");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    const malicious = { title: "Isolation check", kind: "html", html: `<h2>Safe text</h2><script>parent.fixtureSecret='changed';location.href='${base}/leak-script'</script><img src="${base}/leak-image" onerror="parent.fixtureSecret='changed'"><a href="${base}/leak-link">Unsafe link</a><iframe src="${base}/leak-frame"></iframe><svg><foreignObject><input autofocus onfocus="parent.fixtureSecret='changed'"></foreignObject></svg>` };
    await publish(malicious); await frame().locator("body[data-ready=true]").waitFor();
    assert.equal(await frame().locator("#visual script,#visual iframe,#visual foreignObject,#visual [href],#visual [onerror]").count(), 0);
    await frame().getByText("Unsafe link").click(); await page.waitForTimeout(250);
    assert.equal(deniedRequests, 0, "visual content must not issue network requests");
    assert.equal(await page.evaluate(() => globalThis.fixtureSecret), "parent-only-secret");
    const wrong = await page.request.get(base + "/api/hub/voice/presentation", { headers: { "x-hub-voice-call": randomUUID() } }); assert.equal(wrong.status(), 409);
    await page.evaluate(() => globalThis.presentations.setCall(undefined));
    assert.equal(await page.locator("iframe").count(), 0);
    console.log("PASS: real native visual tool -> current-lease HTTP -> opaque Chrome canvas: static SVG, Vega slider, close/reopen, unchanged audio owner, no overflow, auth/parent/storage/network isolation");
  } finally { await browser?.close(); await web.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
