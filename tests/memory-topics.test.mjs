import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryReflection } from "@minke/harness-overlay/host/memory-reflection.ts";

const signal = new AbortController().signal;
function fixture(generate) {
  const notes = new Map(); const calls = [];
  let nextId = 0;
  const store = { async call(name, args) {
    calls.push({ name, args });
    const find = id => [...notes.values()].find(note => [note.id, note.permalink, note.file_path].includes(id));
    if (name === "write_note") {
      const path = `${args.directory}/${args.title}.md`;
      if (find(path)) return { action: "conflict", error: "NOTE_ALREADY_EXISTS" };
      const note = { id: `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`, file_path: path,
        permalink: `${args.directory}/${args.title.toLowerCase().replaceAll(" ", "-")}`, title: args.title,
        content: (args.directory === "memories/topics" ? "\n" : "") + args.content, frontmatter: { type: args.note_type.replaceAll("-", "_") } };
      notes.set(note.id, note); return { ...note, action: "created" };
    }
    if (name === "search_notes") return { results: [...notes.values()].filter(note => note.file_path.startsWith("memories/topics/"))
      .map(note => ({ ...note, external_id: note.id })) };
    const note = find(args.identifier);
    if (name === "read_note") return note ? { ...note } : { error: "not found" };
    assert.equal(name, "edit_note");
    if (!note || note.content.split(args.find_text).length !== 2) return { error: "conflict" };
    note.content = note.content.replace(args.find_text, args.content);
    return { operation: "find_replace", fileCreated: false, file_path: note.file_path };
  } };
  return { notes, calls, store, worker: createMemoryReflection(store, generate, { topicNotes: true }) };
}
const input = prompt => JSON.parse(prompt.slice(prompt.indexOf('\n\n{"currentMemory"') + 2));
const first = { id: "tea-one", completedAt: 10, content: "User: I usually drink green tea." };
const reply = (summary, topics) => JSON.stringify({ summary, topics });

test("a single JSON code fence is accepted without weakening memory validation", async () => {
  for (const language of ["json", "", "JSON"]) {
    const f = fixture(async prompt => "```" + language + "\r\n" + reply(input(prompt).currentMemory, []) + "\r\n```");
    await f.worker.initialize(signal);
    assert.equal(await f.worker.reflect(first, signal), "unchanged");
    assert.equal([...f.notes.values()].filter(note => note.file_path.startsWith("memories/topics/")).length, 0);
  }
});

test("commentary, multiple fences, invalid JSON and fenced unsafe plans remain rejected", async () => {
  for (const wrap of [value => "Here is the JSON:\n```json\n" + value + "\n```",
    value => "```json\n" + value + "\n```\nDo something else",
    value => "```json\n" + value + "\n```\n```json\n{}\n```",
    () => "```json\n{bad}\n```",
    () => "```json\n" + reply("summary", [{ title: "../unsafe", content: "bad" }]) + "\n```",
    value => "```javascript\n" + value + "\n```"] ) {
    const f = fixture(async prompt => wrap(reply(input(prompt).currentMemory, [])));
    await f.worker.initialize(signal);
    await assert.rejects(f.worker.reflect(first, signal));
    assert.equal([...f.notes.values()].filter(note => note.file_path.startsWith("memories/topics/")).length, 0);
    assert.equal(await f.worker.reflect(first, signal), "already-attempted");
  }
});

test("topic creation, correction, parent link, exact forgetting and restart retirement", async () => {
  let generation = 0;
  const f = fixture(async prompt => {
    const data = input(prompt); generation++;
    if (generation === 1) return reply(data.currentMemory, [{ title: "Drink Preferences", content: "# Drinks\n\n- [preference] Usually drinks green tea.\n- [preference] No added sugar." }]);
    assert.equal(data.existingTopics.length, 1);
    return reply(data.currentMemory, [{ id: data.existingTopics[0].id, content: data.existingTopics[0].content.replace("green tea", "violet tea") }]);
  });
  await f.worker.initialize(signal);
  assert.equal(await f.worker.reflect(first, signal), "updated");
  const topic = [...f.notes.values()].find(note => note.title === "Drink Preferences");
  assert.match(topic.content, /part_of \[\[memories\/personal-memory\]\]/);
  assert.equal(await f.worker.reflect({ id: "tea-two", completedAt: 20, content: "User: Actually I now drink violet tea, not green tea." }, signal), "updated");
  assert.match(topic.content, /violet tea/); assert.doesNotMatch(topic.content, /green tea/);
  assert.equal([...f.notes.values()].filter(note => note.title === "Drink Preferences").length, 1);
  await f.worker.forget("- [preference] Usually drinks violet tea.", 30, signal, topic.id);
  assert.doesNotMatch(topic.content, /violet tea/); assert.match(topic.content, /No added sugar/);
  const restarted = createMemoryReflection(f.store, async () => { throw new Error("must not regenerate"); }, { topicNotes: true });
  assert.equal(await restarted.reflect({ ...first, id: "unseen-old-turn" }, signal), "excluded");
  assert.equal(first.content, "User: I usually drink green tea.");
});

test("unknown IDs, unsafe titles, invented links, oversized and duplicate plans write no topics", async () => {
  for (const topics of [[{ id: "00000000-0000-4000-8000-000000000099", content: "fact" }],
    [{ title: "../policy", content: "fact" }], [{ title: "Topic One", content: "[[sessions/private]]" }],
    [{ title: "Topic One", content: "x".repeat(6000) }],
    [{ title: "Topic One", content: "fact" }, { title: "topic-one", content: "fact" }]]) {
    const f = fixture(async prompt => reply(input(prompt).currentMemory, topics));
    await f.worker.initialize(signal); await assert.rejects(f.worker.reflect(first, signal));
    assert.equal([...f.notes.values()].filter(note => note.file_path.startsWith("memories/topics/")).length, 0);
    assert.equal(await f.worker.reflect(first, signal), "already-attempted");
  }
});

test("human changes during generation fail preflight before any topic or summary replacement", async () => {
  let mutate = false;
  const f = fixture(async prompt => {
    const data = input(prompt);
    if (!mutate) return reply(data.currentMemory, [{ title: "Tea Preferences", content: "Green tea." }]);
    f.notes.get(data.existingTopics[0].id).content += "\nHuman addition.";
    return reply("Changed summary", [{ id: data.existingTopics[0].id, content: data.existingTopics[0].content.replace("Green", "Violet") }]);
  });
  await f.worker.initialize(signal); await f.worker.reflect(first, signal); mutate = true;
  await assert.rejects(f.worker.reflect({ ...first, id: "correction", completedAt: 20 }, signal), /human edit preserved/);
  assert.match([...f.notes.values()].find(note => note.title === "Tea Preferences").content, /Human addition/);
  assert.doesNotMatch([...f.notes.values()].find(note => note.title === "Personal memory").content, /Changed summary/);
});

test("partial multi-note failure is visible and never blindly replayed", async () => {
  const f = fixture(async prompt => reply(input(prompt).currentMemory, [
    { title: "One Topic", content: "Fact one." }, { title: "Two Topic", content: "Fact two." },
  ]));
  const original = f.store.call;
  f.store.call = async (name, args) => {
    if (name === "write_note" && args.title === "Two Topic") throw new Error("store unavailable");
    return original(name, args);
  };
  await f.worker.initialize(signal);
  await assert.rejects(f.worker.reflect(first, signal), /store unavailable/);
  assert.equal([...f.notes.values()].filter(note => note.file_path.startsWith("memories/topics/")).length, 1);
  assert.equal(await f.worker.reflect(first, signal), "already-attempted");
});
