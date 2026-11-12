import assert from "node:assert/strict";
import test from "node:test";
import {collectConversationUsage, installConversationUsage} from "@minke/harness-overlay/host/conversation-usage.ts";
import {readOpenRouterGenerationCost} from "@minke/harness-overlay/host/usage.ts";

const response = (turn, id, usage) => ({
  type: "assistant/message",
  data: {turn, usage, message: {source: {provider: "openrouter", replayState: {response: {responseId: id}}}}},
});

test("conversation token totals use recorded buckets and do not double-count replayed generations", () => {
  const rows = [
    response(1, "gen-one", {inputTokens: 2, outputTokens: 3, cacheReadTokens: 60, cacheWriteTokens: 0, totalTokens: 65}),
    response(1, "gen-one", {inputTokens: 2, outputTokens: 3, totalTokens: 65}),
    response(2, "gen-two", {inputTokens: 5, outputTokens: 1}),
    response(2, undefined),
  ];
  const usage = collectConversationUsage(rows, "conversation");
  assert.deepEqual(usage.tokens, {uncachedInput: 7, output: 4, total: 65, cacheReadReported: 60, cacheWriteReported: 0});
  assert.equal(usage.calls, 3);
  assert.equal(usage.recordedCalls, 2);
  assert.equal(usage.callsWithTotal, 1);
  assert.equal(usage.untrackedOpenRouterRequests, 1);
  assert.deepEqual(collectConversationUsage(rows, "latest_turn").generationIds, ["gen-two"]);
});

test("receipt reader queries only the generation and validates provider cost and identity", async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  const fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://openrouter.ai/api/v1/generation?id=gen-one");
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.signal, signal);
    return Response.json({data: {id: "gen-one", total_cost: 0.0045}});
  };
  assert.equal(await readOpenRouterGenerationCost("gen-one", "fixture", signal, fetch), 0.0045);
  await assert.rejects(readOpenRouterGenerationCost("gen-one&bad", "fixture", signal, fetch));
  assert.equal(calls, 1);
  await assert.rejects(readOpenRouterGenerationCost("gen-one", "fixture", signal, async () =>
    Response.json({data: {id: "gen-other", total_cost: 2}})), /different generation/);
});

test("usage tool fails closed for workers and reports unavailable receipts without exposing keys", async () => {
  let tool;
  installConversationUsage({
    tools: {register(value) {tool = value; return () => {};}},
    credentials: {async resolve() {return undefined;}},
  });
  const signal = new AbortController().signal;
  const session = {
    header: {}, inheritedEventCount: 1,
    snapshotEvents: () => [
      response(1, "gen-parent", {inputTokens: 999, outputTokens: 0}),
      {type: "user/message", data: {source: {kind: "user"}}},
      response(2, "gen-current", {inputTokens: 2, outputTokens: 3, totalTokens: 5}),
    ],
  };
  const value = await tool.execute({}, {agent: {session}, signal});
  assert.equal(value.tokens.uncachedInput, 2);
  assert.deepEqual(value.openRouter, {status: "unknown", confirmedUsd: null, confirmedUSCents: null, confirmedRequests: 0, recordedRequests: 1});
  await assert.rejects(tool.execute({}, {agent: {session: {...session, header: {origin: "subagent"}}}, signal}), /current user conversation/);
});
