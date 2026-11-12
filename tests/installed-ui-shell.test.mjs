import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { parse } from "acorn";
import { build } from "esbuild";
import test from "node:test";
import { transformInstalledUIShell } from "../mobile/scripts/installed-ui-shell.mjs";

const root = fileURLToPath(new URL("../runtime/host/node_modules/@deepseek-ai/dsh-web-frontend/dist/", import.meta.url));
const html = await readFile(resolve(root, "index.html"), "utf8");
const entryPath = /<script\b[^>]*type="module"[^>]*src="([^"]+)"/u.exec(html)?.[1];
assert.ok(entryPath?.startsWith("./assets/"), "test requires the actual staged Vite shell");
const staged = await readFile(resolve(root, entryPath), "utf8");
const output = await build({ entryPoints: [resolve(root, entryPath)], bundle: true, write: false, format: "iife", platform: "browser", target: "safari17", minify: true, legalComments: "inline", logLevel: "silent" });
const shell = output.outputFiles.map(file => file.text).join("\n");
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === "object") walk(value, visit);
  }
}
function methods(source) {
  const result = {};
  walk(parse(source, { ecmaVersion: "latest", sourceType: "module" }), node => {
    if (node.type === "MethodDefinition" && ["runPluginBoot", "assertEntriesActive"].includes(node.key?.name)) result[node.key.name] = source.slice(node.start, node.end);
  });
  return result;
}
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(source, failure) {
  const m = methods(source), events = [], entries = new Map(), transport = deferred(), initialization = deferred();
  const loaderSymbol = /\.plugin\((\w+)\)/u.exec(m.runPluginBoot)?.[1];
  const labelsSymbol = /(\w+)\[\w+\.fiber\.state\]/u.exec(m.runPluginBoot)?.[1];
  assert.ok(loaderSymbol && labelsSymbol);
  const scope = { [loaderSymbol]: {}, [labelsSymbol]: { active: "active", pending: "pending" } };
  runInNewContext(`globalThis.Boot = class { ${m.runPluginBoot} ${m.assertEntriesActive} };`, scope);
  const entry = new scope.Boot();
  entry.modules = {};
  entry.manifest = { plugins: [{ id: "slow" }, { id: "fast" }] };
  entry.page = { setState() {}, setTotal() {} };
  const loader = {
    async create({ name }) {
      events.push(`import:${name}`);
      if (name === "slow") await transport.promise;
      else { events.push("initialize:fast"); await initialization.promise; }
      entries.set(name, { options: { name }, fiber: name === "slow" && failure === "import" ? undefined : {
        state: name === "slow" && failure === "service" ? "pending" : "active", inject: failure === "service" ? { requiredService: true } : {},
      } });
      events.push(`settled:${name}`); return name;
    },
    resolve(id) { return entries.get(id); }, async await() { events.push("audit"); }, entries() { return entries.values(); },
  };
  const ctx = { loader, async plugin() {}, on() {}, get() {} };
  return { events, transport, initialization, run: () => entry.runPluginBoot(ctx, transport.promise) };
}

test("actual staged Vite shell and installed rebundle transform one guarded prefetch await", async () => {
  for (const input of [staged, shell]) {
    const result = transformInstalledUIShell(input);
    assert.notEqual(result, input);
    assert.equal(methods(result).assertEntriesActive, methods(input).assertEntriesActive);
    const method = methods(input).runPluginBoot;
    const fn = parse(`class A { ${method} }`, { ecmaVersion: "latest" }).body[0].body.body[0].value;
    const parameter = fn.params[1].name;
    assert.equal(methods(result).runPluginBoot, method.replace(new RegExp(`await ${parameter}(?=[,;])`, "u"), "void 0"));
  }
  // Rebundling/transformation is pure: the actual staged bytes never change.
  assert.equal(await readFile(resolve(root, entryPath), "utf8"), staged);
});

test("actual frontend imports overlap delayed prefetch while all required activation still waits", async () => {
  const optimized = fixture(transformInstalledUIShell(shell)), running = optimized.run();
  await tick();
  assert.deepEqual(optimized.events, ["import:slow", "import:fast", "initialize:fast"]);
  optimized.initialization.resolve(); await tick();
  assert.ok(optimized.events.includes("settled:fast")); assert.ok(!optimized.events.includes("audit"));
  optimized.transport.resolve(); await running;
  assert.equal(optimized.events.at(-1), "audit");
  const baseline = fixture(shell), original = baseline.run(); await tick();
  assert.deepEqual(baseline.events, []);
  baseline.transport.resolve(); baseline.initialization.resolve(); await original;
  assert.equal(baseline.events.at(-1), "audit");
});

test("actual shell retains failed-import and required-service activation rejection", async () => {
  for (const failure of ["import", "service"]) {
    const f = fixture(transformInstalledUIShell(shell), failure), running = f.run();
    f.transport.resolve(); f.initialization.resolve();
    await assert.rejects(running, failure === "import" ? /slow: import failed/ : /waiting for service: requiredService/);
  }
});

test("shell transform fails closed on method, parameter, await or audit drift", () => {
  const sample = `class Boot { async runPluginBoot(ctx,prefetch) { await prefetch; await Promise.all([ctx.loader.create({})]); await ctx.loader.await(); this.assertEntriesActive(ctx); } }`;
  assert.ok(transformInstalledUIShell(sample).includes("void 0"));
  for (const drift of [
    "class Empty {}", sample + sample.replace("Boot", "Duplicate"),
    sample.replace("async runPluginBoot", "runPluginBoot"), sample.replace("ctx,prefetch", "ctx"),
    sample.replace("await prefetch;", "await prefetch; await prefetch;"),
    sample.replace("await prefetch;", "void prefetch;"),
    sample.replace("this.assertEntriesActive(ctx);", ""),
    sample.replace("await ctx.loader.await();", ""),
  ]) assert.throws(() => transformInstalledUIShell(drift));
  assert.throws(() => transformInstalledUIShell(transformInstalledUIShell(sample)), /drift/);
});
