import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { apply } from "@minke/harness-overlay/voice.ts";

test("the installed voice plugin mounts Background with the same authentication and readiness guards as Interrupt", async () => {
  const routes = new Map();
  let cleanup;
  // Deliberately stop before model preparation. Exercise the real plugin's
  // web registration boundary without files, devices, or provider requests.
  apply({
    storageDomain: { async open(spec) {
      if (spec.name !== "hub_voice_task_policies") throw Error("Fixture startup is unavailable");
      return { table: () => ({ size: 0 }), async close() {} };
    } },
    on: () => () => {}, agents: { list: () => [] },
    hubCharacters: { presentations: {} }, subprocess: {},
    connection: { requestRejection: req => req.headers.cookie === "fixture=1" ? undefined : 401 },
    webServer: { register(route) {
      assert.equal(route.kind, "exact"); assert.equal(routes.has(route.path), false);
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    } },
    effect(fn) { cleanup = fn(); },
  }, { python: process.execPath, provider: "fixture", model: "unused" });
  const server = createServer((req, res) => {
    const handler = routes.get(req.url);
    if (!handler) { res.writeHead(404); res.end(); return; }
    void handler(req, res).catch(() => res.destroy());
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/hub/voice/`;
    for (const action of ["attention", "interrupt"]) {
      const post = headers => fetch(url + action, { method: "POST", headers });
      assert.equal((await post({})).status, 401, `${action} must be mounted and authenticated`);
      assert.equal((await post({ cookie: "fixture=1", "sec-fetch-site": "cross-site" })).status, 403);
      const pending = await post({ cookie: "fixture=1" });
      assert.equal(pending.status, 503, `${action} must reach the plugin's readiness guard`);
      assert.deepEqual(await pending.json(), { error: "voice-unavailable" });
    }
  } finally {
    await cleanup(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  assert.equal(routes.size, 0);
});
