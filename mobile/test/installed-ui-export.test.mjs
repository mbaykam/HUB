import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { loadStaticBuildApi, readBuildFile, exportInstalledUI } from "../scripts/export-installed-ui.mjs";

const runtime = resolve("runtime/host");
const bootstrap = "@deepseek-ai/dsh-client-modules";
const input = (id, fields = {}, code = "return {};") => ({
  manifest: { name: id, exports: { "./client": "./lib/client.js" }, dsh: { client: { platform: "web", ...fields } } },
  bundle: Buffer.from(`window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => { ${code} } });\n`),
});

test("pure static graph composes deterministic registrations without executing factories", async () => {
  const api = await loadStaticBuildApi(runtime);
  const inputs = [input(bootstrap), input("consumer", { external: ["dependency/client"] }, "throw new Error('must not activate');"), input("dependency")];
  const first = api.buildStaticClientGraph(inputs, []), second = api.buildStaticClientGraph(inputs, []);
  assert.deepEqual(first, second);
  assert.deepEqual(first.graph.entries.map(row => row.id), [bootstrap, "dependency", "consumer"]);
  assert.equal(first.graph.batches[0].phase, "bootstrap");
  assert.equal(first.graph.batches.flatMap(batch => batch.entries).length, 3);
  assert.ok(first.assets.every(asset => !asset.body.toString().includes("sourceMappingURL")));
  const changed = api.buildStaticClientGraph([input(bootstrap), input("dependency", {}, "return {different:1};")], []);
  assert.notEqual(first.graph.rev, changed.graph.rev);
});

test("static graph refuses incomplete or ambiguous product profiles", async () => {
  const api = await loadStaticBuildApi(runtime);
  assert.throws(() => api.buildStaticClientGraph([], []), /Missing client module bootstrap/);
  assert.throws(() => api.buildStaticClientGraph([input(bootstrap), input(bootstrap)], []), /Duplicate/);
  assert.throws(() => api.buildStaticClientGraph([input(bootstrap), input("consumer", { external: ["missing"] })], []), /Unresolved/);
  assert.throws(() => api.buildStaticClientGraph([input(bootstrap), input("consumer", { inject: ["missing"] })], []), /Missing injected/);
  assert.throws(() => api.buildStaticClientGraph([input(bootstrap), input("a", { external: ["b"] }), input("b", { external: ["a"] })], []), /cycle/);
  assert.throws(() => api.buildStaticClientGraph([{ ...input(bootstrap), bundle: Buffer.from("unrelated script") }], []), /Unexpected client registration/);
});

test("build input reader refuses paths outside staging", async () => {
  const temp = await mkdtemp(join(tmpdir(), "hub-export-input-"));
  try {
    await mkdir(join(temp, "stage"));
    await writeFile(join(temp, "private.txt"), "synthetic private data");
    await assert.rejects(readBuildFile(join(temp, "stage"), "../private.txt"), /escapes staging/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("real staged renderer mounts offline without requesting static code", { skip: process.env.HUB_RUN_INSTALLED_UI_RENDER_TEST !== "1", timeout: 45000 }, async () => {
  const require = createRequire(resolve("vendor/deepseek-harness/package.json"));
  const { JSDOM, VirtualConsole, requestInterceptor } = require("jsdom");
  const output = await mkdtemp(join(tmpdir(), "hub-export-render-"));
  let dom;
  try {
    const manifest = await exportInstalledUI({ runtimeRoot: runtime, output });
    const html = await readFile(join(output, "document.html"), "utf8");
    const errors = [], requests = [];
    const console = new VirtualConsole();
    console.on("jsdomError", error => errors.push(error.message));
    dom = new JSDOM(html, { url: "https://installed-ui-probe.invalid/", runScripts: "dangerously", resources: { interceptors: [requestInterceptor(async request => { requests.push(request.url); return new Response("offline", { status: 503 }); })] }, pretendToBeVisual: true, virtualConsole: console,
      beforeParse(window) {
        window.fetch = async () => { throw new Error("Synthetic offline fixture"); };
        Object.defineProperty(window, "innerWidth", { value: 390 });
        window.matchMedia = query => ({ matches: /max-width/.test(query), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
        window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
        window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
        window.WebSocket = class { static CLOSED = 3; constructor() { this.readyState = 3; } close() {} addEventListener() {} removeEventListener() {} };
      }
    });
    for (let attempt = 0; attempt < 100 && !dom.window.document.querySelector("[data-hub-home-nav]"); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(requests.length, 0, `Unexpected static requests: ${requests.join(", ")}`);
    assert.ok(dom.window.document.querySelector("[data-hub-home-nav]"), `Renderer did not mount: ${errors.join("; ")} / ${dom.window.document.getElementById("root")?.textContent?.slice(0, 1800)}`);
    assert.equal(manifest.packages.includes("@deepseek-ai/dsh-client-hmr"), false);
  } finally { dom?.window.close(); await rm(output, { recursive: true, force: true }); }
});
