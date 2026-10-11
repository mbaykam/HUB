import test from "node:test";
import assert from "node:assert/strict";
import { openNativeVoiceSession, validateVoiceModel } from "@minke/harness-overlay/host/voice-session.ts";

test("voice admission validates the exact installed provider/model/effort without fallback", async () => {
  const route = { provider: "openai-codex", model: "gpt-5.6-luna", reasoningEffort: "low" };
  const expected = { provider: route.provider, id: route.model, reasoning: { efforts: [{ id: "low" }] } };
  const signal = new AbortController().signal;
  let resolutions = 0;
  const catalog = { async resolveModelInfo(provider, model, passedSignal) {
    resolutions++; assert.equal(provider, route.provider); assert.equal(model, route.model); assert.equal(passedSignal, signal); return expected;
  } };
  await validateVoiceModel(catalog, route, signal);
  assert.equal(resolutions, 1);
  for (const result of [{ ...expected, provider: "openrouter" }, { ...expected, id: "another-model" }, { ...expected, reasoning: undefined }, { ...expected, reasoning: { efforts: [{ id: "high" }] } }]) {
    await assert.rejects(validateVoiceModel({ resolveModelInfo: async () => result }, route, signal));
  }
  await assert.rejects(validateVoiceModel({ async resolveModelInfo() { throw new Error("Provider missing"); } }, route, signal));
});

test("cancelled admission does not proceed after native model discovery settles", async () => {
  const controller = new AbortController();
  await assert.rejects(validateVoiceModel({ async resolveModelInfo(provider, id) { controller.abort(); return { provider, id }; } }, { provider: "synthetic", model: "voice" }, controller.signal));
  let called = false;
  await assert.rejects(validateVoiceModel({ async resolveModelInfo() { called = true; } }, { provider: "synthetic", model: "voice" }, controller.signal));
  assert.equal(called, false);
});

function fixture() {
  const count = { created: 0, resumed: 0, renamed: 0, marked: 0, removed: 0, hooks: 0 };
  const agent = { id: "existing-chat", status: "idle", inbox: { nextTurn: [], nextStep: [], remove: () => false }, cancel() {}, async whenIdle() {},
    ctx: { systemPrompt: { section() { count.hooks++; return () => count.removed++; } }, on() { count.hooks++; return () => count.removed++; } } };
  const ctx = { agents: { get: () => agent }, on: () => () => {}, sessionController: {
    async create() { count.created++; return { sessionId: agent.id }; },
    async resolveAgent() { count.resumed++; return { agent }; },
    async rename() { count.renamed++; }, async prompt() {},
  } };
  const options = { sessionId: agent.id, created: async () => count.marked++ };
  return { ctx, agent, options, count };
}
const route = { provider: "synthetic", model: "voice" };

test("closing retains the profile guard until native idle, including repeated or failed shutdown", async () => {
  for (const failure of [false, true]) {
    const f = fixture(); let guard, revoked = 0, settle;
    const idle = new Promise((resolve, reject) => { settle = failure ? () => reject(new Error("uncertain native cleanup")) : resolve; });
    f.agent.whenIdle = () => idle;
    f.agent.ctx.tools = { guard(value) { guard = value; return () => { revoked++; }; } };
    const profile = { id: "b62c85c4-1775-42db-8a02-e21e165da8c2", name: "Jess", instructions: "Brief", route,
      speech: { stt: { engine: "whisper", model: "base.en" }, tts: { engine: "kokoro", model: "82m", voice: "af_heart" } }, tools: { mode: "allow", names: ["read"] } };
    const voice = await openNativeVoiceSession(f.ctx, route, { ...f.options, profile });
    profile.tools.names.push("shell");
    assert.equal(guard({ name: "read" }), undefined); assert.match(guard({ name: "shell" }), /disabled/);
    const closing = voice.close(); const again = voice.close();
    assert.equal(closing, again);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(revoked, 0);
    if (failure) {
      const rejected = assert.rejects(closing, /uncertain/); settle(); await rejected;
      await assert.rejects(voice.close(), /uncertain/); assert.equal(revoked, 0);
    } else { settle(); await closing; await voice.close(); assert.equal(revoked, 1); }
  }
});

test("task attachment follows native capability and cleans up when later voice setup fails", async () => {
  const f = fixture();
  const voice = await openNativeVoiceSession(f.ctx, route, { ...f.options, tasks: async () => undefined });
  assert.equal(f.count.hooks, 2, "No task persona when the native capability is absent");
  await voice.close();
  assert.equal(f.count.removed, 2);
  let detached = 0;
  const broken = fixture();
  await assert.rejects(openNativeVoiceSession(broken.ctx, route, {
    ...broken.options, tasks: async () => async () => { detached++; },
    presentations: { attach() { throw new Error("later setup failed"); } },
  }));
  assert.equal(detached, 1);
  assert.equal(broken.count.removed, broken.count.hooks);
});

test("barge-in retracts only its queued RPC or cancels its own open native turn", async () => {
  for (const scenario of ["queued", "claimed", "unrelated", "ended", "unclaimed"]) {
    const f = fixture(); let request, cancelled = 0, removed;
    let resolveIdle;
    const activity = new Promise(resolve => { resolveIdle = resolve; });
    f.agent.whenIdle = () => activity;
    f.agent.cancel = () => { cancelled++; };
    f.agent.inbox.remove = id => { removed = id; return true; };
    f.ctx.sessionController.prompt = async value => { request = value; };
    f.agent.session = { snapshotEvents: () => {
      const own = { type: "user/message", data: { source: { kind: "user", rpcId: request.requestId } } };
      const start = { type: "turn/start", data: { turn: 1 } };
      if (scenario === "claimed") return [start, own];
      if (scenario === "ended") return [start, own, { type: "turn/end" }];
      if (scenario === "unrelated") return [start, own, { type: "turn/end" }, start, { type: "user/message", data: { source: { kind: "plugin" } } }];
      return [start];
    } };
    const voice = await openNativeVoiceSession(f.ctx, route, f.options);
    const done = voice.speak(1, "Test", () => {});
    if (scenario === "queued") f.agent.inbox.nextTurn.push({ id: "ours", source: { kind: "user", rpcId: request.requestId } });
    f.agent.inbox.nextTurn.push({ id: "unrelated", source: { kind: "plugin" } });
    const stopped = voice.interrupt(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelled, scenario === "claimed" ? 1 : 0, scenario);
    assert.equal(removed, scenario === "queued" ? "ours" : undefined, scenario);
    resolveIdle(); await stopped; await done; await voice.close();
  }
});

test("voice route precedes native selection and cross-scope observation stays session-exact", async () => {
  const f = fixture(); let routeHook, observed;
  f.agent.ctx.on = (name, callback, options) => {
    assert.equal(name, "agent/request"); assert.equal(options.prepend, true);
    routeHook = callback; return () => {};
  };
  f.ctx.on = (name, callback, options) => {
    assert.equal(name, "session/event"); assert.equal(options.global, true);
    observed = callback; return () => {};
  };
  f.ctx.sessionController.prompt = async request => {
    const emit = (id, type, data) => observed({ header: { id } }, { type, data });
    emit(f.agent.id, "turn/start", { turn: 1 });
    emit(f.agent.id, "user/message", { source: { kind: "user", rpcId: request.requestId } });
    emit("unrelated", "assistant/chunk", { turn: 1, chunk: { type: "text-delta", text: "Must not leak" } });
    emit(f.agent.id, "assistant/chunk", { turn: 1, chunk: { type: "text-delta", text: "Owned answer" } });
    emit(f.agent.id, "turn/end", { turn: 1, reason: { kind: "completed" } });
  };
  const voice = await openNativeVoiceSession(f.ctx, route, f.options);
  const result = await routeHook({ agent: f.agent }, async () => ({ provider: "desktop", model: "default" }));
  assert.equal(result.provider, route.provider); assert.equal(result.model, route.model);
  const events = []; await voice.speak(1, "Synthetic", event => events.push(event));
  assert.deepEqual(events.map(event => event.text).filter(Boolean), ["Owned answer"]);
  assert.equal(events.at(-1).status, "completed");
  await voice.close();
});

test("direct native prompt admission receives its required cancellation signal", async () => {
  const f = fixture(); let admitted = false;
  f.ctx.sessionController.prompt = async (request, signal) => {
    signal.throwIfAborted();
    assert.ok(signal instanceof AbortSignal);
    assert.equal(request.mode, "queue");
    admitted = true;
  };
  const voice = await openNativeVoiceSession(f.ctx, route, f.options);
  await voice.speak(1, "Synthetic check", () => {});
  assert.equal(admitted, true);
  await voice.close();
});

test("history tools are scoped to voice and revoked before awaiting native shutdown", async () => {
  const f = fixture(); let tool, removed = false;
  f.agent.ctx.tools = { register(value) { tool = value; return () => { removed = true; }; } };
  const voice = await openNativeVoiceSession(f.ctx, route, { ...f.options, history: { view: () => ({ kind: "voice", saved: false }), save: async () => ({ kind: "voice", saved: true }) } });
  assert.equal(tool.name, "hub_save_conversation");
  const closing = voice.close(); assert.equal(removed, true);
  await assert.rejects(tool.execute({}, { agent: f.agent, signal: new AbortController().signal }));
  await closing;
});

test("voice attaches to the selected text chat without creating, renaming or archiving it", async () => {
  const f = fixture(); const voice = await openNativeVoiceSession(f.ctx, route, f.options);
  assert.equal(voice.sessionId, "existing-chat");
  assert.deepEqual(f.count, { created: 0, resumed: 1, renamed: 0, marked: 0, removed: 0, hooks: 2 });
  await voice.close(); assert.equal(f.count.removed, 2);
});

test("missing, invalid, mismatched and busy attachments never manufacture a new chat or install voice hooks", async () => {
  for (const failure of ["missing", "invalid", "mismatch", "running", "inbox"]) {
    const f = fixture();
    if (failure === "missing") f.ctx.sessionController.resolveAgent = async () => ({ error: new Error("private native details") });
    if (failure === "invalid") f.options.sessionId = "../unrelated";
    if (failure === "mismatch") f.agent.id = "another-chat";
    if (failure === "running") f.agent.status = "running";
    if (failure === "inbox") f.agent.inbox.nextTurn.push({ id: "unrelated-pending" });
    await assert.rejects(openNativeVoiceSession(f.ctx, route, f.options));
    assert.equal(f.count.created, 0); assert.equal(f.count.hooks, 0); assert.equal(f.count.renamed, 0);
  }
});

test("new voice-origin chat is classified before any conversation hooks activate", async () => {
  const f = fixture(); let createdHook = false;
  const voice = await openNativeVoiceSession(f.ctx, route, { created: async agent => { assert.equal(agent, f.agent); assert.equal(f.count.hooks, 0); createdHook = true; } });
  assert.equal(createdHook, true); assert.equal(f.count.created, 1); assert.equal(f.count.resumed, 0); assert.equal(f.count.renamed, 1);
  await voice.close();
});

test("an explicit voice effort affects only the active coordinator", async () => {
  const f = fixture(); let hook;
  f.agent.ctx.on = (_event, callback) => { hook = callback; return () => {}; };
  const voice = await openNativeVoiceSession(f.ctx, { ...route, reasoningEffort: "low" }, f.options);
  const normal = { provider: "desktop", model: "stronger", reasoningEffort: "high", maxTokens: 8192 };
  assert.equal((await hook({ agent: f.agent }, async () => normal)).reasoningEffort, "low");
  assert.equal(await hook({ agent: { id: "background-child" } }, async () => normal), normal);
  assert.equal(normal.reasoningEffort, "high"); await voice.close();
});

test("voice leaves room for structured visuals without changing desktop or child generation limits", async () => {
  const f = fixture(); let hook;
  f.agent.ctx.on = (_event, callback) => { hook = callback; return () => {}; };
  const voice = await openNativeVoiceSession(f.ctx, route, f.options);
  const native = { provider: "desktop-provider", model: "desktop-model", maxTokens: 2048, reasoningEffort: "high" };
  const config = await hook({ agent: f.agent }, async () => native);
  assert.equal(config.maxTokens, 4096);
  assert.equal(config.model, "voice"); assert.equal(config.reasoningEffort, undefined);
  assert.equal(native.maxTokens, 2048); assert.equal(native.provider, "desktop-provider");
  assert.equal(await hook({ agent: { id: "child" } }, async () => native), native);
  await voice.close();
});
