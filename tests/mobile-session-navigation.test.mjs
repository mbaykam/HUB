import test from "node:test";
import assert from "node:assert/strict";
import { openMobileConversation } from "@minke/harness-overlay/client/host/mobile-session-navigation.ts";

function fixture(byId, catalogs = {}) {
  const opened = [], refreshed = [];
  const snapshot = { byId, subagentsByParent: catalogs };
  return { snapshot, opened, refreshed, sessions: {
    list: { getSnapshot: () => snapshot },
    open: id => opened.push({ id }),
    openSubagent: address => opened.push(address),
    refreshSubagents: async parent => refreshed.push(parent),
  } };
}

test("listed delegated work loads its direct parent's catalog before opening history", async () => {
  const f = fixture({ child: { origin: "subagent", parentId: "voice" } });
  f.sessions.refreshSubagents = async parent => {
    f.refreshed.push(parent);
    f.snapshot.subagentsByParent[parent] = { entries: [{ kind: "child", id: "child", mode: "continuable" }] };
  };
  await openMobileConversation(f.sessions, "child");
  assert.deepEqual(f.refreshed, ["voice"]);
  assert.deepEqual(f.opened, [{ parentSessionId: "voice", childSessionId: "child", mode: "continuable" }]);
});

test("nested and catalog-only children use their direct parent, including one-shot history", async () => {
  const f = fixture({}, { worker: { entries: [{ kind: "child", id: "nested", mode: "one-shot" }] } });
  await openMobileConversation(f.sessions, "nested");
  assert.deepEqual(f.opened, [{ parentSessionId: "worker", childSessionId: "nested", mode: "one-shot" }]);
});

test("an ordinary chat or fork keeps normal navigation even if it has a parent", async () => {
  const f = fixture({ fork: { parentId: "voice" } });
  await openMobileConversation(f.sessions, "fork");
  assert.deepEqual(f.opened, [{ id: "fork" }]);
  assert.deepEqual(f.refreshed, []);
});

test("missing, diagnostic and failed catalogs never fall back to an unauthorized child address", async () => {
  for (const kind of ["missing", "diagnostic", "failed"]) {
    const f = fixture({ child: { origin: "subagent", parentId: "voice" } });
    f.sessions.refreshSubagents = async () => {
      if (kind === "failed") throw Error("Connection lost");
      f.snapshot.subagentsByParent.voice = { entries: kind === "diagnostic" ? [{ kind: "diagnostic", id: "child" }] : [] };
    };
    await assert.rejects(openMobileConversation(f.sessions, "child"));
    assert.deepEqual(f.opened, []);
  }
});

test("external admissions refresh membership and orphaned children remain closed", async () => {
  const f = fixture({});
  f.sessions.refresh = async () => { f.snapshot.byId.voice = { title: "Conversation" }; };
  await openMobileConversation(f.sessions, "voice");
  assert.deepEqual(f.opened, [{ id: "voice" }]);
  f.snapshot.byId.orphan = { origin: "subagent" };
  await assert.rejects(openMobileConversation(f.sessions, "orphan"));
  assert.equal(f.opened.length, 1);
});
