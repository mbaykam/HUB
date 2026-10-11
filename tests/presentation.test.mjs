import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parsePresentation, parsePresentationSummary } from "@minke/harness-overlay/presentation-contract.ts";
import { PresentationRuntime, presentationDocument } from "@minke/harness-overlay/host/presentation.ts";
import { staticPresentation, interactivePresentation } from "../scripts/voice/presentation-fixtures.mjs";

test("visual contracts bound content and prevent external, prototype and explosive data inputs", () => {
  assert.deepEqual(parsePresentation(staticPresentation), staticPresentation);
  const parsed = parsePresentation(interactivePresentation); assert.deepEqual(parsed, interactivePresentation); assert.notEqual(parsed.spec, interactivePresentation.spec);
  for (const input of [
    { ...staticPresentation, title: "" }, { ...staticPresentation, html: "x".repeat(128001) },
    { title: "Bad", kind: "js", code: "alert(1)" },
    { ...interactivePresentation, spec: { width: Infinity } },
    { ...interactivePresentation, spec: { data: [{ url: "https://example.com" }] } },
    { ...interactivePresentation, spec: { data: [{ values: Array(5001).fill(0) }] } },
    { ...interactivePresentation, spec: { data: [{ transform: [{ type: "sequence", stop: 1e20 }] }] } },
    { ...interactivePresentation, spec: { data: [{ transform: [{ type: "cross" }] }] } },
    { ...interactivePresentation, spec: JSON.parse('{"__proto__":{}}') },
  ]) assert.throws(() => parsePresentation(input));
  assert.throws(() => parsePresentationSummary({ id: "-".repeat(36), title: "Bad", kind: "html", createdAt: 1 }));
});

test("native presentation tool is scoped, abort-safe, replaceable and revoked when voice closes", async () => {
  const runtime = new PresentationRuntime(); let definition, removed = 0;
  const agent = { id: "voice-one", ctx: { tools: { register(value) { definition = value; return () => removed++; } }, systemPrompt: { section() { return () => removed++; } } } };
  const off = runtime.attach(agent);
  await assert.rejects(definition.execute(staticPresentation, { agent: { id: "foreign" }, signal: new AbortController().signal }));
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(definition.execute(staticPresentation, { agent, signal: aborted.signal }));
  assert.equal(runtime.summary(agent.id), null);
  const one = await definition.execute(staticPresentation, { agent, signal: new AbortController().signal });
  const two = await definition.execute(interactivePresentation, { agent, signal: new AbortController().signal });
  assert.notEqual(one.id, two.id); assert.equal(two.status, "available");
  assert.throws(() => runtime.document(agent.id, one.id, ""));
  assert.equal(runtime.summary("foreign"), null);
  off(); off(); assert.equal(removed, 2); assert.equal(runtime.summary(agent.id), null);
  await assert.rejects(definition.execute(staticPresentation, { agent, signal: new AbortController().signal }));
});

test("failed tool/prompt installation can retry without leaving a phantom presentation owner", () => {
  const runtime = new PresentationRuntime(); let fail = true, removed = 0;
  const agent = { id: "voice-one", ctx: { tools: { register() { return () => removed++; } }, systemPrompt: { section() { if (fail) throw new Error("Fixture failure"); return () => {}; } } } };
  assert.throws(() => runtime.attach(agent)); assert.equal(removed, 1);
  fail = false; runtime.attach(agent)(); assert.equal(removed, 2);
});

test("visual document hashes only the fixed renderer and escapes model text out of HTML syntax", () => {
  const item = { ...staticPresentation, id: randomUUID(), createdAt: Date.now(), html: '</script><script>parent.location="https://example.com"</script>' };
  const doc = presentationDocument(item, "document.body.dataset.fixture='ready';");
  assert.match(doc, /script-src 'sha256-/); assert.match(doc, /connect-src 'none'/); assert.match(doc, /worker-src 'none'/);
  assert.doesNotMatch(doc, /unsafe-eval/); assert.doesNotMatch(doc, /<script>parent/); assert.match(doc, /\\u003c\/script/);
  assert.throws(() => presentationDocument(item, "'</script>'"));
});
