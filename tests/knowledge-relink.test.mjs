import test from "node:test";
import assert from "node:assert/strict";
import {pickForRelink, RELINK_EVERY} from "../packages/harness-overlay/src/host/knowledge-curator.ts";

test("the weekly link pass picks the least-connected notes, newest first, at most ten", () => {
  const notes = Array.from({length: 14}, (_, i) => ({id: "n" + i, degree: i % 3, modifiedAt: i}));
  const picked = pickForRelink(notes);
  assert.ok(picked.length <= 10);
  assert.deepEqual(picked.slice(0, 5), ["n12", "n9", "n6", "n3", "n0"]);
  assert.ok(!picked.includes("n2"), "well-linked notes are left alone");
  assert.equal(RELINK_EVERY, 7 * 24 * 60 * 60 * 1000);
});
