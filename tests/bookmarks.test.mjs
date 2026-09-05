import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BookmarkStore, installBookmarksHost } from "@minke/harness-overlay/host/bookmarks.ts";
import { BookmarkClient, LEGACY_BOOKMARKS_KEY, BOOKMARK_CACHE_KEY } from "@minke/harness-overlay/client/host/bookmarks.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "hub-bookmarks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "bookmarks.json");
  const store = new BookmarkStore(path);
  return { path, store };
}

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
}

function client(store, cache = storage(), request = {}) {
  return new BookmarkClient({
    storage: cache,
    onChange() {},
    async fetch(_url, init) {
      if (request.offline) throw new Error("Offline");
      const result = init.method === "POST"
        ? await store.update(JSON.parse(init.body))
        : await store.read();
      if (request.afterRead) await request.afterRead();
      return Response.json(result);
    },
  });
}

test("two devices merge existing bookmarks and preserve independent concurrent changes after restart", async (t) => {
  const { store, path } = await fixture(t);
  const firstCache = storage({ [LEGACY_BOOKMARKS_KEY]: '["old-first"]' });
  const secondCache = storage({ [LEGACY_BOOKMARKS_KEY]: '["old-second"]' });
  const first = client(store, firstCache);
  const second = client(store, secondCache);
  await Promise.all([first.sync(), second.sync()]);
  assert.equal(firstCache.getItem(LEGACY_BOOKMARKS_KEY), null);
  assert.equal(secondCache.getItem(LEGACY_BOOKMARKS_KEY), null);
  first.set("new-first", true);
  second.set("new-second", true);
  await Promise.all([first.sync(), second.sync()]);
  await Promise.all([first.sync(), second.sync()]);
  assert.deepEqual(new Set(first.sessionIds), new Set(["old-first", "old-second", "new-first", "new-second"]));
  assert.deepEqual(first.sessionIds, second.sessionIds);
  const cleanDevice = client(new BookmarkStore(path));
  await cleanDevice.sync();
  assert.deepEqual(cleanDevice.sessionIds, first.sessionIds);
  first.set("old-first", false);
  await first.sync();
  await second.sync();
  assert.equal(second.sessionIds.includes("old-first"), false);
  // A device that has not yet migrated cannot resurrect an acknowledged unpin.
  const oldDevice = client(store, storage({ [LEGACY_BOOKMARKS_KEY]: '["old-first","yet-another"]' }));
  await oldDevice.sync();
  assert.equal(oldDevice.sessionIds.includes("old-first"), false);
  assert.equal(oldDevice.sessionIds.includes("yet-another"), true);
});

test("offline edits survive reload, retry, and do not replace another device's bookmarks", async (t) => {
  const { store } = await fixture(t);
  const cache = storage({ [LEGACY_BOOKMARKS_KEY]: '["legacy"]' });
  const state = { offline: true };
  let device = client(store, cache, state);
  device.set("offline-pin", true);
  device.set("legacy", false);
  await device.sync();
  assert.equal(device.status, "pending");
  assert.notEqual(cache.getItem(LEGACY_BOOKMARKS_KEY), null);
  assert.deepEqual(device.sessionIds, ["offline-pin"]);
  device.dispose();
  await store.update({ importIds: [], changes: [{ sessionId: "other-device", pinned: true }] });
  device = client(store, cache, state);
  assert.deepEqual(device.sessionIds, ["offline-pin"]);
  state.offline = false;
  await device.sync();
  assert.equal(device.status, "synced");
  assert.deepEqual(new Set(device.sessionIds), new Set(["other-device", "offline-pin"]));
  assert.equal(cache.getItem(LEGACY_BOOKMARKS_KEY), null);
  assert.deepEqual(JSON.parse(cache.getItem(BOOKMARK_CACHE_KEY)).pending, []);
});

test("a rapid unpin during an in-flight pin wins over the delayed response", async (t) => {
  const { store } = await fixture(t);
  let release;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const pause = new Promise((resolve) => { release = resolve; });
  let delayed = false;
  const device = client(store, storage(), {
    async afterRead() {
      if (delayed) return;
      delayed = true;
      started();
      await pause;
    },
  });
  device.set("chat", true);
  await waiting;
  device.set("chat", false);
  assert.deepEqual(device.sessionIds, []);
  release();
  await device.sync();
  assert.deepEqual(device.sessionIds, []);
  assert.deepEqual((await store.read()).sessionIds, []);
  assert.equal(device.status, "synced");
});

test("a stale GET cannot erase a pin made while loading and rejected saves remain pending", async (t) => {
  const { store } = await fixture(t);
  let release;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const pause = new Promise((resolve) => { release = resolve; });
  let delayed = false;
  const cache = storage();
  const device = client(store, cache, { async afterRead() {
    if (delayed) return;
    delayed = true;
    started();
    await pause;
  } });
  const load = device.sync();
  await waiting;
  device.set("new-chat", true);
  release();
  await load;
  assert.deepEqual((await store.read()).sessionIds, ["new-chat"]);
  const unavailable = new BookmarkClient({ storage: cache, onChange() {}, fetch: async () => new Response("denied", { status: 401 }) });
  unavailable.set("new-chat", false);
  await unavailable.sync();
  assert.equal(unavailable.status, "pending");
  assert.deepEqual(JSON.parse(cache.getItem(BOOKMARK_CACHE_KEY)).pending, [{ sessionId: "new-chat", pinned: false }]);
});

test("corrupt server data stays untouched and retried import is idempotent", async (t) => {
  const { store, path } = await fixture(t);
  const update = { importIds: ["chat"], changes: [] };
  const first = await store.update(update);
  assert.deepEqual(await store.update(update), first);
  await writeFile(path, "broken JSON", "utf8");
  await assert.rejects(store.update(update));
  assert.equal(await readFile(path, "utf8"), "broken JSON");
});

test("HTTP route checks auth, cross-site requests and input before changing durable bookmarks", async (t) => {
  const { path } = await fixture(t);
  let route;
  installBookmarksHost({ register(value) { route = value; return () => {}; } }, path,
    (request) => request.headers.cookie === "test-auth=1" ? undefined : 401);
  const server = createServer((req, res) => { void route.handler(req, res); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}${route.path}`;
  const headers = { cookie: "test-auth=1", "content-type": "application/json", "x-hub-bookmarks": "1" };
  const body = JSON.stringify({ changes: [{ sessionId: "real-chat", pinned: true }] });
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { method: "POST", body, headers: { ...headers, "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await fetch(url, { method: "POST", body, headers: { cookie: "test-auth=1", "content-type": "application/json" } })).status, 403);
  assert.equal((await fetch(url, { method: "POST", body: "{}", headers })).status, 400);
  assert.equal((await fetch(url, { method: "POST", body: JSON.stringify({ changes: [{ sessionId: "../bad", pinned: true }] }), headers })).status, 400);
  assert.equal((await fetch(url, { method: "POST", body: "x".repeat(256 * 1024 + 1), headers })).status, 413);
  assert.equal((await fetch(url, { method: "DELETE", headers })).status, 405);
  assert.equal((await fetch(url, { headers })).headers.get("cache-control"), "no-store");
  const saved = await fetch(url, { method: "POST", body, headers }).then((r) => r.json());
  assert.deepEqual(saved.sessionIds, ["real-chat"]);
  const loaded = await fetch(url, { headers }).then((r) => r.json());
  assert.deepEqual(loaded, saved);
});
