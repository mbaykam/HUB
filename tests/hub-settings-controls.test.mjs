import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { JSDOM } from "../vendor/deepseek-harness/node_modules/jsdom/lib/api.js";
import { installHubSettingsControls } from "@minke/harness-overlay/client/host/hub-settings-controls.ts";

function fixture() {
  const dom = new JSDOM('<div data-slot="sidebar.settings"><div role="dialog"><nav></nav><div><header><button data-hub-settings-native-close>Close</button></header><main></main></div></div></div><button data-minke-mobile-right-drawer-close>Close panel</button>', { url: "https://hub.test/" });
  const root = dom.window.document, requests = [], opened = [], changes = [];
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.HTMLDialogElement.prototype.showModal = function() { this.setAttribute("open", ""); };
  dom.window.HTMLDialogElement.prototype.close = function() { this.removeAttribute("open"); this.dispatchEvent(new dom.window.Event("close")); };
  dom.window.fetch = async (url, options) => {
    requests.push({ url, ...options });
    return { ok: true, json: async () => url.includes("telegram") ? { state: "connected" } : url.includes("view=organization")?{suggestions:[],reflections:[]}:{secondBrain:true,settings:{enabled:false},notes:3,todayEstimatedCost:0,jobs:[],vault:"fixture-vault",embedding:"fixture"} };
  };
  root.querySelector("[data-hub-settings-native-close]").addEventListener("click", () => changes.push("settings-closed"));
  root.querySelector("[data-minke-mobile-right-drawer-close]").addEventListener("click", () => changes.push("drawer-closed"));
  const sessions = { list: { getSnapshot: () => ({ byId: { "hub-eval-voice": { title: "Fixture conversation" } } }), subscribe: () => () => {} }, open: id => { opened.push(id); changes.push("chat-opened"); } };
  const history = { getSnapshot: () => ({ phase: "ready", records: [{ sessionId: "hub-eval-voice", createdAt: 12345678, saved: true }] }), subscribe: () => () => {}, refresh: async () => {} };
  const container = root.querySelector("main");
  const dispose = installHubSettingsControls(container, root, sessions, history);
  return { dom, root, container, requests, opened, changes, dispose };
}

test("Settings opens existing characters and Telegram controls without changing configuration", async () => {
  const f = fixture();
  try {
    let characterOpens = 0;
    f.dom.window.addEventListener("hub:characters-open", () => characterOpens++);
    f.container.querySelector("[data-hub-characters-launcher]").click();
    assert.equal(characterOpens, 1);
    [...f.container.querySelectorAll("button")].find(b=>b.textContent==="Telegram").click();
    await setImmediate();
    assert.equal(f.root.querySelector('[aria-label="Telegram connection"]').open, true);
    f.container.querySelector("[data-hub-knowledge-launcher]").click();
    await setImmediate();
    assert.equal(f.root.querySelector('[aria-label="Knowledge AI ayarları"]').open,true,"Knowledge AI opens directly from its Settings tile");
    assert.ok(f.requests.some(r => r.url === "/api/hub/telegram"));
    assert.ok(f.requests.some(r => r.url === "/api/hub/memory"));
    assert.ok(f.requests.every(r => r.method !== "POST"), "Browsing management must preserve user choices");
  } finally { f.dispose(); f.dom.window.close(); }
});

test("opening voice history from Settings exposes the selected chat, closing both overlaid panels", () => {
  const f = fixture();
  try {
    const history = f.container.querySelector("[data-hub-voice-history]");
    history.open = true;
    history.dispatchEvent(new f.dom.window.Event("toggle"));
    history.querySelector("[data-voice-history-open]").click();
    assert.deepEqual(f.opened, ["hub-eval-voice"]);
    assert.deepEqual(f.changes, ["chat-opened", "settings-closed", "drawer-closed"]);
  } finally { f.dispose(); f.dom.window.close(); }
});

test("closing Settings removes contributed dialogs and controls", async () => {
  const f = fixture();
  try {
    f.container.querySelector("[data-hub-models-launcher]").click();
    await setImmediate();
    f.dispose();
    assert.equal(f.container.children.length, 0);
    assert.equal(f.root.querySelector('[aria-label="Telegram connection"]'), null);
    assert.equal(f.root.querySelector("[data-minke-usage-meter]"), null);
    assert.equal(f.root.querySelector('[data-hub-overlay-style="hub-settings-controls"]'), null);
  } finally { f.dom.window.close(); }
});
