// Launch the production Python executable through the real native DSH service.
// No live HUB profile, provider key, user microphone or saved chat is used.
import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { resolve, isAbsolute, join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { startVoiceSidecar } from "../../packages/harness-overlay/src/host/voice-sidecar.ts";
import { createVoiceBridgeServer } from "../../packages/harness-overlay/src/host/voice-bridge-server.ts";

const python = process.argv[2];
assert.ok(python && isAbsolute(python), "Pass the absolute Pipecat venv Python executable");
const root = fileURLToPath(new URL("../../", import.meta.url));
const voicePackage = resolve(root, process.argv.includes("--packaged") ? "out/HUB-win32-x64/resources/host/node_modules/@lencx/minke-harness-overlay" : "packages/harness-overlay");
// Reserved .invalid endpoint: validates real host->Python ICE setup without
// sending traffic to a third-party relay or consuming model quota.
const iceServers = [{ urls: ["turn:relay.invalid:3478"], username: "fixture", credential: "synthetic-only" }];
const vendor = resolve(root, "vendor/deepseek-harness");
const entries = new Map();
for (const group of await readdir(resolve(vendor, "packages"), { withFileTypes: true })) {
  if (!group.isDirectory()) continue;
  for (const pkg of await readdir(resolve(vendor, "packages", group.name), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const directory = resolve(vendor, "packages", group.name, pkg.name);
    let manifest;
    try { manifest = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const entry = manifest.exports?.["."]?.default ?? manifest.main;
    if (entry?.endsWith(".js")) entries.set(manifest.name, pathToFileURL(resolve(directory, entry)).href);
  }
}
registerHooks({ resolve(specifier, context, next) { return next(entries.get(specifier) ?? specifier, context); } });
const requireDsh = createRequire(resolve(vendor, "package.json"));
const { Context } = await import(pathToFileURL(requireDsh.resolve("@deepseek-ai/cordis")));
const { default: SubprocessLocal } = await import("@deepseek-ai/dsh-subprocess-local");
const ctx = new Context();
let closed = 0;
const bridge = await createVoiceBridgeServer(async () => ({ sessionId: "synthetic-supervisor-session", async speak() { throw new Error("No LLM calls allowed"); }, async interrupt() {}, async close() { closed++; } }));
let sidecar, child, metadataRoot;
const children = [];
try {
  await ctx.plugin(SubprocessLocal);
  const call = await bridge.open();
  const subprocess = { resolveExecutable: (...args) => ctx.subprocess.resolveExecutable(...args), spawn(spec) { child = ctx.subprocess.spawn(spec); children.push(child); return child; } };
  sidecar = await startVoiceSidecar(subprocess, { python, script: resolve(voicePackage, "voice/server.py"), bridgeUrl: bridge.url, bridgeToken: bridge.token, callId: call.callId, iceServers }, AbortSignal.timeout(60_000));
  assert.deepEqual(await sidecar.request("/status", "GET"), { status: 200, body: { status: "waiting" } });
  await sidecar.stop();
  await sidecar.done;
  assert.equal(closed, 1, "Graceful Python shutdown must release only its native voice lease");
  console.log("PASS: real DSH managed Python startup, authenticated readiness, graceful lease close and process-tree exit");
  // Optional compiled-entry integration: actual DSH browser authentication and
  // managed Python process, with a synthetic Session Controller seam. No model.
  if (process.argv.includes("--web")) {
    const { default: Sessions } = await import("@deepseek-ai/dsh-session");
    await ctx.plugin(Sessions);
    const { default: Tools } = await import("@deepseek-ai/dsh-tools");
    const { default: SystemPrompt } = await import("@deepseek-ai/dsh-system-prompt");
    const { createScope } = await import("@deepseek-ai/dsh-scope");
    await ctx.plugin(SystemPrompt, {}); await ctx.plugin(Tools);
    const { default: Storage } = await import("@deepseek-ai/dsh-storage");
    const StorageJson = await import("@deepseek-ai/dsh-storage-json");
    const StorageDomain = await import("@deepseek-ai/dsh-storage-domain");
    metadataRoot = await mkdtemp(join(tmpdir(), "hub-voice-supervisor-test-"));
    await ctx.plugin(Storage); await ctx.plugin(StorageJson, { root: metadataRoot }); await ctx.plugin(StorageDomain, { backend: "json" });
    const { BrowserAuth } = await import(pathToFileURL(resolve(vendor, "packages/client/connection/src/browser-auth.ts")));
    const { HostConnectionService } = await import(pathToFileURL(resolve(vendor, "packages/client/connection/src/rpc-host.ts")));
    const { apply } = await import(pathToFileURL(resolve(voicePackage, "lib/voice.js")));
    let record;
    const auth = await BrowserAuth.create({}, { async modifyRecord(_key, update) { const next = await update(record); if (next) record = next; return record; } }, 1);
    const connection = new HostConnectionService(ctx, [], auth);
    const routes = new Map(); let disposeVoice, nativeCreated = 0, catalogAvailable = true;
    const server = createServer((req, res) => {
      if (process.argv.includes("--browser") && req.url === "/synthetic-browser-check") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end('<!doctype html><title>HUB synthetic voice check</title><audio autoplay></audio><button id="start">Start voice</button><button id="end">End voice</button>'); return;
      }
      const route = routes.get(new URL(req.url, "http://localhost").pathname);
      if (!route) { res.writeHead(404); res.end(); return; }
      void route(req, res).catch(() => res.destroy());
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    const authUrl = new URL(connection.authenticatedUrl(origin)); let cookie;
    connection.authorizeIndex({ method: "GET", url: authUrl.pathname + authUrl.search, headers: { host: authUrl.host } }, { writeHead(_code, headers) { cookie = headers["set-cookie"].split(";", 1)[0]; }, end() {} });
    assert.ok(cookie);
    try {
      const agent = { id: "synthetic-web-session", session: ctx.sessions.create("synthetic-web-session", { meta: { cwd: root } }), status: "idle", inbox: { nextTurn: [], nextStep: [] }, whenIdle: async () => {}, cancel() {} };
      await ctx.plugin(Object.assign(inner => { agent.ctx = createScope(inner, agent).ctx; }, { inject: ["tools", "systemPrompt"] }));
      if (process.argv.includes("--default-handoff-check")) {
        ctx.tools.register({ name: "subagent", description: "Synthetic native capability", parameters: { type: "object", properties: { description: { type: "string" }, prompt: { type: "string" }, run_in_background: { type: "boolean" } } },
          output: { schema: { type: "string" }, render: () => [] }, execute() { throw new Error("This composition check must not run a synthetic child"); } });
      }
      apply({ subprocess, storageDomain: ctx.storageDomain, connection,
        llm: { listProviders: () => [{ id: "synthetic-only", name: "Synthetic adapter" }], listModels: async provider => [{ provider, id: "no-model", name: "No model calls", reasoning: { efforts: [{ id: "low" }] } }],
          async resolveModelInfo(provider, id) { assert.equal(provider, "synthetic-only"); assert.equal(id, "no-model"); if (!catalogAvailable) throw new Error("Synthetic adapter unavailable"); return { provider, id, reasoning: { efforts: [{ id: "low" }] } }; } },
        agentPresets: { standingKeyFor: async () => ({ id: "synthetic-standing" }) }, tools: { schemas: () => ctx.tools.schemas(agent) },
        sessionController: { async create() { nativeCreated++; return { sessionId: agent.id }; }, async resolveAgent(id) { return id === agent.id ? { agent } : { error: new Error("Missing synthetic chat") }; }, async rename() {}, async prompt() { throw new Error("No model calls permitted"); } },
        agents: { get: () => agent, list: () => [agent], isOwnedBy: () => false }, on: () => () => {},
        webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
        effect(callback) { disposeVoice = callback(); },
      }, { python, provider: "synthetic-only", model: "no-model", ...(process.argv.includes("--browser") ? {} : { iceServers }) });
      const post = (path, body, headers = {}) => fetch(origin + "/api/hub/voice/" + path, { method: "POST", headers: { cookie, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
      const input = { requestId: randomUUID(), requestedAt: Date.now() };
      assert.equal((await post("open", input, { cookie: "" })).status, 401);
      assert.equal((await post("open", input, { origin: "https://attacker.invalid" })).status, 403);
      assert.equal(nativeCreated, 0);
      const deadline = Date.now() + 5000;
      while ((await fetch(origin + "/api/hub/voice/status", { headers: { cookie } })).status !== 200) {
        assert.ok(Date.now() < deadline, "Optional voice plugin failed to initialize");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      catalogAvailable = false;
      assert.equal((await post("open", { requestId: randomUUID(), requestedAt: Date.now() })).status, 503);
      assert.equal(nativeCreated, 0, "Unavailable exact voice model must not create a transcript or speech process");
      catalogAvailable = true;
      const getProfiles = () => fetch(origin + "/api/hub/voice/profiles", { headers: { cookie } });
      const seeded = await (await getProfiles()).json();
      const voiceCatalog = await (await fetch(origin + "/api/hub/voice/catalog", { headers: { cookie } })).json();
      assert.ok(voiceCatalog.speech.tts[0].voices.includes("bf_emma"), "Real scrubbed native Python catalog discovers installed English voices");
      if (process.argv.includes("--download-models")) {
        const selection = { engine: "whisper", model: "tiny.en" };
        assert.equal((await post("speech-models", selection, { "x-hub-speech-models": "1", cookie: "" })).status, 401);
        assert.equal((await post("speech-models", selection, { "x-hub-speech-models": "1", origin: "https://attacker.invalid" })).status, 403);
        assert.equal((await post("speech-models", selection)).status, 403);
        assert.equal((await post("speech-models", selection, { "x-hub-speech-models": "1" })).status, 202);
        let job; const downloadDeadline = Date.now() + 90000;
        do {
          job = (await (await fetch(origin + "/api/hub/voice/speech-models", { headers: { cookie } })).json()).download;
          if (["complete", "failed"].includes(job.phase)) break;
          assert.ok(Date.now() < downloadDeadline, "Native download worker must finish");
          await new Promise(resolve => setTimeout(resolve, 250));
        } while (true);
        assert.equal(job.phase, "complete", "Actual fixed model downloader completes under native process ownership");
        assert.deepEqual((await (await getProfiles()).json()).profiles, seeded.profiles, "Model installation cannot alter saved personalities");
        const refreshed = await (await fetch(origin + "/api/hub/voice/catalog", { headers: { cookie } })).json();
        assert.ok(refreshed.speech.stt.find(item => item.model === "tiny.en").available);
        console.log("PASS: authenticated native model downloader completes and refreshes offline catalog without changing profiles or creating chats");
      }
      assert.equal(nativeCreated, 0, "Reading settings and the speech catalog cannot create a chat");
      const jess = { ...seeded.profiles[0], name: "Jess", route: { provider: "synthetic-only", model: "no-model", reasoningEffort: "low" },
        speech: process.argv.includes("--piper") ? { stt: { engine: "whisper", model: "tiny.en" }, tts: { engine: "piper", model: "en_US-ljspeech-high", voice: "en_US-ljspeech-high" } } :
          { stt: { engine: "whisper", model: "base.en" }, tts: { engine: "kokoro", model: "82m", voice: "bf_emma" } } };
      delete jess.id;
      let saved = await (await post("profiles", { type: "create", revision: seeded.revision, profile: jess }, { "x-hub-voice-profiles": "1" })).json();
      const jessId = saved.profiles[1].id;
      saved = await (await post("profiles", { type: "select", revision: saved.revision, id: jessId }, { "x-hub-voice-profiles": "1" })).json();
      const opened = await post("open", input); assert.equal(opened.status, 200);
      const result = await opened.json(); assert.equal(result.sessionId, agent.id);
      if (process.argv.includes("--default-handoff-check")) {
        assert.ok(agent.ctx.tools.get("hub_task", agent), "Packaged apply() must attach hub_task even with taskModel omitted");
        assert.ok(voiceCatalog.tools.some(tool => tool.name === "hub_task"), "Default task handoff must be selectable in the PWA tool catalog");
        console.log("PASS: actual packaged voice entry exposes and attaches background handoff with optional taskModel absent");
      }
      assert.deepEqual(result.profile, { id: jessId, name: "Jess", revision: saved.revision });
      await post("profiles", { type: "edit", revision: saved.revision, id: jessId, profile: { ...jess, name: "Jess next call" } }, { "x-hub-voice-profiles": "1" });
      assert.deepEqual((await (await getProfiles()).json()).active, result.profile, "Editing a saved personality cannot change an admitted profile");
      if (!process.argv.includes("--browser")) assert.deepEqual(result.iceServers, iceServers);
      const repeated = await post("open", input); assert.deepEqual(await repeated.json(), result);
      assert.equal(nativeCreated, 1);
      const status = await post("status", { callId: result.callId }); assert.equal((await status.json()).status, "waiting");
      assert.equal((await post("close", { callId: randomUUID() })).status, 410);
      assert.equal((await post("close", { callId: result.callId })).status, 200);
      assert.equal((await post("open", input)).status, 410);
      const getHistory = (headers = {}) => fetch(origin + "/api/hub/voice/history", { headers: { cookie, ...headers } });
      assert.equal((await getHistory({ cookie: "" })).status, 401);
      assert.equal((await getHistory({ origin: "https://attacker.invalid" })).status, 403);
      const archived = await (await getHistory()).json();
      assert.deepEqual(archived.conversations.map(({ sessionId, saved }) => ({ sessionId, saved })), [{ sessionId: agent.id, saved: false }]);
      assert.equal((await post("history", { sessionId: agent.id })).status, 403);
      assert.equal((await post("history", { sessionId: "missing" }, { "x-hub-voice-history": "1" })).status, 404);
      assert.equal((await post("history", { sessionId: agent.id }, { "x-hub-voice-history": "1" })).status, 200);
      assert.equal((await (await getHistory()).json()).conversations[0].saved, true);
      assert.equal(nativeCreated, 1, "Reading/promoting Voice History must not create or activate conversations");
      console.log("PASS: authenticated history list and promotion use durable native metadata, reject foreign origins and preserve session ownership");
      console.log("PASS: compiled voice plugin, real DSH signed-cookie/Origin fence, replay-safe admission and owned process close");
      if (process.argv.includes("--browser")) {
        const modulePath = process.argv[process.argv.indexOf("--browser") + 1];
        assert.ok(modulePath && isAbsolute(modulePath), "Pass an installed Playwright module directory after --browser");
        const { chromium } = createRequire(import.meta.url)(modulePath);
        const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
        try {
          const page = await browser.newPage();
          await page.context().addCookies([{ name: cookie.split("=")[0], value: cookie.slice(cookie.indexOf("=") + 1), url: origin }]);
          const errors = []; page.on("pageerror", error => errors.push(error.message));
          await page.goto(origin + "/synthetic-browser-check");
          await page.evaluate(async () => {
            globalThis.states = []; globalThis.voiceErrors = []; globalThis.micRequests = 0;
            const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            navigator.mediaDevices.getUserMedia = (...args) => { globalThis.micRequests++; return original(...args); };
            const { createVoiceClient } = await import("/api/hub/voice/client.js");
            const audio = document.querySelector("audio");
            globalThis.voice = createVoiceClient({ audio,
              onState: state => globalThis.states.push(state),
              onSession: () => globalThis.voice.mute(true),
              onProfile: profile => { globalThis.admittedProfile = profile; },
              onTranscript() {}, onActivity() {}, onAudioBlocked: () => globalThis.voiceErrors.push("audio blocked"),
              onError: message => globalThis.voiceErrors.push(message),
            });
            document.querySelector("#start").onclick = () => { globalThis.startPromise = globalThis.voice.start(); globalThis.startPromise.catch(error => globalThis.voiceErrors.push(error.message)); };
            document.querySelector("#end").onclick = () => { globalThis.stopPromise = globalThis.voice.stop(); };
          });
          assert.equal(await page.evaluate(() => globalThis.micRequests), 0, "Importing/constructing voice must not request a microphone");
          await page.click("#start");
          await page.waitForFunction(() => globalThis.states.includes("listening") || globalThis.voiceErrors.length, null, { timeout: 90_000 });
          assert.deepEqual(await page.evaluate(() => globalThis.voiceErrors), []);
          assert.equal(await page.evaluate(() => globalThis.admittedProfile?.name), "Jess next call");
          // Decode the actual remote audio stream, not a synthetic UI waveform.
          const heard = await page.evaluate(async () => {
            const audio = document.querySelector("audio");
            const context = new AudioContext(); await context.resume();
            const source = context.createMediaStreamSource(audio.srcObject); const analyser = context.createAnalyser(); source.connect(analyser);
            const samples = new Float32Array(analyser.fftSize); const deadline = Date.now() + 30_000;
            let audible = false;
            while (!audible && Date.now() < deadline) { analyser.getFloatTimeDomainData(samples); audible = samples.some(value => Math.abs(value) > 0.0001); await new Promise(resolve => setTimeout(resolve, 20)); }
            source.disconnect(); await context.close(); return audible;
          });
          assert.equal(heard, true, "Selected local TTS greeting must reach browser WebRTC as non-silent PCM");
          await page.click("#end"); await page.evaluate(() => globalThis.stopPromise);
          assert.equal(await page.evaluate(() => document.querySelector("audio").srcObject), null);
          assert.equal(await page.evaluate(() => globalThis.states.at(-1)), "idle");
          assert.deepEqual(errors, []);
          console.log("PASS: actual Chromium loads lazy official SDK, starts only on gesture, receives real CPU speech over WebRTC and ends cleanly (fake/muted microphone, no model calls)");
        } finally { await browser.close(); }
      }
    } finally {
      await disposeVoice?.();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
  }
} catch (error) {
  // Only synthetic-test diagnostics; never enable child log forwarding in HUB.
  if (process.argv.includes("--diagnostics")) for (const process of children.slice(-3)) console.error(process.collected.stderr?.readFrom(0).text?.slice(-8000).replace(/[A-Za-z0-9_-]{43}/g, "[redacted]"));
  throw error;
} finally {
  await sidecar?.stop();
  await bridge.dispose();
  await ctx.fiber.dispose();
  if (metadataRoot) {
    assert.equal(dirname(resolve(metadataRoot)), resolve(tmpdir()));
    assert.ok(basename(metadataRoot).startsWith("hub-voice-supervisor-test-"));
    await rm(metadataRoot, { recursive: true, force: true });
  }
}
