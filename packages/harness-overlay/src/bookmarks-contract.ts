export const HUB_BOOKMARKS_ROUTE = "/hub/bookmarks";

export interface BookmarkChange {
  readonly sessionId: string;
  readonly pinned: boolean;
}

export interface BookmarkUpdate {
  readonly importIds: readonly string[];
  readonly changes: readonly BookmarkChange[];
}

export interface BookmarkSnapshot {
  readonly revision: number;
  readonly sessionIds: readonly string[];
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid bookmark data");
  }
  return value as Record<string, unknown>;
}

export function bookmarkSessionId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(value)) {
    throw new TypeError("Invalid bookmark session ID");
  }
  return value;
}

export function parseBookmarkIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20_000) {
    throw new TypeError("Invalid bookmark list");
  }
  return [...new Set(value.map(bookmarkSessionId))];
}

export function parseBookmarkUpdate(value: unknown): BookmarkUpdate {
  const input = record(value);
  const importIds = parseBookmarkIds(input.importIds ?? []);
  if (!Array.isArray(input.changes) || input.changes.length > 20_000) {
    throw new TypeError("Invalid bookmark changes");
  }
  const changes = input.changes.map((item): BookmarkChange => {
    const change = record(item);
    if (typeof change.pinned !== "boolean") {
      throw new TypeError("Invalid bookmark state");
    }
    return { sessionId: bookmarkSessionId(change.sessionId), pinned: change.pinned };
  });
  return { importIds, changes };
}

export function parseBookmarkSnapshot(value: unknown): BookmarkSnapshot {
  const input = record(value);
  if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0) {
    throw new TypeError("Invalid bookmark revision");
  }
  return { revision: Number(input.revision), sessionIds: parseBookmarkIds(input.sessionIds) };
}
