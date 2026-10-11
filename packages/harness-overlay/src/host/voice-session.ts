import { ReasoningEffortId, type LlmCallConfig } from "@deepseek-ai/dsh-llm";
import { createVoiceConversation, type VoiceConversationPorts } from "./voice-conversation.ts";
import type { HistorySession } from "./conversation-history.ts";
import type { PresentationAgent, PresentationRuntime } from "./presentation.ts";
import { attachVoiceHistoryTool, type VoiceHistoryPort } from "./voice-history-tool.ts";
import type { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { voiceProfileSchema, type VoiceProfile } from "../voice-profile-contract.ts";
import { attachVoiceProfilePolicy } from "./voice-profile-policy.ts";
import type { createVoiceTaskPolicies } from "./voice-task-policy.ts";

export interface VoiceModelRoute { provider: string; model: string; reasoningEffort?: string }
export interface VoiceModelCatalog {
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{
    provider: string; id: string; reasoning?: { efforts: readonly { id: string; name?: string }[] };
  }>;
}

/** Check the actual installed adapter before creating a transcript or starting
 * speech. A missing model/effort must never fall back to another billing route.
 * Resolve per admission so plugin updates do not leave a stale startup verdict.
 */
export async function validateVoiceModel(catalog: VoiceModelCatalog, route: VoiceModelRoute, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const model = await catalog.resolveModelInfo(route.provider, route.model, signal);
  signal.throwIfAborted();
  if (model.provider !== route.provider || model.id !== route.model) throw new Error("The configured voice model is unavailable");
  if (route.reasoningEffort !== undefined && !model.reasoning?.efforts.some(item => item.id === route.reasoningEffort)) {
    throw new Error("The configured voice reasoning setting is unavailable");
  }
}

export interface VoiceAgent {
  id: string;
  status: string;
  session: HistorySession;
  cancel(cause: { kind: "user" }, options: { keepInbox: true }): void;
  whenIdle(): Promise<void>;
  inbox: {
    nextTurn: readonly { id: string; source: { kind: string; rpcId?: string } }[];
    nextStep: readonly { id: string; source: { kind: string; rpcId?: string } }[];
    remove(id: string): boolean;
  };
  ctx: {
    tools?: PresentationAgent["ctx"]["tools"] & Partial<Pick<ToolRuntime, "get" | "execute" | "guard">>;
    systemPrompt: { section(section: { name: string; order: number; text: string }): () => void };
    on(event: "agent/request", listener: (payload: { agent: { id: string } }, next: () => Promise<LlmCallConfig>) => Promise<LlmCallConfig>, options?: { prepend?: boolean }): () => void;
  };
}
export interface NativeVoiceContext {
  sessionController: {
    create(request: { sessionId?: string }): Promise<{ sessionId: string }>;
    resolveAgent(sessionId: string): Promise<{ agent: VoiceAgent } | { error: unknown }>;
    rename(request: { sessionId: string; title: string }): Promise<unknown>;
    prompt(request: Parameters<VoiceConversationPorts["prompt"]>[0], signal: AbortSignal): ReturnType<VoiceConversationPorts["prompt"]>;
  };
  agents: { get(id: string): VoiceAgent | undefined };
  on(event: "session/event", listener: (session: { header: { id: string } }, event: { type: string; data: unknown }) => void, options?: { global?: boolean }): () => void;
}

/** Native Session Controller owns creation, preset permissions, persistence and
 * history visibility. The voice connection never disposes this agent, so native
 * continuable tasks and the saved chat remain available after the call closes.
 */
export async function openNativeVoiceSession(ctx: NativeVoiceContext, route: VoiceModelRoute, options: {
  sessionId?: string;
  profile?: VoiceProfile;
  taskPolicies?: ReturnType<typeof createVoiceTaskPolicies>;
  created?: (agent: VoiceAgent) => Promise<void>;
  presentations?: PresentationRuntime;
  history?: VoiceHistoryPort;
  tasks?: (agent: VoiceAgent) => Promise<(() => Promise<void>) | undefined>;
} = {}) {
  if (!route.provider?.trim() || !route.model?.trim()) throw new Error("An explicit voice model route is required");
  if (route.reasoningEffort !== undefined && (!route.reasoningEffort.trim() || route.reasoningEffort.length > 80)) throw new Error("Invalid voice reasoning effort");
  const profile = options.profile ? voiceProfileSchema.parse(options.profile) : undefined;
  let sessionId: string;
  let agent: VoiceAgent | undefined;
  if (options.sessionId !== undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(options.sessionId)) throw new Error("Invalid native conversation identity");
    // resolveAgent resumes ONLY an existing native identity, checks subagent
    // ownership and returns not-found. create({sessionId}) could accidentally
    // manufacture a new chat from a stale or fabricated browser selection.
    const resolved = await ctx.sessionController.resolveAgent(options.sessionId);
    if ("error" in resolved) throw new Error("Could not resume the selected conversation");
    agent = resolved.agent; sessionId = options.sessionId;
  } else {
    ({ sessionId } = await ctx.sessionController.create({}));
    agent = ctx.agents.get(sessionId);
  }
  if (!agent) throw new Error("Native voice session is unavailable");
  if (agent.id !== sessionId) throw new Error("Native conversation identity mismatch");
  if (agent.status !== "idle" || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) throw new Error("Conversation is busy; wait for its current work before enabling voice");
  if (options.sessionId === undefined) await options.created?.(agent);
  const offPrompt = agent.ctx.systemPrompt.section({
    name: "hub:voice-conversation", order: 1000,
    text: "You are speaking with the bilingual user in HUB's voice mode. Understand English and Turkish, including language switches. Reply in the language the user currently speaks unless they explicitly request another language. Voice and typed input share this conversation and its existing context. Usually reply in one or two short, natural sentences. Avoid reading Markdown, code, long URLs or long lists aloud. Ask one question at a time. For substantial work, use the configured native continuable background delegation tool and return promptly so conversation can continue. Never claim a handoff or completion until the native tool confirms it. Keep the user's existing permissions and safety checks. Speech interruption alone is not a request to cancel delegated tasks. Explain concrete actions and results when useful; do not reveal private internal reasoning. Voice-origin transcripts are retained in Voice History rather than normal Recents unless explicitly saved; delegated tasks have their own saved chats. Existing text-origin chats remain normal chats. All retain HUB's existing memory policy. A background task completion or failure is a result to report, not a new request. Explain the verified findings or the failure in one or two spoken sentences in the user's language; never retry or delegate again without a new user request. If an output limit caused a rejected request, explain that setting rather than claiming the balance is empty. For prices, name currency and time; keep source URLs in the saved chat.",
  });
  const offRoute = agent.ctx.on("agent/request", async ({ agent: subject }, next) => {
    const config = await next();
    if (subject.id !== sessionId) return config;
    // Route only this voice session; Session Controller's selectModel would
    // also change the user's saved default for unrelated desktop conversations.
    const { reasoningEffort: _reasoning, ...base } = config;
    // Spoken brevity belongs in the persona, not a token cap that also cuts
    // off structured tool arguments (a modest interactive Vega spec can exceed
    // 1024 tokens before its short spoken explanation has even started).
    return { ...base, provider: route.provider, model: route.model, maxTokens: 4096,
      ...route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) } };
  }, { prepend: true });
  let offPresentation: (() => void) | undefined;
  let offHistory: (() => void) | undefined;
  let offTasks: (() => Promise<void>) | undefined;
  let offTaskPrompt: (() => void) | undefined;
  let offProfile: (() => void) | undefined;
  let offTaskPolicy: (() => void) | undefined;
  try {
    if (options.tasks) {
      offTasks = await options.tasks(agent);
      if (offTasks) offTaskPrompt = agent.ctx.systemPrompt.section({ name: "hub:voice-tasks", order: 1001,
        text: "You are the conversation coordinator, not the worker. For any build, filesystem search, browser work or other multi-step task, first acknowledge the request in one spoken sentence, then call hub_task for the configured default specialist and end your turn promptly. If the user explicitly asks for another configured character by name, use hub_delegate with that character instead. It starts a native continuable background task using the configured child model. Never wait for completion; stay available for the user's next question. Do not execute the work yourself or use foreground delegation. On a progress question, use list_agents without waiting, report only observed progress, and say if the remaining time is unknown. Do not invent an ETA. A speech interruption must not cancel the child. To show a self-contained interactive example such as a calculator, ask the child to return one complete hub_present payload with kind vega, title and a Vega v6 spec using inline data and signals for buttons/inputs. No arbitrary JavaScript, external resources or filesystem search is needed for this. On its completion notification, call hub_present with the returned payload so the PWA can open it. For a full website/app beyond the canvas, have the child build/test it and open it in HUB's native browser for the user's task browser viewer, not an external desktop window. A spoken claim alone does not show anything on the phone. Confirm only tool results. Supply the child the necessary context without unnecessary private details." });
    }
    if (options.history) {
      if (!agent.ctx.tools) throw new Error("Native history tool registry is unavailable");
      offHistory = attachVoiceHistoryTool({ id: agent.id, ctx: { tools: agent.ctx.tools, systemPrompt: agent.ctx.systemPrompt } }, options.history);
    }
    if (options.presentations) {
      if (!agent.ctx.tools) throw new Error("Native visual tool registry is unavailable");
      offPresentation = options.presentations.attach({ id: agent.id, ctx: { tools: agent.ctx.tools, systemPrompt: agent.ctx.systemPrompt } });
    }
    if (profile) { offProfile = attachVoiceProfilePolicy(agent, profile); offTaskPolicy = await options.taskPolicies?.bind(agent, profile.tools); }
  } catch (error) { offTaskPolicy?.(); offProfile?.(); offPresentation?.(); offHistory?.(); offTaskPrompt?.(); offRoute(); offPrompt(); await offTasks?.(); throw error; }
  const voice = createVoiceConversation({
    sessionId,
    running: () => agent.status !== "idle",
    // Direct Host calls do not receive the signal injected by the Remote RPC
    // transport. Let admission settle before the existing exact-RPC interrupt
    // logic cancels queued/running work; do not abandon an uncertain admission.
    prompt: request => ctx.sessionController.prompt(request, new AbortController().signal),
    // The web plugin's composition can be a sibling of the native session's
    // scope. Observe globally, but deliver ONLY this already-authorized lease's
    // exact session; never depend on incidental composition ancestry.
    subscribe: listener => ctx.on("session/event", (session, event) => { if (session.header.id === sessionId) listener(event); }, { global: true }),
    cancel: requestId => {
      const queued = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].find(message => message.source.kind === "user" && message.source.rpcId === requestId);
      // Retract only this unclaimed utterance. Preserve unrelated queued input
      // and child notifications instead of wiping the native inbox on barge-in.
      if (queued) agent.inbox.remove(queued.id);
      else {
        // Admission can race a notification or complete before interruption.
        // Cancel only an open native turn that actually claimed this RPC.
        const events = agent.session.snapshotEvents();
        let claimed = false;
        for (let index = events.length - 1; index >= 0; index--) {
          const event = events[index] as { type: string; data?: { source?: { kind?: string; rpcId?: string } } };
          if (event.type === "turn/end") break;
          if (event.type === "user/message" && event.data?.source?.kind === "user" && event.data.source.rpcId === requestId) claimed = true;
          if (event.type === "turn/start") {
            if (claimed) agent.cancel({ kind: "user" }, { keepInbox: true });
            break;
          }
        }
      }
    },
    whenIdle: () => agent.whenIdle(),
  });
  try {
    if (options.sessionId === undefined) await ctx.sessionController.rename({ sessionId, title: "Voice conversation" });
  } catch {
    offHistory?.(); await voice.close(); offTaskPolicy?.(); offProfile?.(); offPresentation?.(); offRoute(); offPrompt();
    offTaskPrompt?.(); await offTasks?.();
    throw new Error("Could not prepare the voice conversation");
  }
  let closing: Promise<void> | undefined;
  return {
    ...voice,
    close() {
      if (closing) return closing;
      // Revoke new saves before waiting for a possibly unwinding native turn.
      offHistory?.();
      closing = (async () => {
        // Attempt both shutdowns even if one fails. Retain permission guards
        // on uncertain cleanup, and return the same verdict to every closer.
        const results = await Promise.allSettled([
          Promise.resolve().then(() => offTasks?.()), voice.close(),
        ]);
        const failed = results.find(result => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        offTaskPolicy?.(); offProfile?.(); offPresentation?.(); offRoute(); offPrompt(); offTaskPrompt?.();
      })();
      return closing;
    },
  };
}
