import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { JSDOM } from "../vendor/deepseek-harness/node_modules/jsdom/lib/api.js";
import { installMobileMemory } from "@minke/harness-overlay/client/host/mobile-memory.ts";

test("memory drawer loads on demand, renders untrusted notes as text, and confirms forgetting", async () => {
  const dom = new JSDOM('<main></main>', { url: "https://hub.test/" });
  const root = dom.window.document; const requests = [];
  dom.window.fetch = async (url, options) => {
    requests.push({ url, ...options });
    return { ok: true, json: async () => ({ enabled: true, status: "ready", content: '# Personal memory\n\n<img src=x onerror=alert(1)>\nPrefers tea.' }) };
  };
  const dispose = installMobileMemory(root.querySelector("main"), root);
  try {
    assert.equal(requests.length, 0);
    root.querySelector("button").click(); await setImmediate();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].credentials, "same-origin");
    assert.equal(root.querySelector("img"), null);
    assert.match(root.querySelector("article").textContent, /<img/);
    const button = root.querySelectorAll("article button")[1];
    button.click(); await setImmediate(); assert.equal(requests.length, 1);
    assert.equal(button.textContent, "Confirm forget");
    button.click(); await setImmediate();
    assert.equal(requests.length, 2);
    assert.deepEqual(JSON.parse(requests[1].body), { action: "forget", passage: "Prefers tea." });
    assert.equal(root.querySelectorAll("article").length, 1);
    assert.match(root.querySelector('[role=status]').textContent, /Original chats are unchanged/);
  } finally { dispose(); assert.equal(root.querySelector("main").children.length, 0); dom.window.close(); }
});

test("failed forgetting leaves the passage visible and unavailable host is never called active", async () => {
  const dom = new JSDOM('<main></main>'); const root = dom.window.document;
  let unavailable = false;
  dom.window.fetch = async (_, options) => ({ ok: !unavailable && options.method !== "POST",
    json: async () => ({ enabled: true, status: "ready", content: "Likes tea." }) });
  const dispose = installMobileMemory(root.querySelector("main"), root);
  try {
    root.querySelector("button").click(); await setImmediate();
    const button = root.querySelector("article button"); button.click(); button.click(); await setImmediate();
    assert.ok(root.querySelector("article")); assert.equal(button.disabled, false);
    assert.match(root.querySelector('[role=status]').textContent, /Couldn’t forget/);
    unavailable = true; root.querySelector("button").click(); await setImmediate();
    assert.match(root.querySelector('[role=status]').textContent, /not available/);
  } finally { dispose(); dom.window.close(); }
});
