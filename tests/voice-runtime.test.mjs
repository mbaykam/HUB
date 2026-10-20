import test from "node:test";
import assert from "node:assert/strict";
import { createPreparedVoiceRuntime } from "@minke/harness-overlay/host/voice-runtime.ts";
import { VoiceSidecarCleanupError } from "@minke/harness-overlay/host/voice-sidecar.ts";

const speech = { stt: { engine: "whisper", model: "tiny.en" }, tts: { engine: "kokoro", model: "82m", voice: "af_heart" } };
const config = { python: "C:/fixture/python.exe", script: "C:/fixture/runtime.py", bridgeUrl: "http://127.0.0.1:9000", bridgeToken: "b".repeat(43) };

test('Soniox credentials are resolved per call and never travel to browser-scoped requests',async()=>{
 const requests=[],process={done:new Promise(()=>{}),async request(path,method,body){requests.push({path,body});return {status:200,body:{ok:true}};},async requestCall(cap,path,method,body){requests.push({path,body,scoped:true});return {status:200,body:{ok:true}};},async stop(){}};
 let key='fixture-key-first';
 const pool=createPreparedVoiceRuntime({}, {...config,sonioxKey:async()=>key},new AbortController().signal,{start:async()=>process});
 const cloud={...speech,stt:{engine:'soniox',model:'stt-rt-v5',language:'en-tr'}};
 await pool.prepare(cloud);assert.equal(JSON.stringify(requests).includes(key),false);
 const first=await pool.open('cloud-first',cloud,[],new AbortController().signal);assert.equal(requests.find(r=>r.path==='/admit').body.sonioxKey,key);
 await first.request('/status','GET');await first.stop();key='fixture-key-second';
 const second=await pool.open('cloud-second',cloud,[],new AbortController().signal);assert.equal(requests.filter(r=>r.path==='/admit').at(-1).body.sonioxKey,key);
 assert.equal(JSON.stringify(requests.filter(r=>r.scoped)).includes('fixture-key'),false);await second.stop();await pool.close();
});
function fixture() {
  let starts = 0, stopped = 0, settle;
  const requests = [], scoped = [];
  const process = { done: new Promise(resolve => { settle = resolve; }),
    async request(path, method, body) { requests.push({ path, method, body }); return { status: 200, body: { ok: true } }; },
    async requestCall(capability, path, method, body) { scoped.push({ capability, path, method, body }); return { status: 200, body: { status: "waiting", ok: true } }; },
    async stop() { stopped++; settle({ exitCode: 0, signal: null }); },
  };
  const pool = createPreparedVoiceRuntime({}, config, new AbortController().signal, { async start() { starts++; return process; } });
  return { pool, process, requests, scoped, get starts() { return starts; }, get stopped() { return stopped; } };
}

test("prepared PWA weights survive sequential calls while capabilities and close ownership change", async () => {
  const f = fixture(); await f.pool.prepare(speech);
  const first = await f.pool.open("first", speech, [], new AbortController().signal);
  await first.request("/status", "GET");
  await first.request("/attention", "POST", { mode: "background" });
  await first.request("/attention", "POST", { mode: "active" });
  assert.deepEqual(f.scoped.filter(item => item.path === "/attention").map(item => ({ callId: item.capability.callId, body: item.body })), [
    { callId: "first", body: { mode: "background" } },
    { callId: "first", body: { mode: "active" } },
  ]);
  await assert.rejects(f.pool.open("second", speech, [], new AbortController().signal), /busy/);
  const firstToken = f.scoped[0].capability.token;
  await Promise.all([first.stop(), first.stop()]); await first.done;
  assert.equal(f.stopped, 0, "Ending a call must not discard prepared weights");
  assert.equal(f.requests.filter(r => r.path === "/release").length, 1);
  await assert.rejects(first.request("/status", "GET"), /closed/);
  await assert.rejects(first.request("/attention", "POST", { mode: "background" }), /closed/);
  const second = await f.pool.open("second", speech, [], new AbortController().signal);
  await second.request("/offer", "POST", { sdp: "fixture" });
  assert.equal(f.starts, 1);
  assert.notEqual(f.scoped.at(-1).capability.token, firstToken);
  assert.equal(f.scoped.at(-1).capability.callId, "second");
  assert.deepEqual(f.scoped.at(-1).body, { sdp: "fixture" });
  await second.stop(); await f.pool.close();
  assert.equal(f.stopped, 1);
});

test("a lost admit response releases that exact unknown call; uncertain cleanup blocks reuse", async () => {
  const f = fixture(); const original = f.process.request;
  f.process.request = async (...args) => { if (args[0] === "/admit") throw Error("response lost"); return original(...args); };
  await assert.rejects(f.pool.open("first", speech, [], new AbortController().signal), /lost/);
  assert.deepEqual(f.requests.at(-1).body, { callId: "first" });
  f.process.request = async () => { throw Error("unconfirmed process state"); };
  await assert.rejects(f.pool.open("second", speech, [], new AbortController().signal), VoiceSidecarCleanupError);
  await assert.rejects(f.pool.open("third", speech, [], new AbortController().signal), /busy/);
  await f.pool.close();
});

test("model preparation failure cannot expose a call; relay credentials stay scoped to its new capability", async () => {
  const f = fixture();
  await f.pool.prepare(speech);
  const relay = [{ urls: ["turn:relay.example:3478"], username: "owned", credential: "fixture-secret" }];
  const call = await f.pool.open("relayed", speech, relay, new AbortController().signal);
  assert.equal(f.requests.some(r => JSON.stringify(r).includes("fixture-secret")), false);
  assert.equal(f.scoped[0].path, "/ice");
  assert.deepEqual(f.scoped[0].body, { iceServers: relay });
  await call.stop(); await f.pool.close();
});
