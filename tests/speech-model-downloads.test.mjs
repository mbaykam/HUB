import test from "node:test";
import assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { createSpeechModelDownloads, createSpeechModelsHandler } from "@minke/harness-overlay/host/speech-model-downloads.ts";

const choice = { engine: "whisper", model: "tiny.en" };
const tick = () => new Promise(resolve => setImmediate(resolve));
const successful = '{"phase":"downloading"}\n{"phase":"verifying"}\n{"phase":"complete"}\n';
function fixture({ output = successful, exitCode = 0, held = false, stops = true } = {}) {
  const done = Promise.withResolvers(), stdout = held ? new PassThrough() : Readable.from([output]);
  let terminated = 0, invalidated = 0; const specs = [], lifetime = new AbortController();
  const subprocess = { async resolveExecutable(path) { return path; }, spawn(spec) {
    specs.push(spec); if (!held) done.resolve({ exitCode, signal: null });
    return { stdout, done: done.promise, terminate() { terminated++; if (stops) { stdout.destroy(); done.resolve({ exitCode: null, signal: "SIGTERM" }); } }, async waitForExit() { return stops; } };
  } };
  const manager = createSpeechModelDownloads(subprocess, resolve("python.exe"), resolve("speech_download.py"), lifetime.signal, () => invalidated++);
  return { manager, specs, lifetime, stdout, done, get terminated() { return terminated; }, get invalidated() { return invalidated; } };
}

test("model download uses bounded native worker, fixed arguments and scrubbed environment; completion requires exit", async () => {
  const f = fixture({ held: true });
  try {
    const first = f.manager.start(choice); await tick();
    assert.deepEqual(f.manager.start(choice), first, "Repeat while running is idempotent");
    assert.throws(() => f.manager.start({ ...choice, model: "base.en" }), /Another/);
    assert.throws(() => f.manager.start({ ...choice, model: "../../secret" }));
    assert.throws(() => f.manager.start({ ...choice, url: "https://example.com" }));
    const spec = f.specs[0]; assert.deepEqual(spec.argv.slice(1), ["-u", resolve("speech_download.py"), "whisper", "tiny.en"]);
    assert.equal(spec.env.HF_HUB_OFFLINE, "0"); assert.equal(spec.env.HF_HUB_DISABLE_IMPLICIT_TOKEN, "1");
    assert.equal(spec.env.OPENAI_API_KEY, undefined); assert.equal(spec.env.PYTHONPATH, undefined);
    assert.equal(spec.stdio.stderr.maxBytes, 4096);
    f.stdout.end(successful); await tick();
    assert.equal(f.manager.status().phase, "verifying"); assert.equal(f.invalidated, 0);
    f.done.resolve({ exitCode: 0, signal: null }); await tick();
    assert.equal(f.manager.status().phase, "complete"); assert.equal(f.invalidated, 1);
    const snapshot = f.manager.status(); snapshot.phase = "failed";
    assert.equal(f.manager.status().phase, "complete", "Caller cannot mutate host status");
  } finally { await f.manager.close(); }
});

test("failed, malformed, oversized and out-of-order worker output never publishes installation", async () => {
  for (const options of [{ exitCode: 1 }, { output: '{"phase":"complete"}\n' }, { output: successful + '{"phase":"failed"}\n' }, { output: "x".repeat(65537) }, { output: successful + "trailing" }]) {
    const f = fixture(options); f.manager.start(choice); await tick();
    assert.equal(f.manager.status().phase, "failed"); assert.equal(f.invalidated, 0); await f.manager.close();
  }
});

test("shutdown terminates owned worker and uncertain cleanup prevents more downloads", async () => {
  const f = fixture({ held: true }); f.manager.start(choice); await tick();
  await f.manager.close(); assert.ok(f.terminated > 0); assert.equal(f.manager.status().phase, "failed");
  assert.throws(() => f.manager.start(choice), /recovery/);
  const bad = fixture({ held: true, stops: false }); bad.manager.start(choice); await tick();
  bad.stdout.end("invalid\n"); await tick();
  assert.equal(bad.manager.status().phase, "failed"); assert.throws(() => bad.manager.start(choice), /recovery/);
  await bad.manager.close();
});

test("download HTTP is authenticated, same-origin, explicit, bounded and model-only", async () => {
  const f = fixture();
  const handler = createSpeechModelsHandler(f.manager, req => req.headers.authorization === "fixture" ? undefined : 401);
  const server = createServer(handler); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: "fixture", "content-type": "application/json", "x-hub-speech-models": "1" };
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { ...headers, "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await fetch(url, { method: "POST", headers: { authorization: "fixture" }, body: "{}" })).status, 403);
    assert.equal((await fetch(url, { method: "POST", headers: { ...headers, "content-type": "text/plain" }, body: "{}" })).status, 415);
    for (const command of [{ ...choice, model: "../../private" }, { ...choice, url: "https://example.com" }]) assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify(command) })).status, 400);
    assert.equal((await fetch(url, { method: "POST", headers, body: " ".repeat(2049) })).status, 413);
    assert.equal(f.specs.length, 0);
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(choice) });
    assert.equal(response.status, 202); assert.equal(response.headers.get("cache-control"), "no-store, private");
    await tick(); const status = await (await fetch(url, { headers })).json(); assert.equal(status.download.phase, "complete");
    assert.equal(f.specs.length, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await f.manager.close(); }
});
