import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { JSDOM } from "../vendor/deepseek-harness/node_modules/jsdom/lib/api.js";
import { createMobilePresentation } from "@minke/harness-overlay/client/host/mobile-presentation.ts";

const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
test("canvas follows updates, can freeze/reopen, and cannot carry a visual into another chat", async () => {
  const dom = new JSDOM("<body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  const { window } = dom, doc = window.document, priorEvent = globalThis.Event;
  globalThis.Event = window.Event;
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new window.Event("close")); };
  let latest = { id: randomUUID(), title: "First plan", kind: "html", createdAt: 1 };
  const requests = [];
  window.fetch = async (url, init) => { requests.push({ url, headers: init.headers }); return Response.json(url.endsWith("presentation-document") ? { document: "<p>Fixture visual</p>" } : { presentation: init.headers["x-hub-session"] === "other" ? null : latest }); };
  const canvas = createMobilePresentation(doc); doc.body.append(canvas.button);
  try {
    canvas.setSession("hub-eval-canvas"); await tick();
    assert.equal(canvas.dialog.open, true); assert.equal(canvas.dialog.querySelector("iframe").title, "First plan");
    assert.equal(canvas.dialog.querySelector("iframe").getAttribute("sandbox"), "allow-scripts");
    latest = { ...latest, id: randomUUID(), title: "Updated plan" }; await tick(1600);
    assert.equal(canvas.dialog.querySelector("iframe").title, "Updated plan");
    canvas.dialog.querySelector('[aria-pressed]').click();
    latest = { ...latest, id: randomUUID(), title: "Frozen update" }; await tick(1600);
    assert.equal(canvas.dialog.querySelector("iframe").title, "Updated plan");
    const update = [...canvas.dialog.querySelectorAll("button")].find(button => button.textContent === "Show latest");
    assert.equal(update.hidden, false); update.click(); await tick();
    assert.equal(canvas.dialog.querySelector("iframe").title, "Frozen update");
    canvas.dialog.close(); await tick(1600); assert.equal(canvas.dialog.open, false);
    canvas.button.click(); await tick(); assert.equal(canvas.dialog.open, true);
    canvas.setSession("other"); await tick(); assert.equal(canvas.dialog.open, false); assert.equal(canvas.button.hidden, true);
    canvas.setSession("hub-eval-canvas"); await tick(); assert.equal(canvas.dialog.open, false); assert.equal(canvas.button.hidden, false);
    canvas.setCall("call-fixture"); await tick(); assert.ok(requests.some(request => request.url.includes("/voice/") && request.headers["x-hub-voice-call"] === "call-fixture"));
    canvas.setCall(undefined); await tick(); assert.equal(canvas.dialog.open, false);
  } finally { canvas.dispose(); dom.window.close(); globalThis.Event = priorEvent; }
});
