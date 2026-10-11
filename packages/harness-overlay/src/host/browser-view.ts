import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BROWSER_VIEW_CHANNEL, BROWSER_VIEW_ROUTE, parseBrowserViewQuery, parseBrowserViewResult, type BrowserViewQuery, type BrowserViewTab, type BrowserViewFrame } from "../browser-view-contract.ts";
import type { PwaWebServer } from "./pwa.ts";

export interface BrowserViewProcessPort {
  readonly connected?: boolean;
  send?(value: unknown, callback?: (error: Error | null) => void): boolean;
  on(event: "message" | "disconnect", listener: (value?: unknown) => void): unknown;
  off(event: "message" | "disconnect", listener: (value?: unknown) => void): unknown;
}
type Pending = { query: BrowserViewQuery; resolve(value: BrowserViewTab[] | BrowserViewFrame): void; reject(error: Error): void; cleanup(): void };
type BrowserViewFailure = "disposed" | "disconnected" | "cancelled" | "busy" | "timeout" | "send-failed" | "parent-unavailable" | "invalid-response";
class BrowserViewUnavailable extends Error {
  readonly reason: BrowserViewFailure;
  constructor(reason: BrowserViewFailure) { super("Browser unavailable"); this.reason = reason; }
}
export class BrowserViewClient {
  readonly #port: BrowserViewProcessPort;
  readonly #pending = new Map<string, Pending>();
  #disposed = false;
  constructor(port: BrowserViewProcessPort = process) {
    this.#port = port;
    port.on("message", this.#receive); port.on("disconnect", this.dispose);
  }
  readonly #receive = (value?: unknown) => {
    if (!value || typeof value !== "object" || Reflect.get(value, "channel") !== BROWSER_VIEW_CHANNEL || Reflect.get(value, "type") !== "response") return;
    const id = Reflect.get(value, "requestId"), pending = this.#pending.get(id);
    if (!pending) return;
    pending.cleanup();
    try {
      if (Reflect.get(value, "error")) throw new BrowserViewUnavailable("parent-unavailable");
      pending.resolve(parseBrowserViewResult(pending.query, Reflect.get(value, "result")));
    } catch (error) { pending.reject(error instanceof BrowserViewUnavailable ? error : new BrowserViewUnavailable("invalid-response")); }
  };
  query(query: BrowserViewQuery, signal: AbortSignal): Promise<BrowserViewTab[] | BrowserViewFrame> {
    if (this.#disposed) return Promise.reject(new BrowserViewUnavailable("disposed"));
    if (this.#port.connected !== true || !this.#port.send) return Promise.reject(new BrowserViewUnavailable("disconnected"));
    if (signal.aborted) return Promise.reject(new BrowserViewUnavailable("cancelled"));
    if (this.#pending.size >= 2) return Promise.reject(new BrowserViewUnavailable("busy"));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const fail = (reason: BrowserViewFailure) => { cleanup(); reject(new BrowserViewUnavailable(reason)); };
      const cancel = () => fail("cancelled");
      const timer = setTimeout(() => fail("timeout"), 6000); timer.unref();
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); this.#pending.delete(id); };
      this.#pending.set(id, { query, resolve, reject, cleanup });
      signal.addEventListener("abort", cancel, { once: true });
      try { this.#port.send!({ channel: BROWSER_VIEW_CHANNEL, type: "request", requestId: id, query }, error => { if (error) fail("send-failed"); }); } catch { fail("send-failed"); }
    });
  }
  readonly dispose = () => {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#port.off("message", this.#receive); this.#port.off("disconnect", this.dispose);
    for (const pending of this.#pending.values()) { pending.cleanup(); pending.reject(new BrowserViewUnavailable("disconnected")); }
  };
}

export function createBrowserViewHandler(client: Pick<BrowserViewClient, "query">, reject: (request: IncomingMessage) => 401 | 403 | undefined) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store, private", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin" }); response.end(JSON.stringify(body));
    };
    const rejection = reject(request);
    if (rejection || request.headers["sec-fetch-site"] === "cross-site" || request.headers["x-hub-browser-view"] !== "1") { send(rejection ?? 403, { error: "unauthorized" }); return; }
    if (request.method !== "POST") { send(405, { error: "method-not-allowed" }); return; }
    if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") { send(415, { error: "json-required" }); return; }
    let query: BrowserViewQuery;
    try {
      let body = "";
      for await (const chunk of request) { body += chunk.toString(); if (Buffer.byteLength(body) > 4096) { send(413, { error: "request-too-large" }); return; } }
      query = parseBrowserViewQuery(JSON.parse(body));
    } catch { send(400, { error: "invalid-query" }); return; }
    const controller = new AbortController();
    const abort = () => controller.abort(); response.on("close", abort);
    try { send(200, await client.query(query, controller.signal)); }
    catch (error) { send(503, { error: "browser-unavailable", reason: error instanceof BrowserViewUnavailable ? error.reason : "internal" }); }
    finally { response.off("close", abort); }
  };
}

export function installBrowserViewHost(web: PwaWebServer, reject: (request: IncomingMessage) => 401 | 403 | undefined): () => void {
  const client = new BrowserViewClient();
  const remove = web.register({ kind: "exact", path: BROWSER_VIEW_ROUTE, handler: createBrowserViewHandler(client, reject) });
  return () => { remove(); client.dispose(); };
}
