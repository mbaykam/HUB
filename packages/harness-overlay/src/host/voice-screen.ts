import type { IncomingMessage, ServerResponse } from "node:http";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SCREEN_MAX_BYTES = 2_000_000, SCREEN_MAX_AGE_MS = 5000;
export interface ScreenOwner { callId: string; sessionId: string }
type Lease = ScreenOwner & { shareId: string; sequence: number; attemptedAt: number; frame?: { bytes: Buffer; expiresAt: number } };
export class ScreenError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function requireId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !uuid.test(id)) throw new ScreenError(400, "invalid-screen-share");
}
/** Header bounds precede the existing full image decoder. This is not a decoder. */
function checkJpeg(bytes: Buffer) {
  if (bytes.length < 12 || bytes.length > SCREEN_MAX_BYTES || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) throw new ScreenError(400, "invalid-screen-image");
  let p = 2;
  while (p < bytes.length - 2) {
    if (bytes[p++] !== 0xff) break;
    while (bytes[p] === 0xff) p++;
    const marker = bytes[p++];
    if (marker === undefined || marker === 0xda || marker === 0xd9 || p + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(p);
    if (length < 2 || p + length > bytes.length - 2) break;
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
      if (length < 8) break;
      const height = bytes.readUInt16BE(p + 3), width = bytes.readUInt16BE(p + 5);
      if (!width || !height || width > 1920 || height > 1920 || width * height > 3_000_000) break;
      return;
    }
    p += length;
  }
  throw new ScreenError(400, "invalid-screen-image");
}

/** One consented call, one fresh JPEG in RAM. No file, transcript, Knowledge or
 * model writes. Closed share IDs cannot be resurrected by delayed requests. */
export class VoiceScreenFrames {
  private scope?: ScreenOwner;
  private lease?: Lease;
  private seen = new Set<string>();
  private decoding = false;
  private expiry?: ReturnType<typeof setTimeout>;
  constructor(private readonly validate: (bytes: Uint8Array) => Promise<void>, private readonly now = Date.now) {}
  private owns(owner: ScreenOwner) { return this.scope?.callId === owner.callId && this.scope.sessionId === owner.sessionId; }
  private forgetFrame() { if (this.expiry) clearTimeout(this.expiry); this.expiry = undefined; if (this.lease) this.lease.frame = undefined; }
  clear() { this.forgetFrame(); this.lease = undefined; this.scope = undefined; this.seen.clear(); }
  start(owner: ScreenOwner, shareId: unknown) {
    requireId(shareId);
    if (!this.owns(owner)) { this.clear(); this.scope = { ...owner }; }
    if (this.lease?.shareId === shareId) return;
    if (this.seen.has(shareId)) throw new ScreenError(410, "screen-share-ended");
    if (this.lease) throw new ScreenError(409, "screen-already-sharing");
    if (this.seen.size >= 64) throw new ScreenError(429, "too-many-screen-shares");
    this.seen.add(shareId);
    this.lease = { ...owner, shareId, sequence: -1, attemptedAt: -Infinity };
  }
  stop(owner: ScreenOwner, shareId: unknown) {
    requireId(shareId);
    if (!this.owns(owner)) { this.clear(); this.scope = { ...owner }; }
    if (!this.seen.has(shareId) && this.seen.size >= 64) throw new ScreenError(429, "too-many-screen-shares");
    this.seen.add(shareId);
    if (this.lease?.shareId === shareId) { this.forgetFrame(); this.lease = undefined; }
  }
  private selected(owner: ScreenOwner, shareId: unknown) {
    requireId(shareId);
    if (!this.owns(owner) || this.lease?.shareId !== shareId) throw new ScreenError(410, "screen-share-ended");
    return this.lease;
  }
  async receive(owner: ScreenOwner, shareId: unknown, sequence: number, ageMs: number, read: () => Promise<Uint8Array>, stillOwned: () => boolean = () => true) {
    const lease = this.selected(owner, shareId), started = this.now();
    if (!Number.isSafeInteger(sequence) || sequence < 0 || !Number.isSafeInteger(ageMs) || ageMs < 0 || ageMs >= SCREEN_MAX_AGE_MS) throw new ScreenError(400, "invalid-screen-frame");
    if (sequence <= lease.sequence) throw new ScreenError(409, "stale-screen-frame");
    if (this.decoding || started - lease.attemptedAt < 1000) throw new ScreenError(429, "screen-rate-limited");
    this.decoding = true; lease.attemptedAt = started;
    try {
      const bytes = Buffer.from(await read());
      if (this.lease !== lease || !stillOwned()) throw new ScreenError(410, "screen-share-ended");
      checkJpeg(bytes);
      try { await this.validate(bytes); } catch { throw new ScreenError(400, "invalid-screen-image"); }
      if (this.lease !== lease || !stillOwned()) throw new ScreenError(410, "screen-share-ended");
      const expiresAt = started + SCREEN_MAX_AGE_MS - ageMs;
      if (expiresAt <= this.now()) throw new ScreenError(409, "stale-screen-frame");
      this.forgetFrame(); lease.sequence = sequence; lease.frame = { bytes, expiresAt };
      this.expiry = setTimeout(() => { if (this.lease === lease) this.forgetFrame(); }, expiresAt - this.now());
      this.expiry.unref();
    } finally { this.decoding = false; }
  }
  frame(sessionId: string) {
    const lease = this.lease;
    if (lease?.frame && lease.frame.expiresAt <= this.now()) this.forgetFrame();
    if (!lease?.frame || lease.sessionId !== sessionId) return;
    return { bytes: Buffer.from(lease.frame.bytes), sequence: lease.sequence, remainingMs: lease.frame.expiresAt - this.now() };
  }
  status(owner: ScreenOwner) { const owned = this.owns(owner); return { sharing: owned && Boolean(this.lease), hasFrame: owned && Boolean(this.frame(owner.sessionId)), maxAgeMs: SCREEN_MAX_AGE_MS }; }
}

async function body(request: IncomingMessage, limit: number) {
  const declared = request.headers["content-length"];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new ScreenError(413, "screen-request-too-large");
  const chunks: Buffer[] = []; let size = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => { for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > limit) throw new ScreenError(413, "screen-request-too-large"); chunks.push(bytes); } return Buffer.concat(chunks); })(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => { reject(new ScreenError(408, "screen-request-timeout")); request.destroy(); }, 5000); timeout.unref(); }),
    ]);
  } finally { if (timeout) clearTimeout(timeout); }
}

/** Caller must authenticate before dispatch. Exact call + explicit screen marker
 * protect this route; binary bytes are never returned over its status endpoint. */
export async function handleVoiceScreen(request: IncomingMessage, response: ServerResponse, frames: VoiceScreenFrames, owner: () => ScreenOwner | undefined) {
  const send = (status: number, value: unknown) => { if (!response.destroyed && !response.writableEnded) { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(JSON.stringify(value)); } };
  try {
    if (request.headers["x-hub-voice-screen"] !== "1") throw new ScreenError(403, "unauthorized");
    const call = owner();
    const owned = () => { const active = owner(); return active?.callId === call?.callId && active?.sessionId === call?.sessionId; };
    if (!call || request.headers["x-hub-voice-call"] !== call.callId) throw new ScreenError(410, "voice-call-ended");
    if (request.method === "GET") { send(200, frames.status(call)); return; }
    const mediaType = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    if (request.method === "PUT") {
      if (mediaType !== "image/jpeg") throw new ScreenError(415, "jpeg-required");
      const integer = (key: string) => { const text = request.headers[key]; return typeof text === "string" && /^\d{1,16}$/.test(text) ? Number(text) : NaN; };
      await frames.receive(call, request.headers["x-hub-screen-share"], integer("x-hub-screen-sequence"), integer("x-hub-screen-age-ms"), () => body(request, SCREEN_MAX_BYTES), owned);
    } else if (request.method === "POST" || request.method === "DELETE") {
      if (mediaType !== "application/json") throw new ScreenError(415, "json-required");
      let input: unknown;
      try { input = JSON.parse((await body(request, 4096)).toString("utf8")); } catch (error) { if (error instanceof ScreenError) throw error; throw new ScreenError(400, "invalid-screen-share"); }
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).join() !== "shareId") throw new ScreenError(400, "invalid-screen-share");
      if (!owned()) throw new ScreenError(410, "voice-call-ended");
      if (request.method === "POST") frames.start(call, (input as { shareId: unknown }).shareId);
      else frames.stop(call, (input as { shareId: unknown }).shareId);
    } else throw new ScreenError(405, "method-not-allowed");
    send(200, frames.status(call));
  } catch (error) { send(error instanceof ScreenError ? error.status : 503, { error: error instanceof ScreenError ? error.message : "screen-unavailable" }); }
}
