import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { ModelCatalogStore } from "./host/model-catalog.ts";
import { installTelegramWeb } from "./host/telegram-web.ts";
import type { HubCatalogModel, HubModelCatalog } from "./model-catalog-contract.ts";
import {voiceRouteSchema} from "./voice-profile-contract.ts";

export const name = "hub-models";
export const inject = ["llm", "settings", "sessionController", "agentDefaultModel", "connection", "webServer"];
interface Model { id: string; name: string; provider: string; contextWindow?: number; maxTokens?: number;context?:{contextWindow:number};defaultMaxTokens?:number;inputModalities?:string[]; reasoning?: { efforts: { id: string; name?: string }[];defaultEffort?:string } }
interface Context {
  llm: { listProviders(): { id: string; name: string }[]; listModels(id: string): Promise<Model[]>; resolveModelInfo?(provider: string, model: string): Promise<Model>; resolveCallConfig(value: { provider: string; model: string; reasoningEffort?: string }): Promise<{ provider: string; model: string; reasoningEffort?: string }> };
  settings: { describe(options: { redactSecrets: true }): { ns: string; revision: number }[]; get(ns: string): unknown; mutate(ns: string, operations: { op: "set"; path: string[]; value: unknown }[], revision: number): Promise<void> };
  sessionController: { selectModel(value: { sessionId: string; provider: string; model: string; reasoningEffort?: string }): Promise<unknown> };
  agentDefaultModel: { saveSelection(value: { provider: string; model: string; reasoningEffort?: string }): Promise<void> };
  connection: { requestRejection(request: IncomingMessage): 401 | 403 | undefined };
  webServer: { register(route: { kind: "exact"; path: string; handler(req: IncomingMessage, res: ServerResponse): Promise<void> }): () => void };
  effect(callback: () => () => void, label: string): unknown;
}
function send(res: ServerResponse, code: number, data: unknown) { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(data)); }
async function body(req: IncomingMessage) {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 16_000) throw new Error("body-too-large"); chunks.push(chunk); }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("bad-request");
  return value;
}
function safe(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u0020\u007f]/.test(value); }
export function apply(ctx: Context, config: { root?: string; fetch?: typeof globalThis.fetch } = {}) {
  const dataHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const root = config.root ?? join(dataHome, "hub-model-catalog");
  if (!isAbsolute(root)) throw new Error("Model catalogue requires an absolute private store");
  const store = new ModelCatalogStore(root, config.fetch ?? globalThis.fetch);
  const removeTelegram = installTelegramWeb(ctx);
  const ready = store.load();
  async function snapshot(): Promise<HubModelCatalog> {
    await ready; store.revalidate();
    const current = store.snapshot();
    const providers = ctx.llm.listProviders();
    const active = new Map<string, HubCatalogModel>();
    for (const p of providers) {
      for (const m of await ctx.llm.listModels(p.id)) {
        // listModels is identity-only in native DSH; resolve the authoritative vocabulary.
        const info = ctx.llm.resolveModelInfo ? await ctx.llm.resolveModelInfo(p.id, m.id) : m;
        active.set(`${p.id}/${m.id}`, { provider: p.id, id: m.id, name: m.name, contextWindow: info.context?.contextWindow??info.contextWindow, maxTokens: info.maxTokens,
          defaults:info.defaultMaxTokens?{max_tokens:info.defaultMaxTokens}:{},defaultEffort:info.reasoning?.defaultEffort,
          input: info.inputModalities??["text"], tools: true, reasoning: !!info.reasoning, efforts: info.reasoning?.efforts.map(e => ({ id: e.id, name: e.name ?? e.id })), enabled: true, source: "installed" });
      }
    }
    for (const m of current.openrouter ?? []) {
      const key = `${m.provider}/${m.id}`, enabled = active.get(key);
      active.set(key, { ...m, enabled: !!enabled, ...(enabled?.efforts ? { efforts: enabled.efforts,defaultEffort:enabled.defaultEffort } : {}) });
    }
    for (const m of current.codex ?? []) {
      const key = `openai-codex/${m.id}`, enabled = active.get(key);
      active.set(key, { provider: "openai-codex", id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens, input: m.input,
        tools: true, reasoning: m.reasoning, enabled: !!enabled, source: "upstream", ...(enabled?.efforts ? { efforts: enabled.efforts } : {}) });
    }
    const favorites = await store.favorites();
    return { providers, models: [...active.values()].map(m => ({ ...m,editableParameters:["max_tokens",...(m.provider==="openrouter"&&m.supportedParameters?.includes("temperature")?["temperature"]:[]),...(m.efforts?.length?["reasoning_effort"]:[])], favorite: favorites.has(JSON.stringify([m.provider, m.id])) })), refreshedAt: current.at ?? null, stale: current.stale, ...(current.warning ? { warning: current.warning } : {}) };
  }
  async function enable(model: HubCatalogModel) {
    if (model.enabled) return;
    if (model.provider !== "openrouter" || !ctx.llm.listProviders().some(p => p.id === model.provider)) throw new Error("adapter-unavailable");
    const section = ctx.settings.get("llm-pi-ai") as { providers?: Record<string, { models?: unknown[] }> } | undefined;
    const profile = section?.providers?.openrouter;
    const revision = ctx.settings.describe({ redactSecrets: true }).find(x => x.ns === "llm-pi-ai")?.revision;
    if (!profile || revision === undefined) throw new Error("provider-unavailable");
    const row = { id: model.id, name: model.name, contextWindow: model.contextWindow,
      maxTokens: Math.min(model.maxTokens ?? 8192, model.contextWindow ?? 8192), input: model.input.filter(x => x === "text" || x === "image"),
      // Unknown models advertise reasoning, but not a verified effort vocabulary.
      ...(model.reasoning ? {} : { reasoningEfforts: false }) };
    const existing = profile.models?.length ? profile.models : (await ctx.llm.listModels("openrouter")).map(m => ({ id: m.id }));
    // Change exactly one model-list path; retain key, endpoint and all other providers.
    await ctx.settings.mutate("llm-pi-ai", [{ op: "set", path: ["providers", "openrouter", "models"], value: [...existing.filter((x: any) => x.id !== model.id), row] }], revision);
  }
  const remove = ctx.webServer.register({ kind: "exact", path: "/api/hub/models", async handler(req, res) {
    const rejected = ctx.connection.requestRejection(req);
    if (rejected || req.headers["sec-fetch-site"] === "cross-site") { send(res, rejected ?? 403, { error: "unauthorized" }); return; }
    if (req.headers["x-hub-models"] !== "1") { send(res, 403, { error: "forbidden" }); return; }
    if (req.method === "GET") { try { send(res, 200, await snapshot()); } catch { send(res, 503, { error: "models-unavailable" }); } return; }
    if (req.method !== "POST") { res.writeHead(405, { allow: "GET, POST" }); res.end(); return; }
    if (!/^application\/json(?:;|$)/i.test(String(req.headers["content-type"] ?? ""))) { send(res, 415, { error: "json-required" }); return; }
    let command;
    try { command = await body(req); } catch { send(res, 400, { error: "bad-request" }); return; }
    try {
      if (command.action === "refresh" && Object.keys(command).length === 1) { await ready; await store.refresh(); send(res, 200, await snapshot()); return; }
      if (command.action === "favorite") {
        if (!safe(command.provider) || !safe(command.model) || typeof command.selected !== "boolean" || Object.keys(command).some(k => !["action", "provider", "model", "selected"].includes(k))) { send(res, 400, { error: "bad-request" }); return; }
        const found = (await snapshot()).models.some(m => m.provider === command.provider && m.id === command.model);
        if (!found) { send(res, 404, { error: "model-unavailable" }); return; }
        await store.favorite(command.provider, command.model, command.selected); send(res, 200, await snapshot()); return;
      }
      if (!["select", "default", "enable"].includes(command.action) || !safe(command.provider) || !safe(command.model)
        || (command.reasoningEffort !== undefined && !safe(command.reasoningEffort))
        || (command.action === "select" && !safe(command.sessionId))
        || Object.keys(command).some(k => !["action", "provider", "model", "reasoningEffort", "sessionId","temperature","maxTokens"].includes(k))) { send(res, 400, { error: "bad-request" }); return; }
      const model = (await snapshot()).models.find(m => m.provider === command.provider && m.id === command.model);
      if (!model) { send(res, 404, { error: "model-unavailable" }); return; }
      await enable(model);
      const selection = voiceRouteSchema.parse({ provider: model.provider, model: model.id, ...(command.reasoningEffort ? { reasoningEffort: command.reasoningEffort } : {}),...(command.temperature!==undefined?{temperature:command.temperature}:{}),...(command.maxTokens!==undefined?{maxTokens:command.maxTokens}:{}) });
      if(selection.temperature!==undefined&&!model.editableParameters?.includes("temperature"))throw Error("Temperature unavailable");
      if(selection.maxTokens!==undefined&&selection.maxTokens>(model.maxTokens??model.contextWindow??1000000))throw Error("Output limit exceeded");
      if (command.action === "enable") { await ctx.llm.resolveCallConfig(selection); send(res, 200, { available: selection }); return; }
      if (command.action === "select") {
        await ctx.sessionController.selectModel({ sessionId: command.sessionId, ...selection });
        send(res, 200, { selected: selection, alsoSavedForNewChats: true });
      } else {
        const resolved = await ctx.llm.resolveCallConfig(selection);
        const normalized = {...selection,provider: resolved.provider, model: resolved.model, ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}) };
        await ctx.agentDefaultModel.saveSelection(normalized);
        send(res, 200, { selected: normalized });
      }
    } catch { send(res, 409, { error: "selection-or-refresh-failed" }); }
  } });
  const timer = setInterval(() => { void ready.then(() => store.revalidate()); }, 60_000); timer.unref();
  void ready.then(() => store.revalidate());
  ctx.effect(() => () => { clearInterval(timer); store.dispose(); remove(); removeTelegram(); }, "hub: shared live model catalogue");
}
