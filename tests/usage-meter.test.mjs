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
import {parseUnlidAccountResponse,parseSonioxSummaryResponse,readUnlidUsage,readSonioxUsage} from "@minke/harness-overlay/host/provider-usage.ts";

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
  installMinkeUsageHost(host, request => request.headers["x-test-signed-in"] === "1" ? undefined : 401);
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
    { method: "GET", headers: { "sec-fetch-site": "cross-site", "x-test-signed-in":"1" } },
    forbidden,
  );
  assert.equal(forbidden.result.status, 403);

  const unsigned = response();
  await route.handler({method:"GET",headers:{}},unsigned);
  assert.equal(unsigned.result.status,401);
  assert.doesNotMatch(unsigned.result.body,/balance|credits|usage/i);

  const allowed = response();
  await route.handler(
    { method: "GET", headers: { "sec-fetch-site": "same-origin", "x-test-signed-in":"1" } },
    allowed,
  );
  assert.equal(allowed.result.status, 200);
  const snapshot = parseMinkeUsageSnapshot(JSON.parse(allowed.result.body));
  assert.equal(snapshot.codex.state, "ready");
  assert.equal(snapshot.openRouter.state, "ready");
  assert.doesNotMatch(allowed.result.body, /private|creator|label|sk-or/iu);
});

const usageHost = (fetch, resolve = async () => ({value:"private-test-key"})) => ({webServer:{port:7711,register(){}},credentials:{resolve},fetch});
const summaryRow = (model=null) => ({model,days:["2026-12-27","2026-12-31","2027-01-01","2027-01-02"],
  cost_usd:["0.1","0.2","0.3","0.4"],num_requests:[1,2,3,4],input_audio_duration_ms:[1000,2000,3000,4000],output_audio_duration_ms:[0,0,1000,2000]});
const summary = () => ({total:summaryRow(),models:[summaryRow("stt-rt-v5")]});
const now = new Date("2027-01-02T23:30:00Z");

test("Unlid account facts exclude identity and subtract reservations only once", () => {
  assert.deepEqual(parseUnlidAccountResponse({balance_usd:5,held_usd:"1.25",month_spend_usd:0.000133,key_prefix:"ul-private",email:"private@example.com"}),
    {balance:5,held:1.25,available:3.75,usageMonthly:0.000133});
  assert.equal(parseUnlidAccountResponse({balance_usd:0,held_usd:1,month_spend_usd:0}).available,0);
  assert.throws(()=>parseUnlidAccountResponse({balance_usd:NaN,held_usd:0,month_spend_usd:0}));
});

test("Unlid reads fixed billing endpoints with the current private credential", async () => {
  const calls=[];
  const host=usageHost(async(url,init)=>{
    calls.push({url,authorization:init.headers.authorization,redirect:init.redirect});
    return Response.json(url.endsWith("/me") ? {balance_usd:4,held_usd:0.25,month_spend_usd:1,key_name:"private"} : {data:{total_credits:5,total_usage:1}});
  },async ref=>{assert.equal(ref,"UNLID_API_KEY");return {value:"ul-private-test-key"};});
  const result=await readUnlidUsage(host);
  assert.equal(result.state,"ready");assert.equal(result.available,3.75);assert.equal(result.account.totalUsage,1);
  assert.deepEqual(calls.map(c=>c.url),["https://api.unlid.ai/v1/me","https://api.unlid.ai/v1/credits"]);
  assert.ok(calls.every(c=>c.redirect==="error"&&c.authorization==="Bearer ul-private-test-key"));
  assert.doesNotMatch(JSON.stringify(result),/private|key_name|authorization|ul-/i);
});

test("a failed Unlid credits read preserves a usable balance", async () => {
  const result=await readUnlidUsage(usageHost(async url=>url.endsWith("/me")
    ? Response.json({balance_usd:4,held_usd:0,month_spend_usd:1}) : new Response("private body",{status:503})));
  assert.equal(result.state,"ready");assert.equal(result.balance,4);assert.equal(result.account,undefined);assert.ok(result.warning);
});

test("Soniox uses total daily series once across UTC month and year boundaries", () => {
  const result=parseSonioxSummaryResponse(summary(),now);
  assert.equal(result.state,"ready");assert.equal(result.today.costUsd,0.4);assert.equal(result.last7Days.costUsd,1);
  assert.equal(result.month.costUsd,0.7);assert.equal(result.month.requests,7);assert.equal(result.month.inputAudioMs,7000);assert.equal(result.month.outputAudioMs,3000);
  assert.equal(result.models[0].id,"stt-rt-v5");assert.equal(result.models[0].month.costUsd,0.7);
});

test("Soniox summary fetch includes the seven-day window before the current month", async () => {
  let seen;
  const result=await readSonioxUsage(usageHost(async(url,init)=>{
    seen={url:new URL(url),init};return Response.json(summary());
  },async ref=>{assert.equal(ref,"SONIOX_API_KEY");return {value:"private-soniox-key"};}),now);
  assert.equal(result.state,"ready");assert.equal(seen.url.origin,"https://api.soniox.com");assert.equal(seen.url.pathname,"/v1/usage/summary");
  assert.equal(seen.url.searchParams.get("start_time"),"2026-12-27T00:00:00.000Z");
  assert.equal(seen.url.searchParams.get("end_time"),now.toISOString());assert.equal(seen.init.redirect,"error");
  assert.equal(seen.init.headers.authorization,"Bearer private-soniox-key");assert.doesNotMatch(JSON.stringify(result),/private-soniox-key/);
});

test("Soniox rejects missing, misaligned and invalid data instead of reporting zero spend", () => {
  for(const edit of [row=>delete row.cost_usd,row=>row.cost_usd.pop(),row=>row.cost_usd[0]="NaN",row=>row.num_requests[0]=-1,row=>row.days[0]="2026-02-30",row=>row.days.reverse()]){
    const data=summary();edit(data.total);assert.throws(()=>parseSonioxSummaryResponse(data,now));
  }
});

test("Soniox accepts a real zero-usage response without invented model rows", () => {
  const total={model:null,days:["2027-01-02"],cost_usd:["0.0000000000"],num_requests:[0],input_audio_duration_ms:[0],output_audio_duration_ms:[0]};
  const result=parseSonioxSummaryResponse({total,models:[]},now);
  assert.equal(result.state,"ready");assert.equal(result.month.costUsd,0);assert.equal(result.month.requests,0);assert.deepEqual(result.models,[]);
});

test("unconfigured providers make no external request and failures never echo secrets", async () => {
  const missing=usageHost(()=>{throw Error("Must not fetch");},async()=>undefined);
  assert.deepEqual(await readUnlidUsage(missing),{state:"not-configured"});assert.deepEqual(await readSonioxUsage(missing,now),{state:"not-configured"});
  const failed=usageHost(async()=>{throw Error("Bearer ul-private-test-key and secret-soniox-value");});
  for(const result of [await readUnlidUsage(failed),await readSonioxUsage(failed,now)]){
    assert.equal(result.state,"error");assert.doesNotMatch(JSON.stringify(result),/private-test-key|secret-soniox-value/);
  }
});

test("unreadable and oversized provider data stays an error without leaking bodies", async () => {
  for(const body of ["not JSON, secret-soniox-value"," ".repeat(256*1024+1)]) {
    const result=await readSonioxUsage(usageHost(async()=>new Response(body)),now);
    assert.equal(result.state,"error");assert.doesNotMatch(JSON.stringify(result),/secret-soniox-value/);
  }
});

test("old hosts show an update message rather than false unconfigured trackers", () => {
  const result=parseMinkeUsageSnapshot({updatedAt:now.toISOString(),codex:{state:"signed-out"},openRouter:{state:"not-configured"}});
  assert.equal(result.unlid.state,"error");assert.match(result.unlid.message,/Update/);assert.equal(result.soniox.state,"error");
});
