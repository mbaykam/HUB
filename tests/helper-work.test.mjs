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
  assert.equal(helperWork([]).outcome, "waiting");
  assert.equal(helperWork([{type: "turn/start"}], false).outcome, "waiting");
});

test("selected route is not execution evidence; actual sources and changes are recorded", () => {
  const selected = {type: "hub/helper-route", data: {preset: "auto", provider: "claude-code", model: "opus", billingBasis: "api", reason: "Subscription-first"}};
  assert.equal(helperWork([selected]).actualRoute, undefined);
  const work = helperWork([selected,
    {type: "request/header", time: 1, data: {header: {config: {provider: "claude-code", model: "opus"}}}},
    {type: "assistant/message", time: 2, data: {message: {...msg("Public update"), source: {provider: "claude-code", model: "opus"}}}},
    {type: "request/header", time: 3, data: {header: {config: {provider: "openrouter", model: "actual-model"}}}},
    {type: "assistant/message", time: 4, data: {message: {...msg("Observed response"), source: {provider: "openrouter", model: "actual-model"}}}},
  ]);
  assert.equal(work.routing.billingBasis, "subscription");
  assert.deepEqual(work.actualRoute, {provider: "openrouter", model: "actual-model", billingBasis: "api", evidence: "response"});
  assert.deepEqual(work.routeChanges, [{provider: "openrouter", model: "actual-model", billingBasis: "api", at: 3}]);
});

test("current operation clears on result; failures and only public findings are visible", () => {
  const start = [{type: "turn/start"}, {type: "tool/call", data: {name: "read", callId: "a", arguments: {file_path: "file.ts"}}}];
  assert.equal(helperWork(start).currentOperation, "read: file.ts");
  const work = helperWork([...start,
    {type: "tool/result", data: {message: {content: [{toolCallId: "a", isError: true, content: [{type: "text", text: "Not found"}]}]}}},
    {type: "assistant/message", data: {message: {content: [{type: "reasoning", text: "private"}, {type: "text", text: "File unavailable"}]}}},
    {type: "turn/end", data: {reason: {kind: "error", failure: {message: "Quota exhausted"}}}},
  ]);
  assert.equal(work.currentOperation, undefined);
  assert.equal(work.entries[0].status, "failed");
  assert.equal(work.entries[0].result, "Not found");
  assert.equal(work.findings, "File unavailable");
  assert.equal(work.blocker, "Quota exhausted");
  assert.equal(JSON.stringify(work).includes("private"), false);
});

test("retry waiting and attempt statuses come from real events and clear after response", () => {
  const events = [{type: "turn/start"}, {type: "llm/retry", data: {failure: {message: "Rate limited"}}}];
  assert.equal(helperWork(events).outcome, "waiting");
  events.push({type: "llm/retry-started"});
  assert.equal(helperWork(events).outcome, "retrying");
  events.push({type: "assistant/message", data: {message: msg("Finished")}}, {type: "turn/end", data: {reason: {kind: "completed"}}});
  const work = helperWork(events);
  assert.equal(work.outcome, "done");
  assert.equal(work.currentOperation, undefined);
  assert.equal(work.blocker, undefined);
  assert.equal(work.result, "Finished");
  assert.equal("percent" in work, false);
});
