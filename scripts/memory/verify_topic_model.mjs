import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire, registerHooks } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Readable } from "node:stream";
import { completedMemoryTurn } from "../../packages/harness-overlay/src/host/memory-capture.ts";
import { createMemoryReflection } from "../../packages/harness-overlay/src/host/memory-reflection.ts";
import { createMemoryGraph } from "../../packages/harness-overlay/src/host/memory-graph.ts";

/** Explicit opt-in. Real existing memory model, production installer and native
 * completed turns; all conversation evidence and Markdown are synthetic.
 */
export async function verifyTopicModel({ ctx, call, vendor, dshHome, hostRoot, vault, configDirectory, LlmAdapter, createUserMessage, applyMemoryHost }) {
  assert.ok(dshHome && hostRoot, "Pass the existing DSH home and installed host explicitly");
  assert.equal(relative(resolve(configDirectory, ".."), resolve(vault)), "vault", "Only the parent's disposable vault is permitted");
  const requireHost = createRequire(resolve(hostRoot, "package.json"));
  registerHooks({ resolve(specifier, context, next) {
    try { return next(specifier, context); }
    catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND" || specifier.startsWith(".") || specifier.startsWith("node:")) throw error;
      return next(specifier, { ...context, parentURL: pathToFileURL(resolve(hostRoot, "package.json")).href });
    }
  } });
  const { parse } = requireHost("yaml");
  const settings = parse(await readFile(resolve(dshHome, "settings.yaml"), "utf8"));
  const patch = parse(await readFile(resolve(dshHome, "profiles/web/cordis.patch.yml"), "utf8"));
  const memoryConfigs = [];
  function findMemory(value) {
    if (!value || typeof value !== "object") return;
    if (value.id === "hub-memory") memoryConfigs.push(value.config);
    for (const child of Object.values(value)) findMemory(child);
  }
  findMemory(patch);
  assert.equal(memoryConfigs.length, 1, "Use the explicit installed memory route, not a guessed chat default");
  const route = { provider: memoryConfigs[0].provider, model: memoryConfigs[0].model };
  assert.equal(route.provider, "openrouter", "This verifier supports only the existing OpenRouter memory route");
  assert.equal(typeof route.model, "string");
  const { default: LocalCredentials } = await import(pathToFileURL(resolve(vendor, "packages/credentials/credentials-local/lib/index.js")));
  const PiAi = await import(pathToFileURL(resolve(vendor, "packages/llm/llm-pi-ai/lib/index.js")));
  await ctx.plugin(LocalCredentials, { path: resolve(dshHome, ".credentials.yaml"), dshHome, watch: false });
  await ctx.plugin(PiAi, { providers: { openrouter: settings["llm-pi-ai"].providers.openrouter } });
  console.log(`Using existing memory route ${route.provider}/${route.model}; voice configuration unchanged`);
  const requests = [];
  class ConversationFixture extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model }; }
    async *stream(options) {
      requests.push(options);
      const text = "Understood. Hypothetically you might own a yacht, but you have not told me that.";
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text };
      yield { type: "block-end", index: 0, block: { type: "text", text } };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  }
  ctx.llm.registerAdapter(["hub-topic-fixture"], new ConversationFixture());
  let routeHandler;
  const disposers = [], agents = [], workers = [];
  const store = { call: async (name, args) => JSON.parse(await call(name, { ...args, output_format: "json" })) };
  const signal = AbortSignal.timeout(300_000);
  await store.call("write_note", { title: "Personal memory", directory: "memories", note_type: "hub-memory", overwrite: false,
    content: "# Personal memory\n\n- [preference] Use metric units for measurements.\n" }, signal);
  applyMemoryHost({
    on: (...args) => ctx.on(...args), tools: ctx.tools,
    agents: { get: id => ctx.agents.get(id), create: options => { workers.push(options.sessionId); return ctx.agents.create(options); } },
    effect: callback => disposers.push(callback()), connection: { requestRejection: () => undefined },
    webServer: { register(value) { routeHandler = value.handler; return () => {}; } },
  }, { ...route, project: "hub-memory-pilot", captureSince: Date.now(), topicNotes: true });
  async function snapshot() {
    let value;
    await routeHandler({ method: "GET", headers: {} }, { writeHead() {}, end(text) { value = JSON.parse(text); } });
    return value;
  }
  async function waitFor(predicate, label, milliseconds = 120_000) {
    const deadline = Date.now() + milliseconds;
    do {
      if (await predicate()) return;
      const status = (await snapshot()).status;
      assert.ok(!["capture-failed", "reflection-failed", "review-attempt-status", "unavailable"].includes(status), `${label}: ${status}`);
      await delay(250);
    } while (Date.now() < deadline);
    throw new Error(`Timed out: ${label}`);
  }
  async function turn(id, text) {
    const handle = await ctx.agents.create({ sessionId: id, agentOptions: { provider: "hub-topic-fixture", model: "scripted" } });
    agents.push(handle);
    handle.agent.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text }] }));
    await handle.agent.whenIdle();
    const events = handle.agent.session.snapshotEvents();
    assert.equal(events.at(-1).data.reason.kind, "completed");
    const note = completedMemoryTurn({ header: handle.agent.session.header, events }, 1);
    assert.ok(note);
    const marker = `control/reflection-${createHash("sha256").update(note.title).digest("hex")}`;
    await waitFor(async () => {
      try { return JSON.parse((await store.call("read_note", { identifier: marker }, signal)).content).status === "completed"; }
      catch { return false; }
    }, `automatic reflection of ${id}`);
    return note;
  }
  async function savedNotes() {
    const paths = (await readdir(join(vault, "memories"), { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith(".md"))
      .map(entry => relative(vault, join(entry.parentPath, entry.name)).replaceAll("\\", "/"));
    return Promise.all(paths.map(identifier => store.call("read_note", { identifier, include_frontmatter: false }, signal)));
  }
  try {
    await waitFor(async () => (await snapshot()).status === "ready", "memory startup", 25_000);
    const source = await turn("topic-model-casual", "I usually drink jasmine tea, and I like short answers. Hypothetically, if I moved to Oslo I would learn Norwegian, but I have no plans to move.");
    const first = await savedNotes();
    assert.match(first.map(note => note.content).join("\n"), /jasmine/i);
    assert.match(first.map(note => note.content).join("\n"), /short|concise|brief/i);
    const canonical = first.find(note => !note.file_path.startsWith("memories/topics/"));
    assert.match(canonical.content, /short|concise|brief/i, "Global interaction preference belongs in always-recalled summary");
    assert.match(canonical.content, /metric/i, "Existing human-owned preference must survive topic consolidation");
    assert.doesNotMatch(first.map(note => note.content).join("\n"), /yacht|Oslo|Norwegian/i);
    const tea = first.filter(note => /jasmine/i.test(note.content));
    assert.equal(tea.length, 1, "A remembered fact must not be duplicated between summary and topics");
    assert.match(tea[0].file_path, /^memories\/topics\//, "Durable detail must be stored in a real topic, not only the summary");
    console.log("PASS: production completed-chat hook + actual model creates topical Markdown without being told to remember; excludes hypothetical/assistant-only claims");
    const graph = createMemoryGraph(store);
    let teaId;
    await waitFor(async () => {
      const found = await graph.search("jasmine", 1, signal);
      teaId = found.nodes.find(node => node.title === tea[0].title)?.id;
      return Boolean(teaId);
    }, "topic indexed", 35_000);
    await turn("topic-model-correction", "Actually I no longer drink jasmine tea; I prefer rooibos now. I still like short answers.");
    const corrected = await savedNotes();
    const joined = corrected.map(note => note.content).join("\n");
    assert.match(joined, /rooibos/i); assert.doesNotMatch(joined, /jasmine|yacht/i);
    assert.equal(corrected.filter(note => /rooibos/i.test(note.content)).length, 1);
    assert.match((await graph.note(teaId, signal)).content, /rooibos/i);
    assert.match(joined, /short|concise|brief/i);
    assert.match(joined, /metric/i);
    const count = corrected.length;
    await turn("topic-model-reader", "What tea do I like?");
    assert.match(JSON.stringify(requests.at(-1).messages), /Retrieved personal notes/);
    assert.match(JSON.stringify(requests.at(-1).messages), /rooibos/i);
    assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /jasmine/i);
    const afterQuestion = await savedNotes();
    assert.equal(afterQuestion.length, count, "A question is not a new durable fact");
    assert.equal(afterQuestion.filter(note => /rooibos/i.test(note.content)).length, 1);
    console.log("PASS: actual model corrects the same topic UUID, preserves unrelated preferences and new-chat recall uses the correction without duplicating it");
    const current = await graph.note(teaId, signal);
    const passage = current.content.split("\n").find(line => /rooibos/i.test(line));
    assert.ok(passage);
    const request = Readable.from([JSON.stringify({ action: "forget", noteId: teaId, passage })]);
    Object.assign(request, { method: "POST", headers: { "content-type": "application/json" } });
    let status;
    await routeHandler(request, { writeHead(code) { status = code; }, end() {} });
    assert.equal(status, 200);
    assert.doesNotMatch((await savedNotes()).map(note => note.content).join("\n"), /rooibos/i);
    assert.match((await savedNotes()).map(note => note.content).join("\n"), /metric/i);
    assert.match((await store.call("read_note", { identifier: `sessions/${source.title}` }, signal)).content, /jasmine/i);
    const restarted = createMemoryReflection(store, async () => { throw new Error("Retired evidence must not reach model"); }, { topicNotes: true });
    assert.equal(await restarted.reflect({ id: "unseen-old-model-source", completedAt: 1, content: "User: I like rooibos." }, signal), "excluded");
    assert.ok(workers.length >= 3 && workers.every(id => ctx.agents.get(id) === undefined), "Native reflection workers must dispose");
    console.log("PASS: exact HTTP Forget preserves original source, excludes pre-cutoff evidence after worker restart and all actual-model workers dispose");
  } finally {
    await Promise.all(disposers.map(dispose => dispose()));
    await Promise.all(agents.map(agent => agent.dispose()));
  }
}
