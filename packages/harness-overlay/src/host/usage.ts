import type {
  IncomingMessage,
  ServerResponse,
} from "node:http";
import {
  MINKE_USAGE_ROUTE,
  parseCodexUsage,
  parseMinkeUsageSnapshot,
  parseOpenRouterUsage,
  type CodexUsage,
  type MinkeUsageSnapshot,
  type OpenRouterUsage,
} from "../usage-contract.ts";

const CODEX_STATUS_PATH = "/plugins/dsh-openai-codex/auth/status";
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const OPENROUTER_CREDITS_URL =
  "https://openrouter.ai/api/v1/credits";
const OPENROUTER_API_KEY_REF = "OPENROUTER_API_KEY";
const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 256 * 1024;

interface UsageRoute {
  readonly kind: "exact";
  readonly path: string;
  readonly handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void | Promise<void>;
}

export interface UsageWebServer {
  readonly port: number;
  register(route: UsageRoute): () => void;
}

export interface UsageCredentials {
  resolve(ref: string): Promise<
    | { readonly value: string }
    | undefined
  >;
}

export interface UsageHost {
  readonly webServer: UsageWebServer;
  readonly credentials: UsageCredentials;
  readonly fetch?: typeof globalThis.fetch;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function safeMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = raw
    .replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/gu, "[redacted key]")
    .slice(0, 220)
    .trim();
  return redacted === "" ? fallback : redacted;
}

async function responseJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    throw new Error("Usage provider returned too much data");
  }
  const body = await response.text();
  if (body.length > MAX_JSON_BYTES) {
    throw new Error("Usage provider returned too much data");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new Error("Usage provider returned unreadable data", {
      cause: error,
    });
  }
}

async function providerJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  apiKey: string,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "error",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
      "cache-control": "no-store",
      "user-agent": "Minke usage meter",
    },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("OpenRouter rejected the configured API key");
    }
    throw new Error(
      `OpenRouter usage request failed with HTTP ${String(response.status)}`,
    );
  }
  return await responseJson(response);
}

function finiteAmount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`OpenRouter returned an invalid ${label}`);
  }
  return value;
}

export function parseOpenRouterKeyResponse(value: unknown): Readonly<{
  usage: number;
  usageDaily: number;
  usageWeekly: number;
  usageMonthly: number;
  isFreeTier: boolean;
  isManagementKey: boolean;
  limit?: {
    amount: number;
    remaining: number;
    reset?: "daily" | "weekly" | "monthly";
  };
}> {
  const root = object(value, "OpenRouter key response");
  const data = object(root.data, "OpenRouter key data");
  if (
    typeof data.is_free_tier !== "boolean" ||
    typeof data.is_management_key !== "boolean"
  ) {
    throw new TypeError("OpenRouter returned invalid key metadata");
  }
  const limitAmount = data.limit;
  const limitRemaining = data.limit_remaining;
  let limit:
    | {
        amount: number;
        remaining: number;
        reset?: "daily" | "weekly" | "monthly";
      }
    | undefined;
  if (limitAmount !== undefined && limitAmount !== null) {
    const reset = data.limit_reset;
    if (
      reset !== undefined &&
      reset !== null &&
      reset !== "daily" &&
      reset !== "weekly" &&
      reset !== "monthly"
    ) {
      throw new TypeError("OpenRouter returned an invalid limit reset");
    }
    limit = {
      amount: finiteAmount(limitAmount, "key limit"),
      remaining: finiteAmount(limitRemaining, "remaining key limit"),
      ...(reset === undefined || reset === null ? {} : { reset }),
    };
  }
  return {
    usage: finiteAmount(data.usage, "total usage"),
    usageDaily: finiteAmount(data.usage_daily, "daily usage"),
    usageWeekly: finiteAmount(data.usage_weekly, "weekly usage"),
    usageMonthly: finiteAmount(data.usage_monthly, "monthly usage"),
    isFreeTier: data.is_free_tier,
    isManagementKey: data.is_management_key,
    ...(limit === undefined ? {} : { limit }),
  };
}

export function parseOpenRouterCreditsResponse(value: unknown): Readonly<{
  totalCredits: number;
  totalUsage: number;
}> {
  const root = object(value, "OpenRouter credits response");
  const data = object(root.data, "OpenRouter credits data");
  return {
    totalCredits: finiteAmount(data.total_credits, "total credits"),
    totalUsage: finiteAmount(data.total_usage, "account usage"),
  };
}

export async function readOpenRouterUsage(
  host: UsageHost,
): Promise<OpenRouterUsage> {
  const credential = await host.credentials.resolve(
    OPENROUTER_API_KEY_REF,
  );
  const apiKey = credential?.value.trim();
  if (apiKey === undefined || apiKey === "") {
    return { state: "not-configured" };
  }
  const fetchImpl = host.fetch ?? globalThis.fetch;
  try {
    const key = parseOpenRouterKeyResponse(
      await providerJson(fetchImpl, OPENROUTER_KEY_URL, apiKey),
    );
    const account = key.isManagementKey
      ? parseOpenRouterCreditsResponse(
          await providerJson(
            fetchImpl,
            OPENROUTER_CREDITS_URL,
            apiKey,
          ),
        )
      : undefined;
    return parseOpenRouterUsage({
      state: "ready",
      isFreeTier: key.isFreeTier,
      usage: key.usage,
      usageDaily: key.usageDaily,
      usageWeekly: key.usageWeekly,
      usageMonthly: key.usageMonthly,
      ...(key.limit === undefined ? {} : { limit: key.limit }),
      ...(account === undefined ? {} : { account }),
    });
  } catch (error) {
    return {
      state: "error",
      message: safeMessage(error, "OpenRouter usage is unavailable"),
    };
  }
}

export async function readCodexUsage(host: UsageHost): Promise<CodexUsage> {
  const fetchImpl = host.fetch ?? globalThis.fetch;
  try {
    const response = await fetchImpl(
      `http://127.0.0.1:${String(host.webServer.port)}${CODEX_STATUS_PATH}`,
      {
        method: "GET",
        redirect: "error",
        headers: {
          accept: "application/json",
          "cache-control": "no-store",
        },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new Error(
        response.status === 404
          ? "Codex Connect Plus is unavailable"
          : `Codex usage request failed with HTTP ${String(response.status)}`,
      );
    }
    const status = object(await responseJson(response), "Codex status");
    if (status.status === "signed-out") return { state: "signed-out" };
    if (status.status !== "signed-in") {
      throw new Error("Codex usage is temporarily unavailable");
    }
    const usage = object(status.usage, "Codex usage payload");
    return parseCodexUsage({
      state: "ready",
      rateLimits: usage.rateLimits,
      ...(usage.credits === undefined ? {} : { credits: usage.credits }),
      ...(usage.individualLimit === undefined
        ? {}
        : { individualLimit: usage.individualLimit }),
      ...(typeof status.quotaError === "string"
        ? {
            warning: safeMessage(
              status.quotaError,
              "Some Codex limits are unavailable",
            ),
          }
        : {}),
    });
  } catch (error) {
    return {
      state: "error",
      message: safeMessage(error, "Codex usage is unavailable"),
    };
  }
}

export async function readMinkeUsage(
  host: UsageHost,
): Promise<MinkeUsageSnapshot> {
  const [codex, openRouter] = await Promise.all([
    readCodexUsage(host),
    readOpenRouterUsage(host),
  ]);
  return parseMinkeUsageSnapshot({
    updatedAt: new Date().toISOString(),
    codex,
    openRouter,
  });
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

/** Register one secret-free, read-only endpoint for the mobile usage meter. */
export function installMinkeUsageHost(host: UsageHost): () => void {
  return host.webServer.register({
    kind: "exact",
    path: MINKE_USAGE_ROUTE,
    async handler(request, response) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { allow: "GET, HEAD" });
        response.end();
        return;
      }
      if (request.headers["sec-fetch-site"] === "cross-site") {
        sendJson(response, 403, { error: "forbidden" });
        return;
      }
      const snapshot = await readMinkeUsage(host);
      if (request.method === "HEAD") {
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end();
        return;
      }
      sendJson(response, 200, snapshot);
    },
  });
}
