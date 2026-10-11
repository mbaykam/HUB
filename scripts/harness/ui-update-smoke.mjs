import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { UI_FILES, uiHash, parseUiHost, changeUiRelease } from "../../packages/harness-overlay/src/host/ui-release-store.ts";

/** Runs against an actual isolated Harness server, not a mocked plugin route. */
export async function smokeUiUpdates(server, root, lib) {
  const { compatibility } = parseUiHost(await readFile(join(lib, "ui-host.json"), "utf8"));
  const directory = join(root, compatibility);
  const base = Object.fromEntries(await Promise.all(UI_FILES.map(async name => [name, await readFile(join(lib, name))])));
  function bundle(label) {
    const files = Object.fromEntries(UI_FILES.map(name => {
      let bytes = base[name];
      if (name === "pwa-client.js") bytes = Buffer.from(bytes.toString() + `\n{ const original = window.__HUB_UI_FACTORY__; window.__HUB_UI_FACTORY__ = require => { const module = original(require); return { ...module, apply(ctx) { window.__HUB_UI_SMOKE__ = ${JSON.stringify(label)}; module.apply(ctx); } }; }; }\n`);
      return [name, { sha256: uiHash(bytes), data: bytes.toString("base64") }];
    }));
    return JSON.stringify({ schema: 1, compatibility, label, files });
  }
  const a = bundle("Smoke A"), b = bundle("Smoke B");
  const status = async () => {
    const result = await server.fetch(server.baseUrl + "/api/hub/ui/status");
    assert.equal(result.status, 200); return result.json();
  };
  assert.equal((await status()).id, "builtin");
  assert.equal((await fetch(server.baseUrl + "/api/hub/ui/status")).status, 401);
  await changeUiRelease(directory, compatibility, { text: a, sha256: uiHash(a) });
  assert.equal((await status()).id, uiHash(a));
  const html = await (await server.fetch(server.baseUrl + "/")).text();
  assert.ok(html.includes(`release=${uiHash(a)}&amp;file=pwa-client.js`));
  assert.ok(html.indexOf(`/api/hub/ui/asset`) < html.indexOf("window.__ModuleLoader__="));
  const assetUrl = server.baseUrl + `/api/hub/ui/asset?release=${uiHash(a)}&file=pwa-client.js`;
  assert.equal(uiHash(await (await server.fetch(assetUrl)).text()), JSON.parse(a).files["pwa-client.js"].sha256);
  const playwrightPath = process.env.HUB_UI_QA_PLAYWRIGHT;
  if (playwrightPath) {
    const { chromium, webkit } = createRequire(import.meta.url)(playwrightPath);
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch({ headless: true, ...(engine === chromium ? { channel: "chrome" } : {}) });
      try {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        const separator = server.browserCookie.indexOf("=");
        await context.addCookies([{ name: server.browserCookie.slice(0, separator), value: server.browserCookie.slice(separator + 1), url: server.baseUrl }]);
        const page = await context.newPage(); const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        const loaded = async expected => {
          await page.waitForFunction(value => window.__HUB_UI_SMOKE__ === value, expected);
          await page.locator("html[data-minke-mobile-web]").waitFor();
          await page.waitForLoadState("networkidle");
          assert.equal(await page.evaluate(() => document.querySelectorAll('[data-hub-ui-update]').length), 0);
        };
        await page.goto(server.baseUrl); await loaded("Smoke A");
        const originalId = await page.evaluate(() => window.__HUB_UI_RELEASE__.id);
        await changeUiRelease(directory, compatibility, { text: b, sha256: uiHash(b) });
        assert.equal((await status()).id, uiHash(b));
        assert.equal(await page.evaluate(() => window.__HUB_UI_RELEASE__.id), originalId);
        assert.deepEqual(await page.evaluate(async () => {
          const id = window.__HUB_UI_RELEASE__.id;
          const graph = await import(`/api/hub/ui/asset?release=${id}&file=memory-graph-browser.js`);
          const voice = await import(`/api/hub/ui/asset?release=${id}&file=voice-browser.js`);
          return [typeof graph.openMemoryGraph, typeof voice.createVoiceClient];
        }), ["function", "function"]);
        await page.reload(); await loaded("Smoke B");
        await changeUiRelease(directory, compatibility, "rollback");
        await page.reload(); await loaded("Smoke A");
        await changeUiRelease(directory, compatibility, "builtin");
        await page.reload(); await page.locator("html[data-minke-mobile-web]").waitFor();
        await page.waitForLoadState("networkidle");
        assert.equal(await page.evaluate(() => window.__HUB_UI_RELEASE__.id), "builtin");
        assert.equal(await page.evaluate(() => window.__HUB_UI_SMOKE__), undefined);
        assert.deepEqual(errors, []);
        console.log(`PWA UI update browser smoke (${engine.name()}): real factory activation, pinned lazy assets, refresh, rollback and built-in recovery passed`);
      } finally { await browser.close(); }
      await changeUiRelease(directory, compatibility, { text: a, sha256: uiHash(a) });
    }
  }
  await changeUiRelease(directory, compatibility, "builtin");
  assert.equal((await status()).id, "builtin");
  console.log("PWA UI update HTTP smoke: authenticated activation and recovery passed without restarting the host");
}
