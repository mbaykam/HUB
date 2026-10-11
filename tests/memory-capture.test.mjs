import assert from "node:assert/strict";
import test from "node:test";
import { completedMemoryTurn } from "@minke/harness-overlay/host/memory-capture.ts";

const text = value => ({ type: "text", text: value });
function session(reason = "completed") {
  return { header: { id: "synthetic-session" }, events: [
    { type: "turn/start", data: { turn: 0 } },
    { type: "user/message", data: { source: { kind: "user" }, content: [text("I like amber tea.")] } },
    { type: "assistant/message", data: { turn: 0, message: { content: [text("Got it.")] } } },
    { type: "turn/end", data: { turn: 0, reason: { kind: reason } } },
  ] };
}

test("completed conversation becomes a non-overwriting Basic Memory evidence note", () => {
  const note = completedMemoryTurn(session(), 0);
  assert.match(note.content, /I like amber tea/);
  assert.match(note.content, /Got it/);
  assert.equal(note.note_type, "conversation-evidence");
  assert.equal(note.overwrite, false);
  assert.equal(note.directory, "sessions");
  assert.deepEqual(completedMemoryTurn(session(), 0), note);
  assert.doesNotMatch(note.title, /synthetic-session/);
});

test("plugin context, reasoning, attachments and tool results are not captured", () => {
  const value = session();
  value.events.splice(2, 0,
    { type: "user/message", data: { source: { kind: "plugin" }, content: [text("INJECTED")] } },
    { type: "tool/result", data: { content: [text("SECRET_OUTPUT")] } },
    { type: "assistant/message", data: { turn: 0, message: { content: [{ type: "reasoning", text: "PRIVATE_REASONING" }, { type: "image", text: "IMAGE" }] } } },
  );
  assert.doesNotMatch(completedMemoryTurn(value, 0).content, /INJECTED|SECRET_OUTPUT|PRIVATE_REASONING|IMAGE/);
});

test("aborted, failed, truncated and incomplete turns are not promoted as completed evidence", () => {
  for (const reason of ["aborted", "error", "max-tokens", "interrupted", "blocked"]) {
    assert.equal(completedMemoryTurn(session(reason), 0), undefined);
  }
  const value = session();
  value.events.pop();
  assert.equal(completedMemoryTurn(value, 0), undefined);
});

test("subagent and plugin-only conversations cannot feed recursive memory capture", () => {
  const child = session();
  child.header.origin = "subagent";
  assert.equal(completedMemoryTurn(child, 0), undefined);
  const synthetic = session();
  synthetic.events[1].data.source.kind = "plugin";
  assert.equal(completedMemoryTurn(synthetic, 0), undefined);
});

test("one turn does not absorb earlier or later session content", () => {
  const first = session();
  const second = session();
  second.events = second.events.map(event => ({ ...event, data: { ...event.data, ...(event.data.turn === 0 ? { turn: 1 } : {}) } }));
  second.events[1].data.content = [text("Now I prefer violet tea.")];
  first.events.push(...second.events);
  assert.doesNotMatch(completedMemoryTurn(first, 0).content, /violet/);
  assert.doesNotMatch(completedMemoryTurn(first, 1).content, /amber/);
  assert.notEqual(completedMemoryTurn(first, 0).title, completedMemoryTurn(first, 1).title);
});

test("oversized evidence fails explicitly instead of silently losing a later correction", () => {
  const value = session();
  value.events[1].data.content = [text("x".repeat(65536))];
  assert.throws(() => completedMemoryTurn(value, 0), /64 KiB/);
});
