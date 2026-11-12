import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { installInstalledUINetwork } from "../mobile/scripts/installed-ui-network.mjs";
import { applyHarnessRuntimePatches, resolveHarnessRuntimePatches } from "../scripts/harness/runtime-patches.mjs";
const hash = "a".repeat(64), tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function response(value = { schema: 1, compatibility: hash }, options = {}) {
  return { status: 200, redirected: false, headers: new Headers({ "content-type": "application/json; charset=utf-8" }), async json() { return value; }, ...options };
}
function fixture(serialized = false) {
  let time = 1000, next = 0, status = () => Promise.resolve(response());
  const calls = [], timers = new Map();
  const scope = { location: { href: "https://hub.test/hub-installed-ui/index.html" }, Date: { now: () => time },
    setTimeout(fn, delay) { const id = ++next; timers.set(id, { fn, at: time + delay }); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch(input, init) { calls.push({ input, init }); return String(input?.url ?? input).includes("/api/hub/ui/status") ? status() : Promise.resolve({ forwarded: true }); },
  };
  if (serialized) runInNewContext(`(${installInstalledUINetwork.toString()})("${hash}", scope)`, { scope, URL, AbortController, Object, Promise, Error, Date });
  else installInstalledUINetwork(hash, scope);
  return { scope, calls, timers, setStatus(fn) { status = fn; }, advance(ms) { time += ms; for (const [id, timer] of timers) if (timer.at <= time) { timers.delete(id); timer.fn(); } } };
}

test("serialized gate coalesces all same-origin requests and forwards exact POST/body once after compatibility", async () => {
  const f = fixture(true), status = deferred(); f.setStatus(() => status.promise);
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("private task")); controller.close(); } });
  const request = new Request("https://hub.test/api/model-task", { method: "POST", body, duplex: "half" });
  const init = { credentials: "same-origin" };
  const first = f.scope.fetch(request, init), second = f.scope.fetch("/api/read-only-post", { method: "POST", body: "query" });
  const ready = f.scope.__HUB_INSTALLED_UI_READY__();
  assert.equal(f.calls.length, 1); assert.equal(request.bodyUsed, false);
  assert.equal(f.calls[0].input, "/api/hub/ui/status");
  assert.equal(f.calls[0].init.cache, "no-store"); assert.equal(f.calls[0].init.redirect, "error"); assert.equal(f.calls[0].init.credentials, "same-origin");
  status.resolve(response()); await Promise.all([first, second, ready]);
  assert.equal(f.calls.length, 3); assert.equal(f.calls[1].input, request); assert.equal(f.calls[1].init, init); assert.equal(request.bodyUsed, false);
  await f.scope.__HUB_INSTALLED_UI_READY__(); assert.equal(f.calls.length, 3);
  assert.equal(f.timers.size, 0);
});

test("incompatibility, sign-in HTML, redirect and invalid JSON block forwarding and retry only after backoff", async () => {
  const failures = [
    () => response({ schema: 1, compatibility: "b".repeat(64) }),
    () => response({ schema: 2, compatibility: hash }),
    () => response({ schema: 1, compatibility: "invalid" }),
    () => response({}, { headers: new Headers({ "content-type": "text/html" }) }),
    () => response({}, { status: 401 }), () => response({}, { redirected: true }),
    () => response({}, { async json() { throw Error("invalid JSON"); } }),
    () => Promise.reject(Error("redirect rejected")),
  ];
  for (const fail of failures) {
    const f = fixture(); f.setStatus(fail);
    await assert.rejects(f.scope.fetch("/api/mutate", { method: "POST", body: "never sent" }));
    await assert.rejects(f.scope.fetch("/api/mutate", { method: "POST", body: "never retried" }));
    assert.equal(f.calls.length, 1);
    f.advance(4999); await assert.rejects(f.scope.__HUB_INSTALLED_UI_READY__()); assert.equal(f.calls.length, 1);
    f.advance(1); f.setStatus(() => response()); await f.scope.fetch("/api/read");
    assert.equal(f.calls.length, 3); assert.equal(f.calls[2].input, "/api/read");
  }
});

test("expired success re-verifies and cannot forward against a changed host", async () => {
  const f = fixture(); await f.scope.fetch("/api/first");
  f.advance(29999); await f.scope.fetch("/api/cached"); assert.equal(f.calls.length, 3);
  f.advance(1); f.setStatus(() => response({ schema: 1, compatibility: "b".repeat(64) }));
  await assert.rejects(f.scope.fetch("/api/task", { method: "POST" })); assert.equal(f.calls.length, 4);
});

test("aborted waiters do not forward, cancel other waiters or consume bodies", async () => {
  const f = fixture(), gate = deferred(); f.setStatus(() => gate.promise);
  const controller = new AbortController(), reason = Error("cancelled");
  const request = new Request("https://hub.test/api/task", { method: "POST", body: "unchanged", signal: controller.signal });
  const aborted = f.scope.fetch(request), surviving = f.scope.fetch("/api/read");
  controller.abort(reason); await assert.rejects(aborted, error => error === reason);
  gate.resolve(response()); await surviving;
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].input, "/api/read"); assert.equal(request.bodyUsed, false);
  await assert.rejects(f.scope.fetch(request), error => error === reason); assert.equal(f.calls.length, 2);
});

test("status and external requests bypass gate; eight-second timeout rejects without a late forward", async () => {
  const f = fixture(), gate = deferred(); f.setStatus(() => gate.promise);
  await f.scope.fetch("https://external.test/resource"); assert.equal(f.calls.length, 1);
  const pending = f.scope.fetch("/api/private");
  const timeoutAssertion = assert.rejects(pending, /timed out/);
  f.advance(8000); await timeoutAssertion;
  assert.equal(f.calls[1].init.signal.aborted, true);
  gate.resolve(response()); await tick(); assert.equal(f.calls.length, 2);
  await assert.rejects(f.scope.__HUB_INSTALLED_UI_READY__(), /timed out/);
  f.advance(5000); f.setStatus(() => response());
  await f.scope.fetch("/api/hub/ui/status", { cache: "no-store" }); assert.equal(f.calls.length, 3);
  await f.scope.fetch("/api/read"); assert.equal(f.calls.length, 5);
});

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
async function gatewayClass(t, ready) {
  const runtime = await mkdtemp(join(tmpdir(), "hub-gated-gateway-")); t.after(() => rm(runtime, { recursive: true, force: true }));
  const target = join(runtime, "node_modules/@deepseek-ai/dsh-api-gateway/lib/client.js"); await mkdir(dirname(target), { recursive: true });
  await writeFile(target, await readFile(new URL("../vendor/deepseek-harness/packages/api/gateway/lib/client.js", import.meta.url)));
  await applyHarnessRuntimePatches(runtime, await resolveHarnessRuntimePatches(root, ["patches/deepseek-harness/installed-ui-network-gate.patch"]));
  const source = await readFile(target, "utf8"), start = source.indexOf("var RemoteStreamMuxClient = class {"), end = source.indexOf("var StreamInbox = class", start);
  const sockets = [];
  class Socket {
    static OPEN = 1;
    listeners = new Map();
    readyState = 0;
    constructor(url) { this.url = url; sockets.push(this); }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    removeEventListener(name) { this.listeners.delete(name); }
    close() {}
  }
  const scope = { WebSocket: Socket, remoteStreamUrl: () => "wss://hub.test/api/stream", RemoteStreamCarrierError: Error, __HUB_INSTALLED_UI_READY__: ready };
  runInNewContext(source.slice(start, end) + "globalThis.Client = RemoteStreamMuxClient;", scope);
  const client = new scope.Client(); client.running = true;
  return { client, sockets };
}

test("patched gateway keeps desktop socket timing and installed UI waits for exact match", async t => {
  const plain = await gatewayClass(t);
  const opened = plain.client.connect(); assert.equal(plain.sockets.length, 1);
  plain.sockets[0].listeners.get("open")(); await opened;
  const f = fixture(), gate = deferred(); f.setStatus(() => gate.promise);
  const installed = await gatewayClass(t, f.scope.__HUB_INSTALLED_UI_READY__);
  const connecting = installed.client.connect(), task = f.scope.fetch("/api/task", { method: "POST" });
  await tick(); assert.equal(installed.sockets.length, 0); assert.equal(f.calls.length, 1);
  gate.resolve(response()); await task; await tick();
  assert.equal(installed.sockets.length, 1); assert.equal(f.calls.length, 2);
  installed.sockets[0].listeners.get("open")(); await connecting;
});

test("incompatible or disposed installed gateway never creates a socket", async t => {
  const f = fixture(); f.setStatus(() => response({ schema: 1, compatibility: "b".repeat(64) }));
  const denied = await gatewayClass(t, f.scope.__HUB_INSTALLED_UI_READY__);
  await assert.rejects(denied.client.connect()); assert.equal(denied.sockets.length, 0);
  for (const stale of ["disposed", "revision"]) {
    const gate = deferred(), current = await gatewayClass(t, () => gate.promise);
    const connecting = current.client.connect(); await tick();
    if (stale === "disposed") current.client.disposed = true; else current.client.revision++;
    gate.resolve(); await assert.rejects(connecting, /cancelled/); assert.equal(current.sockets.length, 0);
  }
});


test("repeated gateway start calls coalesce while verification is delayed", async t => {
  const f = fixture(), gate = deferred(); f.setStatus(() => gate.promise);
  const current = await gatewayClass(t, f.scope.__HUB_INSTALLED_UI_READY__);
  current.client.start(); current.client.start(); current.client.start();
  await tick(); assert.equal(current.sockets.length, 0); assert.equal(f.calls.length, 1);
  gate.resolve(response()); await tick(); assert.equal(current.sockets.length, 1);
  current.sockets[0].readyState = 1;
  current.sockets[0].listeners.get("open")(); await tick();
  current.client.start(); await tick();
  assert.equal(current.sockets.length, 1); assert.equal(f.calls.length, 1);
});
