// Real pinned AgentLoop + continuation manager + JSONL persistence. Only the
// model response is scripted; no paid requests, user chats or live app state.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { createVoiceTaskPolicies } from "@minke/harness-overlay/host/voice-task-policy.ts";

// Resolve the pinned monorepo packages just as the native test runner does.
const entries = new Map();
const packages = new URL("../vendor/deepseek-harness/packages/", import.meta.url);
for (const group of await readdir(packages, { withFileTypes: true })) {
  if (!group.isDirectory()) continue;
  for (const pkg of await readdir(new URL(group.name + "/", packages), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const directory = new URL(`${group.name}/${pkg.name}/`, packages);
    let manifest; try { manifest = JSON.parse(await readFile(new URL("package.json", directory), "utf8")); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const main = manifest.exports?.["."]?.default ?? manifest.main;
    if (main?.endsWith(".js")) entries.set(manifest.name, new URL(main, directory).href);
    for (const [key, value] of Object.entries(manifest.exports ?? {})) {
      const target = typeof value === "string" ? value : value?.default;
      if (key.startsWith("./") && target?.endsWith(".js")) entries.set(manifest.name + key.slice(1), new URL(target, directory).href);
    }
  }
}
registerHooks({ resolve(specifier, context, next) { return next(entries.get(specifier) ?? specifier, context); } });
const { mountAgentLoopTestDependencies } = await import("../vendor/deepseek-harness/packages/test-support/agent-loop-testkit/src/index.ts");
const { MockAdapter, textResponse, toolCallResponse } = await import("../vendor/deepseek-harness/packages/core/agent-loop/tests/mock-adapter.ts");
const { TestSessionQuery } = await import("../vendor/deepseek-harness/packages/subagent/subagent/tests/test-session-query.ts");

const requireNative = createRequire(new URL("../vendor/deepseek-harness/package.json", import.meta.url));
const native = name => import(entries.get(name) ?? pathToFileURL(requireNative.resolve(name)).href);
const { Context } = await native("@deepseek-ai/cordis");
const { default: AgentLoop } = await native("@deepseek-ai/dsh-agent-loop");
const { default: Persistence } = await native("@deepseek-ai/dsh-session-persistence-jsonl");
const { default: Projections } = await native("@deepseek-ai/dsh-session-projection");
const { default: Subagents } = await native("@deepseek-ai/dsh-subagent");
const Spawn = await native("@deepseek-ai/dsh-subagent-spawn-in-process");
const { queueHostSubagentPrompt } = await native("@deepseek-ai/dsh-subagent/internal");
const { default: Storage } = await native("@deepseek-ai/dsh-storage");
const { DomainFacility } = await native("@deepseek-ai/dsh-storage-domain");
const { JsonStorageBackend } = await native("@deepseek-ai/dsh-storage-json");

test("actual native continuation cannot widen its tools after voice ends or cold resume", { timeout: 25000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-voice-continuation-test-"));
  const ctx = new Context(); let policies, facility, backend;
  try {
    await mountAgentLoopTestDependencies(ctx); await ctx.plugin(Projections);
    await ctx.plugin(Persistence, { root: join(root, "sessions") });
    await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(TestSessionQuery);
    await ctx.plugin(Subagents); await ctx.plugin(Spawn, { providerName: "spawn" });
    await ctx.plugin(Storage); backend = new JsonStorageBackend(join(root, "domains"));
    ctx.storage.backend.register("json", backend); facility = new DomainFacility(ctx, { backend: "json" }); ctx.storage.mount("domain", facility);
    policies = createVoiceTaskPolicies(ctx, facility);
    let shellRuns = 0, readRuns = 0;
    for (const name of ["read", "shell"]) ctx.tools.register({ name, description: name, parameters: { type: "object", properties: {} },
      output: { schema: { type: "string" }, render: (_, value) => [{ type: "text", text: value }] },
      async execute() { if (name === "shell") shellRuns++; else readRuns++; return "synthetic tool result"; } });
    const adapter = new MockAdapter([
      toolCallResponse("first-read", "read", {}), toolCallResponse("first-denied", "shell", {}), textResponse("First task finished"),
      toolCallResponse("resumed-denied", "shell", {}), toolCallResponse("resumed-read", "read", {}), textResponse("Resumed task finished"),
    ]);
    ctx.llm.registerAdapter(["mock"], adapter);
    const parent = ctx.agentLoop.create("voice-parent", { provider: "mock", model: "mock" });
    // Native continuation test pattern: park the coordinator so completion
    // notifications cannot consume the child's scripted model responses.
    ctx.on("agent/pre-step", async ({ agent }, next) => agent === parent ? { kind: "reject" } : next());
    const off = await policies.bind(parent, { mode: "allow", names: ["read"] });
    const created = [];
    ctx.on("agent/created", ({ agent }) => { if (agent !== parent) created.push(agent); }, { global: true });
    const child = await ctx.subagents.startContinuable({ provider: "spawn", label: "Permission test",
      request: { prompt: [{ type: "text", text: "Exercise tools" }], parent }, signal: new AbortController().signal });
    off();
    const waitDisposed = async () => {
      const deadline = Date.now() + 10000;
      while (ctx.agents.get(child.childId)) { assert.ok(Date.now() < deadline, "Child did not settle"); await new Promise(resolve => setTimeout(resolve, 10)); }
    };
    await waitDisposed(); assert.equal(readRuns, 1); assert.equal(shellRuns, 0);
    const widened = await policies.bind(parent, { mode: "allow", names: ["shell", "read"] });
    await queueHostSubagentPrompt(ctx.subagents, parent, child.childId, [{ type: "text", text: "Continue the task" }], { kind: "user" }, new AbortController().signal);
    await waitDisposed(); widened();
    assert.equal(created.length, 2); assert.notEqual(created[0], created[1], "Cold resume must create a new native runtime");
    assert.equal(readRuns, 2); assert.equal(shellRuns, 0, "The actual model's tool calls remain host-denied");
    assert.equal(adapter.requests.length, 6);
    const loaded = await ctx.sessionPersistence.load(child.childId);
    assert.ok(loaded.events.some(event => event.type === "tool/result" || event.type === "tool/end"), "Native task persists its real tool trajectory");
  } finally {
    await policies?.close(); await ctx.fiber.dispose(); await facility?.closeAll(); await backend?.close();
    assert.equal(dirname(root), tmpdir()); assert.ok(basename(root).startsWith("hub-voice-continuation-test-")); await rm(root, { recursive: true, force: true });
  }
});
