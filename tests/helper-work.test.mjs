import test from "node:test";
import assert from "node:assert/strict";
import {helperWork} from "../packages/harness-overlay/src/host/helper-work.ts";

const msg = text => ({content: [{type: "text", text}]});

test("a helper's brief, steps, failures and replies are condensed for the phone", () => {
  const work = helperWork([
    {type: "user/message", time: 1, data: {message: msg("Compare three noodle cookers under 20k TL.")}},
    {type: "turn/start", time: 2},
    {type: "tool/call", time: 3, data: {name: "web_search", callId: "c1", arguments: JSON.stringify({query: "pasta cooker 4 basket price"})}},
    {type: "tool/result", time: 4, data: {message: {content: [{type: "tool-result", toolCallId: "c1", isError: true}]}}},
    {type: "tool/call", time: 5, data: {name: "web_fetch", callId: "c2", arguments: {url: "https://example.com/cooker"}}},
    {type: "assistant/message", time: 6, data: {message: msg("The Empero 4-basket model is the best fit.")}},
    {type: "turn/end", time: 7, data: {reason: {kind: "completed"}}},
  ]);
  assert.equal(work.brief, "Compare three noodle cookers under 20k TL.");
  assert.equal(work.outcome, "done");
  assert.deepEqual(work.entries.map(e => e.kind), ["step", "step", "text"]);
  assert.equal(work.entries[0].detail, "pasta cooker 4 basket price");
  assert.equal(work.entries[0].failed, true);
  assert.equal(work.entries[1].detail, "https://example.com/cooker");
});

test("a stopped or failed helper says so", () => {
  assert.equal(helperWork([{type: "turn/end", data: {reason: {kind: "aborted"}}}]).outcome, "stopped");
  assert.equal(helperWork([{type: "turn/end", data: {reason: {kind: "error"}}}]).outcome, "failed");
  assert.equal(helperWork([{type: "turn/start"}]).outcome, "running");
});
