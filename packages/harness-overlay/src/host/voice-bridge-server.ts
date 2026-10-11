import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { VoiceConversationError, type VoiceEvent } from "./voice-conversation.ts";

export interface VoiceBridgeConversation {
  sessionId: string;
  speak(utterance: number, text: string, sink: (event: VoiceEvent) => void): Promise<void>;
  interrupt(utterance: number): Promise<void>;
  close(): Promise<void>;
  notifications?(after: number): { events: { id: number; text: string }[] };
}
interface Lease { id: string; conversation: VoiceBridgeConversation; touched: number }
class RequestError extends Error {
  status: number;
  constructor(status: number) { super("invalid-request"); this.status = status; }
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new RequestError(415);
  let bytes = 0;
  const parts: Buffer[] = [];
  for await (const part of request) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
    bytes += buffer.length;
    if (bytes > 20_000) throw new RequestError(413);
    parts.push(buffer);
  }
  let input;
  try { input = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new RequestError(400); }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new RequestError(400);
  return input;
}

/** A private, ephemeral loopback capability for the speech sidecar. It cannot
 * create sessions or choose models/tools. Only the authenticated HUB web route
 * may call open(); the sidecar can operate on that one admitted voice lease.
 * No provider credential, browser cookie or saved transcript crosses this API.
 */
export async function createVoiceBridgeServer<Admission = undefined>(createConversation: (sessionId?: string, admission?: Admission) => Promise<VoiceBridgeConversation>, options: {
  leaseMs?: number; turnMs?: number; now?: () => number;
  incoming?(): Promise<unknown>;
} = {}) {
  const token = randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? 90_000;
  const turnMs = options.turnMs ?? 120_000;
  if (!Number.isFinite(leaseMs) || leaseMs < 100 || !Number.isFinite(turnMs) || turnMs < 100) throw new Error("Invalid voice deadlines");
  let lease: Lease | undefined;
  let opening = false;
  let closing: Promise<void> | undefined;
  let disposed = false;
  let host = "";
  async function closeCall(id: string) {
    if (lease?.id !== id) return;
    const current = lease;
    lease = undefined;
    const pending = current.conversation.close();
    closing = pending;
    await pending;
    // A failed close retains the admission lock: an uncertain still-running
    // call must not silently coexist with a newly admitted CPU/audio pipeline.
    if (closing === pending) closing = undefined;
  }
  async function handler(request: IncomingMessage, response: ServerResponse) {
    const actual = Buffer.from(request.headers.authorization ?? "");
    if (request.socket.remoteAddress !== "127.0.0.1" || request.headers.host !== host || request.headers.origin !== undefined || request.headers["sec-fetch-site"] !== undefined || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      json(response, 401, { error: "unauthorized" }); return;
    }
    if (request.method !== "POST") { json(response, 405, { error: "method-not-allowed" }); return; }
    if (request.url === "/incoming" && options.incoming) {
      try {
        const input = await body(request);
        if (Object.keys(input).length) { json(response, 400, { error: "invalid-request" }); return; }
        json(response, 200, await options.incoming());
      } catch { json(response, 409, { error: "voice-unavailable" }); }
      return;
    }
    if (!["/turn", "/interrupt", "/heartbeat", "/close", "/notifications"].includes(request.url ?? "")) { json(response, 404, { error: "not-found" }); return; }
    let current: Lease | undefined;
    let utterance: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let complete = false;
    const interrupt = () => {
      if (!complete && current && utterance !== undefined) void current.conversation.interrupt(utterance).catch(() => {});
    };
    try {
      const input = await body(request);
      current = lease;
      if (!current || input.callId !== current.id || now() - current.touched >= leaseMs) {
        if (current && now() - current.touched >= leaseMs) void closeCall(current.id).catch(() => {});
        json(response, 410, { error: "voice-call-unavailable" }); return;
      }
      current.touched = now();
      if (request.url === "/notifications") {
        if (Object.keys(input).some(key => key !== "callId" && key !== "after") || !Number.isSafeInteger(input.after) || (input.after as number) < 0) throw new RequestError(400);
        json(response, 200, current.conversation.notifications?.(input.after as number) ?? { events: [] }); return;
      }
      if (request.url === "/heartbeat") { json(response, 200, { ok: true }); return; }
      if (request.url === "/close") { await closeCall(current.id); json(response, 200, { ok: true }); return; }
      if (!Number.isSafeInteger(input.utterance) || (input.utterance as number) < 1) throw new RequestError(400);
      utterance = input.utterance as number;
      if (request.url === "/interrupt") {
        await current.conversation.interrupt(utterance);
        json(response, 200, { ok: true }); return;
      }
      if (typeof input.text !== "string" || !input.text.trim() || Buffer.byteLength(input.text, "utf8") > 16_000) throw new RequestError(400);
      response.on("close", interrupt);
      timer = setTimeout(() => { interrupt(); response.destroy(); }, turnMs);
      await current.conversation.speak(utterance, input.text, event => {
        if (response.destroyed || response.writableEnded) return;
        if (!response.headersSent) response.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        if (response.writableLength > 64_000) { interrupt(); response.destroy(); return; }
        response.write(JSON.stringify(event) + "\n");
        if (event.type === "end") { complete = true; response.end(); }
      });
      if (!response.writableEnded && !response.destroyed) {
        // A missing terminal event is not successful completion.
        if (response.headersSent) response.end(JSON.stringify({ type: "end", utterance, status: "error" }) + "\n");
        else json(response, 502, { error: "voice-turn-incomplete" });
      }
      complete = true;
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) response.end(JSON.stringify({ type: "end", utterance, status: "error" }) + "\n");
      else if (error instanceof RequestError) json(response, error.status, { error: "invalid-request" });
      else if (error instanceof VoiceConversationError) json(response, error.code === "busy" || error.code === "already-admitted" ? 409 : error.code === "closed" ? 410 : 502, { error: error.code });
      else json(response, 502, { error: "voice-bridge-unavailable" });
      complete = true;
    } finally {
      if (timer) clearTimeout(timer);
      response.off("close", interrupt);
    }
  }
  const server = createServer((request, response) => { void handler(request, response).catch(() => response.destroy()); });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Voice bridge failed to bind");
  host = `127.0.0.1:${address.port}`;
  const expiry = setInterval(() => {
    if (lease && now() - lease.touched >= leaseMs) void closeCall(lease.id).catch(() => {});
  }, Math.min(5000, leaseMs));
  expiry.unref();
  return {
    url: `http://${host}`, token,
    async open(sessionId?: string, admission?: Admission) {
      if (disposed) throw new Error("Voice bridge is closed");
      if (lease || opening || closing) throw new VoiceConversationError("busy");
      opening = true;
      try {
        const conversation = await createConversation(sessionId, admission);
        if (disposed) { await conversation.close(); throw new Error("Voice bridge is closed"); }
        lease = { id: randomUUID(), conversation, touched: now() };
        return { callId: lease.id, sessionId: conversation.sessionId };
      } finally { opening = false; }
    },
    closeCall,
    async dispose() {
      disposed = true;
      clearInterval(expiry);
      server.closeAllConnections();
      const stopped = new Promise<void>(resolve => server.close(() => resolve()));
      if (lease) await closeCall(lease.id);
      if (closing) await closing;
      await stopped;
    },
  };
}
