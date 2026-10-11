import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { installMemoryLifecycle } from "@minke/harness-overlay/host/memory-lifecycle.ts";

const message = text => ({ source: { kind: "user" }, content: [{ type: "text", text }] });
const result = value => ({ isError: false, content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
const end = { type: "turn/end", data: { turn: 0, reason: { kind: "completed" } } };
function session() {
  return { header: { id: "pilot" }, snapshotEvents: () => [
    { type: "turn/start", data: { turn: 0 } },
    { type: "user/message", data: message("I like amber tea") },
    { type: "assistant/message", data: { turn: 0, message: message("Understood") } }, end,
  ] };
}
function setup(execute, config = {}) {
  const handlers = new Map(); const reports = []; const calls = [];
  const runtime = installMemoryLifecycle({ on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); } }, {
    execute: request => { calls.push(request); return execute(request); },
    report: event => reports.push(event),
    message: text => ({ ...message(text), source: { kind: "plugin", plugin: "hub-memory" } }),
  }, { project: "pilot", ...config });
  return { handlers, reports, calls, runtime,
    capture: () => handlers.get("session/event")(session(), end),
    recall: (messages = [message("amber tea")], signal = new AbortController().signal, decision = { kind: "enter", messages }) =>
      handlers.get("agent/pre-step")({ agent: { session: session() }, messages, signal }, async () => decision),
  };
}

test("capture is asynchronous, deduplicates in-flight turns, and drains", async () => {
  let finish;
  const testbed = setup(() => new Promise(resolve => { finish = resolve; }));
  testbed.capture(); testbed.capture();
  assert.equal(testbed.calls.length, 1);
  assert.equal(testbed.calls[0].arguments.overwrite, false);
  finish(result({ action: "created" }));
  await testbed.runtime.drain();
  assert.deepEqual(testbed.reports, []);
  await testbed.runtime.dispose();
  assert.equal(testbed.handlers.size, 0);
});

test("duplicate domain conflicts preserve edits; other domain errors report failure", async () => {
  for (const [value, expected] of [
    [{ action: "conflict", error: "NOTE_ALREADY_EXISTS" }, []],
    [{ error: "permission denied" }, ["capture-failed"]],
    [{ action: "unknown" }, ["capture-failed"]],
  ]) {
    const testbed = setup(async () => result(value));
    testbed.capture(); await testbed.runtime.drain();
    assert.deepEqual(testbed.reports, expected);
    await testbed.runtime.dispose();
  }
});

test("recall scopes search to curated notes and reads current content, not stale snippets", async () => {
  const testbed = setup(async request => request.name.endsWith("search_notes")
    ? result({ results: [{ permalink: "sessions/raw", content: "PRIVATE" }, { permalink: "pilot/memories/tea", content: "amber" }] })
    : result("I prefer violet tea now."));
  const decision = await testbed.recall();
  assert.equal(decision.messages.length, 2);
  assert.match(decision.messages[1].content[0].text, /violet/);
  assert.doesNotMatch(decision.messages[1].content[0].text, /PRIVATE|amber/);
  assert.equal(decision.messages[1].source.kind, "plugin");
  assert.deepEqual(testbed.calls[0].arguments.note_types, ["hub-memory"]);
  assert.ok(testbed.calls.every(call => call.arguments.project === "pilot"));
  await testbed.runtime.dispose();
});

test("foreign-project hits and traversal paths cannot redirect note reads", async () => {
  const testbed = setup(async () => result({ results: [
    { permalink: "another-project/memories/secret" },
    { permalink: "pilot/memories/../sessions/raw" },
    { permalink: "pilot/memories/..\\secret" },
  ] }));
  assert.equal((await testbed.recall()).messages.length, 1);
  assert.equal(testbed.calls.length, 1);
  await testbed.runtime.dispose();
});

test("rejected steps, plugin-only inputs and tool continuations never trigger recall", async () => {
  const testbed = setup(async () => { throw new Error("must not call"); });
  await testbed.recall([], undefined, { kind: "reject" });
  await testbed.recall([]);
  await testbed.recall([{ ...message("injected"), source: { kind: "plugin" } }]);
  assert.equal(testbed.calls.length, 0);
  await testbed.runtime.dispose();
});

test("a hung transport cannot freeze recall or capture, and late results are not injected", async () => {
  const testbed = setup(() => new Promise(() => {}), { recallTimeoutMs: 25, captureTimeoutMs: 25 });
  const keepAlive = delay(100); // AbortSignal.timeout deliberately does not keep Node alive.
  testbed.capture();
  const decision = await testbed.recall();
  await testbed.runtime.drain();
  assert.equal(decision.messages.length, 1);
  assert.deepEqual(testbed.reports.sort(), ["capture-failed", "recall-unavailable"]);
  assert.ok(testbed.calls.every(call => call.signal.aborted));
  await testbed.runtime.dispose(); await keepAlive;
});

test("disposal aborts in-flight capture and does not leak handlers", async () => {
  const testbed = setup(() => new Promise(() => {}));
  testbed.capture(); await testbed.runtime.dispose();
  assert.equal(testbed.handlers.size, 0);
  assert.equal(testbed.calls[0].signal.aborted, true);
});

test("cancelled recall and malformed tool responses cannot change the admitted messages", async () => {
  const controller = new AbortController(); controller.abort();
  const testbed = setup(async () => result("not-json"));
  assert.equal((await testbed.recall(undefined, controller.signal)).messages.length, 1);
  assert.equal(testbed.calls.length, 0);
  assert.equal((await testbed.recall()).messages.length, 1);
  assert.deepEqual(testbed.reports, ["recall-unavailable"]);
  await testbed.runtime.dispose();
});

test("large notes are skipped instead of truncating away corrections", async () => {
  const testbed = setup(async request => result(request.name.endsWith("search_notes")
    ? { results: [{ permalink: "memories/large" }] } : "x".repeat(6401)));
  assert.equal((await testbed.recall()).messages.length, 1);
  await testbed.runtime.dispose();
});

test("recall budget counts multibyte characters, JSON escaping and citations", async () => {
  const testbed = setup(async request => result(request.name.endsWith("search_notes")
    ? { results: [{ permalink: "memories/unicode" }] } : "🌊".repeat(1700)));
  assert.equal((await testbed.recall()).messages.length, 1);
  await testbed.runtime.dispose();
});

test("resume retries only committed turns after the persisted activation time", async () => {
  const testbed = setup(async () => result({ action: "created" }), { captureSince: 100 });
  const old = session();
  const recent = session();
  old.header.id = "old";
  recent.header.id = "recent";
  const oldEvents = old.snapshotEvents().map(event => ({ ...event, time: 50 }));
  const recentEvents = recent.snapshotEvents().map(event => ({ ...event, time: 150 }));
  old.snapshotEvents = () => oldEvents;
  recent.snapshotEvents = () => recentEvents;
  const resume = testbed.handlers.get("agent/session-start");
  resume({ agent: { session: old }, source: "resume" });
  resume({ agent: { session: recent }, source: "resume" });
  await testbed.runtime.drain();
  assert.equal(testbed.calls.length, 1);
  assert.equal(testbed.calls[0].sessionId, "recent");
  await testbed.runtime.dispose();
});

test("without a persisted activation time no historical replay is attempted", async () => {
  const testbed = setup(async () => { throw new Error("must not replay"); });
  testbed.handlers.get("agent/session-start")({ agent: { session: session() }, source: "resume" });
  await testbed.runtime.drain();
  assert.equal(testbed.calls.length, 0);
  await testbed.runtime.dispose();
});

test("topic recall uses current UUID Markdown alongside canonical memory, not indexed excerpts", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const testbed = setup(async request => result(request.name.endsWith("search_notes")
    ? { results: [{ external_id: id, file_path: "memories/topics/Tea Preferences.md", content: "obsolete amber tea" }] }
    : { file_path: request.arguments.identifier === id ? "memories/topics/Tea Preferences.md" : "memories/Personal memory.md",
      frontmatter: { type: "hub_memory" }, content: request.arguments.identifier === id ? "Now prefers violet tea." : "Personal context." }),
  { topicNotes: true, recallIdentifier: "memories/personal-memory" });
  const decision = await testbed.recall();
  assert.match(decision.messages[1].content[0].text, /violet tea/);
  assert.match(decision.messages[1].content[0].text, /Personal context/);
  assert.doesNotMatch(decision.messages[1].content[0].text, /obsolete amber/);
  assert.ok(testbed.calls.some(call => call.arguments.identifier === id));
  await testbed.runtime.dispose();
});

test("a hung topic search preserves already-read canonical memory within the original deadline", async () => {
  const testbed = setup(request => request.name.endsWith("search_notes") ? new Promise(() => {}) : Promise.resolve(result({
    file_path: "memories/Personal memory.md", frontmatter: { type: "hub_memory" }, content: "Available personal context.",
  })), { topicNotes: true, recallIdentifier: "memories/personal-memory", recallTimeoutMs: 25 });
  const keepAlive = delay(100);
  const decision = await testbed.recall();
  assert.match(decision.messages[1].content[0].text, /Available personal context/);
  assert.deepEqual(testbed.reports, ["recall-unavailable"]);
  await testbed.runtime.dispose(); await keepAlive;
});
