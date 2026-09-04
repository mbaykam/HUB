import assert from "node:assert/strict";
import test from "node:test";
import {
  installMinkeUsageHost,
  parseOpenRouterCreditsResponse,
  parseOpenRouterKeyResponse,
  readCodexUsage,
  readOpenRouterUsage,
} from "@minke/harness-overlay/host/usage.ts";
import {
  MINKE_USAGE_ROUTE,
  parseMinkeUsageSnapshot,
} from "@minke/harness-overlay/usage-contract.ts";

const openRouterKey = {
  data: {
    is_free_tier: false,
    is_management_key: false,
    limit: 50,
    limit_remaining: 38.75,
    limit_reset: "monthly",
    usage: 11.25,
    usage_daily: 0.4,
    usage_weekly: 2.5,
    usage_monthly: 8.75,
    label: "sk-or-v1-should-never-cross-the-boundary",
    creator_user_id: "private-user-id",
  },
};

const codexStatus = {
  status: "signed-in",
  usage: {
    rateLimits: [
      {
        id: "codex",
        name: "Codex",
        windows: [
          { remainingPercent: 72.5, windowSeconds: 18_000 },
          { remainingPercent: 64, windowSeconds: 604_800 },
        ],
      },
    ],
    credits: { unlimited: true },
  },
};

test("OpenRouter key parsing keeps only meter-safe fields", () => {
  assert.deepEqual(parseOpenRouterKeyResponse(openRouterKey), {
    isFreeTier: false,
    isManagementKey: false,
    limit: { amount: 50, remaining: 38.75, reset: "monthly" },
    usage: 11.25,
    usageDaily: 0.4,
    usageWeekly: 2.5,
    usageMonthly: 8.75,
  });
  assert.deepEqual(
    parseOpenRouterCreditsResponse({
      data: { total_credits: 100, total_usage: 25.25 },
    }),
    { totalCredits: 100, totalUsage: 25.25 },
  );
});

test("OpenRouter usage resolves credentials on the Host without returning them", async () => {
  const calls = [];
  const snapshot = await readOpenRouterUsage({
    webServer: { port: 4312, register() {} },
    credentials: {
      async resolve(ref) {
        assert.equal(ref, "OPENROUTER_API_KEY");
        return { value: "sk-or-v1-private-test-key" };
      },
    },
    async fetch(url, init) {
      calls.push({ url, authorization: init.headers.authorization });
      return new Response(JSON.stringify(openRouterKey), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(snapshot.state, "ready");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/key");
  assert.equal(calls[0].authorization, "Bearer sk-or-v1-private-test-key");
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /private|creator|label|sk-or/iu);
});

test("OpenRouter requests account credits only for a management key", async () => {
  const calls = [];
  const snapshot = await readOpenRouterUsage({
    webServer: { port: 4312, register() {} },
    credentials: {
      async resolve() {
        return { value: "management-key" };
      },
    },
    async fetch(url) {
      calls.push(url);
      if (url.endsWith("/credits")) {
        return new Response(
          JSON.stringify({ data: { total_credits: 80, total_usage: 12 } }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            ...openRouterKey.data,
            is_management_key: true,
          },
        }),
        { status: 200 },
      );
    },
  });
  assert.deepEqual(calls, [
    "https://openrouter.ai/api/v1/key",
    "https://openrouter.ai/api/v1/credits",
  ]);
  assert.equal(snapshot.state, "ready");
  assert.deepEqual(snapshot.account, {
    totalCredits: 80,
    totalUsage: 12,
  });
});

test("Codex usage is bridged through the installed plugin's loopback route", async () => {
  const calls = [];
  const snapshot = await readCodexUsage({
    webServer: { port: 5544, register() {} },
    credentials: { async resolve() {} },
    async fetch(url) {
      calls.push(url);
      return new Response(JSON.stringify(codexStatus), { status: 200 });
    },
  });
  assert.deepEqual(calls, [
    "http://127.0.0.1:5544/plugins/dsh-openai-codex/auth/status",
  ]);
  assert.equal(snapshot.state, "ready");
  assert.equal(snapshot.rateLimits[0].windows[0].remainingPercent, 72.5);
});

test("usage route rejects cross-site requests and returns a valid snapshot", async () => {
  let route;
  const host = {
    webServer: {
      port: 7711,
      register(candidate) {
        route = candidate;
        return () => {};
      },
    },
    credentials: {
      async resolve() {
        return { value: "sk-or-v1-private-test-key" };
      },
    },
    async fetch(url) {
      return new Response(
        JSON.stringify(
          url.includes("dsh-openai-codex") ? codexStatus : openRouterKey,
        ),
        { status: 200 },
      );
    },
  };
  installMinkeUsageHost(host);
  assert.equal(route.path, MINKE_USAGE_ROUTE);

  const response = () => {
    const result = { status: 0, headers: {}, body: "" };
    return {
      result,
      writeHead(status, headers = {}) {
        result.status = status;
        result.headers = headers;
      },
      end(body = "") {
        result.body = String(body);
      },
    };
  };
  const forbidden = response();
  await route.handler(
    { method: "GET", headers: { "sec-fetch-site": "cross-site" } },
    forbidden,
  );
  assert.equal(forbidden.result.status, 403);

  const allowed = response();
  await route.handler(
    { method: "GET", headers: { "sec-fetch-site": "same-origin" } },
    allowed,
  );
  assert.equal(allowed.result.status, 200);
  const snapshot = parseMinkeUsageSnapshot(JSON.parse(allowed.result.body));
  assert.equal(snapshot.codex.state, "ready");
  assert.equal(snapshot.openRouter.state, "ready");
  assert.doesNotMatch(allowed.result.body, /private|creator|label|sk-or/iu);
});
