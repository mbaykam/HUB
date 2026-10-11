import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { resolve } from "node:path";
import { startVoiceSidecar, voiceSidecarEnvironment } from "@minke/harness-overlay/host/voice-sidecar.ts";

const config = { python: resolve("test-runtime/python.exe"), script: resolve("test-runtime/server.py"), bridgeUrl: "http://127.0.0.1:4321", bridgeToken: "b".repeat(43), callId: "synthetic-call" };
function fixture({ record = '{"type":"hub-voice-ready","port":5432}\n', health = { status: "waiting" }, status = 200, exitOnSpawn = false } = {}) {
  const stdout = new PassThrough();
  let settle, spec, killed = 0, waits = 0;
  const done = new Promise(resolve => { settle = resolve; });
  const requests = [];
  const handle = { stdout, done, terminate() { killed++; settle({ exitCode: 0, signal: null }); }, async waitForExit() { waits++; return true; } };
  const subprocess = {
    async resolveExecutable(command) { return command; },
    spawn(value) { spec = value; setImmediate(() => { if (exitOnSpawn) settle({ exitCode: 1, signal: null }); else if (record !== null) stdout.write(record); }); return handle; },
  };
  const ports = { environment: { PATH: "test-path", OPENROUTER_API_KEY: "private", PIPECAT_SETUP_FILES: "bad-hook", PYTHONPATH: "bad-path" }, startupMs: 100,
    async fetch(url, options) { requests.push({ url, options }); return Response.json(url.endsWith("/status") ? health : { ok: true }, { status }); } };
  return { subprocess, ports, requests, handle, get spec() { return spec; }, get killed() { return killed; }, get waits() { return waits; } };
}

test("voice child gets only OS essentials and explicit call capabilities", () => {
  const env = voiceSidecarEnvironment({ Path: "bin", SystemRoot: "os", PYTHONPATH: "injection", PIPECAT_SETUP_FILES: "hook", OPENROUTER_API_KEY: "secret", HTTP_PROXY: "proxy", DSH_PRIVATE: "private" }, { ...config, controlToken: "control" });
  assert.equal(env.Path, "bin"); assert.equal(env.SystemRoot, "os");
  for (const key of ["PYTHONPATH", "PIPECAT_SETUP_FILES", "OPENROUTER_API_KEY", "HTTP_PROXY", "DSH_PRIVATE"]) assert.equal(env[key], undefined);
  assert.equal(env.HUB_VOICE_BRIDGE_TOKEN, config.bridgeToken);
  assert.equal(env.HF_HUB_OFFLINE, "1");
});
test("selected local speech reaches only its admitted sidecar and rejects executable configuration", async () => {
  const speech = { stt: { engine: "whisper", model: "tiny.en" }, tts: { engine: "kokoro", model: "82m", voice: "bf_emma" } };
  const f = fixture();
  f.ports.environment.HUB_VOICE_SPEECH = "ambient injection";
  const sidecar = await startVoiceSidecar(f.subprocess, { ...config, speech }, new AbortController().signal, f.ports);
  assert.deepEqual(JSON.parse(f.spec.env.HUB_VOICE_SPEECH), speech);
  assert.ok(!JSON.stringify(f.spec.argv).includes("bf_emma"));
  await sidecar.stop();
  assert.throws(() => voiceSidecarEnvironment({}, { ...config, controlToken: "fixture", speech: { ...speech, executable: "bad.exe" } }));
});

test("configured relay credentials go through private control only, and failed ICE setup fails closed", async () => {
  const iceServers = [{ urls: ["turn:relay.example:3478?transport=udp"], username: "fixture-user", credential: "fixture-short-lived" }];
  const f = fixture();
  const sidecar = await startVoiceSidecar(f.subprocess, { ...config, iceServers }, new AbortController().signal, f.ports);
  assert.equal(f.requests[1].url, "http://127.0.0.1:5432/ice");
  assert.deepEqual(JSON.parse(f.requests[1].options.body), { iceServers });
  assert.ok(!JSON.stringify(f.spec).includes("fixture-short-lived"));
  await sidecar.stop();
  const failed = fixture(), original = failed.ports.fetch;
  failed.ports.fetch = (url, options) => url.endsWith("/ice") ? Promise.resolve(Response.json({ error: "test" }, { status: 503 })) : original(url, options);
  await assert.rejects(startVoiceSidecar(failed.subprocess, { ...config, iceServers }, new AbortController().signal, failed.ports));
  assert.equal(failed.killed, 1);
  const invalid = fixture();
  await assert.rejects(startVoiceSidecar(invalid.subprocess, { ...config, iceServers: [{ urls: ["https://not-ice.example"] }] }, new AbortController().signal, invalid.ports));
  assert.equal(invalid.spec, undefined);
});

test("native supervisor admits a health-checked process, proxies only loopback, and stops once", async () => {
  const f = fixture(); const controller = new AbortController();
  const sidecar = await startVoiceSidecar(f.subprocess, config, controller.signal, f.ports);
  assert.deepEqual(f.spec.argv, [config.python, "-u", config.script]);
  assert.ok(!JSON.stringify(f.spec.argv).includes(config.bridgeToken));
  assert.equal(f.spec.env.OPENROUTER_API_KEY, undefined);
  assert.equal(f.spec.stdio.stderr.maxBytes, 16384);
  const auth = f.requests[0].options.headers.authorization;
  assert.match(auth, /^Bearer [\w-]{43}$/); assert.notEqual(auth, `Bearer ${config.bridgeToken}`);
  await sidecar.request("/offer", "POST", { sdp: "synthetic" });
  assert.equal(f.requests[1].url, "http://127.0.0.1:5432/offer");
  assert.equal(f.requests[1].options.redirect, "error");
  assert.equal(f.requests[1].options.headers.authorization, auth);
  await Promise.all([sidecar.stop(), sidecar.stop()]);
  assert.equal(f.killed, 1); assert.equal(f.waits, 1);
  assert.equal(f.requests.filter(x => x.url.endsWith("/close")).length, 1);
  await assert.rejects(sidecar.request("/status", "GET"), /exited/);
});

test("malformed, oversized, invalid-port and exited startups terminate their owned process", async () => {
  for (const options of [{ record: "not-json\n" }, { record: "x".repeat(16385) }, { record: '{"type":"hub-voice-ready","port":0}\n' }, { record: '{"type":"hub-voice-ready","port":65536}\n' }, { record: '{"type":"other","port":5432}\n' }, { exitOnSpawn: true }, { health: { status: "closed" } }, { status: 503 }]) {
    const f = fixture(options);
    await assert.rejects(startVoiceSidecar(f.subprocess, config, new AbortController().signal, f.ports), /could not start/);
    assert.equal(f.killed, 1); assert.equal(f.waits, 1);
  }
});

test("startup timeout and abort release the owned child", async () => {
  for (const abort of [false, true]) {
    const f = fixture({ record: null }); const controller = new AbortController();
    const pending = startVoiceSidecar(f.subprocess, config, controller.signal, f.ports);
    if (abort) setImmediate(() => controller.abort());
    await assert.rejects(pending, /could not start/); assert.equal(f.killed, 1);
  }
});

test("bounded JSON replies reject oversized or non-object bodies; failed graceful close still terminates", async () => {
  const f = fixture(); const original = f.ports.fetch;
  f.ports.fetch = (url, options) => url.endsWith("/status") ? original(url, options) : Promise.resolve(new Response("x".repeat(150001)));
  const sidecar = await startVoiceSidecar(f.subprocess, config, new AbortController().signal, f.ports);
  await assert.rejects(sidecar.request("/offer", "POST", {}), /exceeded/);
  await sidecar.stop(); assert.equal(f.killed, 1);
  const other = fixture(); const orig = other.ports.fetch;
  other.ports.fetch = (url, options) => url.endsWith("/status") ? orig(url, options) : Promise.resolve(Response.json([]));
  const second = await startVoiceSidecar(other.subprocess, config, new AbortController().signal, other.ports);
  await assert.rejects(second.request("/offer", "POST", {}), /Invalid voice response/);
  await second.stop();
});

test("relative paths and already-aborted calls never spawn", async () => {
  const f = fixture(); const controller = new AbortController();
  await assert.rejects(startVoiceSidecar(f.subprocess, { ...config, python: "python" }, controller.signal, f.ports), /absolute/);
  controller.abort();
  await assert.rejects(startVoiceSidecar(f.subprocess, config, controller.signal, f.ports));
  assert.equal(f.spec, undefined);
});

test("failed whole-tree shutdown is surfaced, not treated as successful cleanup", async () => {
  const f = fixture(); f.handle.waitForExit = async () => false;
  const sidecar = await startVoiceSidecar(f.subprocess, config, new AbortController().signal, f.ports);
  await assert.rejects(sidecar.stop(), /did not exit/);
  await assert.rejects(sidecar.stop(), /did not exit/);
  assert.equal(f.killed, 1);
});

test("uncertain cleanup after startup failure is distinguished for fail-closed admission", async () => {
  const f = fixture({ health: { status: "closed" } }); f.handle.waitForExit = async () => false;
  await assert.rejects(startVoiceSidecar(f.subprocess, config, new AbortController().signal, f.ports), /cleanup could not be confirmed/);
  assert.equal(f.killed, 1);
});
