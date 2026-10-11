import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createVoiceWeb } from "@minke/harness-overlay/host/voice-web.ts";
import { voiceTranscript } from "@minke/harness-overlay/host/voice-transcript.ts";
import { localSpeechSchema } from "@minke/harness-overlay/voice-profile-contract.ts";
import { createVoiceBridgeServer } from "@minke/harness-overlay/host/voice-bridge-server.ts";

test("Telegram and PWA share admission: observer sees native transcript, cannot claim audio; native and public secrets stay private", async () => {
  let admissions = 0, closes = 0;
  const call = { callId: randomUUID(), sessionId: "voice-telegram-fixture", transport: "telegram", speech: { private: "not-public" },
    sidecar: { done: new Promise(() => {}), async request() { return { status: 200, body: { status: "connected", audio: { inputFrames: 40, receivingAudio: true, inputLevel: .02 } } }; } } };
  const web = createVoiceWeb({ reject: request => request.headers.cookie !== "fixture" ? 401 : undefined,
    async open(signal, session, transport) { signal.throwIfAborted(); assert.equal(session, undefined); assert.equal(transport, "telegram"); admissions++; return call; },
    async close(value) { assert.equal(value, call); closes++; }, transcript: () => [{ role: "user", text: "Merhaba", final: true }] });
  const server = createServer((request, response) => void web.handler(request, response)); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/api/hub/voice/`;
  const post = (path, body) => fetch(url + path, { method: "POST", headers: { cookie: "fixture", "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    await web.openTelegram();
    await assert.rejects(web.openTelegram(), /voice-busy/);
    assert.equal((await post("open", { requestId: randomUUID(), requestedAt: Date.now() })).status, 409);
    assert.equal((await fetch(url + "status")).status, 401);
    const body = await (await fetch(url + "status", { headers: { cookie: "fixture" } })).json();
    assert.equal(body.externalCall.sessionId, call.sessionId); assert.equal(body.externalCall.transcript[0].text, "Merhaba");
    assert.equal(body.externalCall.speech, undefined);
    assert.equal((await fetch(url + "diagnostics")).status, 401);
    assert.equal((await fetch(url + "diagnostics", { headers: { cookie: "fixture", "sec-fetch-site": "cross-site" } })).status, 403);
    const diagnostics = await (await fetch(url + "diagnostics", { headers: { cookie: "fixture" } })).json();
    assert.equal(diagnostics.audio.receivingAudio, true); assert.equal(diagnostics.audio.inputFrames, 40);
    assert.equal(diagnostics.speech, undefined); assert.equal(diagnostics.profile, undefined);
    assert.equal((await post("offer", { callId: call.callId, sdp: "v=0", type: "offer" })).status, 409);
    assert.equal((await post("close", { callId: randomUUID() })).status, 410);
    assert.equal((await post("close", { callId: call.callId })).status, 200);
    assert.equal(admissions, 1); assert.equal(closes, 1);
    assert.deepEqual(await (await fetch(url + "diagnostics", { headers: { cookie: "fixture" } })).json(), { active: false });
  } finally { await web.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("private incoming hook requires loopback capability and does not exist unless explicitly enabled", async () => {
  let incoming = 0;
  const bridge = await createVoiceBridgeServer(async () => { throw new Error("No native fixture"); }, { async incoming() { incoming++; return { callId: "synthetic" }; } });
  const send = (headers = {}, body = {}) => fetch(bridge.url + "/incoming", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal((await send()).status, 401);
    assert.equal((await send({ authorization: `Bearer ${bridge.token}`, origin: "https://example.com" })).status, 401);
    assert.equal((await send({ authorization: `Bearer ${bridge.token}` }, { provider: "evil" })).status, 400);
    assert.equal((await send({ authorization: `Bearer ${bridge.token}` })).status, 200); assert.equal(incoming, 1);
  } finally { await bridge.dispose(); }
});

test("native transcript coalesces streamed reply with durable message, excludes tools/reasoning, bounds payload", () => {
  const events = [{ type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "Merhaba" }] } },
    { type: "assistant/chunk", data: { chunk: { type: "reasoning-delta", text: "private" } } },
    { type: "assistant/chunk", data: { chunk: { type: "text-delta", text: "Hello" } } },
    { type: "assistant/chunk", data: { chunk: { type: "text-delta", text: "." } } },
    { type: "assistant/message", data: { message: { content: [{ type: "text", text: "Hello." }] } } },
    { type: "user/message", data: { source: { kind: "plugin" }, content: [{ type: "text", text: "private notification" }] } }];
  assert.deepEqual(voiceTranscript(events), [{ role: "user", text: "Merhaba", final: true }, { role: "assistant", text: "Hello.", final: true }]);
  assert.equal(voiceTranscript(events.slice(0, 4))[1].final, false);
  assert.ok(voiceTranscript(Array(300).fill(events[0])).length <= 60);
});

test("multilingual settings accept fixed supported engines while rejecting arbitrary remote models/voices", () => {
  const config = { stt: { engine: "whisper", model: "small", language: "auto" }, tts: { engine: "bilingual", model: "kokoro-piper", voice: "am_echo", turkishVoice: "tr_TR-dfki-medium", language: "auto" } };
  assert.deepEqual(localSpeechSchema.parse(config), config);
  for (const value of [{ ...config, stt: { ...config.stt, language: "random" } }, { ...config, tts: { ...config.tts, turkishVoice: "../../secret" } }, { ...config, tts: { ...config.tts, model: "remote/model" } }]) assert.equal(localSpeechSchema.safeParse(value).success, false);
});
