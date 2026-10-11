import test from "node:test";
import assert from "node:assert/strict";
import { attachVoiceHistoryTool } from "@minke/harness-overlay/host/voice-history-tool.ts";

function fixture(saved = false) {
  let tool, writes = 0, removed = 0;
  const agent = { id: "voice-owner", ctx: { tools: { register(value) { tool = value; return () => removed++; } } } };
  const history = { view: () => ({ kind: "voice", saved }), async save(id) { assert.equal(id, agent.id); writes++; saved = true; return { kind: "voice", saved }; } };
  const off = attachVoiceHistoryTool(agent, history);
  const controller = new AbortController();
  return { tool, history, controller, off, exec: { agent, signal: controller.signal }, writes: () => writes, removed: () => removed };
}
test("save is current-session-only, explicit in its instructions, durable and idempotent", async () => {
  const f = fixture();
  assert.match(f.tool.description, /ONLY when the user explicitly asks/);
  assert.equal(f.tool.parameters.additionalProperties, false);
  assert.deepEqual(await f.tool.execute({}, f.exec), { sessionId: "voice-owner", saved: true, status: "saved" });
  assert.equal((await f.tool.execute({}, f.exec)).status, "already-saved");
  assert.equal(f.writes(), 1);
  f.off(); f.off(); assert.equal(f.removed(), 1);
});
test("foreign agents, arguments, aborted turns and revoked handles cannot save", async () => {
  const f = fixture();
  for (const args of [null, [], "", { sessionId: "someone-else" }]) await assert.rejects(f.tool.execute(args, f.exec));
  await assert.rejects(f.tool.execute({}, { ...f.exec, agent: { id: "child" } }));
  await assert.rejects(f.tool.execute({}, { signal: f.exec.signal }));
  f.controller.abort(); await assert.rejects(f.tool.execute({}, f.exec));
  f.off(); await assert.rejects(f.tool.execute({}, { ...f.exec, signal: new AbortController().signal }));
  assert.equal(f.writes(), 0);
});
test("text-origin conversations are already normal chats; no archive record is manufactured", async () => {
  const f = fixture(); f.history.view = () => ({ kind: "chat", saved: true });
  assert.equal((await f.tool.execute({}, f.exec)).status, "already-saved");
  assert.equal(f.writes(), 0); f.off();
});
test("no success before durability, and speech cancellation does not undo a committed save", async () => {
  const f = fixture(); let commit, settled = false;
  f.history.save = () => new Promise(resolve => { commit = resolve; });
  const pending = f.tool.execute({}, f.exec).then(value => { settled = true; return value; });
  await Promise.resolve(); assert.equal(settled, false);
  f.controller.abort(); f.off();
  commit({ kind: "voice", saved: true });
  assert.equal((await pending).status, "saved");
});
test("a failed native write never reports success", async () => {
  const f = fixture(); f.history.save = async () => { throw new Error("write failed"); };
  await assert.rejects(f.tool.execute({}, f.exec), /write failed/); f.off();
});
