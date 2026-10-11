import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createMemoryReflection } from "../../packages/harness-overlay/src/host/memory-reflection.ts";
import { createMemoryGraph } from "../../packages/harness-overlay/src/host/memory-graph.ts";
import { installMemoryLifecycle } from "../../packages/harness-overlay/src/host/memory-lifecycle.ts";

// Real Basic Memory through the native DSH registry, disposable data only.
// The model is deliberately scripted: this verifies storage/integration, not
// semantic extraction quality or the live user's vault.
export async function verifyTopicNotes(call) {
  const signal = AbortSignal.timeout(120_000);
  const store = { call: async (name, args) => {
    const result = JSON.parse(await call(name, { ...args, output_format: "json" }));
    return result;
  } };
  let pass = 0;
  const worker = createMemoryReflection(store, async prompt => {
    const input = JSON.parse(prompt.slice(prompt.indexOf('\n\n{"currentMemory"') + 2));
    pass++;
    if (pass === 1) return JSON.stringify({ summary: input.currentMemory, topics: [{ title: "Beverage Preferences",
      content: "# Beverage preferences\n\n- [preference] Drinks synthetic green tea.\n- [preference] No added sugar." }] });
    assert.equal(input.existingTopics.length, 1, "Real native search must gather the existing topic");
    return JSON.stringify({ summary: input.currentMemory, topics: [{ id: input.existingTopics[0].id,
      content: input.existingTopics[0].content.replace("green tea", "violet tea") }] });
  }, { topicNotes: true });
  async function eventually(operation, label) {
    const deadline = Date.now() + 35_000;
    do { if (await operation()) return; await delay(350); } while (Date.now() < deadline);
    throw new Error(`${label} did not become ready`);
  }
  await worker.initialize(signal);
  await store.call("write_note", { title: "Original topic source", directory: "sessions", content: "User: I drink synthetic green tea and use no added sugar.", overwrite: false }, signal);
  assert.equal(await worker.reflect({ id: "topic-first", completedAt: 10, content: "User: I drink synthetic green tea and use no added sugar." }, signal), "updated");
  let id;
  await eventually(async () => {
    const search = await store.call("search_notes", { query: '"green"', search_type: "text", note_types: ["hub_memory"], entity_types: ["entity"] }, signal);
    id = search.results?.find(hit => hit.title === "Beverage Preferences")?.external_id;
    return Boolean(id);
  }, "Topic indexing");
  const first = await store.call("read_note", { identifier: id, include_frontmatter: false }, signal);
  assert.match(first.file_path, /^memories\/topics\//);
  assert.match(first.content, /part_of \[\[memories\/personal-memory\]\]/);
  assert.equal(await worker.reflect({ id: "topic-correct", completedAt: 20, content: "User: Actually I now drink synthetic violet tea, not green tea. Still no added sugar." }, signal), "updated");
  const corrected = await store.call("read_note", { identifier: id, include_frontmatter: false }, signal);
  assert.match(corrected.content, /violet tea/); assert.doesNotMatch(corrected.content, /green tea/);
  assert.equal(corrected.file_path, first.file_path);
  const graph = createMemoryGraph(store);
  await eventually(async () => {
    const page = await graph.page(1, signal);
    return page.nodes.some(node => node.id === id) && page.edges.some(edge => edge.source === id && edge.label === "part_of");
  }, "Actual indexed parent relationship");
  const handlers = new Map();
  const runtime = installMemoryLifecycle({ on: (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name); } }, {
    execute: async request => ({ isError: false, content: [{ type: "text", text: await call(request.name.replace("mcp__hub_memory__", ""), request.arguments) }] }),
    message: text => ({ source: { kind: "plugin" }, content: [{ type: "text", text }] }), report: () => {},
  }, { project: "hub-memory-pilot", topicNotes: true, recallIdentifier: "memories/personal-memory", recallTimeoutMs: 1000 });
  try {
    const messages = [{ source: { kind: "user" }, content: [{ type: "text", text: "What tea do I drink?" }] }];
    const started = Date.now();
    const decision = await handlers.get("agent/pre-step")({ agent: { session: { header: { id: "new-topic-chat" } } }, messages, signal }, async () => ({ kind: "enter", messages }));
    assert.match(JSON.stringify(decision.messages.slice(1)), /violet tea/);
    assert.doesNotMatch(JSON.stringify(decision.messages.slice(1)), /green tea/);
    console.log(`PASS: native topic recall in a new conversation (${Date.now() - started} ms, 1000 ms deadline)`);
  } finally { await runtime.dispose(); }
  await worker.forget("- [preference] Drinks synthetic violet tea.", 30, signal, id);
  const forgotten = await store.call("read_note", { identifier: id, include_frontmatter: false }, signal);
  assert.doesNotMatch(forgotten.content, /violet tea/); assert.match(forgotten.content, /No added sugar/);
  assert.match((await store.call("read_note", { identifier: "sessions/original-topic-source" }, signal)).content, /green tea/);
  const restarted = createMemoryReflection(store, async () => { throw new Error("Old source must stay excluded"); }, { topicNotes: true });
  assert.equal(await restarted.reflect({ id: "unseen-old-topic", completedAt: 20, content: "User: I drink synthetic violet tea." }, signal), "excluded");
  console.log("PASS: real Markdown topic creation, UUID correction, native graph link, exact forgetting, original source preservation and restart exclusion (scripted model)");
}
