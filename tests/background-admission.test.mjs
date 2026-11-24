import test from "node:test";
import assert from "node:assert/strict";
import {BackgroundAdmission, recentlyActive} from "../packages/harness-overlay/src/host/background-admission.ts";

test("a chat that has gone quiet for ten minutes stops holding background work", () => {
  const now = Date.parse("2026-11-19T00:00:00Z");
  const agent = time => ({session: {snapshotEvents: () => [{time: now - 60_000}, {time}]}});
  assert.equal(recentlyActive(agent(now - 30_000), now), true);
  assert.equal(recentlyActive(agent(now - 11 * 60_000), now), false);
  assert.equal(recentlyActive({}, now), true, "unknown activity still counts as busy");
  let busy = [agent(now - 11 * 60_000)];
  const lease = new BackgroundAdmission(() => busy.some(a => recentlyActive(a, now)));
  const release = lease.acquire("knowledge");
  assert.ok(release, "a stalled chat does not block Knowledge");
  release();
  busy = [agent(now - 5_000)];
  assert.equal(lease.acquire("knowledge"), undefined, "an active chat still has priority");
});
