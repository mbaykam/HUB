import { randomUUID } from "node:crypto";

interface WorkerContext {
  tools: { restrict(filter: { allow: string[] }): unknown; presentAs(mode: "native"): unknown };
}
interface WorkerHandle {
  agent: {
    followup(message: unknown): void;
    whenIdle(): Promise<void>;
    cancel(cause: { kind: "user" }): void;
    session: { snapshotEvents(): readonly { type: string; data: unknown }[] };
  };
  dispose(): Promise<void>;
}
export interface MemoryWorkerPorts {
  create(options: {
    sessionId: string;
    meta: { origin: "subagent"; cwd: string };
    agentOptions: { provider: string; model: string; maxTokens: number; reasoningEffort?: string };
    signal: AbortSignal;
    setup(ctx: WorkerContext): void;
  }): Promise<WorkerHandle>;
  message(text: string): unknown;
}

/** Reuses the native DSH agent factory and configured provider. The reflection
 * model has no tools, so evidence cannot authorize shell, network or vault edits.
 * The separately checked Basic Memory operation applies its returned Markdown.
 */
export function createMemoryGenerator(ports: MemoryWorkerPorts, route: { provider: string; model: string; reasoningEffort?: string; maxTokens?: number }) {
  if (!route.provider.trim() || !route.model.trim()) throw new Error("Select an explicit reflection model route");
  return async (prompt: string, parent: AbortSignal): Promise<string> => {
    const signal = AbortSignal.any([parent, AbortSignal.timeout(90_000)]);
    const handle = await ports.create({
      // The ordinary deployment prompt includes {{cwd}} even for no-tool
      // workers. Supply it explicitly just as the session controller does.
      sessionId: `hub-memory-reflection-${randomUUID()}`, meta: { origin: "subagent", cwd: process.cwd() },
      agentOptions: { ...route, maxTokens: route.maxTokens ?? 4096 }, signal,
      setup(ctx) { ctx.tools.presentAs("native"); ctx.tools.restrict({ allow: [] }); },
    });
    const abort = () => handle.agent.cancel({ kind: "user" });
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      handle.agent.followup(ports.message(prompt));
      await handle.agent.whenIdle();
      signal.throwIfAborted();
      const events = [...handle.agent.session.snapshotEvents()].reverse();
      const end = events.find(event => event.type === "turn/end")?.data as { reason?: { kind?: string;error?:{code?:string;message?:string} } } | undefined;
      if (end?.reason?.kind !== "completed") {
        const error=new Error(end?.reason?.error?.message??"Reflection did not complete");
        Object.assign(error,{code:end?.reason?.error?.code??"REFLECTION_INCOMPLETE"});throw error;
      }
      const answer = events.find(event => event.type === "assistant/message")?.data as {
        message?: { content?: { type: string; text?: string }[] };
      } | undefined;
      const text = answer?.message?.content?.filter(block => block.type === "text").map(block => block.text ?? "").join("\n").trim();
      if (!text) throw new Error("Reflection returned no Markdown");
      return text;
    } finally {
      signal.removeEventListener("abort", abort);
      await handle.dispose();
    }
  };
}
