import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { createVoiceBridgeServer } from "@minke/harness-overlay/host/voice-bridge-server.ts";
import { VoiceConversationError } from "@minke/harness-overlay/host/voice-conversation.ts";

async function fixture(options) {
  const calls = []; const interrupted = []; let closed = 0, created = 0;
  const conversation = {
    sessionId: "synthetic-session",
    async speak(utterance, text, sink) {
      calls.push({ utterance, text });
      sink({ type: "text", utterance, text: "Hello." });
      sink({ type: "end", utterance, status: "completed" });
    },
    async interrupt(id) { interrupted.push(id); }, async close() { closed++; },
    notifications(after) { return {events:after<1?[{id:1,text:'The owned task finished.'}]:[]}; },
  };
  const bridge = await createVoiceBridgeServer(async () => { created++; return conversation; }, options);
  const call = await bridge.open();
  const post = (path, body, headers = {}) => fetch(bridge.url + path, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json", ...headers }, body: JSON.stringify({ callId: call.callId, ...body }) });
  return { bridge, call, post, calls, interrupted, conversation, get closed() { return closed; }, get created() { return created; } };
}

test('photo sharing is host-only, belongs to the live lease and cannot reopen a closed call',async()=>{
 const f=await fixture(),shared=[];f.conversation.share=async(id,text)=>shared.push({id,text});
 try{
  await f.bridge.share(f.call.callId,'fixture-share','Inspect the photo');assert.equal(shared.length,1);assert.equal(f.created,1);assert.equal(f.interrupted.length,0);
  assert.equal((await f.post('/share',{requestId:'fixture-share',text:'Injected'})).status,404);
  await assert.rejects(f.bridge.share('another-call','fixture-share','Wrong owner'),{code:'closed'});assert.equal(shared.length,1);
  await f.bridge.closeCall(f.call.callId);await assert.rejects(f.bridge.share(f.call.callId,'fixture-share','Late'),{code:'closed'});assert.equal(f.created,1);
 }finally{await f.bridge.dispose();}
});

test("private speech capability rejects unauthenticated, browser-origin, foreign-host and unknown-call requests", async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(f.bridge.url + "/turn", { method: "POST" })).status, 401);
    for (const headers of [{ authorization: "Bearer wrong" }, { origin: "https://example.com" }, { "sec-fetch-site": "same-origin" }]) {
      assert.equal((await f.post("/turn", { utterance: 1, text: "Hello" }, headers)).status, 401, JSON.stringify(headers));
    }
    // Fetch normalizes Host; use an actual HTTP request for the rebinding gate.
    const rebound = await new Promise((resolve, reject) => {
      const req = request(f.bridge.url + "/heartbeat", { method: "POST", headers: { host: "attacker.invalid", authorization: `Bearer ${f.bridge.token}`, "content-type": "application/json" } }, res => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end(JSON.stringify({ callId: f.call.callId }));
    });
    assert.equal(rebound, 401);
    assert.equal((await f.post("/turn", { callId: "unknown", utterance: 1, text: "Hello" })).status, 410);
    assert.equal(f.calls.length, 0);
    assert.equal(f.created, 1);
  } finally { await f.bridge.dispose(); }
});

test("task result polling is private, lease-bound, cursor-based and cannot run a new model command", async () => {
  const f=await fixture();
  try {
    assert.equal((await fetch(f.bridge.url+'/notifications',{method:'POST'})).status,401);
    assert.equal((await f.post('/notifications',{after:0},{origin:'https://foreign.invalid'})).status,401);
    assert.equal((await f.post('/notifications',{callId:'another-call',after:0})).status,410);
    for(const body of [{after:-1},{after:1.5},{after:true},{after:0,text:'replay'},{after:0,model:'other'}])assert.equal((await f.post('/notifications',body)).status,400);
    assert.deepEqual(await (await f.post('/notifications',{after:0})).json(),{events:[{id:1,text:'The owned task finished.'}]});
    assert.deepEqual(await (await f.post('/notifications',{after:1})).json(),{events:[]});
    assert.deepEqual(f.calls,[]);assert.equal(f.created,1);
    await f.post('/close',{});assert.equal((await f.post('/notifications',{after:0})).status,410);
  }finally{await f.bridge.dispose();}
});

test("speech bridge streams a correlated turn, supports heartbeat and closes only the owned call", async () => {
  const f = await fixture();
  try {
    const response = await f.post("/turn", { utterance: 1, text: "Hello" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual((await response.text()).trim().split("\n").map(JSON.parse).map(x => x.type), ["text", "end"]);
    assert.deepEqual(f.interrupted, []);
    assert.equal((await f.post("/heartbeat", {})).status, 200);
    assert.equal((await f.post("/interrupt", { utterance: 1 })).status, 200);
    await f.bridge.closeCall("unknown"); assert.equal(f.closed, 0);
    assert.equal((await f.post("/close", {})).status, 200);
    assert.equal(f.closed, 1);
    assert.equal((await f.post("/turn", { utterance: 2, text: "Hello" })).status, 410);
  } finally { await f.bridge.dispose(); }
});

test("only one voice call can be admitted and the sidecar cannot create one", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.bridge.open(), { code: "busy" });
    assert.equal((await f.post("/open", {})).status, 404);
    assert.equal((await f.post("/turn?x=1", { utterance: 1, text: "Hello" })).status, 404);
    assert.equal(f.created, 1);
  } finally { await f.bridge.dispose(); }
});

test("malformed, oversized, wrong-media and wrong-method inputs never reach a native prompt", async () => {
  const f = await fixture();
  const headers = { authorization: `Bearer ${f.bridge.token}`, "content-type": "application/json" };
  try {
    for (const body of ["{", "null", "[]"]) assert.equal((await fetch(f.bridge.url + "/turn", { method: "POST", headers, body })).status, 400);
    assert.equal((await f.post("/turn", { utterance: 1, text: "x".repeat(21_000) })).status, 413);
    assert.equal((await f.post("/turn", { utterance: 1, text: "x".repeat(16_001) })).status, 400);
    assert.equal((await f.post("/turn", { utterance: 1, text: "Hello" }, { "content-type": "text/plain" })).status, 415);
    assert.equal((await fetch(f.bridge.url + "/turn", { headers })).status, 405);
    assert.equal(f.calls.length, 0);
  } finally { await f.bridge.dispose(); }
});

test("expired calls are closed, not silently resumed or replayed", async () => {
  let now = 0; const f = await fixture({ now: () => now, leaseMs: 5000 });
  try {
    now = 6000;
    assert.equal((await f.post("/heartbeat", {})).status, 410);
    assert.equal(f.closed, 1);
    assert.equal(f.created, 1);
  } finally { await f.bridge.dispose(); }
});

test("native failures expose stable errors without backend details or successful completion", async () => {
  const f = await fixture();
  try {
    f.conversation.speak = async () => { throw new VoiceConversationError("busy"); };
    assert.equal((await f.post("/turn", { utterance: 1, text: "Hello" })).status, 409);
    f.conversation.speak = async () => { throw new Error("secret backend path"); };
    const response = await f.post("/turn", { utterance: 1, text: "Hello" });
    assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /secret/);
  } finally { await f.bridge.dispose(); }
});

test("disconnecting a streamed turn interrupts only its utterance", async () => {
  const f = await fixture(); let finish;
  f.conversation.speak = async (utterance, text, sink) => { sink({ type: "text", utterance, text: "First" }); await new Promise(resolve => { finish = resolve; }); };
  try {
    const response = await f.post("/turn", { utterance: 7, text: "Hello" });
    await response.body.cancel();
    const deadline = Date.now() + 3000;
    while (!f.interrupted.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(f.interrupted, [7]);
  } finally { finish?.(); await f.bridge.dispose(); }
});
