import test from "node:test";
import assert from "node:assert/strict";
import {KnowledgeCurator, KNOWLEDGE_CALL_TIMEOUT_MS} from "../packages/harness-overlay/src/host/knowledge-curator.ts";

test("a Knowledge AI call that never answers is cut off instead of freezing the queue", async () => {
  assert.equal(KNOWLEDGE_CALL_TIMEOUT_MS, 300000);
  let seen;
  const hang = (_prompt, _settings, signal) => new Promise((_, reject) => { seen = signal; signal.addEventListener("abort", () => reject(signal.reason), {once: true}); });
  const curator = new KnowledgeCurator({}, hang, undefined, undefined, 30);
  const started = Date.now();
  await assert.rejects(curator.generate("p", {}, new AbortController().signal), error => error?.name === "TimeoutError");
  assert.ok(Date.now() - started < 2000);
  assert.ok(seen.aborted);
  const stop = new AbortController();
  const pending = curator.generate("p", {}, stop.signal);
  stop.abort(new Error("HUB is stopping"));
  await assert.rejects(pending, /HUB is stopping/);
});
