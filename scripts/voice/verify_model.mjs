// Opt-in real-provider check, with synthetic input and a disposable native home.
// Reuses existing credentials without printing/copying them. Browser tools are
// opt-in and confined to the owning Electron launcher's synthetic loopback page.
import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { zstdDecompressSync } from "node:zlib";
import { openNativeVoiceSession, validateVoiceModel } from "../../packages/harness-overlay/src/host/voice-session.ts";
import { PresentationRuntime } from "../../packages/harness-overlay/src/host/presentation.ts";
const { values, positionals } = parseArgs({ allowPositionals: true, options: { provider: { type: "string" }, "codex-plugin": { type: "string" }, "catalog-only": { type: "boolean" }, model: { type: "string" }, effort: { type: "string" }, "child-model": { type: "string" }, "audio-python": { type: "string" }, "audio-only": { type: "boolean" }, "browser-task": { type: "string" } } });
const [dshHome, hostRoot, playwright, screenshot] = positionals;
const modelId = values.model, effort = values.effort, childModel = values["child-model"];
const voiceProvider = values.provider;
assert.ok(["openai-codex", "openrouter"].includes(voiceProvider), "Choose the explicit --provider; never infer a billing route");
assert.ok(voiceProvider !== "openai-codex" || values["codex-plugin"], "Provide the already installed --codex-plugin directory");
assert.ok(dshHome && hostRoot, "Provide the existing DSH home and installed host explicitly");
assert.ok(modelId && childModel, "Explicit --model and --child-model are required; no implicit voice model");
assert.ok(!values["audio-only"] || values["audio-python"], "--audio-only requires --audio-python");
assert.ok(!values["browser-task"] || (values["audio-only"] && process.connected && new URL(values["browser-task"]).hostname === "127.0.0.1"), "Browser task requires the owned Electron parent, loopback fixture and audio-only mode");
const root = fileURLToPath(new URL("../../", import.meta.url));
const vendor = resolve(root, "vendor/deepseek-harness");
const entries = new Map();
const piAiEntries = new Set();
for (const group of await readdir(join(vendor, "packages"), { withFileTypes: true })) {
  if (!group.isDirectory()) continue;
  for (const pkg of await readdir(join(vendor, "packages", group.name), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const directory = join(vendor, "packages", group.name, pkg.name);
    let manifest; try { manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const entry = manifest.exports?.["."]?.default ?? manifest.main;
    if (entry?.endsWith(".js")) entries.set(manifest.name, pathToFileURL(resolve(directory, entry)).href);
  }
}
const hostAnchor = pathToFileURL(resolve(hostRoot, "package.json")).href;
registerHooks({ resolve(specifier, context, next) {
  const target = entries.get(specifier) ?? specifier;
  let resolved;
  try { resolved = next(target, context); } catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND" || target.startsWith(".") || target.startsWith("node:")) throw error;
    resolved = next(target, { ...context, parentURL: hostAnchor });
  }
  if (specifier === "@earendil-works/pi-ai") piAiEntries.add(resolved.url);
  return resolved;
} });
const requireHost = createRequire(hostAnchor), requireDsh = createRequire(join(vendor, "package.json"));
const settings = requireHost("yaml").parse(await readFile(resolve(dshHome, "settings.yaml"), "utf8"));
const provider = settings["llm-pi-ai"]?.providers?.openrouter;
assert.ok(provider, "Existing OpenRouter connection is missing");
assert.ok(provider.models.some(model => model.id === childModel), "Requested stronger model must already be configured");
let profile = provider;
if (voiceProvider === "openrouter") {
const catalogResponse = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(15_000) });
assert.equal(catalogResponse.status, 200);
const catalogModel = (await catalogResponse.json()).data.find(model => model.id === modelId);
assert.ok(catalogModel, "Requested model is absent from the provider catalog");
assert.ok(catalogModel.supported_parameters.includes("tools"), "Voice coordinator requires tool calling");
if (effort) assert.ok(catalogModel.reasoning?.supported_efforts?.includes(effort), "Requested effort must be explicitly advertised by the provider");
const modelDescriptor = { id: modelId, name: catalogModel.name, contextWindow: catalogModel.context_length,
  ...(effort ? { reasoningEfforts: { [effort]: effort } } : {}) };
profile = { ...provider, models: [...provider.models.filter(model => model.id !== modelId), modelDescriptor] };
}
// Only the isolated adapter profile changes. No credentials or settings writes.
const nativeFetch = globalThis.fetch, wire = [];
const nativeSocketSend = globalThis.WebSocket?.prototype.send;
const isCodexRequest = url => url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex/") && url.pathname.endsWith("/responses");
// Passive observation only: keep native compression, transport selection and
// OAuth untouched. Retain only model/effort/transport, never headers or input.
if (nativeSocketSend) globalThis.WebSocket.prototype.send = function (data) {
  if (isCodexRequest(new URL(this.url)) && typeof data === "string") {
    const body = JSON.parse(data);
    if (body.type === "response.create") wire.push({ provider: "openai-codex", model: body.model, effort: body.reasoning?.effort, transport: "websocket" });
  }
  return nativeSocketSend.call(this, data);
};
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (((url.hostname === "openrouter.ai" && url.pathname.endsWith("/chat/completions")) ||
       isCodexRequest(url)) && init?.body !== undefined) {
    const encoded = new Headers(init.headers).get("content-encoding") === "zstd";
    const body = JSON.parse(encoded ? zstdDecompressSync(init.body).toString("utf8") : String(init.body));
    wire.push({ provider: url.hostname === "chatgpt.com" ? "openai-codex" : "openrouter", model: body.model, effort: body.reasoning?.effort ?? body.reasoning_effort, transport: encoded ? "sse-zstd" : "sse" });
  }
  return nativeFetch(input, init);
};
const load = async path => { const module = await import(pathToFileURL(join(vendor, "packages", path, "lib/index.js"))); return module.default ?? module; };
const { Context } = await import(pathToFileURL(requireDsh.resolve("@deepseek-ai/cordis")));
const { createUserMessage } = await import(pathToFileURL(join(vendor, "packages/llm/llm/lib/index.js")));
const ctx = new Context(); const handles = [], requests = [];
const testRoot = await mkdtemp(join(tmpdir(), "hub-voice-model-"));
const priorDshHome = process.env.DSH_HOME;
let voice, parent, releaseChild;
const childGate = new Promise(resolve => { releaseChild = resolve; });
let childRequestStarted = false;
let childRequests = 0;
const presentations = new PresentationRuntime();
let deadline; const runBegan = performance.now();
try {
  for (const path of ["llm/llm", "core/session", "session/session-projection", "core/system-prompt", "core/tools", "core/agent"]) await ctx.plugin(await load(path));
  await ctx.plugin(await load("session/session-persistence-jsonl"), { root: testRoot, compression: "none" });
  await ctx.plugin(await load("core/agent-loop"), { agents: [] });
  await ctx.plugin(await load("subagent/subagent"));
  await ctx.plugin(await load("subagent/subagent-spawn-in-process"), { providerName: "spawn" });
  await ctx.plugin(await load("credentials/credentials-local"), { path: resolve(dshHome, ".credentials.yaml"), dshHome, watch: false });
  await ctx.plugin(await load("llm/llm-pi-ai"), { providers: { openrouter: profile } });
  if (voiceProvider === "openai-codex") {
    const pluginRoot = resolve(values["codex-plugin"]);
    const manifest = JSON.parse(await readFile(join(pluginRoot, "package.json"), "utf8"));
    assert.equal(manifest.name, "dsh-codex-connect-plus");
    process.env.DSH_HOME = resolve(dshHome);
    const plugin = await import(pathToFileURL(join(pluginRoot, "lib/index.js")));
    assert.equal((await plugin.openAICodexAuthStatus()).authenticated, true, "Existing Codex plugin must already be signed in");
    await ctx.plugin(plugin, { enableSearch: false, enableImageTool: false, enableImageGeneration: false });
    assert.equal(ctx.llm.listProviders().filter(item => item.id === "openai-codex").length, 1, "Register the subscription adapter exactly once");
  }
  const advertised = await ctx.llm.listModels(voiceProvider);
  assert.ok(advertised.some(model => model.id === modelId), "Requested exact model must be in the installed native provider catalog");
  const resolvedModel = await ctx.llm.resolveModelInfo(voiceProvider, modelId);
  await validateVoiceModel(ctx.llm, { provider: voiceProvider, model: modelId, reasoningEffort: effort }, AbortSignal.timeout(15_000));
  if (effort) assert.ok(resolvedModel.reasoning?.efforts.some(item => item.id === effort), "Native provider must advertise the requested effort");
  console.log(JSON.stringify({ provider: voiceProvider, model: modelId, efforts: resolvedModel.reasoning?.efforts.map(item => item.id), nativeCatalogVerified: true }));
  if (values["catalog-only"]) { console.log("PASS: installed adapter advertises the exact model and effort; no inference request sent"); }
  else {
  const browserTools = ["browser_open", "browser_navigate", "browser_snapshot", "browser_find", "browser_click", "browser_scroll", "browser_wait"];
  if (values["browser-task"]) {
    const { apply } = await import("../../packages/harness-overlay/src/host/agent-browser-tools.ts");
    assert.equal(apply({ tools: ctx.tools, systemPrompt: ctx.systemPrompt, on: (...args) => ctx.on(...args), effect: (...args) => ctx.effect(...args),
      attachments: { async saveImage() { throw new Error("Screenshot attachment tools are not enabled in this fixture"); } },
    }), true);
  }
  await ctx.plugin(await load("subagent/tool-subagent"), {
    provider: "spawn", toolName: "subagent", enableRunInBackground: true, backgroundMode: "continuable", maxDepth: 1,
    agentOptions: { provider: "openrouter", model: childModel, maxTokens: 1024 },
    toolFilter: { allow: values["browser-task"] ? browserTools : [] }, persona: values["browser-task"]
      ? "Complete the supplied browser task using the available native browser tools. Only the supplied loopback fixture is in scope. Observe, click once, verify the visible completion message, then report briefly. Do not close the browser tab."
      : "Complete only the supplied synthetic reasoning task. Be concise. No tools are available.",
  });
  ctx.on("agent/request", async ({ agent }, next) => {
    const config = await next();
    requests.push({ parent: agent.id === parent?.id, provider: config.provider, model: config.model });
    if (agent.id !== parent?.id) {
      childRequests++;
      if (values["browser-task"] ? childRequests === 2 : !childRequestStarted) {
        childRequestStarted = true;
        if (values["browser-task"]) console.log(JSON.stringify({ browserChildPausedAtStep: childRequests, provider: config.provider, model: config.model }));
        await childGate;
      }
    }
    return config;
  });
  const controller = {
    async create() { const handle = await ctx.agents.create({ sessionId: "hub-live-model-pilot", meta: { cwd: testRoot }, agentOptions: { provider: voiceProvider, model: modelId } }); handles.push(handle); parent = handle.agent; return { sessionId: parent.id }; },
    async resolveAgent(id) { const agent = ctx.agents.get(id); return agent ? { agent } : { error: "not found" }; },
    async rename() {},
    async prompt(request) { ctx.agents.get(request.sessionId).followup(createUserMessage({ source: { kind: "user", rpcId: request.requestId }, content: request.content })); },
  };
  voice = await openNativeVoiceSession({ sessionController: controller, agents: ctx.agents, on: (...args) => ctx.on(...args) }, { provider: voiceProvider, model: modelId, ...(effort ? { reasoningEffort: effort } : {}) }, { presentations });
  deadline = setTimeout(() => { console.error("Model verifier deadline reached"); releaseChild(); void voice?.close(); void ctx.fiber.dispose(); }, values["audio-python"] ? 300_000 : 180_000);
  async function speak(id, input) {
    const events = [], began = performance.now(); let firstTextMs;
    await voice.speak(id, input, event => { if (event.type === "text" && event.text && firstTextMs === undefined) firstTextMs = Math.round(performance.now() - began); events.push(event); });
    const text = events.filter(event => event.type === "text").map(event => event.text).join("");
    console.log(JSON.stringify({ model: modelId, effort, utterance: id, status: events.at(-1)?.status, firstTextMs, elapsedMs: Math.round(performance.now() - began), speechCharacters: text.length, tools: events.filter(event => event.type === "tool-start").map(event => event.name) }));
    assert.equal(events.at(-1)?.status, "completed", `Real model utterance ${id} did not complete`);
    return { text, events };
  }
  if (!values["audio-only"]) {
  const greeting = await speak(1, "Hello. For this synthetic test our project is named Lantern. Say a brief hello, without tools.");
  assert.ok(greeting.text.length > 0 && greeting.text.length < 500);
  const recall = await speak(2, "What is our synthetic project called? Answer in one sentence without tools.");
  assert.match(recall.text, /Lantern/i);
  const visual = await speak(3, "Show me a simple interactive explanation of a square's area with a side-length slider, and explain it in one short sentence. Use the available visual tool.");
  assert.ok(visual.events.some(event => event.type === "tool-start" && event.name === "hub_present"));
  assert.equal(presentations.summary(parent.id)?.kind, "vega", "Real model must publish a validated interactive visual");
  if (playwright && !playwright.startsWith("--")) {
    const renderer = await readFile(resolve(root, "packages/harness-overlay/lib/presentation-renderer.js"), "utf8");
    const { verifyModelVisual } = await import("./verify_model_visual.mjs");
    await verifyModelVisual({ document: presentations.document(parent.id, presentations.summary(parent.id).id, renderer), playwright, screenshot });
  }
  console.log("PASS: requested live model provides concise shared-context conversation and native validated interactive visual tool");
  const delegation = await speak(4, "Have the smarter background assistant compare a single shared voice/text conversation with separate voice and text histories for our synthetic Lantern project. Ask for two tradeoffs and a recommendation in three sentences. Delegate now and acknowledge briefly; do not wait for its result.");
  assert.ok(delegation.events.some(event => event.type === "tool-start" && event.name === "subagent"), "Live coordinator did not delegate");
  const nativeChildren = ctx.agents.list().filter(agent => agent.id !== parent.id);
  assert.equal(nativeChildren.length, 1, "Exactly one native child should be admitted");
  const child = nativeChildren[0];
  assert.equal(child.options.model, childModel);
  await voice.close(); voice = undefined;
  assert.ok(ctx.agents.get(child.id), "Closing voice must not dispose admitted work");
  releaseChild(); await child.whenIdle(); await parent.whenIdle();
  const events = child.session.snapshotEvents();
  assert.ok(events.some(event => event.type === "turn/end" && event.data.reason.kind === "completed"), "Real stronger model did not complete");
  assert.ok(requests.some(request => !request.parent && request.model === childModel));
  const voiceWire = wire.filter(request => request.model === modelId && request.provider === voiceProvider);
  assert.ok(voiceWire.length >= 4, "Verify real outbound provider requests, not only the configured route");
  if (effort) assert.ok(voiceWire.every(request => request.effort === effort), "Requested effort must reach every coordinator API request");
  console.log(JSON.stringify({ verifiedWire: voiceWire }));
  console.log("PASS: live native continuable handoff -> admitted child survives voice close -> real configured stronger model completes; requested model/effort verified on API requests");
  } else { await voice.close(); voice = undefined; }
  if (values["audio-python"]) {
    assert.ok(playwright, "Audio acceptance requires Playwright");
    const beforeAudio = wire.length;
    const { verifyBrowserNative } = await import("./verify_browser_native.mjs");
    await verifyBrowserNative({ ctx, voiceContext: { sessionController: controller, agents: ctx.agents, on: (...args) => ctx.on(...args) },
      voiceRoute: { provider: voiceProvider, model: modelId, ...(effort ? { reasoningEffort: effort } : {}) }, sessionId: parent.id,
      root, python: values["audio-python"], playwright, requests, liveModel: true,
      browserTask: values["browser-task"] ? { url: values["browser-task"], release: releaseChild, screenshot } : undefined });
    const audioWire = wire.slice(beforeAudio).filter(request => request.model === modelId && request.provider === voiceProvider);
    assert.ok(audioWire.length >= 4, "Audio phase itself must issue requests on the selected provider");
    if (effort) assert.ok(audioWire.every(request => request.effort === effort));
    console.log(JSON.stringify({ verifiedAudioWire: audioWire }));
    if (values["browser-task"]) {
      const childWire = wire.slice(beforeAudio).filter(request => request.model === childModel && request.provider === "openrouter");
      assert.ok(childWire.length >= 2, "Browser task must execute real requests through the existing stronger model route");
      console.log(JSON.stringify({ verifiedBrowserTaskWire: childWire }));
    }
  }
  }
} finally {
  console.log(JSON.stringify({ verificationElapsedMs: Math.round(performance.now() - runBegan) }));
  globalThis.fetch = nativeFetch;
  if (nativeSocketSend) globalThis.WebSocket.prototype.send = nativeSocketSend;
  clearTimeout(deadline); releaseChild(); await voice?.close();
  await Promise.all(handles.map(handle => handle.dispose()));
  // This process contains synthetic fixture sessions only. Release the
  // provider's native five-minute WebSocket cache instead of leaving the
  // successful verifier alive until upstream idle expiry.
  // Installed plugin and source-checkout adapters can resolve different copies
  // of pi-ai. Clean each actually loaded instance, not a guessed root import.
  for (const entry of piAiEntries) (await import(entry)).cleanupSessionResources();
  await ctx.fiber.dispose();
  if (priorDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = priorDshHome;
  assert.equal(dirname(resolve(testRoot)), resolve(tmpdir())); assert.ok(basename(testRoot).startsWith("hub-voice-model-"));
  await rm(testRoot, { recursive: true, force: true });
  console.log(JSON.stringify({ verificationCleanupComplete: true, providerModuleInstances: piAiEntries.size }));
  if (values["browser-task"] && process.connected) process.disconnect();
}
