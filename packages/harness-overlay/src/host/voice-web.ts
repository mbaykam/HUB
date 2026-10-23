import type { IncomingMessage, ServerResponse } from "node:http";
import type { VoiceSidecar } from "./voice-sidecar.ts";
import type { openConversationHistory } from "./conversation-history.ts";
import type { PresentationSummary } from "../presentation-contract.ts";
import { parseVoiceIceServers, type VoiceIceServer } from "../voice-ice-contract.ts";
import type { ActiveVoiceProfile } from "./voice-profiles-web.ts";
import { randomUUID } from "node:crypto";
import type { LocalSpeechConfig } from "../voice-profile-contract.ts";
import type { VoiceTranscriptLine } from "./voice-transcript.ts";
import {uploadId,UPLOAD_MAX_FILES} from "../upload-contract.ts";
import {UploadError} from "./uploads.ts";

interface Call { callId: string; sessionId: string; sidecar: VoiceSidecar; iceServers?: VoiceIceServer[]; profile?: ActiveVoiceProfile; transport?: "telegram"; speech?: LocalSpeechConfig }
export interface VoiceWebPorts {
  reject(request: IncomingMessage): 401 | 403 | undefined;
  open(signal: AbortSignal, sessionId?: string, transport?: "telegram"): Promise<Call>;
  close(call: Call): Promise<void>;
  history?: Awaited<ReturnType<typeof openConversationHistory>>;
  presentations?: { summary(sessionId: string): PresentationSummary | null; document(sessionId: string, id: string): Promise<string> };
  transcript?(sessionId: string): VoiceTranscriptLine[];
  character?(sessionId:string): {id:string;name:string}|undefined;
  runtimeStatus?(): "cold" | "warming" | "ready" | "unavailable";
  share?(call: Call, requestId: string, uploads: string[], instruction: string): Promise<unknown>;
}
class RequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function send(response: ServerResponse, status: number, body: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}
async function read(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new RequestError(415, "json-required");
  const parts: Buffer[] = []; let length = 0;
  for await (const part of request) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
    length += buffer.length;
    if (length > 128_000) throw new RequestError(413, "request-too-large");
    parts.push(buffer);
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new RequestError(400, "invalid-request"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError(400, "invalid-request");
  return body as Record<string, unknown>;
}

/** Authenticated browser control plane, never a model proxy. One current call,
 * bounded/replay-safe admission receipts, fixed sidecar endpoints, and native
 * process ownership. A lost open response can be recovered with the same UUID;
 * it must never silently create another native chat or speech process.
 */
export function createVoiceWeb(ports: VoiceWebPorts, options: { now?: () => number; pollMs?: number } = {}) {
  const now = options.now ?? Date.now;
  const lifetime = new AbortController();
  let current: Call | undefined;
  let opening: Promise<Call> | undefined;
  let closing: Promise<void> | undefined;
  let disposed = false, polling = false;
  const signaling = new WeakMap<Call, { pending: number; epoch: number }>();
  const receipts = new Map<string, { at: number; requestedAt: number; sessionId?: string; result: Promise<Call> }>();
  function callProfile(call:Call){return call.profile?{...call.profile,...ports.character?.(call.sessionId)}:undefined;}
  function publicCall(call: Call) { const profile=callProfile(call);return { callId: call.callId, sessionId: call.sessionId, ...(profile ? { profile } : {}), ...(call.iceServers ? { iceServers: parseVoiceIceServers(call.iceServers) } : {}) }; }
  function close(call: Call): Promise<void> {
    if (current !== call) return Promise.resolve();
    if (closing) return closing;
    closing = (async () => {
      // Never release admission if shutdown failed; a second process must not
      // coexist with one whose cancellation is uncertain.
      await ports.close(call);
      if (current === call) current = undefined;
      closing = undefined;
    })();
    return closing;
  }
  async function admit(input: Record<string, unknown>, transport?: "telegram") {
    if (disposed) throw new RequestError(503, "voice-unavailable");
    if (typeof input.requestId !== "string" || !uuid.test(input.requestId) || !Number.isSafeInteger(input.requestedAt)) throw new RequestError(400, "invalid-admission");
    if (input.sessionId !== undefined && (typeof input.sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(input.sessionId))) throw new RequestError(400, "invalid-session");
    const sessionId = input.sessionId as string | undefined;
    const prior = receipts.get(input.requestId);
    if (prior) {
      if (prior.requestedAt !== input.requestedAt || prior.sessionId !== sessionId) throw new RequestError(409, "admission-conflict");
      const call = await prior.result;
      if (current !== call || closing) throw new RequestError(410, "voice-call-ended");
      return call;
    }
    const timestamp = input.requestedAt as number;
    if (timestamp < now() - 60_000 || timestamp > now() + 5000) throw new RequestError(400, "expired-admission");
    if (current || opening || closing) throw new RequestError(409, "voice-busy");
    for (const [key, receipt] of receipts) if (now() - receipt.at > 120_000) receipts.delete(key);
    if (receipts.size >= 64) throw new RequestError(429, "too-many-admissions");
    const result = Promise.resolve().then(async () => {
      const call = await ports.open(lifetime.signal, sessionId, transport);
      current = call;
      void call.sidecar.done.then(() => close(call), () => close(call)).catch(() => {});
      if (disposed) { await close(call); throw new RequestError(503, "voice-unavailable"); }
      return call;
    });
    opening = result;
    receipts.set(input.requestId, { at: now(), requestedAt: timestamp, sessionId, result });
    try { return await result; }
    finally { if (opening === result) opening = undefined; }
  }
  const timer = setInterval(() => {
    const call = current;
    if (!call || closing || polling || signaling.get(call)?.pending) return;
    const epoch = signaling.get(call)?.epoch ?? 0;
    polling = true;
    void call.sidecar.request("/status", "GET").then(async reply => {
      if (reply.status !== 200 || reply.body.status === "closed") await close(call);
    }, () => {
      // Local model loading can briefly block Python's event loop during an
      // offer. That request already has a 60s deadline; a shorter overlapping
      // health probe must not tear it down. Epoch also covers a probe whose
      // failure arrives just after signaling completes. Real process exit and
      // explicit closed status still close immediately; polling resumes next tick.
      if ((signaling.get(call)?.epoch ?? 0) === epoch && !signaling.get(call)?.pending) return close(call);
    }).catch(() => {}).finally(() => { polling = false; });
  }, options.pollMs ?? 5000);
  timer.unref();
  return {
    isBusy() { return Boolean(current || opening || closing); },
    openTelegram() { return admit({ requestId: randomUUID(), requestedAt: now() }, "telegram"); },
    activeProfile(): ActiveVoiceProfile | null { return current?callProfile(current)??null:null; },
    async handler(request: IncomingMessage, response: ServerResponse) {
      const rejection = ports.reject(request);
      if (rejection || request.headers["sec-fetch-site"] === "cross-site") { send(response, rejection ?? 403, { error: "unauthorized" }); return; }
      if (disposed) { send(response, 503, { error: "voice-unavailable" }); return; }
      const path = request.url;
      if (path === "/api/hub/voice/share") {
        if (request.method !== "POST") { send(response, 405, { error: "method-not-allowed" }); return; }
        if (request.headers["x-hub-voice-share"] !== "1") { send(response, 403, { error: "unauthorized" }); return; }
        try {
          const input = await read(request), call = current;
          if (!call || closing || input.callId !== call.callId) throw new RequestError(410, "This voice call has ended");
          if (typeof input.requestId !== "string" || !uploadId.test(input.requestId) || !Array.isArray(input.uploads) || !input.uploads.length || input.uploads.length > UPLOAD_MAX_FILES || input.uploads.some(id => typeof id !== "string" || !uploadId.test(id)) || new Set(input.uploads).size !== input.uploads.length || typeof input.instruction !== "string" || input.instruction.length > 4000 || Object.keys(input).some(key => !["callId","requestId","uploads","instruction"].includes(key))) throw new RequestError(400, "Invalid shared attachment request");
          if (!ports.share) throw new RequestError(503, "Sharing is unavailable");
          await ports.share(call, input.requestId, input.uploads, input.instruction);
          send(response, 200, { accepted: true });
        } catch (error) { send(response, error instanceof RequestError || error instanceof UploadError ? error.status : 409, { error: error instanceof RequestError || error instanceof UploadError ? error.message : "Sharing could not be confirmed. Retry this photo with the same request." }); }
        return;
      }
      if (path === "/api/hub/voice/presentation" || path === "/api/hub/voice/presentation-document") {
        if (request.method !== "GET") { send(response, 405, { error: "method-not-allowed" }); return; }
        const call = current;
        if (!call || closing || request.headers["x-hub-voice-call"] !== call.callId) { send(response, 409, { error: "voice-call-mismatch" }); return; }
        if (!ports.presentations) { send(response, 503, { error: "presentations-unavailable" }); return; }
        if (path.endsWith("/presentation")) { send(response, 200, { presentation: ports.presentations.summary(call.sessionId) }); return; }
        const id = request.headers["x-hub-presentation"];
        if (typeof id !== "string" || !uuid.test(id)) { send(response, 400, { error: "invalid-presentation" }); return; }
        try {
          const document = await ports.presentations.document(call.sessionId, id);
          if (current !== call || closing) { send(response, 409, { error: "voice-call-mismatch" }); return; }
          send(response, 200, { document });
        } catch { send(response, 404, { error: "presentation-unavailable" }); }
        return;
      }
      if (path === "/api/hub/voice/history") {
        if (!ports.history) { send(response, 503, { error: "history-unavailable" }); return; }
        if (request.method === "GET") { send(response, 200, { conversations: ports.history.snapshot() }); return; }
        if (request.method !== "POST") { send(response, 405, { error: "method-not-allowed" }); return; }
        if (request.headers["x-hub-voice-history"] !== "1") { send(response, 403, { error: "unauthorized" }); return; }
        try {
          const body = await read(request);
          if (typeof body.sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(body.sessionId) || Object.keys(body).length !== 1) throw new RequestError(400, "invalid-session");
          if (ports.history.view(body.sessionId).kind !== "voice") throw new RequestError(404, "voice-history-not-found");
          send(response, 200, { sessionId: body.sessionId, ...await ports.history.save(body.sessionId) });
        } catch (error) {
          send(response, error instanceof RequestError ? error.status : 503, { error: error instanceof RequestError ? error.code : "history-operation-failed" });
        }
        return;
      }
      if (path === "/api/hub/voice/status" && request.method === "GET") {
        send(response, 200, { enabled: true, busy: Boolean(current || opening || closing), serverTime: now(),
          ...(ports.runtimeStatus ? { runtime: ports.runtimeStatus() } : {}),
          ...(current&&!closing?{activeCall:{callId:current.callId,sessionId:current.sessionId,profile:callProfile(current)}}:{}),
          ...(current?.transport === "telegram" && !closing ? { externalCall: { ...publicCall(current), transport: "telegram", transcript: ports.transcript?.(current.sessionId) ?? [] } } : {}) }); return;
      }
      if (path === "/api/hub/voice/diagnostics" && request.method === "GET") {
        const call = current;
        if (!call || closing) { send(response, 200, { active: false }); return; }
        try {
          const reply = await call.sidecar.request("/status", "GET");
          if (current !== call || closing) { send(response, 200, { active: false }); return; }
          send(response, reply.status, { active: true, sessionId: call.sessionId, status: reply.body.status, audio: reply.body.audio ?? null });
        } catch { send(response, 503, { error: "voice-diagnostics-unavailable" }); }
        return;
      }
      if (!["/api/hub/voice/open", "/api/hub/voice/close", "/api/hub/voice/offer", "/api/hub/voice/status", "/api/hub/voice/interrupt", "/api/hub/voice/attention"].includes(path ?? "")) { send(response, 404, { error: "not-found" }); return; }
      if (request.method !== "POST" && !(path === "/api/hub/voice/offer" && request.method === "PATCH")) { send(response, 405, { error: "method-not-allowed" }); return; }
      try {
        const body = await read(request);
        if (path === "/api/hub/voice/open") { send(response, 200, publicCall(await admit(body))); return; }
        const call = current;
        // Official SmallWebRTC forwards APIRequest headers on both offer and
        // trickle-ICE PATCH, but nests requestData on POST and omits it on PATCH.
        // A dedicated header preserves ownership without modifying the SDK.
        const headerId = path === "/api/hub/voice/offer" ? request.headers["x-hub-voice-call"] : undefined;
        if (headerId !== undefined && (typeof headerId !== "string" || body.callId !== undefined && body.callId !== headerId)) throw new RequestError(400, "conflicting-call-id");
        const callId = headerId ?? body.callId;
        if (!call || callId !== call.callId) throw new RequestError(410, "voice-call-unavailable");
        if (path === "/api/hub/voice/close") { await close(call); send(response, 200, { ok: true }); return; }
        if (call.transport === "telegram" && path === "/api/hub/voice/offer") throw new RequestError(409, "external-call-has-no-browser-audio");
        if (closing) throw new RequestError(410, "voice-call-ending");
        if(path==="/api/hub/voice/attention"){
          if(Object.keys(body).length!==2||!["active","background"].includes(body.mode as string))throw new RequestError(400,"invalid-listening-mode");
          const reply=await call.sidecar.request("/attention","POST",{mode:body.mode});
          if(current!==call||closing)throw new RequestError(410,"voice-call-ended");
          send(response,reply.status,reply.status===200?reply.body:{error:"Could not change listening mode. Your call is still connected."});return;
        }
        if (path === "/api/hub/voice/interrupt") {
          if (Object.keys(body).length !== 1) throw new RequestError(400, "invalid-interrupt");
          const reply = await call.sidecar.request("/interrupt", "POST", {});
          if (current !== call || closing) throw new RequestError(410, "voice-call-ending");
          send(response, reply.status, reply.status === 200 ? { ok: true } : { error: "voice-interrupt-failed" }); return;
        }
        if (path === "/api/hub/voice/status") {
          const reply = await call.sidecar.request("/status", "GET");
          send(response, reply.status, { ...publicCall(call), status: reply.body.status }); return;
        }
        // Strip browser-only IDs and reject arbitrary proxy destinations.
        const payload = Object.fromEntries(["sdp", "type", "pc_id", "restart_pc", "candidates"].filter(key => key in body).map(key => [key, body[key]]));
        const state = signaling.get(call) ?? { pending: 0, epoch: 0 };
        signaling.set(call, state); state.pending++; state.epoch++;
        let reply;
        try { reply = await call.sidecar.request("/offer", request.method as "POST" | "PATCH", payload); }
        finally { state.pending--; }
        if (reply.status !== 200) { send(response, reply.status, { error: "voice-signaling-failed" }); return; }
        send(response, 200, reply.body);
      } catch (error) {
        send(response, error instanceof RequestError ? error.status : 503, { error: error instanceof RequestError ? error.code : "voice-operation-failed" });
      }
    },
    async dispose() {
      disposed = true; clearInterval(timer); lifetime.abort();
      await opening?.catch(() => {});
      if (current) await close(current);
      if (closing) await closing;
    },
  };
}
