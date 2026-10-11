import test from "node:test";
import assert from "node:assert/strict";
import { openConversationHistory, conversationHistoryDomain } from "@minke/harness-overlay/host/conversation-history.ts";

function session(id = "session-voice", extra = {}, events = []) {
  return { id, header: { id, ...extra }, inheritedEventCount: 0, snapshotEvents: () => events };
}
function storage() {
  const values = new Map();
  let fail = false, writes = 0;
  const table = {
    get: id => values.get(id), entries: () => values.entries(), get size() { return values.size; },
    async put(id, value) {
      if (fail) throw new Error("Synthetic durability failure");
      values.set(id, conversationHistoryDomain.tables.voice.valueSchema.parse(value)); writes++;
    },
    async update(id, transform) { const value = transform(values.get(id)); await table.put(id, value); return value; },
  };
  return { async open(spec) { assert.equal(spec.name, "hub_conversations"); return { table: () => table, async close() {} }; },
    set fail(value) { fail = value; }, get writes() { return writes; } };
}

test("voice classification and promotion never write or replace transcript events", async () => {
  const backing = storage(); const history = await openConversationHistory(backing);
  const s = session(); await history.markVoiceOrigin(s); await history.markVoiceOrigin(s);
  assert.deepEqual(history.view(s.id), { kind: "voice", saved: false });
  assert.equal(backing.writes, 1);
  s.snapshotEvents().push({ type: "user/message", data: { text: "A spoken detail" } });
  const original = structuredClone(s.snapshotEvents());
  assert.deepEqual(await history.save(s.id), { kind: "voice", saved: true });
  await history.save(s.id);
  assert.equal(backing.writes, 2);
  assert.deepEqual(s.snapshotEvents(), original);
  await history.close();
  const reopened = await openConversationHistory(backing);
  assert.deepEqual(reopened.view(s.id), { kind: "voice", saved: true });
  assert.deepEqual(Object.keys(reopened.snapshot()[0]).sort(), ["createdAt", "saved", "sessionId"]);
});

test("ordinary text history cannot be retroactively hidden when voice attaches", async () => {
  const history = await openConversationHistory(storage());
  const s = session("typed", {}, [{ type: "user/message" }]);
  await assert.rejects(history.markVoiceOrigin(s), /new empty/);
  assert.deepEqual(history.view(s.id), { kind: "chat", saved: true });
  await assert.rejects(history.save(s.id), /not an archived/);
});

test("delegated tasks and forks never inherit a voice parent's hidden classification", async () => {
  const history = await openConversationHistory(storage());
  const parent = session(); await history.markVoiceOrigin(parent);
  for (const origin of ["subagent", undefined]) {
    const child = session("child", { origin }); child.inheritedEventCount = 1;
    assert.deepEqual(history.view(child.id, origin), { kind: origin ? "task" : "chat", saved: true });
    await assert.rejects(history.markVoiceOrigin(child), /new empty/);
    await assert.rejects(history.save(child.id), /not an archived/);
  }
});

test("failed durable writes do not advertise archived or promoted state", async () => {
  const backing = storage(); const history = await openConversationHistory(backing); const s = session();
  backing.fail = true;
  await assert.rejects(history.markVoiceOrigin(s), /durability/);
  assert.deepEqual(history.view(s.id), { kind: "chat", saved: true });
  backing.fail = false; await history.markVoiceOrigin(s); backing.fail = true;
  await assert.rejects(history.save(s.id), /durability/);
  assert.deepEqual(history.view(s.id), { kind: "voice", saved: false });
});
