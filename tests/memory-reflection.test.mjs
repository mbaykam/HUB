import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryReflection } from "@minke/harness-overlay/host/memory-reflection.ts";

const signal = new AbortController().signal;
function fixture(generate) {
  const notes = new Map();
  const store = { async call(name, args) {
    if (name === "write_note") {
      const id = args.directory + "/" + args.title.toLowerCase().replaceAll(" ", "-");
      if (notes.has(id)) return { action: "conflict", error: "NOTE_ALREADY_EXISTS" };
      notes.set(id, args.content); return { action: "created" };
    }
    if (name === "read_note") return { content: notes.get(args.identifier) };
    assert.equal(name, "edit_note");
    const current = notes.get(args.identifier);
    if (current.split(args.find_text).length !== 2) return { error: "conflict" };
    notes.set(args.identifier, current.replace(args.find_text, args.content));
    return { operation: "find_replace", checksum: null, fileCreated: false, file_path: args.identifier + ".md" };
  } };
  return { notes, store, worker: createMemoryReflection(store, generate) };
}
const evidence = { id: "one", completedAt: 10, content: "User: I prefer tea." };

test("exact-ID forgetting removes only the reviewed saved-note passage and retires old evidence", async () => {
  const f = fixture(async () => { throw new Error("No model calls for forgetting"); });
  await f.worker.initialize(signal);
  const id = "00000000-0000-4000-8000-000000000001";
  f.notes.set(id, "# Project memory\n\n- Prefers accessible controls.\n- Keep this decision.");
  f.notes.set("sessions/original", "Prefers accessible controls.");
  const original = f.store.call;
  f.store.call = async (name, args) => {
    const result = await original(name, args);
    return name === "read_note" && args.identifier === id ? { ...result, file_path: "memories/projects/hub.md", frontmatter: { type: "hub_memory" } } : result;
  };
  const summary = f.notes.get("memories/personal-memory");
  await f.worker.forget("- Prefers accessible controls.", 30, signal, id);
  assert.doesNotMatch(f.notes.get(id), /accessible/); assert.match(f.notes.get(id), /Keep this decision/);
  assert.equal(f.notes.get("memories/personal-memory"), summary);
  assert.equal(f.notes.get("sessions/original"), "Prefers accessible controls.");
  assert.equal(await f.worker.reflect({ ...evidence, id: "old-project-source" }, signal), "excluded");
});

test("named forgetting rejects path fallbacks, archives, policies and untyped notes before changing retention", async () => {
  for (const metadata of [{ file_path: "sessions/source.md", frontmatter: { type: "hub-memory" } },
    { file_path: "control/policy.md", frontmatter: { type: "hub-memory" } },
    { file_path: "memories/../control/policy.md", frontmatter: { type: "hub-memory" } },
    { file_path: "memories/topic.md", frontmatter: { type: "note" } }, {}]) {
    const f = fixture(async () => "unused"); await f.worker.initialize(signal);
    const original = f.store.call;
    f.store.call = async (name, args) => name === "read_note" && args.identifier.startsWith("0000") ? { content: "fact", ...metadata } : original(name, args);
    await assert.rejects(f.worker.forget("fact", 30, signal, "00000000-0000-4000-8000-000000000001"), /Not a saved memory/);
    assert.equal(f.notes.get("control/memory-policy"), '{"forgetBefore":0}');
    await assert.rejects(f.worker.forget("fact", 30, signal, "memories/topic"), /Invalid memory identity/);
  }
});

test("moving a saved note out of managed scope during forgetting preserves its content", async () => {
  const f = fixture(async () => "unused"); await f.worker.initialize(signal);
  const id = "00000000-0000-4000-8000-000000000001"; f.notes.set(id, "fact");
  let path = "memories/topic.md"; const original = f.store.call;
  f.store.call = async (name, args) => {
    if (name === "edit_note" && args.identifier === "control/memory-policy") path = "notes/human-owned.md";
    const result = await original(name, args);
    return name === "read_note" && args.identifier === id ? { ...result, file_path: path, frontmatter: { type: "hub-memory" } } : result;
  };
  await assert.rejects(f.worker.forget("fact", 30, signal, id), /Not a saved memory/);
  assert.equal(f.notes.get(id), "fact");
  assert.equal(JSON.parse(f.notes.get("control/memory-policy")).forgetBefore, 30);
});

test("reflection stores a model-curated note and does not reprocess old evidence", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return "# Personal memory\n\nPrefers tea."; });
  await f.worker.initialize(signal);
  assert.equal(await f.worker.reflect(evidence, signal), "updated");
  const restarted = createMemoryReflection(f.store, async () => { throw new Error("must not replay"); });
  assert.equal(await restarted.reflect(evidence, signal), "unchanged");
  assert.equal(calls, 1);
});

test("forget preserves original evidence and suppresses all older evidence after restart", async () => {
  const f = fixture(async () => "# Personal memory\n\nPrefers tea.");
  await f.worker.initialize(signal);
  await f.worker.reflect(evidence, signal);
  const copy = structuredClone(evidence);
  await f.worker.forget("Prefers tea.", 20, signal);
  assert.doesNotMatch(f.notes.get("memories/personal-memory"), /Prefers tea/);
  const restarted = createMemoryReflection(f.store, async () => { throw new Error("must not see retired evidence"); });
  assert.equal(await restarted.reflect({ ...evidence, id: "previously-unseen-old-evidence" }, signal), "excluded");
  assert.deepEqual(evidence, copy);
});

test("a human edit during generation is preserved and the uncertain attempt is not replayed", async () => {
  const f = fixture(async () => {
    f.notes.set("memories/personal-memory", "# Personal memory\n\nHuman correction.");
    return "# Personal memory\n\nModel replacement.";
  });
  await f.worker.initialize(signal);
  await assert.rejects(f.worker.reflect(evidence, signal), /edit preserved/);
  assert.match(f.notes.get("memories/personal-memory"), /Human correction/);
  assert.equal(await f.worker.reflect(evidence, signal), "already-attempted");
});

test("forget policy changes during generation stop stale writes", async () => {
  const f = fixture(async () => {
    f.notes.set("control/memory-policy", '{"forgetBefore":50}');
    return "# Personal memory\n\nStale fact.";
  });
  await f.worker.initialize(signal);
  assert.equal(await f.worker.reflect(evidence, signal), "excluded");
  assert.doesNotMatch(f.notes.get("memories/personal-memory"), /Stale fact/);
});

test("corrupt policy fails closed and unsuccessful model calls never claim success", async () => {
  const f = fixture(async () => { throw new Error("provider unavailable"); });
  await f.worker.initialize(signal);
  await assert.rejects(f.worker.reflect(evidence, signal), /provider unavailable/);
  assert.ok([...f.notes.values()].some(text => text.includes('"status":"started"')));
  f.notes.set("control/memory-policy", "invalid");
  await assert.rejects(f.worker.reflect({ ...evidence, id: "two" }, signal));
});
