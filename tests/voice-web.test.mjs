import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createVoiceWeb } from "@minke/harness-overlay/host/voice-web.ts";

const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function fixture(overrides = {}, options = {}) {
  let opened = 0, closed = 0;
  const process = defer(); const requests = [];
  const call = { callId: randomUUID(), sessionId: "synthetic-voice-chat", sidecar: { done: process.promise, async request(path, method, body) { requests.push({ path, method, body }); return { status: 200, body: path === "/status" ? { status: "waiting" } : { sdp: "synthetic-answer", type: "answer", pc_id: "synthetic-peer" } }; }, async stop() {} } };
  const web = createVoiceWeb({ reject: req => req.headers.cookie !== "synthetic-auth=1" ? 401 : undefined,
    history: overrides.history,
    presentations: overrides.presentations,
    runtimeStatus: overrides.runtimeStatus,
    share:overrides.share,
    async open(signal, sessionId) { opened++; if (overrides.open) await overrides.open(signal, sessionId); return call; },
    async close(value) { assert.equal(value, call); closed++; if (overrides.close) await overrides.close(); },
  }, options);
  const server = createServer((req, res) => { void web.handler(req, res).catch(() => res.destroy()); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/api/hub/voice/`;
  const post = (path, body, headers = {}, method = "POST") => fetch(url + path, { method, headers: { cookie: "synthetic-auth=1", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { web, call, process, requests, post, url, get opened() { return opened; }, get closed() { return closed; }, async dispose() { try { await web.dispose(); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } } };
}
const admission = () => ({ requestId: randomUUID(), requestedAt: Date.now() });

test('camera sharing authenticates the active call and accepts both PWA and Telegram without reopening audio',async()=>{
 const shared=[],f=await fixture({share:async(...args)=>shared.push(args)});const body={callId:f.call.callId,requestId:randomUUID(),uploads:[randomUUID()],instruction:'Read this label'};
 try{
  assert.equal((await f.post('share',body,{'x-hub-voice-share':'1'})).status,410);await f.post('open',admission());
  assert.equal((await f.post('share',body)).status,403);assert.equal((await f.post('share',body,{'x-hub-voice-share':'1',cookie:''})).status,401);
  assert.equal((await f.post('share',{...body,callId:randomUUID()},{'x-hub-voice-share':'1'})).status,410);
  assert.equal((await f.post('share',{...body,uploads:[]},{'x-hub-voice-share':'1'})).status,400);
  for(const transport of [undefined,'telegram']){f.call.transport=transport;assert.equal((await f.post('share',body,{'x-hub-voice-share':'1'})).status,200);}
  assert.equal(shared.length,2);assert.equal(f.opened,1);assert.equal(f.closed,0);assert.equal(f.requests.length,0);
  await f.post('close',{callId:f.call.callId});assert.equal((await f.post('share',body,{'x-hub-voice-share':'1'})).status,410);
 }finally{await f.dispose();}
});

test("preparation state is authenticated and independent of call occupancy", async () => {
  let state = "warming";
  const f = await fixture({ runtimeStatus: () => state });
  try {
    assert.equal((await fetch(f.url + "status")).status, 401);
    const status = () => fetch(f.url + "status", { headers: { cookie: "synthetic-auth=1" } }).then(r => r.json());
    assert.equal((await status()).runtime, "warming");
    assert.equal((await status()).busy, false);
    state = "ready";
    await f.post("open", admission());
    assert.equal((await status()).runtime, "ready");
    assert.equal((await status()).busy, true);
    await f.post("close", { callId: f.call.callId });
    assert.equal((await status()).runtime, "ready");
    assert.equal((await status()).busy, false);
    assert.equal(f.opened, 1);
  } finally { await f.dispose(); }
});

test("interruption requires authentication and current-call ownership without admitting a new call or proxying input", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post('interrupt', {callId:f.call.callId})).status, 410);
    await f.post('open',admission());
    assert.equal((await f.post('interrupt',{callId:f.call.callId},{cookie:''})).status,401);
    assert.equal((await f.post('interrupt',{callId:randomUUID()})).status,410);
    assert.equal((await f.post('interrupt',{callId:f.call.callId,text:'replay'})).status,400);
    for (const transport of [undefined,'telegram']) {
      f.call.transport=transport;
      assert.deepEqual(await (await f.post('interrupt',{callId:f.call.callId})).json(),{ok:true});
      assert.deepEqual(f.requests.at(-1),{path:'/interrupt',method:'POST',body:{}});
    }
    assert.equal(f.opened,1);assert.equal(f.closed,0);
    await f.post('close',{callId:f.call.callId});
    assert.equal((await f.post('interrupt',{callId:f.call.callId})).status,410);
  } finally {await f.dispose();}
});

test("relay credentials require authentication and call ownership, survive admission recovery and cannot be browser-overridden", async () => {
  const f = await fixture();
  const iceServers = [{ urls: ["turn:relay.example:3478"], username: "fixture", credential: "synthetic-relay-secret" }];
  f.call.iceServers = iceServers;
  try {
    const input = admission();
    assert.equal((await f.post("open", input, { cookie: "" })).status, 401);
    const opened = await f.post("open", { ...input, iceServers: [{ urls: "https://attacker.invalid" }] });
    assert.equal(opened.headers.get("cache-control"), "no-store");
    const result = await opened.json();
    assert.deepEqual(result.iceServers, iceServers);
    assert.deepEqual(await (await f.post("open", input)).json(), result);
    const publicStatus = await fetch(f.url + "status", { headers: { cookie: "synthetic-auth=1" } });
    assert.doesNotMatch(await publicStatus.text(), /synthetic-relay-secret/);
    const wrong = await f.post("status", { callId: randomUUID() });
    assert.equal(wrong.status, 410); assert.doesNotMatch(await wrong.text(), /synthetic-relay-secret/);
    assert.deepEqual((await (await f.post("status", { callId: f.call.callId })).json()).iceServers, iceServers);
    assert.equal((await f.post("ice", { iceServers })).status, 404);
  } finally { await f.dispose(); }
});

test("visual endpoints are read-only and bound to the current call even across a slow document load", async () => {
  const gate = defer(); const seen = []; const id = randomUUID();
  const f = await fixture({ presentations: { summary(sessionId) { seen.push(sessionId); return { id, title: "Fixture", kind: "html", createdAt: 1 }; }, async document(sessionId, visualId) { seen.push(sessionId); assert.equal(visualId, id); await gate.promise; return "fixture-document"; } } });
  const headers = { cookie: "synthetic-auth=1", "x-hub-voice-call": f.call.callId, "x-hub-presentation": id };
  try {
    assert.equal((await fetch(f.url + "presentation", { headers })).status, 409);
    await f.post("open", admission());
    assert.equal((await fetch(f.url + "presentation")).status, 401);
    assert.equal((await fetch(f.url + "presentation", { headers: { ...headers, "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await fetch(f.url + "presentation", { headers: { ...headers, "x-hub-voice-call": randomUUID() } })).status, 409);
    assert.equal((await f.post("presentation", {}, headers)).status, 405);
    assert.equal((await fetch(f.url + "presentation", { headers })).status, 200);
    const pending = fetch(f.url + "presentation-document", { headers });
    while (seen.length < 2) await new Promise(resolve => setTimeout(resolve, 5));
    await f.post("close", { callId: f.call.callId }); gate.resolve();
    const result = await pending; assert.equal(result.status, 409);
    assert.doesNotMatch(await result.text(), /fixture-document/);
    assert.deepEqual(seen, [f.call.sessionId, f.call.sessionId]);
  } finally { gate.resolve(); await f.dispose(); }
});

test("history is authenticated, validates promotion and never admits a call", async () => {
  let saved = false;
  const f = await fixture({ history: {
    snapshot: () => [{ sessionId: "archived", saved, createdAt: 1 }],
    view: id => ({ kind: id === "archived" ? "voice" : "chat", saved }),
    async save(id) { assert.equal(id, "archived"); saved = true; return { kind: "voice", saved }; },
  } });
  try {
    assert.equal((await fetch(f.url + "history")).status, 401);
    const get = await fetch(f.url + "history", { headers: { cookie: "synthetic-auth=1" } });
    assert.equal(get.headers.get("cache-control"), "no-store");
    assert.deepEqual(await get.json(), { conversations: [{ sessionId: "archived", saved: false, createdAt: 1 }] });
    assert.equal((await f.post("history", { sessionId: "archived" })).status, 403);
    const headers = { "x-hub-voice-history": "1" };
    assert.equal((await f.post("history", { sessionId: "archived" }, { ...headers, "sec-fetch-site": "cross-site" })).status, 403);
    for (const body of [{ sessionId: "../invalid" }, {}, [], { sessionId: "archived", saved: false }]) {
      assert.equal((await f.post("history", body, headers)).status, 400);
    }
    assert.equal((await f.post("history", { sessionId: "ordinary" }, headers)).status, 404);
    assert.equal((await f.post("history", { sessionId: "archived" }, headers, "DELETE")).status, 405);
    assert.deepEqual(await (await f.post("history", { sessionId: "archived" }, headers)).json(), { sessionId: "archived", kind: "voice", saved: true });
    assert.equal(f.opened, 0);
  } finally { await f.dispose(); }
});

test("selected conversation is pinned to admission and cannot be swapped on retry", async () => {
  let selected;
  const f = await fixture({ open: async (_signal, sessionId) => { selected = sessionId; } });
  const input = { ...admission(), sessionId: "existing-text-chat" };
  try {
    assert.equal((await f.post("open", { ...input, sessionId: "../bad" })).status, 400);
    assert.equal((await f.post("open", input)).status, 200); assert.equal(selected, input.sessionId);
    assert.equal((await f.post("open", { ...input, sessionId: "another-chat" })).status, 409);
    assert.equal((await f.post("open", { requestId: input.requestId, requestedAt: input.requestedAt })).status, 409);
    assert.equal(f.opened, 1);
  } finally { await f.dispose(); }
});

test("public voice API authenticates before admission and rejects cross-site, wrong-media and malformed requests", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post("open", admission(), { cookie: "" })).status, 401);
    assert.equal((await f.post("open", admission(), { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await f.post("open", admission(), { "content-type": "text/plain" })).status, 415);
    assert.equal((await f.post("open", [])).status, 400);
    assert.equal((await f.post("open", { requestId: "bad", requestedAt: Date.now() })).status, 400);
    assert.equal((await f.post("open", { ...admission(), requestedAt: Date.now() - 61000 })).status, 400);
    assert.equal((await f.post("open", { ...admission(), requestedAt: Date.now() + 6000 })).status, 400);
    assert.equal((await f.post("open", { huge: "x".repeat(128001) })).status, 413);
    assert.equal((await f.post("elsewhere", {})).status, 404);
    assert.equal((await f.post("open", {}, {}, "PATCH")).status, 405);
    assert.equal(f.opened, 0);
  } finally { await f.dispose(); }
});

test("a repeated or concurrent admission UUID creates exactly one native call", async () => {
  const gate = defer(); const started = defer();
  const f = await fixture({ open: async () => { started.resolve(); await gate.promise; } });
  const input = admission();
  try {
    const first = f.post("open", input); await started.promise;
    const repeated = f.post("open", input);
    assert.equal((await f.post("open", admission())).status, 409);
    gate.resolve();
    const replies = await Promise.all([first, repeated]);
    for (const reply of replies) { assert.equal(reply.status, 200); assert.deepEqual(await reply.json(), { callId: f.call.callId, sessionId: f.call.sessionId }); }
    assert.equal(f.opened, 1);
    assert.equal((await f.post("open", { ...input, requestedAt: input.requestedAt + 1 })).status, 409);
    const ended = await f.post("close", { callId: f.call.callId }); assert.equal(ended.status, 200);
    assert.equal((await f.post("open", input)).status, 410);
    assert.equal(f.opened, 1); assert.equal(f.closed, 1);
  } finally { gate.resolve(); await f.dispose(); }
});

test("fixed signaling proxy strips unrelated data and requires the current call id", async () => {
  const f = await fixture();
  try {
    await f.post("open", admission());
    const status = await fetch(f.url + "status", { headers: { cookie: "synthetic-auth=1" } });
    assert.equal(status.headers.get("cache-control"), "no-store");
    const body = await status.json(); assert.equal(body.busy, true); assert.equal(body.callId, undefined);
    assert.equal((await f.post("offer", { callId: randomUUID(), sdp: "no" })).status, 410);
    assert.equal((await f.post("close", { callId: randomUUID() })).status, 410);
    assert.equal(f.closed, 0); assert.equal(f.requests.length, 0);
    const response = await f.post("offer", { callId: f.call.callId, type: "offer", sdp: "v=0 synthetic", url: "https://attacker.invalid", provider: "wrong", token: "do-not-forward" });
    assert.equal(response.status, 200);
    assert.deepEqual(f.requests[0], { path: "/offer", method: "POST", body: { sdp: "v=0 synthetic", type: "offer" } });
    await f.post("offer", { callId: f.call.callId, pc_id: "peer", candidates: [] }, {}, "PATCH");
    assert.equal(f.requests[1].method, "PATCH");
    const header = { "x-hub-voice-call": f.call.callId };
    assert.equal((await f.post("offer", { type: "offer", sdp: "v=0", requestData: { callId: "SDK-nested-ignored" } }, header)).status, 200);
    assert.equal((await f.post("offer", { pc_id: "peer", candidates: [] }, header, "PATCH")).status, 200);
    assert.equal((await f.post("offer", { callId: randomUUID(), sdp: "v=0" }, header)).status, 400);
    assert.equal((await f.post("offer", { pc_id: "peer", candidates: [] }, { "x-hub-voice-call": randomUUID() }, "PATCH")).status, 410);
    const own = await f.post("status", { callId: f.call.callId });
    assert.equal((await own.json()).status, "waiting");
  } finally { await f.dispose(); }
});

test("backend exception details are not exposed, and failed admission is never automatically replayed", async () => {
  const f = await fixture({ open: async () => { throw new Error("secret-in-error"); } });
  const input = admission();
  try {
    for (let i = 0; i < 2; i++) {
      const response = await f.post("open", input); assert.equal(response.status, 503);
      assert.equal(await response.text(), '{"error":"voice-operation-failed"}');
    }
    assert.equal(f.opened, 1);
  } finally { await f.dispose(); }
});

test("disposing during native admission cancels startup and closes its eventual owned call", async () => {
  const gate = defer(); const started = defer(); let signal;
  const f = await fixture({ open: async s => { signal = s; started.resolve(); await gate.promise; } });
  try {
    const response = f.post("open", admission()); await started.promise;
    const disposed = f.web.dispose(); assert.equal(signal.aborted, true);
    gate.resolve(); await disposed;
    assert.equal((await response).status, 503); assert.equal(f.closed, 1);
  } finally { gate.resolve(); await f.dispose(); }
});

test("process exit closes only its call and failed cleanup keeps admission locked", async () => {
  const closed = defer();
  const f = await fixture({ close: async () => { closed.resolve(); throw new Error("uncertain-tree"); } });
  try {
    await f.post("open", admission());
    f.process.resolve({ exitCode: 1, signal: null }); await closed.promise;
    assert.equal((await f.post("open", admission())).status, 409);
    assert.equal(f.opened, 1); assert.equal(f.closed, 1);
    assert.equal((await f.post("close", { callId: f.call.callId })).status, 503);
  } finally { await assert.rejects(f.dispose(), /uncertain-tree/); }
});

test("bounded receipt storage rejects floods without discarding replay protection", async () => {
  const f = await fixture({ open: async () => { throw new Error("synthetic startup failure"); } });
  try {
    for (let i = 0; i < 64; i++) assert.equal((await f.post("open", admission())).status, 503);
    assert.equal((await f.post("open", admission())).status, 429);
    assert.equal(f.opened, 64);
  } finally { await f.dispose(); }
});

test("closed sidecar status is detected even when its process is still alive", async () => {
  const stopped = defer(); const f = await fixture({ close: async () => stopped.resolve() }, { pollMs: 10 });
  try {
    f.call.sidecar.request = async () => ({ status: 200, body: { status: "closed" } });
    await f.post("open", admission());
    await Promise.race([stopped.promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Watchdog did not close")), 1000); timer.unref(); })]);
    assert.equal(f.closed, 1);
  } finally { await f.dispose(); }
});

test("health polling cannot cancel bounded WebRTC setup while local models block the sidecar", async () => {
  const health = defer(), polling = defer(), offer = defer(), offering = defer(), subsequent = defer();
  let healthCalls = 0;
  const f = await fixture({}, { pollMs: 10 });
  f.call.sidecar.request = async path => {
    if (path === "/offer") { offering.resolve(); await offer.promise; return { status: 200, body: { type: "answer", sdp: "synthetic-answer" } }; }
    if (++healthCalls === 1) { polling.resolve(); return health.promise; }
    subsequent.resolve(); return { status: 200, body: { status: "connected" } };
  };
  try {
    await f.post("open", admission()); await polling.promise;
    const pending = f.post("offer", { callId: f.call.callId, type: "offer", sdp: "synthetic" }); await offering.promise;
    health.reject(new Error("Status timed out while CPU model loads"));
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(f.closed, 0, "An overlapping heartbeat timeout is not proof the call died");
    assert.equal(healthCalls, 1, "Do not pile health requests onto bounded signaling");
    offer.resolve(); assert.equal((await pending).status, 200);
    await subsequent.promise; assert.equal(f.closed, 0, "Health monitoring resumes after setup");
  } finally { offer.resolve(); health.resolve({ status: 200, body: { status: "connected" } }); await f.dispose(); }
});

test("late overlapping health failure is ignored once, but a later idle failure still closes voice", async () => {
  const first = defer(), entered = defer(), closed = defer(); let checks = 0;
  const f = await fixture({ close: async () => closed.resolve() }, { pollMs: 10 });
  f.call.sidecar.request = async path => {
    if (path === "/offer") return { status: 200, body: { type: "answer" } };
    if (++checks === 1) { entered.resolve(); return first.promise; }
    throw new Error("Genuinely unavailable after signaling");
  };
  try {
    await f.post("open", admission()); await entered.promise;
    assert.equal((await f.post("offer", { callId: f.call.callId, type: "offer" })).status, 200);
    first.reject(new Error("Delayed error from overlapping probe"));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(f.closed, 0);
    await Promise.race([closed.promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Health polling did not resume")), 1000); timer.unref(); })]);
    assert.equal(f.closed, 1); assert.equal(checks, 2);
  } finally { first.resolve({ status: 200, body: { status: "connected" } }); await f.dispose(); }
});
