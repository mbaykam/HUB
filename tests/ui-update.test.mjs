import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { runInNewContext } from "node:vm";
import { execFileSync, spawnSync } from "node:child_process";
import { UI_FILES, uiHash, parseUiRelease, parseUiPointer, changeUiRelease, readUiPointer } from "../packages/harness-overlay/src/host/ui-release-store.ts";
import { installUiUpdates } from "../packages/harness-overlay/src/host/ui-updates.ts";
const compatibility = "a".repeat(64);
function bundle(label = "Test 1", patch = {}) {
  const files = Object.fromEntries(UI_FILES.map(name => {
    const data = name === "pwa-client.js" ? `window.__HUB_UI_FACTORY__ = () => ({ label: ${JSON.stringify(label)} });` : `/* ${name} ${label} */`;
    return [name, { sha256: uiHash(data), data: Buffer.from(data).toString("base64") }];
  }));
  return JSON.stringify({ schema: 1, compatibility, label, files, ...patch });
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "hub-ui-update-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory: join(root, compatibility) };
}
test("accepts only complete checksum-verified UI assets and the exact host", () => {
  const text = bundle();
  assert.equal(parseUiRelease(text, compatibility).id, uiHash(text));
  assert.throws(() => parseUiRelease(text, "b".repeat(64)), /matching host/);
  for (const edit of [
    value => { value.files["host.js"] = value.files["pwa-client.js"]; },
    value => { value.files["../../credentials"] = value.files["pwa-client.js"]; },
    value => { delete value.files["voice-browser.js"]; },
    value => { value.files["voice-browser.js"].data += "!"; },
    value => { value.files["voice-browser.js"].sha256 = "0".repeat(64); },
    value => { value.label = "<script>"; },
    value => { value.install = "powershell"; },
    value => { value.schema = 2; },
  ]) {
    const value = JSON.parse(text); edit(value);
    assert.throws(() => parseUiRelease(JSON.stringify(value), compatibility));
  }
  assert.throws(() => parseUiPointer('{"schema":1,"active":"../foo","previous":null}'));
});
test("activation is atomic, idempotent, rollback retains both releases and does not touch unrelated files", async t => {
  const { root, directory } = await fixture(t);
  await writeFile(join(root, "private-memory.txt"), "unchanged");
  const a = bundle("A"), b = bundle("B");
  const activate = text => changeUiRelease(directory, compatibility, { text, sha256: uiHash(text) });
  await assert.rejects(changeUiRelease(directory, compatibility, { text: a, sha256: "0".repeat(64) }), /approved/);
  assert.deepEqual(await readUiPointer(directory), { schema: 1, active: null, previous: null });
  await activate(a);
  assert.deepEqual(await activate(b), { schema: 1, active: uiHash(b), previous: uiHash(a) });
  assert.equal((await activate(b)).previous, uiHash(a));
  assert.equal((await changeUiRelease(directory, compatibility, "rollback")).active, uiHash(a));
  assert.equal((await changeUiRelease(directory, compatibility, "builtin")).active, null);
  assert.equal((await changeUiRelease(directory, compatibility, "rollback")).active, uiHash(a));
  assert.equal(await readFile(join(directory, `${uiHash(b)}.json`), "utf8"), b);
  assert.equal(await readFile(join(root, "private-memory.txt"), "utf8"), "unchanged");
});
test("corruption and a concurrent activation fail without replacing the active pointer", async t => {
  const { directory } = await fixture(t); const a = bundle("A"), b = bundle("B");
  await changeUiRelease(directory, compatibility, { text: a, sha256: uiHash(a) });
  await writeFile(join(directory, `${uiHash(b)}.json`), "interrupted or corrupted package");
  await assert.rejects(changeUiRelease(directory, compatibility, { text: b, sha256: uiHash(b) }));
  assert.equal((await readUiPointer(directory)).active, uiHash(a));
  await mkdir(join(directory, "activation.lock"));
  await assert.rejects(changeUiRelease(directory, compatibility, "builtin"), { code: "EEXIST" });
  assert.equal((await readUiPointer(directory)).active, uiHash(a));
});
test("real HTTP: authenticated read-only routes, activation without restart, pinned old assets, restart, corrupt fallback", async t => {
  const { root, directory } = await fixture(t);
  const routes = new Map(); let transform;
  const web = { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); }, tapIndex(fn) { transform = fn; return () => { transform = undefined; }; } };
  const options = { root, host: JSON.stringify({ schema: 1, compatibility }) };
  let dispose = installUiUpdates(web, request => request.headers.authorization === "test-only" ? undefined : 401, options);
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const route = routes.get(url.pathname);
    if (route) return route(request, response);
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { dispose(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = (path, init) => fetch(url + path, { headers: { authorization: "test-only" }, ...init });
  assert.equal((await fetch(url + "/api/hub/ui/status")).status, 401);
  assert.equal((await get("/api/hub/ui/status", { method: "POST" })).status, 405);
  assert.equal((await get("/api/hub/ui/status", { headers: { authorization: "test-only", "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await (await get("/api/hub/ui/status")).json()).id, "builtin");
  const a = bundle("A"), b = bundle("B");
  await changeUiRelease(directory, compatibility, { text: a, sha256: uiHash(a) });
  const html = transform('<html><head><script type="module" src="/main.js"></script></head></html>');
  assert.ok(html.indexOf("/api/hub/ui/asset") < html.indexOf('type="module"'));
  assert.ok(html.includes("integrity=\"sha256-"));
  assert.equal((await (await get("/api/hub/ui/status")).json()).id, uiHash(a));
  const pinned = `/api/hub/ui/asset?release=${uiHash(a)}&file=memory-graph-browser.js`;
  await changeUiRelease(directory, compatibility, { text: b, sha256: uiHash(b) });
  assert.equal((await (await get("/api/hub/ui/status")).json()).label, "B");
  assert.match(await (await get(pinned)).text(), / A /);
  assert.equal((await get(`/api/hub/ui/asset?release=${uiHash(a)}&file=../../credentials`)).status, 400);
  assert.equal((await get(pinned, { headers: {} })).status, 401);
  assert.equal((await get(pinned, { method: "POST" })).status, 405);
  dispose(); dispose = installUiUpdates(web, request => request.headers.authorization === "test-only" ? undefined : 401, options);
  assert.equal((await (await get("/api/hub/ui/status")).json()).label, "B");
  await writeFile(join(directory, "active.json"), "broken");
  const status = await (await get("/api/hub/ui/status")).json();
  assert.equal(status.id, "builtin"); assert.equal(status.fallback, true);
  assert.ok(!transform("<head></head>").includes('src="/api/hub/ui/asset'));
  assert.match(await (await get(pinned)).text(), / A /);
  await changeUiRelease(directory, compatibility, "builtin");
  assert.equal((await (await get("/api/hub/ui/status")).json()).fallback, false);
});
test("built factory chooses the override before materialization; desktop retains the bundled factory", async () => {
  const source = await readFile(new URL("../packages/harness-overlay/lib/client.js", import.meta.url), "utf8");
  const pwa = await readFile(new URL("../packages/harness-overlay/lib/pwa-client.js", import.meta.url), "utf8");
  let registration;
  const desktop = { __ModuleLoader__: { load(value) { registration = value; } } };
  runInNewContext(source, { window: desktop });
  assert.equal(typeof registration.factory, "function");
  const bundled = registration.factory;
  const override = () => "updated";
  runInNewContext(source, { window: { ...desktop, __HUB_UI_FACTORY__: override } });
  assert.equal(registration.factory, override); assert.notEqual(registration.factory, bundled);
  const window = {};
  runInNewContext(pwa, { window });
  assert.equal(typeof window.__HUB_UI_FACTORY__, "function");
  assert.ok(!pwa.includes("sourceMappingURL="));
});

test("compressed CLI package round-trip requires its exact checksum and the target host metadata", async t => {
  const { root } = await fixture(t);
  const lib = join(root, "lib"); await mkdir(lib);
  const source = JSON.parse(bundle());
  for (const name of UI_FILES) await writeFile(join(lib, name), Buffer.from(source.files[name].data, "base64"));
  const host = join(lib, "ui-host.json"); await writeFile(host, JSON.stringify({ schema: 1, compatibility }));
  const script = new URL("../scripts/harness/ui-update.mjs", import.meta.url);
  const run = args => JSON.parse(execFileSync(process.execPath, [script.pathname.replace(/^\/([A-Z]:)/i, "$1"), ...args], { encoding: "utf8", windowsHide: true }));
  const artifact = join(root, "update.hub-ui");
  const packed = run(["pack", "--lib", lib, "--out", artifact, "--label", "CLI test"]);
  assert.ok(packed.bytes < 2048);
  const args = ["activate", "--host-manifest", host, "--store", join(root, "store"), "--package", artifact];
  assert.equal(spawnSync(process.execPath, [script.pathname.replace(/^\/([A-Z]:)/i, "$1"), ...args, "--sha256", "0".repeat(64)], { windowsHide: true }).status, 1);
  const result = run([...args, "--sha256", packed.sha256]);
  assert.equal(result.active, packed.release);
  assert.equal(run(["status", "--host-compatibility", compatibility, "--store", join(root, "store")]).active, packed.release);
  assert.equal(spawnSync(process.execPath, [script.pathname.replace(/^\/([A-Z]:)/i, "$1"), "status", "--host-manifest", host, "--host-compatibility", compatibility], { windowsHide: true }).status, 1);
  const wrong = join(root, "wrong-host.json"); await writeFile(wrong, JSON.stringify({ schema: 1, compatibility: "b".repeat(64) }));
  assert.equal(spawnSync(process.execPath, [script.pathname.replace(/^\/([A-Z]:)/i, "$1"), "activate", "--host-manifest", wrong, "--store", join(root, "store"), "--package", artifact, "--sha256", packed.sha256], { windowsHide: true }).status, 1);
});
