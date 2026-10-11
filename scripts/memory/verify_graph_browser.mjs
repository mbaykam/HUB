// Runs against the actual memory plugin handler and a disposable native MCP vault.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export async function verifyGraphBrowser({ root, playwright, screenshot, chrome, handler, searchTarget, searchCounts }) {
  const { chromium } = await import(pathToFileURL(resolve(playwright, "index.mjs")));
  const bundle = await build({ entryPoints: [resolve(root, "packages/harness-overlay/src/client/host/mobile-memory-graph.ts")], bundle: true, write: false, format: "esm", metafile: true, loader: { ".css": "text" } });
  assert.ok(!Object.keys(bundle.metafile.inputs).some(path => path.includes("node_modules/cytoscape")), "Tile must not bundle the graph engine");
  let downloads = 0, graphReads = 0, forgetRequests = 0;
  let admitPreview, sawPreview;
  const previewAdmission = new Promise(resolve => { admitPreview = resolve; });
  const previewRequested = new Promise(resolve => { sawPreview = resolve; });
  const server = createServer((req, res) => {
    if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:20px;background:#101426;color:#edf0f7;font-family:system-ui}*{box-sizing:border-box}</style><main id="widgets"></main><audio id="voice"></audio><script type="module">import {installMobileMemoryGraph} from "/tile.js";window.dispose=installMobileMemoryGraph(document.querySelector("main"),document)</script>'); }
    else if (req.url === "/tile.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(bundle.outputFiles[0].text); }
    else if (req.url?.startsWith("/api/hub/memory")) {
      if (req.method === "POST") forgetRequests++;
      if (req.url.includes("view=client")) downloads++;
      if (req.url.includes("view=graph")) {
        graphReads++;
        if (graphReads === 1) { sawPreview(); void previewAdmission.then(() => handler(req, res)); return; }
      }
      void handler(req, res);
    }
    else { res.writeHead(404); res.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  let browser;
  try {
    // The MCP fixture deliberately isolates USERPROFILE/LOCALAPPDATA, so a
    // caller may supply the installed executable while still using a fresh
    // Playwright-owned browser profile (never the user's browser data).
    browser = await chromium.launch({ ...(chrome ? { executablePath: chrome } : { channel: "chrome" }), headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await Promise.race([previewRequested, new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error("Preview did not request real graph")), 15_000); timeout.unref(); })]);
    assert.equal(downloads, 0, "Graph engine must not download with Home/tile startup");
    await page.evaluate(() => { window.originalAudio = document.querySelector("audio"); });
    await page.locator("[data-hub-graph-tile]").click();
    // One tap during an in-flight preview must still open the viewer.
    admitPreview();
    await page.waitForSelector("[data-hub-graph-dialog][open] canvas");
    assert.equal(graphReads, 1, "Opening must await the existing preview instead of requiring another tap");
    assert.equal(downloads, 1);
    assert.equal(await page.getByRole("button", { name: searchTarget.title, exact: true }).count(), 0);
    await page.getByRole("searchbox").fill(searchTarget.query);
    await page.getByRole("searchbox").press("Enter");
    await page.getByRole("button", { name: searchTarget.title, exact: true }).waitFor();
    assert.equal(await page.locator("[data-graph-notes] button").count(), 1);
    await page.getByRole("button", { name: searchTarget.title, exact: true }).click();
    await page.waitForFunction(token => document.querySelector("[data-graph-note] pre")?.textContent.includes(token), searchTarget.query);
    await page.getByRole("button", { name: "‹ Results", exact: true }).click();
    assert.equal(await page.evaluate(() => document.activeElement.textContent), searchTarget.title);
    await page.getByRole("searchbox").fill("Graph Person");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("button", { name: "Graph Person", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("[data-graph-note] pre")?.textContent.includes("works_on [[Graph Project]]"));
    await page.getByRole("button", { name: "‹ Results", exact: true }).click();
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "Graph Person", "Returning from note restores focus to its row");
    for (let tab = 0; tab < 12; tab++) {
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest("[data-hub-graph-dialog]"))), true, "Tab remains inside the graph modal");
    }
    await page.getByRole("searchbox").fill("Graph Project");
    await page.getByRole("searchbox").press("Enter");
    await page.getByRole("button", { name: "Graph Project", exact: true }).waitFor();
    // Full-text search can also find Graph Person's link to Graph Project.
    assert.ok(await page.locator("[data-graph-notes] button").count() >= 1);
    await page.getByRole("searchbox").fill("Vault fixture");
    await page.getByRole("searchbox").press("Enter");
    await page.waitForFunction(count => document.querySelectorAll("[data-graph-notes] button").length === count, searchCounts[0]);
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.waitForFunction(count => document.querySelectorAll("[data-graph-notes] button").length === count, searchCounts[1]);
    assert.equal(await page.getByRole("button", { name: "Next", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Previous", exact: true }).click();
    await page.waitForFunction(count => document.querySelectorAll("[data-graph-notes] button").length === count, searchCounts[0]);
    await page.getByRole("searchbox").fill("nonexistentuniquetoken");
    await page.getByRole("searchbox").press("Enter");
    await page.getByRole("status").filter({ hasText: "No visible matches" }).waitFor();
    assert.equal(await page.locator("[data-graph-notes] button").count(), 0);
    await page.getByRole("searchbox").fill(searchTarget.query);
    await page.getByRole("searchbox").press("Enter");
    await page.getByRole("button", { name: searchTarget.title, exact: true }).waitFor();
    assert.equal(await page.locator("[data-graph-notes] button").count(), 1);
    await page.getByRole("searchbox").fill("");
    // Find an actual rendered mint node pixel, then tap the real canvas. No
    // private Cytoscape state or artificial DOM replacement stands in for input.
    const point = await page.evaluate(() => {
      for (const canvas of document.querySelectorAll("[data-graph-canvas] canvas")) {
        const context = canvas.getContext("2d"); if (!context) continue;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
          const i = (y * canvas.width + x) * 4;
          if (pixels[i] === 145 && pixels[i + 1] === 208 && pixels[i + 2] === 194 && pixels[i + 3] === 255) {
            const bounds = canvas.getBoundingClientRect(); return { x: bounds.x + (x + 2) * bounds.width / canvas.width, y: bounds.y + (y + 2) * bounds.height / canvas.height };
          }
        }
      }
    });
    assert.ok(point, "Graph must render actual visible nodes");
    await page.touchscreen.tap(point.x, point.y);
    await page.waitForSelector("[data-graph-note]:not([hidden])");
    await page.waitForFunction(() => { const value = document.querySelector("[data-graph-note] h3")?.textContent; return value && value !== "Loading note…"; });
    assert.notEqual(await page.locator("[data-graph-note] h3").textContent(), "Couldn’t open this note. It may have changed or been removed.");
    await page.getByRole("button", { name: "‹ Graph", exact: true }).click();
    const canvas = page.locator("[data-graph-canvas]"); const before = await canvas.screenshot();
    await canvas.hover(); await page.mouse.wheel(0, -200); await page.waitForTimeout(350);
    assert.equal(before.equals(await canvas.screenshot()), false, "Real graph zoom must change its rendered surface");
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    const span = await page.evaluate(() => {
      const ys = [];
      for (const canvas of document.querySelectorAll("[data-graph-canvas] canvas")) {
        const ctx = canvas.getContext("2d"); if (!ctx) continue;
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
          const i = (y * canvas.width + x) * 4;
          if (pixels[i] === 145 && pixels[i + 1] === 208 && pixels[i + 2] === 194 && pixels[i + 3] === 255) { ys.push(y); break; }
        }
      }
      return Math.max(...ys) - Math.min(...ys);
    });
    assert.ok(span > 60, "Returning from search must restore a usable 2D layout, not a collapsed row");
    if (screenshot) await page.screenshot({ path: screenshot });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole("searchbox").fill("Topic Preferences"); await page.getByRole("searchbox").press("Enter");
    await page.getByRole("button", { name: "Topic Preferences", exact: true }).click();
    await page.getByRole("combobox", { name: "Saved passage to forget" }).selectOption("0");
    await page.getByRole("button", { name: "Forget", exact: true }).click();
    assert.equal(forgetRequests, 0, "First click only asks for confirmation");
    await page.getByRole("button", { name: "Confirm forget", exact: true }).click();
    await page.waitForFunction(() => { const body = document.querySelector("[data-graph-note] pre")?.textContent; return body?.includes("accessible controls") && !body.includes("green tea"); });
    assert.equal(forgetRequests, 1);
    await page.getByRole("button", { name: "‹ Results", exact: true }).click();
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "Topic Preferences");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.waitForSelector("[data-hub-graph-dialog]", { state: "detached" });
    assert.equal(await page.locator("[data-hub-graph-dialog]").count(), 0);
    assert.equal(await page.evaluate(() => window.originalAudio === document.querySelector("audio")), true);
    assert.deepEqual(errors, []);
    await page.evaluate(() => window.dispose());
    assert.equal(await page.locator("[data-hub-graph-tile]").count(), 0);
    console.log("PASS: actual PWA tile lazy-load -> real graph -> canvas tap/original note -> whole-vault body search/pagination/no-results/focus -> zoom/close, no overflow or audio-element replacement");
  } finally { admitPreview(); await browser?.close(); server.close(); await once(server, "close"); }
}
