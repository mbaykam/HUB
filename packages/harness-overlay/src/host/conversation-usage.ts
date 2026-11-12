import {currentTurnHasUserRequest} from "./task-turn.ts";
import {readOpenRouterGenerationCost, type UsageCredentials} from "./usage.ts";

interface UsageEvent {
  type: string;
  data?: {
    turn?: number;
    usage?: Partial<Record<"inputTokens" | "outputTokens" | "totalTokens" | "cacheReadTokens" | "cacheWriteTokens", number>>;
    message?: {
      source?: {
        provider?: string;
        replayState?: {response?: {responseId?: string}};
      };
    };
  };
}
interface UsageAgent {
  session: {
    header: {origin?: string};
    inheritedEventCount?: number;
    snapshotEvents(): readonly UsageEvent[];
  };
}
interface UsageContext {
  credentials: UsageCredentials;
  tools: {register(definition: {
    name: string;
    description: string;
    parameters: object;
    output: {schema: object; render(args: unknown, value: unknown): {type: "text"; text: string}[]};
    timeoutMs: number;
    execute(args: {scope?: "conversation" | "latest_turn"}, exec: {agent?: UsageAgent; signal: AbortSignal}): Promise<unknown>;
  }): () => void};
}

const generationPattern = /^gen-[A-Za-z0-9_-]{1,160}$/u;
const receiptLimit = 32;
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function collectConversationUsage(events: readonly UsageEvent[], scope: "conversation" | "latest_turn") {
  const messages = events.filter(event => event.type === "assistant/message");
  const latestTurn = messages.at(-1)?.data?.turn;
  const generationIds = new Set<string>();
  let untrackedOpenRouterRequests = 0;
  let calls = 0;
  let recordedCalls = 0;
  let callsWithTotal = 0;
  const tokens = {uncachedInput: 0, output: 0, total: 0, cacheReadReported: 0, cacheWriteReported: 0};
  for (const {data} of messages) {
    if (!data || (scope === "latest_turn" && data.turn !== latestTurn)) continue;
    const source = data.message?.source;
    const id = source?.replayState?.response?.responseId;
    if (source?.provider === "openrouter") {
      if (id && generationPattern.test(id)) {
        if (generationIds.has(id)) continue;
        generationIds.add(id);
      } else {
        untrackedOpenRouterRequests++;
      }
    }
    calls++;
    const usage = data.usage;
    const input = count(usage?.inputTokens);
    const output = count(usage?.outputTokens);
    if (input === undefined || output === undefined) continue;
    const read = count(usage?.cacheReadTokens);
    const write = count(usage?.cacheWriteTokens);
    recordedCalls++;
    tokens.uncachedInput += input;
    tokens.output += output;
    tokens.cacheReadReported += read ?? 0;
    tokens.cacheWriteReported += write ?? 0;
    const total = count(usage?.totalTokens) ?? (read !== undefined && write !== undefined ? input + output + read + write : undefined);
    if (total !== undefined) {
      tokens.total += total;
      callsWithTotal++;
    }
  }
  return {calls, recordedCalls, callsWithTotal, tokens, generationIds: [...generationIds], untrackedOpenRouterRequests};
}

export function installConversationUsage(ctx: UsageContext) {
  const costs = new Map<string, number>();
  return ctx.tools.register({
    name: "hub_conversation_usage",
    description: "Read this conversation's recorded model token usage and OpenRouter billed USD. Use once for a spending question. Receipts are read-only and partial data is labeled. Never inspect keys, files or account settings to fill gaps. Usage covers recorded assistant responses before this tool returns, not future tokens, child sessions or attempts with no saved response.",
    parameters: {type: "object", properties: {scope: {enum: ["conversation", "latest_turn"]}}, additionalProperties: false},
    output: {schema: {type: "object"}, render: (_args, value) => [{type: "text", text: JSON.stringify(value)}]},
    timeoutMs: 12_000,
    async execute({scope = "conversation"}, {agent, signal}) {
      if (!agent || agent.session.header.origin === "subagent" || !currentTurnHasUserRequest(agent)) {
        throw new Error("Usage is available only in the current user conversation.");
      }
      signal.throwIfAborted();
      const {generationIds, untrackedOpenRouterRequests, ...recorded} = collectConversationUsage(
        agent.session.snapshotEvents().slice(agent.session.inheritedEventCount ?? 0), scope,
      );
      const totalRequests = generationIds.length + untrackedOpenRouterRequests;
      const toFetch = generationIds.filter(id => !costs.has(id)).slice(-receiptLimit);
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
      if (toFetch.length) {
        const key = (await ctx.credentials.resolve("OPENROUTER_API_KEY").catch(() => undefined))?.value.trim();
        if (key) {
          let next = 0;
          await Promise.all(Array.from({length: Math.min(4, toFetch.length)}, async () => {
            while (!timeout.aborted && next < toFetch.length) {
              const id = toFetch[next++]!;
              const cost = await readOpenRouterGenerationCost(id, key, timeout).catch(() => undefined);
              if (cost === undefined) continue;
              costs.set(id, cost);
              if (costs.size > 512) costs.delete(costs.keys().next().value!);
            }
          }));
        }
      }
      signal.throwIfAborted();
      const billed = generationIds.flatMap(id => costs.has(id) ? [costs.get(id)!] : []);
      const usd = billed.reduce((total, cost) => total + cost, 0);
      return {
        scope, ...recorded,
        openRouter: {
          status: totalRequests === 0 ? "no_recorded_requests" : billed.length === totalRequests ? "complete_for_recorded_requests" : billed.length ? "partial" : "unknown",
          confirmedUsd: billed.length ? Number(usd.toFixed(9)) : null,
          confirmedUSCents: billed.length ? Number((usd * 100).toFixed(7)) : null,
          confirmedRequests: billed.length, recordedRequests: totalRequests,
        },
      };
    },
  });
}
