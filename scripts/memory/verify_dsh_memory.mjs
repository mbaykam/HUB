// Real DSH tool registry -> upstream MCP plugin -> isolated Basic Memory server.
// Called only by verify_basic_memory.py with a disposable configuration directory.
import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { completedMemoryTurn } from "../../packages/harness-overlay/src/host/memory-capture.ts";
import { installMemoryLifecycle } from "../../packages/harness-overlay/src/host/memory-lifecycle.ts";
import { createMemoryReflection } from "../../packages/harness-overlay/src/host/memory-reflection.ts";
import { createMemoryGenerator } from "../../packages/harness-overlay/src/host/memory-worker.ts";
import { createMemoryGraph } from "../../packages/harness-overlay/src/host/memory-graph.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const vendor = resolve(root, "vendor/deepseek-harness");
// The product checkout includes built workspaces without every pnpm symlink.
// Resolve only their declared public JS entry points; never mix source copies.
const workspaceEntries = new Map();
for (const group of await readdir(resolve(vendor, "packages"), { withFileTypes: true })) {
  if (!group.isDirectory()) continue;
  for (const pkg of await readdir(resolve(vendor, "packages", group.name), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const directory = resolve(vendor, "packages", group.name, pkg.name);
    let manifest;
    try { manifest = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const entry = manifest.exports?.["."]?.default ?? manifest.main;
    if (entry?.endsWith(".js")) workspaceEntries.set(manifest.name, pathToFileURL(resolve(directory, entry)).href);
  }
}
registerHooks({ resolve(specifier, context, next) { return next(workspaceEntries.get(specifier) ?? specifier, context); } });
const requireDsh = createRequire(resolve(vendor, "package.json"));
const { Context } = await import(pathToFileURL(requireDsh.resolve("@deepseek-ai/cordis")));
const { default: SystemPrompt } = await import(pathToFileURL(resolve(vendor, "packages/core/system-prompt/lib/index.js")));
const { default: ToolRuntime } = await import(pathToFileURL(resolve(vendor, "packages/core/tools/lib/index.js")));
const McpClient = await import(pathToFileURL(resolve(vendor, "packages/mcp/mcp-client/lib/index.js")));
const { default: SessionStore } = await import(pathToFileURL(resolve(vendor, "packages/core/session/lib/index.js")));
const { default: JsonlPersistence } = await import(pathToFileURL(resolve(vendor, "packages/session/session-persistence-jsonl/lib/index.js")));
const { apply: applyMemoryHost } = await import(new URL(process.argv.some(arg => ["--graph-browser", "--topics-model"].includes(arg)) ? "../../packages/harness-overlay/lib/memory.js" : "../../packages/harness-overlay/src/memory.ts", import.meta.url));
const { default: Projections } = await import(pathToFileURL(resolve(vendor, "packages/session/session-projection/lib/index.js")));
const { default: Agents } = await import(pathToFileURL(resolve(vendor, "packages/core/agent/lib/index.js")));
const { default: AgentLoop } = await import(pathToFileURL(resolve(vendor, "packages/core/agent-loop/lib/index.js")));
const { default: LlmRuntime, LlmAdapter, createUserMessage } = await import(pathToFileURL(resolve(vendor, "packages/llm/llm/lib/index.js")));
const [command, configDirectory, modelCheck, dshHome, hostRoot] = process.argv.slice(2);
if (modelCheck !== undefined) assert.ok(["--model-check", "--graph-browser", "--topics-only", "--topics-model"].includes(modelCheck));
assert.ok(command && configDirectory, "Run through verify_basic_memory.py, not against a personal vault");
const config = JSON.parse(await readFile(resolve(configDirectory, "config.json"), "utf8"));
assert.equal(config.default_project, "hub-memory-pilot");
assert.equal(config.semantic_search_enabled, false);
assert.equal(config.projects["hub-memory-pilot"].mode, "local");

const ctx = new Context();
let memory;
try {
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(JsonlPersistence, { root: resolve(configDirectory, "dsh-sessions"), compression: "none" });
  await ctx.plugin(Projections);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(Agents);
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(McpClient, {
    serverName: "hub_memory", transport: "stdio", command, args: ["mcp"],
    cwd: configDirectory,
    env: {
      BASIC_MEMORY_CONFIG_DIR: configDirectory,
      USERPROFILE: resolve(configDirectory, "../profile"),
      LOCALAPPDATA: resolve(configDirectory, "../profile/AppData/Local"),
      APPDATA: resolve(configDirectory, "../profile/AppData/Roaming"),
      BASIC_MEMORY_SEMANTIC_SEARCH_ENABLED: "false",
      BASIC_MEMORY_LOGFIRE_ENABLED: "false",
      HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1",
      LITELLM_LOCAL_MODEL_COST_MAP: "True", DO_NOT_TRACK: "1", PYTHONUTF8: "1",
      FASTMCP_CHECK_FOR_UPDATES: "off", FASTMCP_SHOW_SERVER_BANNER: "false",
    },
    failOnStartupError: true, toolCallTimeoutMs: 30_000,
    reconnect: { enabled: false },
  });
  assert.ok(ctx.tools.get("mcp__hub_memory__write_note"));
  let sequence = 0;
  async function call(name, args) {
    const result = await ctx.tools.execute({
      name: `mcp__hub_memory__${name}`, arguments: { project: "hub-memory-pilot", ...args },
      callId: `hub-memory-pilot-${++sequence}`, signal: AbortSignal.timeout(30_000),
    });
    assert.equal(result.isError, false, JSON.stringify(result.content));
    return result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  }
  if (modelCheck === "--topics-only") {
    const { verifyTopicNotes } = await import("./verify_topic_notes.mjs");
    await verifyTopicNotes(call);
  } else if (modelCheck === "--topics-model") {
    const { verifyTopicModel } = await import("./verify_topic_model.mjs");
    await verifyTopicModel({ ctx, call, vendor, dshHome, hostRoot, configDirectory, vault: config.projects["hub-memory-pilot"].path, LlmAdapter, createUserMessage, applyMemoryHost });
  } else {
  const note = completedMemoryTurn({ header: { id: "synthetic-dsh-pilot" }, events: [
    { type: "turn/start", data: { turn: 0 } },
    { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "I prefer concise answers." }] } },
    { type: "assistant/message", data: { turn: 0, message: { content: [{ type: "text", text: "Understood." }] } } },
    { type: "turn/end", data: { turn: 0, reason: { kind: "completed" } } },
  ] }, 0);
  assert.ok(note);
  await call("write_note", note);
  const identifier = `sessions/${note.title}`;
  assert.match(await call("read_note", { identifier }), /I prefer concise answers/);
  await call("edit_note", { identifier, operation: "find_replace", find_text: "concise answers", content: "detailed answers" });
  const duplicate = await ctx.tools.execute({
    name: "mcp__hub_memory__write_note", arguments: { project: "hub-memory-pilot", ...note, output_format: "json" },
    callId: `hub-memory-pilot-${++sequence}`, signal: AbortSignal.timeout(30_000),
  });
  // Basic Memory returns a domain conflict inside a successful MCP response.
  // Never use the transport isError flag alone to acknowledge capture.
  assert.equal(duplicate.isError, false);
  const conflict = JSON.parse(duplicate.content.filter(block => block.type === "text").map(block => block.text).join("\n"));
  assert.equal(conflict.action, "conflict");
  assert.equal(conflict.error, "NOTE_ALREADY_EXISTS");
  assert.match(await call("read_note", { identifier }), /detailed answers/);
  await call("delete_note", { identifier });
  console.log("PASS: native DSH registry and MCP bridge capture/read/correct/reject duplicate/delete");

  // Actual indexed Markdown relations, not an invented graph response. Only
  // the upstream external UUIDs may identify nodes and link endpoints.
  await call("write_note", { title: "Graph Project", directory: "projects", content: "# Graph Project\nA synthetic project.", output_format: "json" });
  await call("write_note", { title: "Graph Person", directory: "people", content: "# Graph Person\n\n## Relations\n- works_on [[Graph Project]]\n", output_format: "json" });
  const graphApi = createMemoryGraph({ call: async (tool, args) => JSON.parse(await call(tool, args)) });
  let realGraph;
  for (let attempt = 0; attempt < 30; attempt++) {
    realGraph = await graphApi.page(1, AbortSignal.timeout(30_000));
    if (realGraph.edges.some(edge => edge.label === "works_on")) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const person = realGraph.nodes.find(node => node.title === "Graph Person");
  const projectNode = realGraph.nodes.find(node => node.title === "Graph Project");
  assert.ok(person && projectNode, "Real graph must include both saved notes");
  assert.ok(realGraph.edges.some(edge => edge.source === person.id && edge.target === projectNode.id && edge.label === "works_on"), "Exact typed native relationship missing");
  const openedNote = await graphApi.note(person.id, AbortSignal.timeout(30_000));
  assert.match(openedNote.content, /works_on \[\[Graph Project\]\]/);
  assert.equal(openedNote.title, "Graph Person");
  assert.ok(realGraph.nodes.every(node => !/^(sessions|control)\//.test(node.permalink)));
  console.log("PASS: real Basic Memory graph -> exact UUID relationship -> original editable Markdown note");

  // Real DSH turns and middleware; only model generation is scripted. No paid API.
  const requests = [];
  let pilotReply = "Synthetic reply.";
  class PilotModel extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model }; }
    async *stream(options) {
      requests.push(options);
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: pilotReply };
      yield { type: "block-end", index: 0, block: { type: "text", text: pilotReply } };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  }
  ctx.llm.registerAdapter(["hub-pilot"], new PilotModel());
  const reports = [];
  memory = installMemoryLifecycle(ctx, {
    execute: ({ sessionId, ...request }) => {
      const agent = ctx.agents.get(sessionId);
      assert.ok(agent, "Memory must not fall back to unscoped authority after agent disposal");
      return agent.ctx.tools.execute({ ...request, agent });
    },
    message: text => createUserMessage({ source: { kind: "plugin", plugin: "hub-memory" }, content: [{ type: "text", text }] }),
    report: event => reports.push(event),
  }, { project: "hub-memory-pilot", captureTimeoutMs: 5000, recallTimeoutMs: 3000 });
  async function turn(id, text, setup) {
    const agent = ctx.agentLoop.create(id, { provider: "hub-pilot", model: "scripted" });
    setup?.(agent);
    agent.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text }] }));
    await agent.whenIdle();
    await memory.drain();
    assert.equal(agent.session.snapshotEvents().at(-1).data.reason.kind, "completed");
    return agent;
  }
  const first = await turn("hub-lifecycle-first", "I prefer amber tea.");
  const evidence = completedMemoryTurn({ header: first.session.header, events: first.session.snapshotEvents() }, 1);
  assert.ok(evidence);
  assert.match(await call("read_note", { identifier: `sessions/${evidence.title}` }), /amber tea/);
  // This note is deliberately seeded: automatic fact extraction is NOT under test.
  await call("write_note", { title: "Tea preference", directory: "memories", note_type: "hub-memory", content: "The synthetic user prefers violet tea." });
  // The index is asynchronous. Test recall after this synthetic fixture is
  // searchable; do not conflate index publication with the recall deadline.
  const searchDeadline = Date.now() + 15_000;
  while (true) {
    // Recall asks for entities, not observation hits. A newly indexed
    // observation alone must not satisfy this readiness gate.
    const found = JSON.parse(await call("search_notes", { query: '"tea"', note_types: ["hub-memory"], entity_types: ["entity"], search_type: "text", output_format: "json" }));
    if (found.results.some(hit => hit.permalink.endsWith("/tea-preference"))) break;
    assert.ok(Date.now() < searchDeadline, "Curated fixture did not reach the Basic Memory index");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const second = await turn("hub-lifecycle-second", "What tea do I prefer?");
  assert.match(JSON.stringify(requests.at(-1).messages), /violet tea/, JSON.stringify(reports));
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /amber tea/);
  assert.ok(second.session.snapshotEvents().some(event => event.type === "user/message" && event.data.source.plugin === "hub-memory"));
  const secondEvidence = completedMemoryTurn({ header: second.session.header, events: second.session.snapshotEvents() }, 1);
  assert.doesNotMatch(secondEvidence.content, /violet tea/);
  await call("edit_note", { identifier: "memories/tea-preference", operation: "find_replace", find_text: "violet tea", content: "silver tea" });
  await turn("hub-lifecycle-third", "What tea do I prefer?");
  assert.match(JSON.stringify(requests.at(-1).messages), /silver tea/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /violet tea/);
  await call("delete_note", { identifier: "memories/tea-preference" });
  await turn("hub-lifecycle-fourth", "What tea do I prefer?");
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /silver tea|violet tea|amber tea/);
  assert.deepEqual(reports, []);
  {
    const denied = await turn("hub-lifecycle-denied", "This capture must be denied.", agent => {
      agent.ctx.tools.restrict({ deny: ["mcp__hub_memory__write_note"] });
    });
    const deniedNote = completedMemoryTurn({ header: denied.session.header, events: denied.session.snapshotEvents() }, 1);
    const deniedSearch = JSON.parse(await call("search_notes", { query: deniedNote.title, search_type: "title", output_format: "json" }));
    assert.equal(deniedSearch.results.length, 0);
    assert.deepEqual(reports, ["capture-failed"]);
  }
  console.log("PASS: real DSH completed-turn capture, cross-session recall, current edits and deletion exclusion (scripted model, no reflection)");

  const workerIds = [];
  // Full deployments require cwd in their persona section; a no-tool worker
  // must still be a fully formed native session.
  const offPersona = ctx.systemPrompt.section({ name: "memory-test:deployment-persona", order: 0, text: "Working directory: {{cwd}}" });
  const generate = createMemoryGenerator({
    create: options => { workerIds.push(options.sessionId); return ctx.agents.create(options); },
    message: text => createUserMessage({ source: { kind: "plugin", plugin: "hub-memory-reflection" }, content: [{ type: "text", text }] }),
  }, { provider: "hub-pilot", model: "scripted" });
  const reflectionStore = { call: async (name, args) => {
    const result = JSON.parse(await call(name, { ...args, output_format: "json" }));
    return result;
  } };
  const reflection = createMemoryReflection(reflectionStore, generate);
  const reflectionSignal = AbortSignal.timeout(60_000);
  await reflection.initialize(reflectionSignal);
  pilotReply = "# Personal memory\n\n- The synthetic user prefers amber tea.";
  assert.equal(await reflection.reflect({ id: "reflection-first", completedAt: 100, content: "User: I prefer amber tea." }, reflectionSignal), "updated");
  pilotReply = "# Personal memory\n\n- The synthetic user now prefers violet tea.";
  assert.equal(await reflection.reflect({ id: "reflection-second", completedAt: 200, content: "User: Actually, I prefer violet tea now." }, reflectionSignal), "updated");
  assert.doesNotMatch(await call("read_note", { identifier: "memories/personal-memory" }), /amber tea/);
  await reflection.forget("- The synthetic user now prefers violet tea.", 300, reflectionSignal);
  const restartedReflection = createMemoryReflection(reflectionStore, async () => { throw new Error("Retired evidence reached model"); });
  assert.equal(await restartedReflection.reflect({ id: "unseen-old-source", completedAt: 250, content: "User: I prefer violet tea." }, reflectionSignal), "excluded");
  assert.doesNotMatch(await call("read_note", { identifier: "memories/personal-memory" }), /violet tea/);
  assert.ok(workerIds.every(id => ctx.agents.get(id) === undefined), "Reflection workers must dispose their scopes");
  console.log("PASS: native restricted reflection worker, Basic Memory merge/forget, and persisted old-evidence exclusion");
  offPersona();
  // The production installer, not a manually invoked reflection: a real user
  // turn triggers capture -> restricted native worker -> Markdown -> new chat.
  await memory.dispose(); memory = undefined;
  let route;
  const hostDisposers = [];
  const activation = Date.now();
  const missed = await ctx.agents.create({ sessionId: "hub-recovery-source", agentOptions: { provider: "hub-pilot", model: "scripted" } });
  missed.agent.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "I prefer mint tea." }] }));
  await missed.agent.whenIdle();
  await missed.dispose();
  applyMemoryHost({
    on: (...args) => ctx.on(...args), agents: ctx.agents, tools: ctx.tools,
    effect: callback => hostDisposers.push(callback()),
    connection: { requestRejection: () => undefined },
    webServer: { register(value) { route = value; return () => {}; } },
  }, { project: "hub-memory-pilot", provider: "hub-pilot", model: "scripted", captureSince: activation });
  async function waitFor(predicate, label) {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error(`Timed out: ${label}`);
  }
  async function snapshot() {
    let value;
    await route.handler({ method: "GET", headers: {} }, { writeHead() {}, end(text) { value = JSON.parse(text); } });
    return value;
  }
  try {
    await waitFor(async () => (await snapshot()).status === "ready", "production host ready");
    pilotReply = "# Personal memory\n\n- The synthetic user prefers mint tea.";
    const restored = await ctx.agents.resume({ resumeSessionId: "hub-recovery-source", agentOptions: { provider: "hub-pilot", model: "scripted" } });
    await waitFor(async () => /mint tea/.test((await snapshot()).content ?? ""), "native JSONL resume recovery");
    await restored.dispose();
    pilotReply = "# Personal memory\n\n- The synthetic user prefers lemon tea.";
    const source = await ctx.agents.create({ sessionId: "hub-production-source", agentOptions: { provider: "hub-pilot", model: "scripted" } });
    source.agent.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "Actually I prefer lemon tea now." }] }));
    await source.agent.whenIdle();
    await waitFor(async () => /lemon tea/.test((await snapshot()).content ?? ""), "automatic production reflection");
    const reader = await ctx.agents.create({ sessionId: "hub-production-reader", agentOptions: { provider: "hub-pilot", model: "scripted" } });
    reader.agent.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "What tea do I like?" }] }));
    await reader.agent.whenIdle();
    assert.ok(requests.some(request => JSON.stringify(request.messages).includes("Retrieved personal notes") && JSON.stringify(request.messages).includes("lemon tea")));
    await Promise.all([source.dispose(), reader.dispose()]);
    console.log("PASS: production host automatically captures, reflects and recalls; native persisted-session resume recovers a missed capture");
    if (modelCheck === "--graph-browser") {
      // More notes than one graph page, all synthetic and inside this fixture.
      // Search must reach a body-only term from a note absent from the preview.
      for (let index = 0; index < 55; index++) {
        const suffix = String(index).padStart(3, "0");
        await call("write_note", { title: `Vault fixture ${suffix}`, directory: "notes", content: `# Vault fixture ${suffix}\n\nBody-only search token hubcontenttoken${suffix}.`, output_format: "json" });
      }
      const firstPage = await graphApi.page(1, AbortSignal.timeout(30_000));
      const missing = Array.from({ length: 55 }, (_, index) => String(index).padStart(3, "0")).find(suffix => !firstPage.nodes.some(node => node.title === `Vault fixture ${suffix}`));
      assert.ok(missing, "Fixture must contain a note beyond the first graph page");
      const searchTarget = { title: `Vault fixture ${missing}`, query: `hubcontenttoken${missing}` };
      const found = await graphApi.search(searchTarget.query, 1, AbortSignal.timeout(30_000));
      assert.deepEqual(found.nodes.map(node => node.title), [searchTarget.title]);
      let searchFirst, searchSecond, stablePages = 0, lastPages = "";
      await waitFor(async () => {
        searchFirst = await graphApi.search("Vault fixture", 1, AbortSignal.timeout(30_000));
        searchSecond = await graphApi.search("Vault fixture", 2, AbortSignal.timeout(30_000));
        const count = new Set([...searchFirst.nodes, ...searchSecond.nodes].map(node => node.id)).size;
        const signature = JSON.stringify([searchFirst.nodes.map(node => node.id), searchSecond.nodes.map(node => node.id)]);
        const complete = count === 55 && searchFirst.nodes.length + searchSecond.nodes.length === 55 && searchFirst.hasMore && !searchSecond.hasMore;
        stablePages = complete && signature === lastPages ? stablePages + 1 : 0; lastPages = signature;
        return stablePages >= 2;
      }, "all newly written fixture notes become searchable");
      const rawSearch = JSON.parse(await call("search_notes", { query: '"Vault" AND "fixture"', search_type: "text", entity_types: ["entity"], page: 1, page_size: 50, search_all_projects: false, output_format: "json" }));
      console.log(JSON.stringify({ rawSearchHits: rawSearch.results.length, rawUniqueNotes: new Set(rawSearch.results.map(node => node.external_id)).size, visiblePageOne: searchFirst.nodes.length, visiblePageTwo: searchSecond.nodes.length }));
      assert.ok(searchFirst.nodes.length > 0 && searchFirst.nodes.length <= 50); assert.equal(searchFirst.hasMore, true);
      assert.ok(searchSecond.nodes.length > 0 && searchSecond.nodes.length <= 50); assert.equal(searchSecond.hasMore, false);
      assert.equal(new Set([...searchFirst.nodes, ...searchSecond.nodes].map(node => node.id)).size, 55);
      console.log("PASS: native full-vault body search reaches a note absent from preview and paginates 55 exact UUID results");
      await call("write_note", { title: "Topic Preferences", directory: "memories/topics", note_type: "hub-memory", content: "# Topic Preferences\n\n- Enjoys synthetic green tea.\n- Prefers accessible controls.", output_format: "json" });
      await call("write_note", { title: "Topic source", directory: "sessions", content: "Original user statement: enjoys synthetic green tea.", output_format: "json" });
      let topic;
      await waitFor(async () => { topic = (await graphApi.search("Topic Preferences", 1, AbortSignal.timeout(30_000))).nodes.find(node => node.title === "Topic Preferences"); return Boolean(topic); }, "saved topic search readiness");
      assert.equal((await graphApi.note(topic.id, AbortSignal.timeout(30_000))).canForget, true);
      const { verifyGraphBrowser } = await import("./verify_graph_browser.mjs");
      await verifyGraphBrowser({ root, playwright: dshHome, screenshot: hostRoot, chrome: process.argv[7], handler: route.handler, searchTarget, searchCounts: [searchFirst.nodes.length, searchSecond.nodes.length] });
      const forgottenTopic = await graphApi.note(topic.id, AbortSignal.timeout(30_000));
      assert.doesNotMatch(forgottenTopic.content, /green tea/); assert.match(forgottenTopic.content, /accessible controls/);
      assert.match(await call("read_note", { identifier: "sessions/topic-source" }), /green tea/);
      const restarted = createMemoryReflection(reflectionStore, async () => { throw new Error("Forgotten old evidence must not reach the model"); });
      assert.equal(await restarted.reflect({ id: "old-topic-evidence", completedAt: 1, content: "User: enjoys synthetic green tea." }, AbortSignal.timeout(30_000)), "excluded");
      console.log("PASS: actual PWA confirmation -> exact UUID topic edit -> original chat preserved -> persisted old-evidence exclusion");
    }
  } finally { await Promise.all(hostDisposers.map(dispose => dispose())); }
  if (modelCheck === "--model-check") {
    assert.ok(dshHome && hostRoot, "Real-model checks require explicitly named existing DSH home and installed host");
    const requireHost = createRequire(resolve(hostRoot, "package.json"));
    // Load installed provider dependencies without modifying either installation.
    registerHooks({ resolve(specifier, context, next) {
      try { return next(specifier, context); }
      catch (error) {
        if (error.code !== "ERR_MODULE_NOT_FOUND" || specifier.startsWith(".") || specifier.startsWith("node:")) throw error;
        return next(specifier, { ...context, parentURL: pathToFileURL(resolve(hostRoot, "package.json")).href });
      }
    } });
    const { parse } = requireHost("yaml");
    const settings = parse(await readFile(resolve(dshHome, "settings.yaml"), "utf8"));
    const route = settings["agent-default-model"];
    assert.equal(route.provider, "openrouter", "This opt-in check only uses the existing OpenRouter route");
    assert.equal(typeof route.model, "string");
    const { default: LocalCredentials } = await import(pathToFileURL(resolve(vendor, "packages/credentials/credentials-local/lib/index.js")));
    const PiAi = await import(pathToFileURL(resolve(vendor, "packages/llm/llm-pi-ai/lib/index.js")));
    await ctx.plugin(LocalCredentials, { path: resolve(dshHome, ".credentials.yaml"), dshHome, watch: false });
    await ctx.plugin(PiAi, { providers: { openrouter: settings["llm-pi-ai"].providers.openrouter } });
    const realGenerate = createMemoryGenerator({
      create: options => ctx.agents.create(options),
      message: text => createUserMessage({ source: { kind: "plugin", plugin: "hub-memory-reflection" }, content: [{ type: "text", text }] }),
    }, { provider: route.provider, model: route.model });
    const realReflection = createMemoryReflection(reflectionStore, realGenerate);
    const realSignal = AbortSignal.timeout(150_000);
    await realReflection.reflect({ id: "real-casual", completedAt: 400, content: "## User\nI usually drink jasmine tea and I like short answers.\n\n## Assistant\nUnderstood." }, realSignal);
    const firstMemory = await call("read_note", { identifier: "memories/personal-memory" });
    assert.match(firstMemory, /jasmine/i);
    assert.match(firstMemory, /short|concise|brief/i);
    await realReflection.reflect({ id: "real-correction", completedAt: 500, content: "## User\nActually, I no longer drink jasmine tea; I prefer rooibos now. Hypothetically, if I moved to Oslo I would learn Norwegian, but I have no plans to move.\n\n## Assistant\nGot it. I think you also own a yacht." }, realSignal);
    const corrected = await call("read_note", { identifier: "memories/personal-memory" });
    assert.match(corrected, /rooibos/i);
    assert.doesNotMatch(corrected, /jasmine|yacht|Oslo|Norwegian/i);
    const savedBody = JSON.parse(await call("read_note", { identifier: "memories/personal-memory", output_format: "json" })).content;
    const teaPassage = savedBody.split("\n").find(line => /rooibos/i.test(line));
    assert.ok(teaPassage);
    await realReflection.forget(teaPassage, 600, realSignal);
    assert.equal(await realReflection.reflect({ id: "real-old-replay", completedAt: 500, content: "## User\nI prefer rooibos." }, realSignal), "excluded");
    assert.doesNotMatch(await call("read_note", { identifier: "memories/personal-memory" }), /rooibos/i);
    console.log("PASS: existing OpenRouter model extracts casual preferences, corrects them, rejects hypothetical/assistant-only facts, and old evidence stays forgotten");
  }
  }
} finally {
  await memory?.dispose();
  await ctx.fiber.dispose();
}
