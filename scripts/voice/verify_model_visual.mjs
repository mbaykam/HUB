import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
/** Inspect a real model-generated visual using the product's fixed renderer. */
export async function verifyModelVisual({ document, playwright, screenshot }) {
  const { chromium } = await import(pathToFileURL(resolve(playwright, "index.mjs")));
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route("**/*", route => route.abort());
    await page.setContent('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#0e1220}iframe{width:100%;height:100vh;border:0}</style><iframe sandbox="allow-scripts" title="Real model explanation"></iframe>');
    await page.locator("iframe").evaluate((frame, content) => { frame.srcdoc = content; }, document);
    const frame = page.frameLocator("iframe");
    await frame.locator('body[data-ready], body[data-error]').waitFor();
    assert.equal(await frame.locator('body[data-error]').count(), 0, "Model-generated Vega must actually render");
    const slider = frame.locator('input[type="range"]').first(); await slider.waitFor();
    await slider.focus(); await slider.press("Home");
    const before = await frame.locator("svg").first().innerHTML();
    await slider.press("End");
    await page.waitForTimeout(100);
    assert.notEqual(await frame.locator("svg").first().innerHTML(), before, "Slider must change the explanatory SVG, not just its own control");
    assert.equal(await frame.locator("body").evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Real generated visual must fit phone width");
    if (screenshot) await page.screenshot({ path: screenshot });
    console.log("PASS: real model Vega renders in the opaque product sandbox; actual slider changes the explanatory SVG at phone width");
  } finally { await browser.close(); }
}
