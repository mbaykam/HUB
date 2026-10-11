import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";

const bundle = await build({ entryPoints: ["packages/harness-overlay/src/client/voice/browser-client.ts"], bundle: true, format: "cjs", platform: "browser", write: false, external: ["@pipecat-ai/client-js", "@pipecat-ai/small-webrtc-transport"] });
async function fixture(openFields = {}, start = true) {
  let callbacks, disconnects = 0;
  const requests = [], errors = [], notices = [], states = [], sent = [], connections = [], transcripts = [];
  const module = { exports: {} };
  class Client {
    connected = true;
    constructor(options) { callbacks = options.callbacks; }
    async initDevices() {}
    async connect(params) { connections.push(params); }
    async disconnect() { disconnects++; }
    async sendText(text) { sent.push(text); }
  }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports,
    require: id => id === "@pipecat-ai/client-js" ? { PipecatClient: Client } : { SmallWebRTCTransport: class {} },
    window: { isSecureContext: true }, AbortSignal, Headers, DOMException, crypto: webcrypto,
    async fetch(url) { requests.push(url); return Response.json(url.endsWith("status") ? { serverTime: Date.now() } : url.endsWith("open") ? { callId: "call-one", sessionId: "session-one", ...openFields } : {}); },
  });
  const voice = module.exports.createVoiceClient({ audio: { pause() {}, async play() {}, srcObject: null },
    onState: value => states.push(value), onSession() {}, onTranscript: (...value) => transcripts.push(value), onActivity() {}, onAudioBlocked() {},
    onError: value => errors.push(value), onNotice: value => notices.push(value) });
  if (start) await voice.start();
  return { voice, callbacks: () => callbacks, requests, errors, notices, states, sent, connections, transcripts, disconnects: () => disconnects };
}

test("authenticated ICE reaches the official transport with the existing call ownership header", async () => {
  const iceServers = [{ urls: ["turn:relay.example:3478"], username: "fixture", credential: "synthetic-only" }];
  const f = await fixture({ iceServers });
  assert.deepEqual(JSON.parse(JSON.stringify(f.connections[0].iceConfig)), { iceServers });
  assert.equal(f.connections[0].webrtcRequestParams.headers.get("x-hub-voice-call"), "call-one");
  await f.voice.stop();
});

test("invalid ICE never connects and releases the admitted call", async () => {
  const f = await fixture({ iceServers: [{ urls: "https://invalid.example" }] }, false);
  await assert.rejects(f.voice.start(), /Invalid voice/);
  assert.equal(f.connections.length, 0);
  assert.equal(f.disconnects(), 1);
  assert.equal(f.requests.filter(path => path.endsWith("close")).length, 1);
});

test("recoverable RTVI warnings keep the call usable without replaying input or exposing backend details", async () => {
  const f = await fixture();
  f.callbacks().onError({ data: { fatal: false, error: "synthetic private backend details" } });
  assert.equal(f.disconnects(), 0); assert.equal(f.notices.length, 1); assert.equal(f.errors.length, 0);
  assert.ok(!f.notices[0].includes("private")); assert.match(f.notices[0], /before repeating a task/);
  assert.deepEqual(f.sent, []);
  await f.voice.sendText("A separate new instruction");
  assert.deepEqual(f.sent, ["A separate new instruction"]);
  assert.equal(f.requests.filter(path => path.endsWith("open")).length, 1);
  await f.voice.stop(); assert.equal(f.states.at(-1), "idle");
});

test("fatal or unclassified errors still stop and clean up the owned call", async () => {
  for (const data of [{ fatal: true }, {}, null]) {
    const f = await fixture(); f.callbacks().onError({ data });
    await f.voice.stop();
    assert.equal(f.errors.length, 1); assert.equal(f.notices.length, 0);
    assert.equal(f.states.at(-1), "idle"); assert.ok(f.disconnects() > 0);
    assert.equal(f.requests.filter(path => path.endsWith("close")).length, 1);
  }
});

test("official transcript callbacks preserve human partial/final and spoken bot text, ignoring ended calls", async () => {
  const f = await fixture();
  f.callbacks().onUserTranscript({ text: 'Could you', final: false });
  f.callbacks().onUserTranscript({ text: 'Could you explain this?', final: true });
  f.callbacks().onBotTtsText({ text: 'Of course.' });
  assert.deepEqual(f.transcripts, [['user', 'Could you', false], ['user', 'Could you explain this?', true], ['assistant', 'Of course.', true]]);
  await f.voice.stop();
  f.callbacks().onUserTranscript({ text: 'late event', final: true });
  f.callbacks().onBotTtsText({ text: 'late output' });
  assert.equal(f.transcripts.length, 3);
});

test("explicit interruption keeps the same call connected and does not manufacture user text", async () => {
  const f = await fixture();
  await f.voice.interrupt();
  assert.equal(f.disconnects(), 0); assert.deepEqual(f.sent, []);
  assert.equal(f.requests.filter(path => path.endsWith("interrupt")).length, 1);
  assert.equal(f.requests.filter(path => path.endsWith("open")).length, 1);
  await f.voice.stop();
  await assert.rejects(f.voice.interrupt(), /not connected/);
});
