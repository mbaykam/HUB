export interface VoiceHistoryRecord {
  readonly sessionId: string;
  readonly saved: boolean;
  readonly createdAt: number;
}
export interface VoiceHistorySnapshot {
  readonly phase: "idle" | "loading" | "ready" | "error";
  readonly records: readonly VoiceHistoryRecord[];
}
const endpoint = "/api/hub/voice/history";
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value);

export function parseVoiceHistory(value: unknown): readonly VoiceHistoryRecord[] {
  const rows = (value as { conversations?: unknown } | null)?.conversations;
  if (!Array.isArray(rows) || rows.length > 20_000) throw new Error("Invalid voice history");
  const seen = new Set<string>();
  return rows.map(row => {
    if (!row || !validId(row.sessionId) || seen.has(row.sessionId) || typeof row.saved !== "boolean" || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0) throw new Error("Invalid voice record");
    seen.add(row.sessionId);
    return { sessionId: row.sessionId, saved: row.saved, createdAt: row.createdAt };
  }).sort((a, b) => b.createdAt - a.createdAt || a.sessionId.localeCompare(b.sessionId));
}

/** Presentation metadata only. Never caches transcripts or changes native
 * archive/workspace state; the host owns durable promotion. */
export class VoiceHistoryClient {
  readonly #fetch: typeof fetch;
  readonly #lifetime = new AbortController();
  readonly #listeners = new Set<() => void>();
  #snapshot: VoiceHistorySnapshot = { phase: "idle", records: [] };
  #flight: Promise<void> | undefined;
  #refreshAgain = false;
  readonly #saving = new Map<string, Promise<void>>();
  #revision = 0;
  constructor(fetcher: typeof fetch) { this.#fetch = fetcher; }
  getSnapshot = (): VoiceHistorySnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  #publish(snapshot: VoiceHistorySnapshot) {
    if (this.#lifetime.signal.aborted) return;
    this.#snapshot = snapshot; this.#listeners.forEach(listener => listener());
  }
  refresh(): Promise<void> {
    if (this.#lifetime.signal.aborted) return Promise.resolve();
    if (this.#flight) return this.#flight;
    const revision = this.#revision;
    this.#publish({ ...this.#snapshot, phase: "loading" });
    this.#flight = (async () => {
      try {
        const response = await this.#fetch(endpoint, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(10_000)]) });
        if (!response.ok) throw new Error("History unavailable");
        const records = parseVoiceHistory(await response.json());
        // A GET started before a confirmed Save cannot undo that acknowledgement.
        if (revision === this.#revision) this.#publish({ phase: "ready", records });
      } catch { this.#publish({ ...this.#snapshot, phase: "error" }); }
    })().finally(() => {
      this.#flight = undefined;
      if (this.#refreshAgain) { this.#refreshAgain = false; void this.refresh(); }
    });
    return this.#flight;
  }
  /** A new voice session or promotion arrived while an older GET may be in flight. */
  invalidate(): void {
    if (this.#lifetime.signal.aborted) return;
    if (this.#flight) this.#refreshAgain = true;
    else void this.refresh();
  }
  save(sessionId: string): Promise<void> {
    if (!validId(sessionId) || !this.#snapshot.records.some(row => row.sessionId === sessionId)) return Promise.reject(new Error("Unknown voice conversation"));
    const existing = this.#saving.get(sessionId); if (existing) return existing;
    const flight = (async () => {
      const response = await this.#fetch(endpoint, { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json", "x-hub-voice-history": "1" }, body: JSON.stringify({ sessionId }),
        signal: AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(10_000)]) });
      if (!response.ok) throw new Error("Save was not confirmed");
      const result = await response.json();
      if (result?.sessionId !== sessionId || result?.saved !== true || result?.kind !== "voice") throw new Error("Save was not confirmed");
      this.#revision++;
      this.#publish({ phase: "ready", records: this.#snapshot.records.map(row => row.sessionId === sessionId ? { ...row, saved: true } : row) });
    })().finally(() => { this.#saving.delete(sessionId); });
    this.#saving.set(sessionId, flight); return flight;
  }
  dispose() { this.#lifetime.abort(); this.#listeners.clear(); }
}
