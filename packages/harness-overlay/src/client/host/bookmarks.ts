import {
  HUB_BOOKMARKS_ROUTE,
  bookmarkSessionId,
  parseBookmarkIds,
  parseBookmarkSnapshot,
  parseBookmarkUpdate,
  type BookmarkChange,
} from "../../bookmarks-contract.ts";

export const LEGACY_BOOKMARKS_KEY = "hub.mobile.pinned-sessions.v1";
export const BOOKMARK_CACHE_KEY = "hub.bookmarks.cache.v2";

interface BookmarkClientOptions {
  readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  readonly fetch: typeof globalThis.fetch;
  readonly onChange: () => void;
}

/** The cache is only for immediate rendering and retrying unacknowledged edits. */
export class BookmarkClient {
  readonly #options: BookmarkClientOptions;
  #confirmed: string[] = [];
  #pending: BookmarkChange[] = [];
  #legacy: string[] = [];
  #flight: Promise<void> | undefined;
  #status: "syncing" | "synced" | "pending" = "syncing";
  #disposed = false;

  constructor(options: BookmarkClientOptions) {
    this.#options = options;
    try {
      const raw = options.storage.getItem(BOOKMARK_CACHE_KEY);
      if (raw !== null) {
        const cache = JSON.parse(raw);
        this.#confirmed = parseBookmarkIds(cache.sessionIds);
        this.#pending = [...parseBookmarkUpdate({ changes: cache.pending }).changes];
      }
    } catch { /* A bad cache does not replace the Host's durable copy. */ }
    try {
      this.#legacy = parseBookmarkIds(JSON.parse(options.storage.getItem(LEGACY_BOOKMARKS_KEY) ?? "[]"));
    } catch { /* Keep malformed legacy data untouched. */ }
  }

  get sessionIds(): string[] {
    const ids = new Set([...this.#confirmed, ...this.#legacy]);
    for (const change of this.#pending) {
      if (change.pinned) ids.add(change.sessionId);
      else ids.delete(change.sessionId);
    }
    return [...ids];
  }

  get status(): "syncing" | "synced" | "pending" {
    return this.#status;
  }

  set(sessionId: string, pinned: boolean): void {
    bookmarkSessionId(sessionId);
    this.#pending = this.#pending.filter((change) => change.sessionId !== sessionId);
    this.#pending.push({ sessionId, pinned });
    this.#status = "syncing";
    this.#saveCache();
    this.#options.onChange();
    void this.sync();
  }

  #saveCache(): void {
    try {
      this.#options.storage.setItem(BOOKMARK_CACHE_KEY, JSON.stringify({
        sessionIds: this.#confirmed,
        pending: this.#pending,
      }));
    } catch { /* The Host remains durable even when browser storage is blocked. */ }
  }

  sync(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#flight !== undefined) return this.#flight;
    this.#flight = this.#synchronize().finally(() => { this.#flight = undefined; });
    return this.#flight;
  }

  async #synchronize(): Promise<void> {
    try {
      do {
        const sent = [...this.#pending];
        const importing = [...this.#legacy];
        const write = sent.length > 0 || importing.length > 0;
        const response = await this.#options.fetch(HUB_BOOKMARKS_ROUTE, {
          method: write ? "POST" : "GET",
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
          ...(write ? {
            headers: { "content-type": "application/json", "x-hub-bookmarks": "1" },
            body: JSON.stringify({ importIds: importing, changes: sent }),
          } : {}),
        });
        if (!response.ok) throw new Error("Bookmarks are unavailable");
        const snapshot = parseBookmarkSnapshot(await response.json());
        if (this.#disposed) return;
        this.#confirmed = [...snapshot.sessionIds];
        // New taps during the request remain pending, including a second tap
        // on the same session. Never overwrite them with an older response.
        this.#pending = this.#pending.filter((change) => !sent.includes(change));
        this.#legacy = [];
        this.#saveCache();
        try { this.#options.storage.removeItem(LEGACY_BOOKMARKS_KEY); } catch { /* Import is idempotent. */ }
        this.#status = this.#pending.length > 0 ? "syncing" : "synced";
        this.#options.onChange();
      } while (this.#pending.length > 0 && !this.#disposed);
    } catch {
      if (this.#disposed) return;
      this.#status = "pending";
      this.#saveCache();
      this.#options.onChange();
    }
  }

  dispose(): void {
    this.#disposed = true;
  }
}
