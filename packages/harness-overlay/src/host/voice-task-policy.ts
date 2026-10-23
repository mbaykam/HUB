import { z } from "zod";
import type { VoiceAgent } from "./voice-session.ts";
import { voiceToolPolicySchema, type VoiceToolPolicy } from "../voice-profile-contract.ts";

const recordSchema = z.object({ tools: voiceToolPolicySchema }).strict();
// Stable across module reloads; the replacement guard is installed before the
// previous service's fail-closed guard is removed from a still-live agent.
const attachmentKey = Symbol.for("hub.voice-task-policy.attachment");
type GuardedAgent = VoiceAgent & { [attachmentKey]?: () => void };
export const voiceTaskPolicyDomain = { name: "hub_voice_task_policies", version: 1, tables: { tasks: { valueSchema: recordSchema } } };
interface Table {
  get(id: string): z.infer<typeof recordSchema> | undefined;
  put(id: string, value: z.infer<typeof recordSchema>): Promise<void>;
  readonly size: number;
}
export interface TaskPolicyStorage {
  open(spec: typeof voiceTaskPolicyDomain): Promise<{ table(name: "tasks"): Table; close(): Promise<void> }>;
}
export interface TaskPolicyContext {
  agents: { list(): VoiceAgent[]; get(id: string): VoiceAgent | undefined; isOwnedBy(id: string, owner: VoiceAgent): boolean };
  on(event: "agent/created" | "agent/disposed", listener: (payload: { agent: VoiceAgent }) => void, options: { global: true; prepend?: boolean }): () => void;
}
/** Intersection is monotonic: a new voice profile cannot grant a task tools
 * denied by its original delegation snapshot. Inherit is not an allow grant. */
export function intersectVoiceTools(a: VoiceToolPolicy | undefined, b: VoiceToolPolicy | undefined): VoiceToolPolicy | undefined {
  if (!a) return b ? voiceToolPolicySchema.parse(b) : undefined;
  if (!b || b.mode === "inherit") return voiceToolPolicySchema.parse(a);
  if (a.mode === "inherit") return voiceToolPolicySchema.parse(b);
  return { mode: "allow", names: a.names.filter(name => b.names.includes(name)) };
}

/** Native agent creation installs a provisional monotonic guard synchronously.
 * The native request hook waits for a native domain write before the first
 * request; direct tool dispatch fails closed while that write is pending.
 * Child-owned guards outlive the voice lease. This owns no agents or scheduler.
 */
export function createVoiceTaskPolicies(ctx: TaskPolicyContext, storage: TaskPolicyStorage) {
  let stopped = false;
  const active = new Map<VoiceAgent, () => VoiceToolPolicy>();
  const states = new Map<VoiceAgent, { ready: Promise<VoiceToolPolicy | undefined> }>();
  const writes = new Set<Promise<unknown>>();
  const pendingById = new Map<string, Promise<VoiceToolPolicy | undefined>>();
  const domain = storage.open(voiceTaskPolicyDomain);
  void domain.catch(() => {});
  const table = domain.then(value => value.table("tasks")); void table.catch(() => {});
  function capture(agent: VoiceAgent | undefined) {
    if (!agent) return Promise.resolve(undefined);
    const read = active.get(agent);
    const lease = read ? voiceToolPolicySchema.parse(read()) : undefined; // Detached at the synchronous delegation boundary.
    const inherited = states.get(agent)?.ready;
    return Promise.resolve(inherited).then(policy => intersectVoiceTools(policy, lease));
  }
  function attach(agent: GuardedAgent) {
    if (states.has(agent) || stopped) return;
    if (!agent.ctx.tools?.guard) throw new Error("Native task permission guards are unavailable");
    const parent = ctx.agents.list().find(candidate => candidate !== agent && ctx.agents.isOwnedBy(agent.id, candidate))
      ?? (agent.session.header.origin === "subagent" && agent.session.header.parentSession ? ctx.agents.get(agent.session.header.parentSession) : undefined);
    const inherited = capture(parent);
    // Old unrelated tasks must not acquire the parent's NEW voice settings.
    // Exclude a fork's inherited prefix; new native child descriptor seeds do
    // not yet contain a child-owned human/task message at agent/created.
    const alreadyRan = agent.session.snapshotEvents().slice(agent.session.inheritedEventCount).some(event => event.type === "user/message");
    let settled = false, failed = false, policy: VoiceToolPolicy | undefined;
    const offGuard = agent.ctx.tools.guard(exec => {
      if (!settled) return "Task permissions are loading. Retry after initialization.";
      if (failed || (stopped && policy)) return "Task permissions are unavailable. Restart HUB before continuing this task.";
      return policy?.mode === "allow" && !policy.names.includes(exec.name) ? "This tool is disabled by the task’s voice personality." : undefined;
    });
    let offRequest: (() => void) | undefined;
    const priorWrite = pendingById.get(agent.id);
    const ready = (async () => {
      // A disposed runtime can be recreated with the same session ID while its
      // first write is still pending. Do not trust the table's in-memory value
      // until that original durability barrier has completed successfully.
      await priorWrite;
      const records = await table;
      const existing = records.get(agent.id);
      if (existing) policy = recordSchema.parse(existing).tools;
      else if (!alreadyRan) {
        policy = await inherited;
        if (policy) {
          if (stopped || records.size >= 20000) throw new Error("Task permission storage is unavailable");
          await records.put(agent.id, { tools: policy });
        }
      }
      settled = true;
      if (!policy) { offGuard(); offRequest?.(); }
      return policy;
    })().catch(error => { settled = true; failed = true; throw error; });
    offRequest = agent.ctx.on("agent/request", async ({ agent: subject }, next) => {
      if (subject.id !== agent.id) return next();
      const bound = await ready;
      if (stopped && bound) throw new Error("Task permissions are unavailable");
      return next();
    }, { prepend: true });
    agent[attachmentKey]?.();
    const release = () => { offGuard(); offRequest?.(); if (agent[attachmentKey] === release) delete agent[attachmentKey]; };
    agent[attachmentKey] = release;
    states.set(agent, { ready }); writes.add(ready);
    pendingById.set(agent.id, ready);
    // Retain rejected barriers until restart: a failed write must never become
    // an apparently durable record on a quick same-ID retry.
    void ready.then(() => { if (pendingById.get(agent.id) === ready) pendingById.delete(agent.id); }, () => {});
    void ready.finally(() => writes.delete(ready)).catch(() => {});
  }
  // Prepend denies reentrant dispatch from later creation listeners until the
  // complete permission snapshot is durable. Scope owns each registered guard.
  const offCreated = ctx.on("agent/created", ({ agent }) => attach(agent), { global: true, prepend: true });
  const offDisposed = ctx.on("agent/disposed", ({ agent }) => { states.delete(agent); active.delete(agent); }, { global: true });
  for (const agent of ctx.agents.list()) attach(agent);
  return {
    async bind(agent: VoiceAgent, value: VoiceToolPolicy | (()=>VoiceToolPolicy)) {
      if (stopped || active.has(agent)) throw new Error("Task permissions are not ready for another voice lease");
      attach(agent); await states.get(agent)!.ready;
      if (stopped || active.has(agent)) throw new Error("Task permissions are not ready for another voice lease");
      const snapshot=voiceToolPolicySchema.parse(typeof value==="function"?value():value);
      const policy=typeof value==="function"?value:()=>snapshot;active.set(agent,policy);
      let closed = false;
      return () => { if (!closed) { closed = true; if (active.get(agent) === policy) active.delete(agent); } };
    },
    async ready(agent: VoiceAgent) { attach(agent); return states.get(agent)?.ready; },
    async close() {
      if (stopped) return; stopped = true; offCreated(); offDisposed(); active.clear();
      // Do not remove child-scoped guards while native tasks may still exist.
      // An unloaded permissions service denies further work, never grants it.
      await Promise.allSettled([...writes]); await (await domain).close(); states.clear();
    },
  };
}
