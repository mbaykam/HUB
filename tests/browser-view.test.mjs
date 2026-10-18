import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { BROWSER_VIEW_CHANNEL, parseBrowserViewQuery, parseBrowserViewResult } from "@minke/harness-overlay/browser-view-contract.ts";
import { BrowserViewClient, createBrowserViewHandler } from "@minke/harness-overlay/host/browser-view.ts";
import { bindBrowserViewChannel } from "@minke/desktop/main/agent-browser/view-channel.ts";
import {JSDOM} from "../vendor/deepseek-harness/node_modules/jsdom/lib/api.js";
import {createMobileBrowserView} from "@minke/harness-overlay/client/host/mobile-browser-view.ts";

const tab = { sessionId: "browser-one", ownerSessionId: "task-one", title: "Example", url: "https://example.com", status: "ready", owner: "agent" };
const frame = { tab, capturedAt: 1000, width: 500, height: 600, mimeType: "image/jpeg", data: "/9j/" };
const query = { type: "frame", ownerSessionId: tab.ownerSessionId, sessionId: tab.sessionId };
const tick = () => new Promise(resolve => setImmediate(resolve));
class Port extends EventEmitter { connected = true; sent = []; send(value, callback) { this.sent.push(value); callback?.(null); return true; } }

test("Home shows browser failures only for an observed task, not for every voice call",async t=>{
 const dom=new JSDOM('<body></body>',{url:'https://hub.test',pretendToBeVisual:true});let available=false;
 dom.window.ResizeObserver=class{observe(){}disconnect(){}};dom.window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
 dom.window.fetch=async(_url,init)=>available?Response.json(JSON.parse(init.body).type==='list'?[tab]:frame):new Response('',{status:503});
 const viewer=createMobileBrowserView(dom.window.document);dom.window.document.body.append(viewer.panel);t.after(()=>{viewer.dispose();dom.window.close();});
 const refresh=async()=>{viewer.update(false,new Map());viewer.update(true,new Map(),'voice-fixture');await new Promise(r=>setTimeout(r,40));};
 await refresh();assert.equal(viewer.panel.hidden,true,'No observed browser means no empty warning widget on Home');
 available=true;await refresh();assert.equal(viewer.panel.hidden,false);assert.equal(viewer.panel.querySelector('img').hidden,false);
 available=false;await refresh();assert.equal(viewer.panel.hidden,false,'An observed task keeps its reconnect status');assert.equal(viewer.panel.querySelector('img').hidden,true,'A failed refresh must not show stale pixels');assert.match(viewer.panel.textContent,/Reconnecting/);
});

test("viewer contract rejects mutation operations, foreign frames and oversized content", () => {
  assert.throws(() => parseBrowserViewQuery({ type: "navigate", url: "https://example.com" }));
  assert.throws(() => parseBrowserViewQuery({ ...query, ownerSessionId: "../other" }));
  assert.throws(() => parseBrowserViewResult(query, { ...frame, tab: { ...tab, ownerSessionId: "other" } }));
  assert.throws(() => parseBrowserViewResult(query, { ...frame, width: 1025 }));
  assert.throws(() => parseBrowserViewResult(query, { ...frame, data: "<svg/onload=alert(1)>" }));
  assert.deepEqual(parseBrowserViewResult(query, frame), frame);
});

test("parent viewer gates owner ledger before capture and again after async capture", async () => {
  const port = new Port(), owners = new Set([tab.ownerSessionId]); let calls = 0, finish;
  const dispose = bindBrowserViewChannel(port, { listOwnedBrowsers: ids => ids.has(tab.ownerSessionId) ? [tab] : [], captureOwnedBrowser: async () => { calls++; return await new Promise(resolve => { finish = resolve; }); } }, () => owners);
  const request = (id, q) => port.emit("message", { channel: BROWSER_VIEW_CHANNEL, type: "request", requestId: id, query: q });
  request("foreign", { ...query, ownerSessionId: "other" }); await tick();
  assert.equal(calls, 0); assert.equal(port.sent.at(-1).error, "unavailable");
  request("capture", query); await tick(); owners.clear(); finish(frame); await tick();
  assert.equal(port.sent.at(-1).error, "unavailable");
  request("list", { type: "list" }); await tick(); assert.deepEqual(port.sent.at(-1).result, []);
  dispose(); assert.equal(port.listenerCount("message"), 0);
});

test("viewer IPC drops late responses, cancels on disconnect and bounds pending requests", async () => {
  const port = new Port(), client = new BrowserViewClient(port), controller = new AbortController();
  const cancelled = client.query(query, controller.signal); const id = port.sent.at(-1).requestId;
  controller.abort(); await assert.rejects(cancelled);
  port.emit("message", { channel: BROWSER_VIEW_CHANNEL, type: "response", requestId: id, result: frame });
  const first = client.query(query, new AbortController().signal);
  const second = client.query(query, new AbortController().signal);
  await assert.rejects(client.query(query, new AbortController().signal));
  port.emit("disconnect"); await assert.rejects(first); await assert.rejects(second);
  assert.equal(port.listenerCount("message"), 0);
});

test("viewer HTTP requires trusted auth, same-site custom header and bounded read-only JSON", async () => {
  let calls = 0;
  const handler = createBrowserViewHandler({ async query(input) { calls++; return input.type === "list" ? [tab] : frame; } }, req => req.headers.cookie === "fixture=allowed" ? undefined : 401);
  const server = createServer(handler); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { cookie: "fixture=allowed", "content-type": "application/json", "x-hub-browser-view": "1" };
  const post = (body, overrides = {}) => fetch(url, { method: "POST", headers: { ...headers, ...overrides }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ type: "list" }, { cookie: "bad" })).status, 401);
    assert.equal((await post({ type: "list" }, { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await post({ type: "list" }, { "x-hub-browser-view": "" })).status, 403);
    assert.equal((await post({ type: "list" }, { "content-type": "text/plain" })).status, 415);
    assert.equal((await post({ type: "navigate" })).status, 400);
    assert.equal((await post({ type: "list", extra: "x".repeat(5000) })).status, 413);
    assert.equal(calls, 0);
    const result = await post({ type: "list" }); assert.equal(result.status, 200);
    assert.match(result.headers.get("cache-control"), /no-store/);
    assert.equal(result.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.deepEqual(await result.json(), [tab]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
