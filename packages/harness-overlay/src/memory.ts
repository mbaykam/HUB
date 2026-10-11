import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { installMemoryLifecycle, type MemoryHooks, type MemoryPorts } from "./host/memory-lifecycle.ts";
import { createMemoryGenerator, type MemoryWorkerPorts } from "./host/memory-worker.ts";
import { createMemoryReflection } from "./host/memory-reflection.ts";
import { createMemoryGraph, memoryEntityId } from "./host/memory-graph.ts";
import { applyKnowledge } from "./host/knowledge.ts";

export const name = "hub-memory";
export const inject = ["agents", "tools", "connection", "webServer", "llm", "sessionQuery", "attachments", "subprocess"];
export interface Config { project: string; provider: string; model: string; captureSince: number; topicNotes?: boolean; secondBrain?: boolean; vault?: string; knowledgeRoot?: string; embeddingPython?: string; embeddingRoot?: string }
type Execute = (request: Omit<Parameters<MemoryPorts["execute"]>[0], "sessionId"> & { agent?: unknown }) => ReturnType<MemoryPorts["execute"]>;
interface Context extends MemoryHooks {
  agents: { create: MemoryWorkerPorts["create"]; get(id: string): { ctx: { tools: { execute: Execute } } } | undefined };
  tools: { execute: Execute };
  connection: { requestRejection(request: IncomingMessage): 401 | 403 | undefined };
  webServer: { register(route: { kind: "exact"; path: string; handler(request: IncomingMessage, response: ServerResponse): Promise<void> }): () => void };
  effect(callback: () => () => Promise<void>, label: string): unknown;
}

/** Install only in an explicitly configured private profile after MCP is mounted. */
export function apply(ctx: Context, config: Config): void {
  if (config.secondBrain) {
    if (!config.vault || !Number.isSafeInteger(config.captureSince) || config.captureSince < 1) throw new Error("Knowledge AI requires an explicit vault and activation time");
    applyKnowledge(ctx, { ...config, vault: config.vault }); return;
  }
  if (!config.project || !config.provider || !config.model || !Number.isSafeInteger(config.captureSince) || config.captureSince < 1) {
    throw new Error("Memory requires a project, model route and persisted activation timestamp");
  }
  if (config.topicNotes !== undefined && typeof config.topicNotes !== "boolean") throw new Error("Invalid topic memory configuration");
  const lifetime = new AbortController();
  let generation = new AbortController();
  let ready = false;
  let status = "starting";
  let updatedAt: number | null = null;
  const message = (text: string) => createUserMessage({ source: { kind: "plugin", plugin: "hub-memory" }, content: [{ type: "text", text }] });
  // Explicit host-owned storage operations, limited to this private memory
  // project. This is not a fallback for denied/disposed conversation agents:
  // capture/recall below always use their originating scoped tool registry.
  async function storeCall(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (!["read_note", "write_note", "edit_note", "build_context", "search_notes"].includes(tool)) throw new Error("Unsupported memory operation");
    const result = await ctx.tools.execute({ name: `mcp__hub_memory__${tool}`,
      arguments: { ...args, project: config.project, output_format: "json" },
      callId: `hub-memory-store-${randomUUID()}`, signal,
    });
    if (result.isError) throw new Error("Memory store unavailable");
    return JSON.parse(result.content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n"));
  }
  const generate = createMemoryGenerator({ create: options => ctx.agents.create(options), message }, config);
  const reflection = createMemoryReflection({ call: storeCall }, generate, { topicNotes: config.topicNotes });
  const graph = createMemoryGraph({ call: storeCall });
  // MCP start is allowed to finish without making the entire app depend on it.
  const startup = (async () => {
    for (let attempt = 0; attempt < 15 && !lifetime.signal.aborted; attempt++) {
      try {
        await reflection.initialize(AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)]));
        ready = true; status = "ready"; return;
      } catch {
        if (attempt === 14) { status = "unavailable"; return; }
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); lifetime.signal.removeEventListener("abort", finish); resolve(); };
          const timer = setTimeout(finish, 1000);
          lifetime.signal.addEventListener("abort", finish, { once: true });
        });
      }
    }
  })();
  const lifecycle = installMemoryLifecycle(ctx, {
    execute: ({ sessionId, ...request }) => {
      const agent = ctx.agents.get(sessionId);
      if (!agent) throw new Error("Originating memory agent is no longer live");
      return agent.ctx.tools.execute({ ...request, agent });
    },
    message,
    report: event => { status = event; },
    captured: async (note, completedAt, signal) => {
      await startup;
      if (!ready) throw new Error("Memory unavailable");
      const runSignal = AbortSignal.any([signal, generation.signal, AbortSignal.timeout(120_000)]);
      const saved = await storeCall("read_note", { identifier: `sessions/${note.title}` }, runSignal) as { content?: string };
      if (typeof saved.content !== "string") throw new Error("Captured evidence unavailable");
      status = "reflecting";
      const outcome = await reflection.reflect({ id: note.title, completedAt, content: saved.content }, runSignal);
      status = outcome === "already-attempted" ? "review-attempt-status" : "ready";
      if (outcome === "updated") updatedAt = Date.now();
    },
  }, { project: config.project, captureSince: config.captureSince, recallIdentifier: "memories/personal-memory", topicNotes: config.topicNotes });
  function send(response: ServerResponse, code: number, value: unknown) {
    response.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    response.end(JSON.stringify(value));
  }
  const offRoute = ctx.webServer.register({ kind: "exact", path: "/api/hub/memory", async handler(request, response) {
    const rejection = ctx.connection.requestRejection(request);
    if (rejection || request.headers["sec-fetch-site"] === "cross-site") { send(response, rejection ?? 403, { error: "unauthorized" }); return; }
    if (request.method !== "GET" && request.method !== "POST") { send(response, 405, { error: "method-not-allowed" }); return; }
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]);
    try {
      if (!ready) { send(response, 503, { enabled: false, status }); return; }
      const query = new URL(request.url ?? "/api/hub/memory", "http://hub.invalid").searchParams;
      if (query.has("view")) {
        if (request.method !== "GET") { send(response, 405, { error: "read-only" }); return; }
        if (query.get("view") === "client") {
          const source = await readFile(new URL("./memory-graph-browser.js", import.meta.url));
          response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin" });
          response.end(source); return;
        }
        if (request.headers["x-hub-memory"] !== "1") { send(response, 403, { error: "header-required" }); return; }
        const view = query.get("view");
        const page = query.get("page") ?? "1";
        const id = query.get("id") ?? "";
        const search = query.get("q") ?? "";
        if (view === "search" && search.trim() && search.length <= 200 && !/[\u0000-\u001f\u007f]/.test(search) && /^[1-9][0-9]{0,4}$/.test(page) && Number(page) <= 10_000) {
          send(response, 200, await graph.search(search, Number(page), signal)); return;
        }
        if (view === "graph" && /^[1-9][0-9]{0,4}$/.test(page) && Number(page) <= 10_000) {
          send(response, 200, await graph.page(Number(page), signal)); return;
        }
        if (view === "note" && memoryEntityId.test(id)) {
          send(response, 200, await graph.note(id, signal)); return;
        }
        send(response, 400, { error: "invalid-graph-request" }); return;
      }
      if (request.method === "POST") {
        if (!request.headers["content-type"]?.startsWith("application/json")) { send(response, 415, { error: "json-required" }); return; }
        let data = "";
        request.setEncoding("utf8");
        for await (const chunk of request) {
          data += chunk.toString();
          if (Buffer.byteLength(data, "utf8") > 32_000) { send(response, 413, { error: "too-large" }); return; }
        }
        let input;
        try { input = JSON.parse(data); } catch { send(response, 400, { error: "invalid-request" }); return; }
        if (!input || input.action !== "forget" || typeof input.passage !== "string" || !input.passage.trim()) { send(response, 400, { error: "invalid-request" }); return; }
        if (input.noteId !== undefined && (typeof input.noteId !== "string" || !memoryEntityId.test(input.noteId))) { send(response, 400, { error: "invalid-memory-identity" }); return; }
        generation.abort(); generation = new AbortController();
        await reflection.forget(input.passage, Date.now(), signal, input.noteId);
        status = "ready"; updatedAt = Date.now();
      }
      const note = await storeCall("read_note", { identifier: "memories/personal-memory" }, signal) as { content?: string };
      if (typeof note.content !== "string") throw new Error("Memory unavailable");
      send(response, 200, { enabled: true, status, updatedAt, content: note.content, model: config.model });
    } catch { send(response, request.method === "POST" ? 409 : 503, { error: "memory-operation-failed", status }); }
  } });
  ctx.effect(() => async () => {
    offRoute(); lifetime.abort(); generation.abort();
    await lifecycle.dispose(); await startup; await reflection.drain();
  }, "hub-memory lifetime");
}
