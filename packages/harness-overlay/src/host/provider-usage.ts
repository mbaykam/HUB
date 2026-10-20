import type {UsageHost} from "./usage.ts";
import {parseSonioxUsage, parseUnlidUsage, type SonioxUsage, type SpeechUsagePeriod, type UnlidUsage} from "../usage-contract.ts";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid provider usage data");
  return value as Record<string, unknown>;
}
function amount(value: unknown): number {
  const number = typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0) throw Error("Invalid provider usage amount");
  return number;
}
function count(value: unknown): number {
  const number = amount(value);
  if (!Number.isSafeInteger(number)) throw Error("Invalid provider usage count");
  return number;
}

async function providerJson(host: UsageHost, url: string, key: string, provider: string): Promise<unknown> {
  // Hosts are fixed by the caller. Credentials never follow redirects or reach the browser.
  const response = await (host.fetch ?? globalThis.fetch)(url, {method:"GET", redirect:"error",
    headers:{authorization:`Bearer ${key}`, accept:"application/json", "cache-control":"no-store"}, signal:AbortSignal.timeout(10_000)});
  if (!response.ok) throw Error(`${provider} usage request failed (HTTP ${response.status}). Check the connection and API-key permissions.`);
  const reader = response.body?.getReader();
  if (!reader) throw Error(`${provider} returned empty usage data.`);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 256 * 1024) { await reader.cancel(); throw Error(`${provider} returned too much usage data.`); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** Account facts only. Key names, prefixes, IDs and response extras are discarded. */
export function parseUnlidAccountResponse(value: unknown) {
  const data = object(value), balance = amount(data.balance_usd), held = amount(data.held_usd);
  return {balance, held, available:Math.max(0,balance-held), usageMonthly:amount(data.month_spend_usd)};
}
export function parseUnlidCreditsResponse(value: unknown) {
  const data = object(object(value).data);
  return {totalCredits:amount(data.total_credits), totalUsage:amount(data.total_usage)};
}

export async function readUnlidUsage(host: UsageHost): Promise<UnlidUsage> {
  try {
    const key = (await host.credentials.resolve("UNLID_API_KEY"))?.value.trim();
    if (!key) return {state:"not-configured"};
    const current = parseUnlidAccountResponse(await providerJson(host,"https://api.unlid.ai/v1/me",key,"Unlid"));
    // Lifetime credits are supplementary: their failure must not hide a valid balance.
    let account, warning;
    try { account = parseUnlidCreditsResponse(await providerJson(host,"https://api.unlid.ai/v1/credits",key,"Unlid")); }
    catch { warning = "Lifetime totals are unavailable. Current balance and monthly spend are still shown."; }
    return parseUnlidUsage({state:"ready", ...current, ...(account ? {account} : {}), ...(warning ? {warning} : {})});
  } catch {
    return {state:"error", message:"Unlid usage is unavailable. Check the API key and connection, then refresh."};
  }
}

function period(): SpeechUsagePeriod { return {costUsd:0, requests:0, inputAudioMs:0, outputAudioMs:0}; }
function add(total: SpeechUsagePeriod, row: SpeechUsagePeriod): SpeechUsagePeriod {
  return {costUsd:total.costUsd+row.costUsd, requests:total.requests+row.requests, inputAudioMs:total.inputAudioMs+row.inputAudioMs, outputAudioMs:total.outputAudioMs+row.outputAudioMs};
}
function dateKey(value: Date) { return value.toISOString().slice(0,10); }
function series(value: unknown, now: Date) {
  const data = object(value);
  if (!Array.isArray(data.days) || data.days.length > 38) throw Error("Invalid usage dates");
  const keys = ["cost_usd","num_requests","input_audio_duration_ms","output_audio_duration_ms"] as const;
  for (const key of keys) if (!Array.isArray(data[key]) || data[key].length !== data.days.length) throw Error("Misaligned usage series");
  const arrays = keys.map(key => data[key] as unknown[]);
  const todayKey = dateKey(now), monthKey = todayKey.slice(0,7), weekKey = dateKey(new Date(now.getTime()-6*86400_000));
  let today = period(), last7Days = period(), month = period(), previous = "";
  for (let index=0;index<data.days.length;index++) {
    const day = data.days[index];
    if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || dateKey(new Date(day)) !== day || day <= previous || day > todayKey) throw Error("Invalid usage date");
    previous = day;
    const row = {costUsd:amount(arrays[0]![index]), requests:count(arrays[1]![index]), inputAudioMs:count(arrays[2]![index]), outputAudioMs:count(arrays[3]![index])};
    if (day === todayKey) today = row;
    if (day >= weekKey) last7Days = add(last7Days,row);
    if (day.startsWith(monthKey)) month = add(month,row);
  }
  return {today,last7Days,month};
}

/** Use the provider's total series; adding the model rows would double-count it. */
export function parseSonioxSummaryResponse(value: unknown, now = new Date()): SonioxUsage {
  const data = object(value);
  if (!Array.isArray(data.models) || data.models.length > 256) throw Error("Invalid Soniox model summary");
  return parseSonioxUsage({state:"ready", ...series(data.total,now), models:data.models.map(value => {
    const model = object(value);
    return {id:model.model, month:series(model,now).month};
  })});
}

export async function readSonioxUsage(host: UsageHost, now = new Date()): Promise<SonioxUsage> {
  try {
    const key = (await host.credentials.resolve("SONIOX_API_KEY"))?.value.trim();
    if (!key) return {state:"not-configured"};
    const monthStart = Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1);
    const weekStart = Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-6);
    const url = new URL("https://api.soniox.com/v1/usage/summary");
    url.searchParams.set("start_time",new Date(Math.min(monthStart,weekStart)).toISOString());
    url.searchParams.set("end_time",now.toISOString());
    return parseSonioxSummaryResponse(await providerJson(host,url.href,key,"Soniox"),now);
  } catch {
    return {state:"error",message:"Soniox usage is unavailable. Check the project API key and connection, then refresh."};
  }
}
