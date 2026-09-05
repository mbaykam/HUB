import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import {
  HUB_BOOKMARKS_ROUTE,
  parseBookmarkUpdate,
  type BookmarkSnapshot,
  type BookmarkUpdate,
} from "../bookmarks-contract.ts";

interface BookmarkDocument {
  version: 1;
  revision: number;
  entries: Map<string, boolean>;
}

function snapshot(document: BookmarkDocument): BookmarkSnapshot {
  return {
    revision: document.revision,
    sessionIds: [...document.entries].filter(([, pinned]) => pinned).map(([id]) => id),
  };
}

/** One serialized writer per Host. Persist before acknowledging any change. */
export class BookmarkStore {
  readonly #path: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => {});
    return result;
  }

  async #load(): Promise<BookmarkDocument> {
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, revision: 0, entries: new Map() };
      }
      throw error;
    }
    const data = JSON.parse(text);
    if (data.version !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 0) {
      throw new Error("Invalid bookmark store");
    }
    const { changes } = parseBookmarkUpdate({ changes: data.entries });
    return { version: 1, revision: data.revision, entries: new Map(changes.map((c) => [c.sessionId, c.pinned])) };
  }

  read(): Promise<BookmarkSnapshot> {
    return this.#serialize(async () => snapshot(await this.#load()));
  }

  update(input: BookmarkUpdate): Promise<BookmarkSnapshot> {
    const update = parseBookmarkUpdate(input);
    return this.#serialize(async () => {
      const document = await this.#load();
      let changed = false;
      // Remember unpins too: an old browser's later migration must not revive
      // a bookmark that another device has already removed.
      for (const id of update.importIds) {
        if (document.entries.has(id)) continue;
        document.entries.set(id, true);
        changed = true;
      }
      for (const { sessionId, pinned } of update.changes) {
        if (document.entries.get(sessionId) === pinned) continue;
        document.entries.set(sessionId, pinned);
        changed = true;
      }
      if (!changed) return snapshot(document);
      if (document.entries.size > 20_000) throw new Error("Bookmark store is full");
      document.revision += 1;
      await mkdir(dirname(this.#path), { recursive: true });
      const temporary = `${this.#path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(JSON.stringify({
            version: 1,
            revision: document.revision,
            entries: [...document.entries].map(([sessionId, pinned]) => ({ sessionId, pinned })),
          }) + "\n");
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, this.#path);
      } finally {
        await rm(temporary, { force: true });
      }
      return snapshot(document);
    });
  }
}

interface BookmarkWebServer {
  register(route: {
    kind: "exact";
    path: string;
    handler(request: IncomingMessage, response: ServerResponse): Promise<void>;
  }): () => void;
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

export function installBookmarksHost(
  webServer: BookmarkWebServer,
  path: string,
  requestRejection: (request: IncomingMessage) => 401 | 403 | undefined,
): () => void {
  const store = new BookmarkStore(path);
  return webServer.register({
    kind: "exact",
    path: HUB_BOOKMARKS_ROUTE,
    async handler(request, response) {
      const rejection = requestRejection(request);
      if (rejection !== undefined) {
        send(response, rejection, { error: rejection === 401 ? "unauthorized" : "forbidden" });
        return;
      }
      if (request.headers["sec-fetch-site"] === "cross-site") {
        send(response, 403, { error: "forbidden" });
        return;
      }
      if (request.method !== "GET" && request.method !== "POST") {
        response.writeHead(405, { allow: "GET, POST" });
        response.end();
        return;
      }
      let update: BookmarkUpdate | undefined;
      if (request.method === "POST") {
        // Non-simple requests require a preflight from foreign origins. This
        // route deliberately provides no CORS permission, including to siblings.
        if (request.headers["x-hub-bookmarks"] !== "1" ||
          !request.headers["content-type"]?.startsWith("application/json")) {
          send(response, 403, { error: "forbidden" });
          return;
        }
        try {
          let bytes = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            const buffer = Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > 256 * 1024) {
              send(response, 413, { error: "Bookmark update is too large" });
              return;
            }
            chunks.push(buffer);
          }
          update = parseBookmarkUpdate(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          send(response, 400, { error: "Invalid bookmark update" });
          return;
        }
      }
      try {
        send(response, 200, update === undefined ? await store.read() : await store.update(update));
      } catch {
        // A corrupt/unwritable store is never replaced with an empty list.
        send(response, 503, { error: "Bookmarks are temporarily unavailable" });
      }
    },
  });
}
