import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

/** What the user's iPhone last reported about where it is and what is around
 * it. The phone sends this only while the HUB app is allowed to; HUB keeps the
 * latest snapshot, never a history. */
export interface PhoneContextSnapshot {
  capturedAt: number;
  receivedAt: number;
  location?: { latitude: number; longitude: number; accuracyMeters: number; altitudeMeters?: number; speedMetersPerSecond?: number; courseDegrees?: number };
  place?: { name?: string; street?: string; neighborhood?: string; city?: string; region?: string; postalCode?: string; country?: string; timeZone?: string };
  nearby?: { name: string; category?: string; distanceMeters?: number }[];
  device?: { batteryPercent?: number; charging?: boolean; lowPowerMode?: boolean; network?: string; timeZone?: string; locale?: string; appState?: string };
  motion?: string;
}

export const PHONE_CONTEXT_TOOL = "hub_phone_context";
export const PHONE_CONTEXT_GUIDANCE = "The user's iPhone is your main sense organ when they are away from the PC. Call hub_phone_context when the user asks where they are, what is around them, for nearby places, directions, local time, weather or anything that depends on their current situation, and before you guess their location. fresh:true asks the open HUB app for a new reading (a few seconds). The result can be stale or missing when the HUB app is closed or location is off: say how old it is and do not invent a location. Location is private: use it for the user's request, never volunteer it to others. For weather or details, combine the coordinates with web search.";

const num = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const text = (v: unknown, max = 200) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const cleanText = (v: unknown, max = 200) => text(v, max) ? (v as string).trim() : undefined;

/** Accepts only the documented, bounded fields; everything else is dropped. */
export function parsePhoneContext(value: unknown, now: number): PhoneContextSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-context");
  const v = value as Record<string, any>;
  if (!num(v.capturedAt, now - 7 * 86_400_000, now + 120_000)) throw new Error("invalid-context");
  const out: PhoneContextSnapshot = { capturedAt: v.capturedAt, receivedAt: now };
  const l = v.location;
  if (l !== undefined) {
    if (!l || !num(l.latitude, -90, 90) || !num(l.longitude, -180, 180) || !num(l.accuracyMeters, 0, 100_000)) throw new Error("invalid-location");
    out.location = { latitude: l.latitude, longitude: l.longitude, accuracyMeters: Math.round(l.accuracyMeters) };
    if (num(l.altitudeMeters, -1000, 20_000)) out.location.altitudeMeters = Math.round(l.altitudeMeters);
    if (num(l.speedMetersPerSecond, 0, 400)) out.location.speedMetersPerSecond = Math.round(l.speedMetersPerSecond * 10) / 10;
    if (num(l.courseDegrees, 0, 360)) out.location.courseDegrees = Math.round(l.courseDegrees);
  }
  if (v.place && typeof v.place === "object") {
    const p: Record<string, string | undefined> = {};
    for (const key of ["name", "street", "neighborhood", "city", "region", "postalCode", "country", "timeZone"]) p[key] = cleanText(v.place[key], 120);
    const kept = Object.fromEntries(Object.entries(p).filter(([, x]) => x !== undefined));
    if (Object.keys(kept).length) out.place = kept;
  }
  if (Array.isArray(v.nearby)) {
    out.nearby = v.nearby.slice(0, 15).filter((n: any) => n && text(n.name, 120)).map((n: any) => ({
      name: n.name.trim(), ...(text(n.category, 60) ? { category: n.category.trim() } : {}),
      ...(num(n.distanceMeters, 0, 50_000) ? { distanceMeters: Math.round(n.distanceMeters) } : {}),
    }));
  }
  if (v.device && typeof v.device === "object") {
    const d = v.device, device: NonNullable<PhoneContextSnapshot["device"]> = {};
    if (num(d.batteryPercent, 0, 100)) device.batteryPercent = Math.round(d.batteryPercent);
    if (typeof d.charging === "boolean") device.charging = d.charging;
    if (typeof d.lowPowerMode === "boolean") device.lowPowerMode = d.lowPowerMode;
    for (const key of ["network", "timeZone", "locale", "appState"] as const) { const x = cleanText(d[key], 60); if (x) device[key] = x; }
    if (Object.keys(device).length) out.device = device;
  }
  const motion = cleanText(v.motion, 40);
  if (motion) out.motion = motion;
  return out;
}

export class PhoneContextStore {
  #latest?: PhoneContextSnapshot;
  #requestedAt = 0;
  #waiters = new Set<() => void>();
  #loaded?: Promise<void>;
  constructor(readonly root: string, readonly now: () => number = Date.now) {}
  private file() { return join(this.root, "latest.json"); }
  load() {
    return this.#loaded ??= readFile(this.file(), "utf8").then(raw => {
      try { this.#latest = parsePhoneContext(JSON.parse(raw), this.now()); } catch { /* A damaged file is ignored. */ }
    }, () => {});
  }
  latest() { return this.#latest; }
  /** True while an assistant is waiting for a fresh reading. */
  requested() { return this.now() - this.#requestedAt < 30_000; }
  async save(snapshot: PhoneContextSnapshot) {
    this.#latest = snapshot;
    this.#requestedAt = 0;
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
    await mkdir(this.root, { recursive: true });
    const temp = this.file() + ".tmp";
    await writeFile(temp, JSON.stringify(snapshot), { mode: 0o600 });
    await rename(temp, this.file());
  }
  /** Asks the phone for a new reading and waits up to `ms` for it. */
  async requestFresh(ms: number, signal?: AbortSignal) {
    const before = this.#latest?.receivedAt ?? 0;
    this.#requestedAt = this.now();
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); this.#waiters.delete(done); signal?.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, ms);
      this.#waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
    return (this.#latest?.receivedAt ?? 0) > before;
  }
}

/** POST stores a reading; GET tells the open app whether one is wanted. */
export function createPhoneContextHandler(store: PhoneContextStore, reject: (request: IncomingMessage) => 401 | 403 | undefined) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store, private", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(body)); };
    const rejection = reject(req);
    if (rejection || req.headers["sec-fetch-site"] === "cross-site" || req.headers["x-hub-phone-context"] !== "1") { send(rejection ?? 403, { error: "unauthorized" }); return; }
    await store.load();
    if (req.method === "GET") { send(200, { requested: store.requested() }); return; }
    if (req.method !== "POST") { send(405, { error: "method-not-allowed" }); return; }
    if (!/^application\/json(?:;|$)/i.test(String(req.headers["content-type"] ?? ""))) { send(415, { error: "json-required" }); return; }
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) { size += chunk.length; if (size > 16_000) { send(413, { error: "body-too-large" }); return; } chunks.push(chunk); }
    try {
      await store.save(parsePhoneContext(JSON.parse(Buffer.concat(chunks).toString("utf8")), store.now()));
      send(200, { saved: true });
    } catch { send(400, { error: "invalid-context" }); }
  };
}

export function describePhoneContext(snapshot: PhoneContextSnapshot | undefined, now: number, fresh: boolean) {
  if (!snapshot) return { available: false, reason: "The phone has not shared its context yet. Ask the user to open HUB on the iPhone and allow location in Settings → iPhone settings." };
  const ageSeconds = Math.max(0, Math.round((now - snapshot.capturedAt) / 1000));
  const { capturedAt, receivedAt: _received, ...rest } = snapshot;
  return { available: true, fresh, ageSeconds, capturedAt: new Date(capturedAt).toISOString(), ...rest };
}

export function attachPhoneContextTool(agent: any, store: PhoneContextStore, allowed: (agent: any) => boolean) {
  const off = agent.ctx.tools.register({
    name: PHONE_CONTEXT_TOOL,
    description: "Read the user's iPhone context: location, place name, nearby places, battery, network, time zone and motion. fresh:true asks the open HUB app for a new reading.",
    parameters: { type: "object", properties: { fresh: { type: "boolean", description: "Ask the phone for a new reading first (waits up to 12 seconds)." } }, additionalProperties: false },
    output: { schema: { type: "object" }, render: (_args: unknown, value: unknown) => [{ type: "text", text: JSON.stringify(value) }] },
    async execute(args: any, exec: any) {
      exec.signal?.throwIfAborted?.();
      if (!allowed(agent)) throw new Error("Phone context is disabled for this character.");
      if (args !== undefined && (typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(k => k !== "fresh"))) throw new Error("Only the fresh option is accepted.");
      await store.load();
      const old = store.latest(), stale = !old || store.now() - old.capturedAt > 120_000;
      let fresh = false;
      if (args?.fresh === true || stale) fresh = await store.requestFresh(12_000, exec.signal);
      return describePhoneContext(store.latest(), store.now(), fresh);
    },
  });
  let offPrompt: () => void;
  try { offPrompt = agent.ctx.systemPrompt.section({ name: "hub:phone-context", order: 1006, text: PHONE_CONTEXT_GUIDANCE }); }
  catch (error) { off(); throw error; }
  return () => { off(); offPrompt(); };
}
