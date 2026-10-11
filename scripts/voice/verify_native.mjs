// Real DSH sessions and continuable-child lifecycle; synthetic model, no API key,
// microphone, private history, or live app is accessed by this verification.
import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openNativeVoiceSession } from "../../packages/harness-overlay/src/host/voice-session.ts";
import { openConversationHistory } from "../../packages/harness-overlay/src/host/conversation-history.ts";
import { PresentationRuntime } from "../../packages/harness-overlay/src/host/presentation.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixedTaskRoute = process.argv.includes("--fixed-task-route");
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
const load = path => import(pathToFileURL(resolve(vendor, "packages", path, "lib/index.js")));
const { default: LlmRuntime, LlmAdapter, createUserMessage } = await load("llm/llm");
const { default: Sessions } = await load("core/session");
const { default: Persistence } = await load("session/session-persistence-jsonl");
const { default: SessionQuery } = await load("session-query/session-query");
const { default: Projections } = await load("session/session-projection");
const { default: SystemPrompt } = await load("core/system-prompt");
const { default: Tools } = await load("core/tools");
const { default: Agents } = await load("core/agent");
const { default: AgentLoop } = await load("core/agent-loop");
const { default: Subagents } = await load("subagent/subagent");
const Spawn = await load("subagent/subagent-spawn-in-process");
const NativeSubagentTool = await load("subagent/tool-subagent");
const { default: TaskModelSettings } = await import(pathToFileURL(resolve(vendor, "packages/subagent/tool-subagent/lib/model-selection-settings.js")));
const { default: Storage } = await load("storage/storage");
const StorageJson = await load("storage/storage-json");
const StorageDomain = await load("storage/storage-domain");

const ctx = new Context(); const handles = []; const requests = [];
const testRoot = await mkdtemp(join(tmpdir(), "hub-voice-test-"));
let holdParent = false, holdChild = false, nextPresentation, nextSave = false;
let holdBackground = false, backgroundSignal, releaseBackground;
const backgroundGate = new Promise(resolve => { releaseBackground = resolve; });
const cancelledVoiceText = "Synthetic cancelled request: count seventeen blue triangles.";
let cancelledVoiceMessageId;
let releaseChild, childSignal;
const childGate = new Promise(resolve => { releaseChild = resolve; });
async function waitFor(check) {
  const until = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < until, "Native voice check timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
class SyntheticModel extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model }; }
  async *stream(options) {
    requests.push(options);
    if (holdBackground) {
      holdBackground = false; backgroundSignal = options.signal;
      await backgroundGate;
      options.signal.throwIfAborted();
    } else if (options.model === "child") {
      childSignal = options.signal;
      if (holdChild) await childGate;
    } else if (holdParent) {
      await new Promise(resolve => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener("abort", resolve, { once: true });
      });
      options.signal.throwIfAborted();
    }
    const text = options.model === "child" ? "Synthetic task completed." : "Hello from the native session.";
    if ((nextPresentation || nextSave) && options.model === "voice") {
      const name = nextSave ? "hub_save_conversation" : "hub_present";
      const args = nextSave ? {} : nextPresentation; nextPresentation = undefined; nextSave = false;
      const block = { type: "tool-call", id: `fixture-tool-${requests.length}`, name, arguments: JSON.stringify(args) };
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield { type: "tool-call-delta", index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
      yield { type: "block-end", index: 0, block };
      yield { type: "finish", reason: { kind: "tool-calls" } }; return;
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}
let voice, cold, history, coldHistory, savedId;
async function mountStorage(context) {
  await context.plugin(Storage);
  await context.plugin(StorageJson, { root: join(testRoot, "metadata") });
  await context.plugin(StorageDomain, { backend: "json" });
}
try {
  for (const plugin of [LlmRuntime, Sessions, Projections, SystemPrompt, Tools, Agents]) await ctx.plugin(plugin);
  await ctx.plugin(Persistence, { root: testRoot, compression: "none" });
  await ctx.plugin(SessionQuery);
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(Subagents);
  await ctx.plugin(Spawn, { providerName: "spawn" });
  await ctx.plugin(TaskModelSettings, { enabled: true, allowedModels: [{ provider: "voice-pilot", model: "child" }] });
  await mountStorage(ctx);
  history = await openConversationHistory(ctx.storageDomain);
  ctx.llm.registerAdapter(["voice-pilot", "default-pilot"], new SyntheticModel());
  // Controller command routing is a seam here; everything below it (agent,
  // scoped prompt/model hook, durable events and cancellation) is real DSH.
  const controller = {
    async create() {
      const handle = await ctx.agents.create({ sessionId: "hub-voice-native-pilot", meta: { cwd: root }, agentOptions: { provider: "default-pilot", model: "default" } });
      await handle.agent.ctx.plugin(NativeSubagentTool, { provider: "spawn", toolName: "subagent", backgroundMode: "continuable", modelSelectionSettings: !fixedTaskRoute,
        ...(fixedTaskRoute ? { agentOptions: { provider: "voice-pilot", model: "child" } } : {}) });
      handles.push(handle); return { sessionId: handle.agent.id };
    },
    async rename({ title }) { assert.equal(title, "Voice conversation"); },
    async resolveAgent(sessionId) { const agent = ctx.agents.get(sessionId); return agent ? { agent } : { error: new Error("No such synthetic native session") }; },
    async prompt(request) {
      ctx.agents.get(request.sessionId).followup(createUserMessage({
        source: { kind: "user", rpcId: request.requestId }, content: request.content,
      }));
    },
  };
  const voiceContext = { sessionController: controller, agents: ctx.agents, on: (...args) => ctx.on(...args) };
  const voiceRoute = { provider: "voice-pilot", model: "voice" };
  const { attachNativeVoiceTasks } = await import("../../packages/harness-overlay/src/host/voice-tasks.ts");
  voice = await openNativeVoiceSession(voiceContext, voiceRoute, {
    created: agent => history.markVoiceOrigin(agent.session),
    tasks: agent => attachNativeVoiceTasks(agent, fixedTaskRoute ? undefined : { provider: "voice-pilot", model: "child" }),
  });
  const output = [];
  await voice.speak(1, "Hello", event => output.push(event));
  assert.equal(output.filter(x => x.type === "text").map(x => x.text).join(""), "Hello from the native session.");
  assert.equal(output.at(-1).status, "completed");
  assert.equal(requests[0].provider, "voice-pilot");
  assert.equal(requests[0].model, "voice");
  assert.match(requests[0].system, /English voice mode/);
  const parent = ctx.agents.get(voice.sessionId);
  assert.deepEqual(history.view(parent.id), { kind: "voice", saved: false });
  assert.equal(parent.options.provider, "default-pilot", "Do not mutate the configured desktop default");
  assert.equal(parent.session.snapshotEvents().find(x => x.type === "user/message").data.source.kind, "user");
  console.log("PASS: native human turn, voice-scoped route and prompt, streaming, durable chat");

  holdChild = true;
  const taskResult = await parent.ctx.tools.execute({ name: "hub_task", callId: "native-voice-task-check",
    arguments: { description: "Synthetic independent task", prompt: "Synthetic task" },
    agent: parent, signal: new AbortController().signal });
  assert.ok(!taskResult.isError);
  const childId = taskResult.value?.kind === "continuable" ? taskResult.value.subagentId : undefined;
  assert.ok(childId, "Native tool must acknowledge a real child identity");
  const child = { childId };
  await waitFor(() => childSignal !== undefined);
  const conversational = [];
  await voice.speak(2, "What are you doing?", event => conversational.push(event));
  assert.equal(conversational.filter(event => event.type === "text").map(event => event.text).join(""), "Hello from the native session.");
  assert.equal(childSignal.aborted, false);
  assert.ok(ctx.agents.get(childId), "A complete spoken follow-up must finish while the child is still running");
  const foregroundAttempt = await parent.ctx.tools.execute({ name: "subagent", callId: "foreground-bypass",
    arguments: { description: "Must not wait", prompt: "Synthetic", run_in_background: false }, agent: parent, signal: new AbortController().signal });
  assert.equal(foregroundAttempt.isError, true); assert.match(foregroundAttempt.error.message, /Keep voice responsive/);
  console.log("PASS: completed spoken follow-up while child remains in flight; foreground delegation rejected");
  holdParent = true;
  const before = requests.length;
  const turn = voice.speak(3, "Keep talking", event => output.push(event));
  await waitFor(() => requests.length > before);
  await voice.interrupt(3); await turn;
  assert.equal(output.at(-1).status, "aborted");
  assert.equal(childSignal.aborted, false, "Interrupting speech must not abort an admitted continuable child");
  await voice.close();
  assert.equal(ctx.agents.get(parent.id), parent, "Ending audio must preserve the native parent/chat");
  assert.equal(parent.ctx.tools.get("hub_task", parent), undefined, "Voice close removes its task tool registration");
  assert.ok(parent.ctx.tools.get("subagent", parent), "Voice close leaves the original native tool intact");
  assert.equal(childSignal.aborted, false);
  holdParent = false;
  releaseChild();
  await waitFor(() => ctx.sessions.get(child.childId)?.snapshotEvents().some(x => x.type === "turn/end" && x.data.reason.kind === "completed") || !ctx.agents.get(child.childId));
  await waitFor(() => parent.session.snapshotEvents().some(x => x.type === "user/message" && x.data.source.kind === "subagent-settled"));
  await parent.whenIdle();
  console.log("PASS: real continuable child survives voice interruption/close and delivers native settlement");

  const childrenBeforeDenied = requests.filter(item => item.model === "child").length;
  if (fixedTaskRoute) {
    await assert.rejects(attachNativeVoiceTasks(parent, { provider: "voice-pilot", model: "not-allowed" }), /requires native subagent model selection/);
    console.log("PASS: absent optional task route uses native child defaults; explicit unsupported routing fails loudly");
  } else {
  const offDenied = await attachNativeVoiceTasks(parent, { provider: "voice-pilot", model: "not-allowed" });
  const denied = await parent.ctx.tools.execute({ name: "hub_task", callId: "native-voice-task-denied",
    arguments: { description: "Denied synthetic task", prompt: "Must not run" }, agent: parent, signal: new AbortController().signal });
  assert.equal(denied.isError, true, "Alias must respect the native model allowlist");
  assert.match(denied.error.message, /not allowed|not authorized/i);
  assert.equal(requests.filter(item => item.model === "child").length, childrenBeforeDenied);
  assert.equal(requests.some(item => item.model === "not-allowed"), false);
  await offDenied();
  }
  const restricted = await ctx.agents.create({ sessionId: "hub-voice-no-delegation", meta: { cwd: root }, agentOptions: { provider: "default-pilot", model: "default" } });
  handles.push(restricted);
  assert.equal(await attachNativeVoiceTasks(restricted.agent, { provider: "voice-pilot", model: "child" }), undefined);
  assert.equal(restricted.agent.ctx.tools.get("hub_task", restricted.agent), undefined);
  console.log("PASS: native model policy refuses an unauthorized route; voice grants no delegation to a preset without it");

  // Keep a text fact in the SAME native history between voice attachments.
  await controller.prompt({ sessionId: parent.id, requestId: "synthetic-typed-turn", content: [{ type: "text", text: "My synthetic project is named Lantern." }] });
  await parent.whenIdle();
  const createdBefore = handles.length;
  voice = await openNativeVoiceSession(voiceContext, voiceRoute, { sessionId: parent.id, created: async () => { throw new Error("Attachment must not reclassify an existing chat"); } });
  await voice.speak(1, "Continue discussing Lantern", event => output.push(event));
  assert.equal(handles.length, createdBefore);
  assert.match(JSON.stringify(requests.at(-1).messages), /My synthetic project is named Lantern/);
  const ownPromptIds = parent.session.snapshotEvents().filter(x => x.type === "user/message" && x.data.source?.rpcId?.startsWith("hub-voice:")).map(x => x.data.source.rpcId);
  assert.equal(new Set(ownPromptIds).size, ownPromptIds.length);
  assert.equal(history.view(parent.id).saved, false);
  await voice.close();
  console.log("PASS: typed and spoken turns share native context across voice reattachment; request receipts remain unique");

  // Real native inbox insertion/removal, while unrelated work owns the turn.
  // The command remains in the native audit log but must never reach an LLM.
  const queueHandle = await ctx.agents.create({ sessionId: "hub-voice-queued-cancel", meta: { cwd: root }, agentOptions: { provider: "default-pilot", model: "default" } });
  handles.push(queueHandle);
  const queueAgent = queueHandle.agent;
  await history.markVoiceOrigin(queueAgent.session);
  voice = await openNativeVoiceSession(voiceContext, voiceRoute, { sessionId: queueAgent.id });
  holdBackground = true;
  await controller.prompt({ sessionId: queueAgent.id, requestId: "synthetic-background-owner", content: [{ type: "text", text: "Synthetic unrelated work owns this turn." }] });
  await waitFor(() => backgroundSignal !== undefined);
  const queueOutput = [], requestCount = requests.length;
  const queuedTurn = voice.speak(1, cancelledVoiceText, event => queueOutput.push(event));
  await waitFor(() => queueAgent.inbox.nextTurn.some(message => message.source.rpcId?.startsWith("hub-voice:")));
  cancelledVoiceMessageId = queueAgent.inbox.nextTurn.find(message => message.source.rpcId?.startsWith("hub-voice:")).id;
  const interruptedQueue = voice.interrupt(1);
  await waitFor(() => queueAgent.inbox.nextTurn.length === 0);
  assert.equal(backgroundSignal.aborted, false, "Retracting queued voice input cannot cancel unrelated running work");
  assert.equal(requests.length, requestCount, "Cancelled queued input must not start a request");
  releaseBackground(); await interruptedQueue; await queuedTurn;
  assert.equal(queueOutput.at(-1).status, "aborted");
  const cancellationEvents = queueAgent.session.snapshotEvents();
  assert.ok(cancellationEvents.some(event => event.type === "agent/inbox/spliced" && event.data.inserted.some(message => message.id === cancelledVoiceMessageId && JSON.stringify(message.content).includes(cancelledVoiceText))));
  assert.ok(cancellationEvents.some(event => event.type === "agent/inbox/spliced" && event.data.outcome === "canceled"));
  assert.equal(cancellationEvents.some(event => event.type === "user/message" && event.data.id === cancelledVoiceMessageId), false);
  await voice.speak(2, "Continue with a new synthetic question.", () => {});
  assert.equal(JSON.stringify(requests.at(-1).messages).includes(cancelledVoiceText), false, "Cancelled instructions must not enter later model context");
  await voice.close();
  console.log("PASS: real native queue cancellation preserves original text and cancellation audit without executing/replaying it or stopping unrelated work");

  if (process.argv.includes("--browser")) {
    const index = process.argv.indexOf("--browser");
    const python = process.argv[index + 1], playwright = process.argv[index + 2];
    assert.ok(python && playwright, "Pass Python executable and Playwright module directory after --browser");
    const { verifyBrowserNative } = await import("./verify_browser_native.mjs");
    await verifyBrowserNative({ ctx, voiceContext, voiceRoute, sessionId: parent.id, root, python, playwright, requests, queuePresentation: input => { nextPresentation = input; } });
    await parent.whenIdle();
  }

  if (process.argv.includes("--presentation-browser")) {
    const playwright = process.argv[process.argv.indexOf("--presentation-browser") + 1];
    const runtime = new PresentationRuntime();
    voice = await openNativeVoiceSession(voiceContext, voiceRoute, { sessionId: parent.id, presentations: runtime });
    assert.equal(ctx.tools.schemas().some(tool => tool.name === 'hub_present'), false, 'visual tool must not enter the global desktop registry');
    assert.equal(ctx.tools.schemas(parent).some(tool => tool.name === 'hub_present'), true);
    const { verifyPresentationBrowser } = await import("./verify_presentation_browser.mjs");
    let sequence = 1;
    await verifyPresentationBrowser({ root, playwright, runtime, sessionId: parent.id, async publish(input) {
      nextPresentation = input;
      await voice.speak(sequence++, "Explain this with a visual.", () => {});
      assert.equal(runtime.summary(parent.id)?.title, input.title, "the native model/tool loop must publish the requested visual");
    } });
    await voice.close();
    assert.equal(runtime.summary(parent.id), null);
    assert.equal(ctx.tools.schemas(parent).some(tool => tool.name === 'hub_present'), false, 'voice close must revoke the scoped visual tool');
  }

  // Explicit voice-command promotion through a real scoped native tool loop.
  // Keep the original unsaved parent for the separate cold/UI Save check below.
  const saveHandle = await ctx.agents.create({ sessionId: "hub-voice-save-pilot", meta: { cwd: root }, agentOptions: { provider: "default-pilot", model: "default" } });
  handles.push(saveHandle); savedId = saveHandle.agent.id;
  await history.markVoiceOrigin(saveHandle.agent.session);
  voice = await openNativeVoiceSession(voiceContext, voiceRoute, { sessionId: savedId, history });
  assert.equal(ctx.tools.schemas().some(tool => tool.name === "hub_save_conversation"), false);
  assert.equal(ctx.tools.schemas(saveHandle.agent).some(tool => tool.name === "hub_save_conversation"), true);
  let saveSequence = 1;
  const promote = async () => {
    nextSave = true; const events = [];
    await voice.speak(saveSequence++, "Please save this whole voice conversation as a normal chat.", event => events.push(event));
    assert.ok(events.some(event => event.type === "tool-start" && event.name === "hub_save_conversation"));
    assert.ok(events.some(event => event.type === "tool-end" && event.status === "completed"));
    assert.equal(history.view(savedId).saved, true);
    return events;
  };
  if (process.argv.includes("--save-browser")) {
    const playwright = process.argv[process.argv.indexOf("--save-browser") + 1];
    const { verifySaveBrowser } = await import("./verify_save_browser.mjs");
    await verifySaveBrowser({ root, playwright, history, sessionId: savedId, promote });
  } else await promote();
  await promote(); // Repeated explicit requests remain idempotent.
  await voice.close();
  assert.equal(ctx.tools.schemas(saveHandle.agent).some(tool => tool.name === "hub_save_conversation"), false);
  const saveEvents = saveHandle.agent.session.snapshotEvents();
  assert.ok(saveEvents.some(event => event.type === "tool/result" && JSON.stringify(event.data).includes("already-saved")));
  console.log("PASS: explicit Save executes through native scoped tool loop, is idempotent, and is revoked on voice close");

  // Actual persistence flush -> a NEW context -> cold native observation.
  // Native JSONL, projection fold and source events, not a mock JSON round trip.
  await Promise.all(handles.map(handle => handle.dispose()));
  await history.close();
  await ctx.fiber.dispose();
  cold = new Context();
  for (const plugin of [Sessions, Projections]) await cold.plugin(plugin);
  await mountStorage(cold);
  coldHistory = await openConversationHistory(cold.storageDomain);
  assert.deepEqual(coldHistory.view(savedId), { kind: "voice", saved: true });
  await cold.plugin(Persistence, { root: testRoot, compression: "none" });
  await cold.plugin(SessionQuery);
  using savedObservation = await cold.sessionQuery.observeSession(savedId, { projectionMode: "all" });
  assert.ok(savedObservation.events.some(event => event.type === "tool/result" && JSON.stringify(event.data).includes("hub-voice-save-pilot")));
  using voiceObservation = await cold.sessionQuery.observeSession(parent.id, { projectionMode: "all" });
  assert.deepEqual(coldHistory.view(voiceObservation.header.id), { kind: "voice", saved: false });
  using childObservation = await cold.sessionQuery.observeSession(child.childId, { projectionMode: "all" });
  assert.deepEqual(coldHistory.view(childObservation.header.id, childObservation.header.origin), { kind: "task", saved: true });
  console.log("PASS: cold durable voice archive classification survives restart; delegated task remains a normal visible chat");

  // Native domain promotion persists separately; transcript remains byte-for-byte.
  const transcript = cold.sessionPersistence.locate(voiceObservation.header).path;
  const previousFile = await readFile(transcript, "utf8");
  if (process.argv.includes("--history-browser")) {
    const playwright = process.argv[process.argv.indexOf("--history-browser") + 1];
    assert.ok(playwright, "Pass Playwright module directory after --history-browser");
    const { verifyHistoryBrowser } = await import("./verify_history_browser.mjs");
    await verifyHistoryBrowser({ history: coldHistory, observations: [voiceObservation, childObservation], playwright, root });
  } else await coldHistory.save(parent.id);
  assert.equal(await readFile(transcript, "utf8"), previousFile);
  await coldHistory.close(); coldHistory = await openConversationHistory(cold.storageDomain);
  assert.deepEqual(coldHistory.view(parent.id), { kind: "voice", saved: true });
  console.log("PASS: Save conversation promotes native voice history without deleting or rewriting original turns");

  // Actual cold resume, not just JSON inspection: cancelled inbox work must not
  // become runnable again and subsequent requests must exclude its command.
  for (const plugin of [LlmRuntime, SystemPrompt, Tools, Agents]) await cold.plugin(plugin);
  await cold.plugin(AgentLoop, { agents: [] });
  cold.llm.registerAdapter(["voice-pilot", "default-pilot"], new SyntheticModel());
  const resumedQueue = await cold.agents.resume({ resumeSessionId: "hub-voice-queued-cancel", agentOptions: { provider: "default-pilot", model: "default" } });
  try {
    assert.equal(resumedQueue.agent.inbox.hasPending, false);
    const replayed = resumedQueue.agent.session.snapshotEvents();
    assert.ok(replayed.some(event => event.type === "agent/inbox/spliced" && event.data.inserted.some(message => message.id === cancelledVoiceMessageId && JSON.stringify(message.content).includes(cancelledVoiceText))));
    assert.ok(replayed.some(event => event.type === "agent/inbox/spliced" && event.data.outcome === "canceled"));
    const beforeResumedRequest = requests.length;
    resumedQueue.agent.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "A new question after restart." }] }));
    await resumedQueue.agent.whenIdle();
    assert.ok(requests.length > beforeResumedRequest, "A real post-resume model request must execute");
    assert.ok(JSON.stringify(requests.at(-1).messages).includes("A new question after restart."));
    assert.equal(JSON.stringify(requests.at(-1).messages).includes(cancelledVoiceText), false);
    console.log("PASS: cold native resume retains cancelled voice transcript evidence, restores no pending command and excludes it from the next LLM request");
  } finally { await resumedQueue.dispose(); }
} finally {
  releaseBackground();
  releaseChild();
  await voice?.close();
  await Promise.all(handles.map(handle => handle.dispose()));
  await ctx.fiber.dispose();
  await coldHistory?.close();
  await cold?.fiber.dispose();
  assert.equal(dirname(resolve(testRoot)), resolve(tmpdir()));
  assert.ok(basename(testRoot).startsWith("hub-voice-test-"));
  await rm(testRoot, { recursive: true, force: true });
}
