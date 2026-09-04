/** Secret-free usage data shared between the HUB Host and mobile client. */

export const MINKE_USAGE_ROUTE = "/minke/api/usage";

export interface UsageWindow {
  readonly remainingPercent: number;
  readonly windowSeconds: number;
}

export interface UsageRateLimit {
  readonly id: string;
  readonly name?: string;
  readonly windows: readonly UsageWindow[];
}

export interface CodexUsageReady {
  readonly state: "ready";
  readonly rateLimits: readonly UsageRateLimit[];
  readonly credits?: {
    readonly unlimited: boolean;
    readonly balance?: string;
  };
  readonly individualLimit?: {
    readonly limit: string;
    readonly used: string;
    readonly remaining: string;
    readonly remainingPercent: number;
  };
  readonly warning?: string;
}

export type CodexUsage =
  | CodexUsageReady
  | { readonly state: "signed-out" }
  | { readonly state: "error"; readonly message: string };

export interface OpenRouterUsageReady {
  readonly state: "ready";
  readonly isFreeTier: boolean;
  readonly usage: number;
  readonly usageDaily: number;
  readonly usageWeekly: number;
  readonly usageMonthly: number;
  readonly limit?: {
    readonly amount: number;
    readonly remaining: number;
    readonly reset?: "daily" | "weekly" | "monthly";
  };
  readonly account?: {
    readonly totalCredits: number;
    readonly totalUsage: number;
  };
}

export type OpenRouterUsage =
  | OpenRouterUsageReady
  | { readonly state: "not-configured" }
  | { readonly state: "error"; readonly message: string };

export interface MinkeUsageSnapshot {
  readonly updatedAt: string;
  readonly codex: CodexUsage;
  readonly openRouter: OpenRouterUsage;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 240) {
    throw new TypeError(`${label} must be a short non-empty string`);
  }
  return value;
}

function amount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative finite number`);
  }
  return value;
}

function percent(value: unknown, label: string): number {
  const parsed = amount(value, label);
  if (parsed > 100) throw new TypeError(`${label} must not exceed 100`);
  return parsed;
}

function exactAmount(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 64 ||
    !/^-?\d+(?:\.\d+)?$/u.test(value)
  ) {
    throw new TypeError(`${label} must be a decimal string`);
  }
  return value;
}

function parseRateLimits(value: unknown): readonly UsageRateLimit[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Codex rate limits must be an array");
  }
  return value.map((entry, limitIndex) => {
    const limit = record(entry, `Codex rate limit ${String(limitIndex)}`);
    if (!Array.isArray(limit.windows)) {
      throw new TypeError("Codex rate-limit windows must be an array");
    }
    const name = limit.name;
    return {
      id: text(limit.id, "Codex rate-limit id"),
      ...(name === undefined
        ? {}
        : { name: text(name, "Codex rate-limit name") }),
      windows: limit.windows.map((entry, windowIndex) => {
        const window = record(
          entry,
          `Codex rate-limit window ${String(windowIndex)}`,
        );
        const windowSeconds = amount(
          window.windowSeconds,
          "Codex window length",
        );
        if (!Number.isInteger(windowSeconds) || windowSeconds === 0) {
          throw new TypeError("Codex window length must be a positive integer");
        }
        return {
          remainingPercent: percent(
            window.remainingPercent,
            "Codex remaining percentage",
          ),
          windowSeconds,
        };
      }),
    };
  });
}

export function parseCodexUsage(value: unknown): CodexUsage {
  const codex = record(value, "Codex usage");
  if (codex.state === "signed-out") return { state: "signed-out" };
  if (codex.state === "error") {
    return {
      state: "error",
      message: text(codex.message, "Codex error"),
    };
  }
  if (codex.state !== "ready") {
    throw new TypeError("Codex usage state is invalid");
  }
  const creditsValue = codex.credits;
  let credits: CodexUsageReady["credits"];
  if (creditsValue !== undefined) {
    const parsed = record(creditsValue, "Codex credits");
    if (typeof parsed.unlimited !== "boolean") {
      throw new TypeError("Codex unlimited flag must be boolean");
    }
    credits = {
      unlimited: parsed.unlimited,
      ...(parsed.balance === undefined
        ? {}
        : { balance: exactAmount(parsed.balance, "Codex credit balance") }),
    };
  }
  const individualValue = codex.individualLimit;
  let individualLimit: CodexUsageReady["individualLimit"];
  if (individualValue !== undefined) {
    const parsed = record(individualValue, "Codex individual limit");
    individualLimit = {
      limit: exactAmount(parsed.limit, "Codex individual limit"),
      used: exactAmount(parsed.used, "Codex individual usage"),
      remaining: exactAmount(
        parsed.remaining,
        "Codex individual remaining amount",
      ),
      remainingPercent: percent(
        parsed.remainingPercent,
        "Codex individual remaining percentage",
      ),
    };
  }
  return {
    state: "ready",
    rateLimits: parseRateLimits(codex.rateLimits),
    ...(credits === undefined ? {} : { credits }),
    ...(individualLimit === undefined ? {} : { individualLimit }),
    ...(codex.warning === undefined
      ? {}
      : { warning: text(codex.warning, "Codex usage warning") }),
  };
}

export function parseOpenRouterUsage(value: unknown): OpenRouterUsage {
  const openRouter = record(value, "OpenRouter usage");
  if (openRouter.state === "not-configured") {
    return { state: "not-configured" };
  }
  if (openRouter.state === "error") {
    return {
      state: "error",
      message: text(openRouter.message, "OpenRouter error"),
    };
  }
  if (openRouter.state !== "ready") {
    throw new TypeError("OpenRouter usage state is invalid");
  }
  if (typeof openRouter.isFreeTier !== "boolean") {
    throw new TypeError("OpenRouter free-tier flag must be boolean");
  }
  const limitValue = openRouter.limit;
  let limit: OpenRouterUsageReady["limit"];
  if (limitValue !== undefined) {
    const parsed = record(limitValue, "OpenRouter limit");
    const reset = parsed.reset;
    if (
      reset !== undefined &&
      reset !== "daily" &&
      reset !== "weekly" &&
      reset !== "monthly"
    ) {
      throw new TypeError("OpenRouter limit reset is invalid");
    }
    limit = {
      amount: amount(parsed.amount, "OpenRouter limit"),
      remaining: amount(parsed.remaining, "OpenRouter remaining limit"),
      ...(reset === undefined ? {} : { reset }),
    };
  }
  const accountValue = openRouter.account;
  let account: OpenRouterUsageReady["account"];
  if (accountValue !== undefined) {
    const parsed = record(accountValue, "OpenRouter account usage");
    account = {
      totalCredits: amount(
        parsed.totalCredits,
        "OpenRouter total credits",
      ),
      totalUsage: amount(parsed.totalUsage, "OpenRouter total usage"),
    };
  }
  return {
    state: "ready",
    isFreeTier: openRouter.isFreeTier,
    usage: amount(openRouter.usage, "OpenRouter total key usage"),
    usageDaily: amount(openRouter.usageDaily, "OpenRouter daily usage"),
    usageWeekly: amount(openRouter.usageWeekly, "OpenRouter weekly usage"),
    usageMonthly: amount(openRouter.usageMonthly, "OpenRouter monthly usage"),
    ...(limit === undefined ? {} : { limit }),
    ...(account === undefined ? {} : { account }),
  };
}

/** Validate all data before it reaches either side of the browser boundary. */
export function parseMinkeUsageSnapshot(value: unknown): MinkeUsageSnapshot {
  const snapshot = record(value, "HUB usage snapshot");
  const updatedAt = text(snapshot.updatedAt, "HUB usage timestamp");
  if (!Number.isFinite(Date.parse(updatedAt))) {
    throw new TypeError("HUB usage timestamp is invalid");
  }
  return {
    updatedAt,
    codex: parseCodexUsage(snapshot.codex),
    openRouter: parseOpenRouterUsage(snapshot.openRouter),
  };
}
