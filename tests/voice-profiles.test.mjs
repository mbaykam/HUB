import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { openVoiceProfiles, VoiceProfileConflict } from "@minke/harness-overlay/host/voice-profiles.ts";
import { voiceProfileInputSchema } from "@minke/harness-overlay/voice-profile-contract.ts";
import { attachVoiceProfilePolicy } from "@minke/harness-overlay/host/voice-profile-policy.ts";
import { createVoiceProfilesHandler } from "@minke/harness-overlay/host/voice-profiles-web.ts";
import { createServer } from "node:http";
import { createVoiceTaskPolicies } from "@minke/harness-overlay/host/voice-task-policy.ts";

// Actual pinned native services, not a replacement implementation of storage or
// tool dispatch. Build/stage the native dependencies before running this suite.
const requireNative = createRequire(new URL("../runtime/host/package.json", import.meta.url));
const native = name => import(pathToFileURL(requireNative.resolve(name)).href);
const { Context } = await native("@deepseek-ai/cordis");
const { default: Storage } = await native("@deepseek-ai/dsh-storage");
const { DomainFacility } = await native("@deepseek-ai/dsh-storage-domain");
const { JsonStorageBackend } = await native("@deepseek-ai/dsh-storage-json");
const { default: Tools } = await native("@deepseek-ai/dsh-tools");
const { default: SystemPrompt } = await native("@deepseek-ai/dsh-system-prompt");
const { createScope } = await native("@deepseek-ai/dsh-scope");
const { default: Agents } = await native("@deepseek-ai/dsh-agent");
const { default: Sessions } = await native("@deepseek-ai/dsh-session");
const initial = { name: "HUB", instructions: "Be concise and helpful.", route: { provider: "openai-codex", model: "gpt-5.6-luna", reasoningEffort: "low" },
  speech: { stt: { engine: "whisper", model: "base.en" }, tts: { engine: "kokoro", model: "82m", voice: "af_heart" } }, tools: { mode: "inherit" } };
async function storage(root) {
  const ctx = new Context(); await ctx.plugin(Storage);
  const backend = new JsonStorageBackend(root); ctx.storage.backend.register("json", backend);
  const facility = new DomainFacility(ctx, { backend: "json" }); ctx.storage.mount("domain", facility);
  return { ctx, facility, async close() { await facility.closeAll(); await backend.close(); } };
}
test("native child policy persists, intersects across generations and survives voice lease end and cold restore", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-voice-profile-test-"));
  let host, policies; const scopes = [];
  async function boot() {
    host = await storage(root); const ctx = host.ctx;
    await ctx.plugin(Agents); await ctx.plugin(Sessions); await ctx.plugin(SystemPrompt, {}); await ctx.plugin(Tools);
    let held;
    policies = createVoiceTaskPolicies(ctx, { async open(spec) {
      const domain = await host.facility.open(spec), table = domain.table("tasks");
      return { close: () => domain.close(), table: () => ({ get: id => table.get(id), get size() { return table.size; }, async put(id, value) {
        await table.put(id, value);
        if (held?.id === id) { held.entered.resolve(); await held.done.promise; }
      } }) };
    } });
    const unregister = new Map();
    const ran = [];
    for (const name of ["read", "shell", "subagent"]) ctx.tools.register({ name, description: name, parameters: { type: "object", properties: {} },
      output: { schema: { type: "string" }, render: (_, value) => [{ type: "text", text: value }] }, async execute() { ran.push(name); return name; } });
    async function agent(id, parent, session) {
      const subject = { id, status: "idle", session: session ?? ctx.sessions.create(id, { meta: { cwd: root, ...(parent ? { origin: "subagent", parentSession: parent.id } : {}) } }), inbox: { nextTurn: [], nextStep: [] }, cancel() {}, whenIdle: async () => {} };
      let scope;
      await ctx.plugin(Object.assign(inner => { scope = createScope(inner, subject); }, { inject: ["tools", "systemPrompt"] }));
      scopes.push(scope); subject.ctx = scope.ctx;
      unregister.set(subject, ctx.agents.register(subject)); return subject;
    }
    const run = (subject, name) => ctx.tools.execute({ name, arguments: {}, agent: subject, signal: new AbortController().signal, callId: "fixture" });
    return { ctx, agent, run, ran, unregister: subject => unregister.get(subject)(), hold(id) {
      held = { id, entered: Promise.withResolvers(), done: Promise.withResolvers() }; return held;
    } };
  }
  try {
    let f = await boot(); const parent = await f.agent("voice-parent");
    const offVoice = await policies.bind(parent, { mode: "allow", names: ["read", "subagent"] });
    const child = await f.agent("child-task", parent); await policies.ready(child);
    offVoice();
    assert.equal((await f.run(child, "read")).isError, false);
    assert.equal((await f.run(child, "shell")).isError, true, "Ending voice cannot lift an independent child's restriction");
    const different = await policies.bind(parent, { mode: "allow", names: ["shell"] });
    assert.equal((await f.run(child, "shell")).isError, true, "Later personalities cannot rewrite the child snapshot");
    const offChildVoice = await policies.bind(child, { mode: "allow", names: ["shell", "read"] });
    const grandchild = await f.agent("grandchild-task", child); await policies.ready(grandchild);
    offChildVoice(); different();
    assert.equal((await f.run(grandchild, "read")).isError, false);
    assert.equal((await f.run(grandchild, "shell")).isError, true);
    assert.equal((await f.run(grandchild, "subagent")).isError, true, "A new profile intersects the inherited task policy");
    const unrelated = await f.agent("unrelated"); await policies.ready(unrelated);
    assert.equal((await f.run(unrelated, "shell")).isError, false);
    const raceLease = await policies.bind(parent, { mode: "allow", names: ["read"] });
    for (const shouldFail of [false, true]) {
      const id = shouldFail ? "failed-write-child" : "pending-write-child", held = f.hold(id);
      const first = await f.agent(id, parent); const firstReady = policies.ready(first); void firstReady.catch(() => {});
      await held.entered.promise; await f.unregister(first);
      const replacement = await f.agent(id, parent, first.session);
      const secondReady = policies.ready(replacement); void secondReady.catch(() => {});
      await new Promise(resolve => setImmediate(resolve));
      assert.equal((await f.run(replacement, "read")).isError, true, "Same-ID resume cannot pass an unfinished write");
      if (shouldFail) {
        held.done.reject(new Error("Synthetic durability failure"));
        await assert.rejects(firstReady, /durability/); await assert.rejects(secondReady, /durability/);
        assert.equal((await f.run(replacement, "read")).isError, true, "Failed durability remains denied");
      } else {
        held.done.resolve(); await firstReady; await secondReady;
        assert.equal((await f.run(replacement, "read")).isError, false);
        assert.equal((await f.run(replacement, "shell")).isError, true);
      }
    }
    raceLease();
    await policies.close(); assert.equal((await f.run(child, "read")).isError, true, "Unloading the policy service fails closed for still-live bound children");
    policies = createVoiceTaskPolicies(f.ctx, host.facility);
    await policies.ready(child);
    assert.equal((await f.run(child, "read")).isError, false, "Reload replaces the old closed guard only after installing a new one");
    assert.equal((await f.run(child, "shell")).isError, true);
    await policies.close();
    for (const scope of scopes.splice(0)) await scope.dispose(); await host.close(); await f.ctx.fiber.dispose();
    f = await boot(); const cold = await f.agent("child-task"); await policies.ready(cold);
    assert.equal((await f.run(cold, "read")).isError, false);
    assert.equal((await f.run(cold, "shell")).isError, true, "Own durable snapshot restores with the parent absent");
  } finally {
    await policies?.close(); for (const scope of scopes.splice(0)) await scope.dispose(); await host?.close(); await host?.ctx.fiber.dispose();
    assert.equal(dirname(root), tmpdir()); assert.ok(basename(root).startsWith("hub-voice-profile-test-")); await rm(root, { recursive: true, force: true });
  }
});
test("profile HTTP uses native durable revisions, protects mutations and never rewrites active admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-voice-profile-test-"));
  let host, profiles, server;
  try {
    host = await storage(root); profiles = await openVoiceProfiles(host.facility, initial);
    const pinned = { id: profiles.selected().id, name: "HUB", revision: 0 };
    let catalogCalls = 0;
    const handler = createVoiceProfilesHandler({ profiles, active: () => pinned,
      reject: req => req.headers.authorization === "Bearer fixture" ? undefined : 401,
      catalog: async provider => { catalogCalls++; return { provider: provider ?? null }; },
    });
    server = createServer(handler); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const request = (path = "profiles", options = {}) => fetch(`${origin}/api/hub/voice/${path}`, {
      ...options, headers: { authorization: "Bearer fixture", ...options.headers },
    });
    const post = (body, headers = {}) => request("profiles", { method: "POST", headers: { "content-type": "application/json", "x-hub-voice-profiles": "1", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
    assert.equal((await request("profiles", { headers: { authorization: "" } })).status, 401);
    assert.equal((await request("catalog", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal(catalogCalls, 0);
    assert.equal((await post({}, { "x-hub-voice-profiles": "" })).status, 403);
    assert.equal((await post({}, { "content-type": "text/plain" })).status, 415);
    assert.equal((await post("broken json")).status, 400);
    assert.equal((await post(" ".repeat(128001))).status, 413);
    let response = await request();
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal((await response.json()).appliesAt, "next-call");
    response = await post({ type: "create", revision: 0, profile: { ...initial, name: "Jess" } });
    assert.equal(response.status, 200);
    let state = await response.json(); const jess = state.profiles[1].id;
    response = await post({ type: "select", revision: state.revision, id: jess });
    state = await response.json();
    assert.equal(state.selectedId, jess); assert.deepEqual(state.active, pinned);
    assert.equal((await post({ type: "select", revision: 0, id: jess })).status, 409);
    assert.equal((await post({ type: "delete", revision: state.revision, id: "b62c85c4-1775-42db-8a02-e21e165da8c2" })).status, 404);
    state = await (await post({ type: "delete", revision: state.revision, id: jess })).json();
    response = await post({ type: "delete", revision: state.revision, id: pinned.id });
    assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: "last-profile" });
    assert.equal((await request("catalog?provider=")).status, 400);
    assert.deepEqual(await (await request("catalog?provider=openai-codex")).json(), { provider: "openai-codex" });
    assert.equal(catalogCalls, 1);
    assert.deepEqual(pinned, { id: profiles.selected().id, name: "HUB", revision: 0 });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await profiles?.close(); await host?.close();
    assert.equal(dirname(root), tmpdir()); assert.ok(basename(root).startsWith("hub-voice-profile-test-"));
    await rm(root, { recursive: true, force: true });
  }
});
test("native durable profiles CRUD, selection, restart, detached snapshots and concurrent revision checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-voice-profile-test-"));
  let host, profiles;
  try {
    host = await storage(root); profiles = await openVoiceProfiles(host.facility, initial);
    let state = profiles.snapshot(); const original = state.selectedId;
    state.profiles[0].name = "Mutated outside storage";
    assert.equal(profiles.selected().name, "HUB");
    state = await profiles.change({ type: "create", revision: 0, profile: { ...initial, name: "Jess", tools: { mode: "allow", names: ["read"] } } });
    const jess = state.profiles[1].id;
    state.profiles[1].name = "Mutated response";
    assert.equal(profiles.snapshot().profiles[1].name, "Jess", "Write responses must not lend native stored objects");
    state = await profiles.change({ type: "select", revision: state.revision, id: jess });
    state = await profiles.change({ type: "edit", revision: state.revision, id: jess, profile: { ...initial, name: "Jess", instructions: "Warm, brief, practical.", speech: { ...initial.speech, stt: { engine: "whisper", model: "tiny.en" } }, tools: { mode: "allow", names: [] } } });
    state = await profiles.change({ type: "duplicate", revision: state.revision, id: jess, name: "Jess copy" });
    assert.notEqual(state.profiles[2].id, jess);
    await profiles.close(); await host.close();
    host = await storage(root); profiles = await openVoiceProfiles(host.facility, { ...initial, name: "Do not overwrite saved preferences" });
    assert.deepEqual(profiles.snapshot(), state);
    assert.equal(profiles.selected().speech.stt.model, "tiny.en");
    const results = await Promise.allSettled([profiles.change({ type: "select", revision: state.revision, id: original }), profiles.change({ type: "select", revision: state.revision, id: jess })]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.ok(results.find(result => result.status === "rejected").reason instanceof VoiceProfileConflict);
    state = profiles.snapshot();
    while (state.profiles.length > 1) state = await profiles.change({ type: "delete", revision: state.revision, id: state.selectedId });
    await assert.rejects(profiles.change({ type: "delete", revision: state.revision, id: state.selectedId }), /at least one/);
    assert.deepEqual(profiles.snapshot(), state);
    await profiles.close(); await host.close();
    host = await storage(root); profiles = await openVoiceProfiles(host.facility, initial);
    assert.deepEqual(profiles.snapshot(), state, "Deleting profiles must survive a cold storage restore");
  } finally {
    await profiles?.close(); await host?.close();
    assert.equal(dirname(root), tmpdir()); assert.ok(basename(root).startsWith("hub-voice-profile-test-"));
    await rm(root, { recursive: true, force: true });
  }
});
test("profile contract rejects executable paths, credentials fields, duplicate tool names and unsupported engines", () => {
  for (const value of [
    { ...initial, python: "evil.exe" }, { ...initial, apiKey: "synthetic" },
    { ...initial, speech: { ...initial.speech, stt: { engine: "command", model: "cmd.exe" } } },
    { ...initial, speech: { ...initial.speech, tts: { ...initial.speech.tts, voice: "../../secret" } } },
    { ...initial, tools: { mode: "allow", names: ["read", "read"] } },
  ]) assert.equal(voiceProfileInputSchema.safeParse(value).success, false);
});
test("native monotonic profile guard blocks global, scoped and nested dispatch without altering other agents", async () => {
  const ctx = new Context(); await ctx.plugin(SystemPrompt, {}); await ctx.plugin(Tools);
  const key = { id: "voice-fixture" }; let scope;
  await ctx.plugin(Object.assign(inner => { scope = createScope(inner, key); }, { inject: ["tools", "systemPrompt"] }));
  key.ctx = scope.ctx;
  const bodies = [];
  const tool = name => ({ name, description: name, parameters: { type: "object", properties: {} }, output: { schema: { type: "string" }, render: (_, value) => [{ type: "text", text: value }] }, async execute() { bodies.push(name); return name; } });
  ctx.tools.register(tool("read")); ctx.tools.register(tool("shell")); scope.ctx.tools.register(tool("hub_present"));
  ctx.tools.register({ ...tool("proxy"), async execute(_args, exec) {
    const result = await ctx.tools.execute({ name: "shell", arguments: {}, agent: exec.agent, signal: exec.signal,
      callId: `${exec.callId}:inner`, rootCallId: exec.rootCallId, parent: exec.token });
    if (result.isError) throw new Error(result.error.message);
    return result.value;
  } });
  const run = (name, agent = key) => ctx.tools.execute({ name, arguments: {}, agent, signal: new AbortController().signal, callId: "fixture" });
  const profile = { ...initial, id: "e1a5064c-a39f-4b01-95bf-d07c9324f786", tools: { mode: "allow", names: ["read", "proxy"] } };
  const off = attachVoiceProfilePolicy(key, profile);
  profile.tools.names.push("shell"); // In-flight policy must be detached from editor values.
  scope.ctx.on("tools/pre-execute", () => Promise.resolve({ kind: "allow" }), { prepend: true });
  assert.equal((await run("read")).isError, false);
  assert.equal((await run("shell")).isError, true);
  assert.equal((await run("hub_present")).isError, true);
  assert.equal((await run("proxy")).isError, true, "An allowed tool cannot dispatch a disabled nested tool");
  assert.equal((await run("shell", { id: "other" })).isError, false);
  assert.deepEqual(bodies, ["read", "shell"]);
  const globalDeny = ctx.tools.guard(exec => exec.name === "read" ? "Existing native restriction" : undefined);
  assert.equal((await run("read")).isError, true, "Profile allow is not a permission grant");
  globalDeny(); off(); off();
  assert.equal((await run("shell")).isError, false);
  await scope.dispose();
});

test('explicit voice handoffs replace the foreground policy while existing children keep their detached policy',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub-voice-profile-test-'));let host,policies;const scopes=[];
 try{
  host=await storage(root);const ctx=host.ctx;await ctx.plugin(Agents);await ctx.plugin(Sessions);await ctx.plugin(SystemPrompt,{});await ctx.plugin(Tools);
  policies=createVoiceTaskPolicies(ctx,host.facility);
  for(const name of ['read','shell'])ctx.tools.register({name,description:name,parameters:{type:'object',properties:{}},output:{schema:{type:'string'},render:()=>[]},execute:async()=>name});
  async function make(id,parent){const agent={id,status:'idle',session:ctx.sessions.create(id,{meta:{cwd:root,...parent?{origin:'subagent',parentSession:parent.id}:{}}}),inbox:{nextTurn:[],nextStep:[]}};let scope;await ctx.plugin(Object.assign(inner=>{scope=createScope(inner,agent);},{inject:['tools','systemPrompt']}));scopes.push(scope);agent.ctx=scope.ctx;ctx.agents.register(agent);return agent;}
  const parent=await make('handoff-parent'),run=(agent,name)=>ctx.tools.execute({agent,name,arguments:{},callId:'fixture-'+name,signal:AbortSignal.timeout(1000)});
  let selected={...initial,id:'e1a5064c-a39f-4b01-95bf-d07c9324f786',name:'First',tools:{mode:'allow',names:['read']}};
  const offProfile=attachVoiceProfilePolicy(parent,selected,undefined,()=>selected),offTasks=await policies.bind(parent,()=>selected.tools);
  const first=await make('first-worker',parent);await policies.ready(first);
  selected={...selected,name:'Second',instructions:'New personality',tools:{mode:'allow',names:['shell']}};
  assert.equal((await run(parent,'read')).isError,true);assert.equal((await run(parent,'shell')).isError,false);
  const assembly=await ctx.systemPrompt.assemble({scope:parent});assert.match(assembly.sections.find(s=>s.name==='hub:voice-personality').text,/Second[\s\S]*New personality/);
  const second=await make('second-worker',parent);await policies.ready(second);
  assert.equal((await run(first,'read')).isError,false);assert.equal((await run(first,'shell')).isError,true);
  assert.equal((await run(second,'shell')).isError,false);assert.equal((await run(second,'read')).isError,true);
  selected.tools.names.push('read');assert.equal((await run(second,'read')).isError,true,'Child policy is captured at delegation, not a live reference');
  offProfile();offTasks();assert.equal((await run(first,'shell')).isError,true);assert.equal((await run(second,'read')).isError,true);
 }finally{await policies?.close();for(const scope of scopes)await scope.dispose();await host?.close();await host?.ctx.fiber.dispose();assert.equal(dirname(root),tmpdir());assert.ok(basename(root).startsWith('hub-voice-profile-test-'));await rm(root,{recursive:true,force:true});}
});
