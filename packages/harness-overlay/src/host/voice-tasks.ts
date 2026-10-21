import type { ToolRunContext,ToolGuard } from "@deepseek-ai/dsh-tools";
import type { VoiceAgent, VoiceModelRoute } from "./voice-session.ts";
import { currentTurnHasUserRequest, TASK_NOTIFICATION_RULE } from "./task-turn.ts";

export const VOICE_TASK_TOOL = "hub_task";
export type VoiceTaskAttachment = (() => Promise<void>) & { allowNested?: (execution: Parameters<ToolGuard>[0]) => boolean };

/** An optionally route-pinned alias of the existing native delegation tool. Never
 * install a new delegation capability: re-enter native dispatch so its preset,
 * allowed-model policy, depth limit, approvals and tool filters remain binding.
 * The alias owns no child agent, scheduler or cancellation lifetime.
 */
export async function attachNativeVoiceTasks(agent: VoiceAgent, route?: VoiceModelRoute, options?: { toolName?: string; targetName?: string; allowNested?: (exec: { callId: unknown; parent?: unknown }) => boolean }): Promise<VoiceTaskAttachment | undefined> {
  const tools = agent.ctx.tools;
  const nativeName = options?.toolName ?? "subagent";
  const native = tools?.get?.(nativeName, agent);
  const properties = native?.parameters.properties as Record<string, unknown> | undefined;
  if (!tools?.execute || !native || !properties?.run_in_background) return;
  if (route && (!properties.provider || !properties.model)) throw new Error("The requested task model requires native subagent model selection; enable that setting before using this route.");
  const executeNative = tools.execute.bind(tools);
  // Omission preserves the native configured child model, not the voice hook.
  const selectedRoute = route ? { provider: route.provider, model: route.model,
    ...(route.reasoningEffort ? { reasoning_effort: route.reasoningEffort } : {}) } : {};
  let active = true;
  const dispatched = new Map<string, unknown>();
  const foreground = new Set([VOICE_TASK_TOOL, "hub_delegate", "hub_goals_manage", "hub_automation_manage", "hub_planner", "hub_work_plan", "hub_present", "hub_save_conversation", "list_agents", "send_message", "interrupt_agent", "list_subagent_models"]);
  const canUseForeground = (name: string) => foreground.has(name) || /^hub_knowledge_(search|read)$/.test(name) || /^mcp__hub_memory__(read_note|write_note|edit_note|build_context|search_notes)$/.test(name);
  // Filter the MODEL's view, rather than restricting inherited execution
  // capabilities that the specialist needs. The native guard below still
  // rejects guessed names, and the child's own assembled scope is untouched.
  const prompt = agent.ctx.systemPrompt as typeof agent.ctx.systemPrompt & { assemble?: unknown };
  const offSchemas = typeof prompt.assemble === "function" ? (agent.ctx.on as Function)("system-prompt/assemble", async (_assembly: unknown, context: { scope?: { id?: string } }, next: () => Promise<{ tools: { name: string }[] }>) => {
    const assembled = await next();
    return context.scope?.id === agent.id ? { ...assembled, tools: assembled.tools.filter(tool => canUseForeground(tool.name)) } : assembled;
  }, { prepend: true }) as (() => void) : undefined;
  if (!tools.guard) throw new Error("Voice coordination requires native execution guards");
  // Scope to the coordinator identity: children keep the user's actual tool
  // policy. The nested subagent call is allowed only during this alias dispatch.
  const offGuard = tools.guard(exec => {
    if (exec.agent !== agent || canUseForeground(exec.name)) return;
    if (options?.allowNested?.(exec)) return;
    if (exec.name === nativeName && dispatched.has(exec.callId) && dispatched.get(exec.callId) === exec.parent) return;
    return currentTurnHasUserRequest(agent) ? "Keep voice responsive: use hub_task for this work, then end your turn. Use list_agents for a non-blocking progress check. This operation was not started." : TASK_NOTIFICATION_RULE;
  });
  let off: () => void;
  try { off = tools.register({
    name: VOICE_TASK_TOOL,
    description: "Start work in the background and immediately return a task identity so you can keep talking. Uses the native configured child model and permissions. For a self-contained interactive on-screen example, ask the child to return a complete hub_present payload (kind vega, title, Vega v6 spec with inline data and signals) in its final answer; publish that payload using hub_present when its completion notice arrives. For a full web app, have the child open its tested app in HUB's native browser so the user's task browser viewer can show it. Do not wait for the task here or claim success when delegation is refused.",
    parameters: { type: "object", properties: { description: { type: "string" }, prompt: { type: "string" } }, required: ["description", "prompt"], additionalProperties: false },
    output: { schema: { ...native.output.schema }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    async execute(args, context) {
      // Native runtime supplies execution identity; require it, including for PTC
      // nested calls. Never manufacture a parent token or accept another agent.
      const exec = context as ToolRunContext;
      exec.signal.throwIfAborted();
      if (!active || exec.agent !== agent || !exec.token || !exec.callId || !exec.deferContext) throw new Error("Tasks require this active voice conversation");
      if (!currentTurnHasUserRequest(agent)) { exec.concludeTurn?.(); throw new Error(TASK_NOTIFICATION_RULE); }
      if (tools.get?.(nativeName, agent) !== native) throw new Error("Native delegation changed; reopen voice before starting a task");
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid task arguments");
      const input = args as Record<string, unknown>;
      if (Object.keys(input).some(key => key !== "description" && key !== "prompt") || typeof input.description !== "string" || !input.description.trim() || typeof input.prompt !== "string" || !input.prompt.trim()) throw new Error("A task needs a description and prompt");
      const nativeCallId = `${exec.callId}:native-task` as typeof exec.callId;
      dispatched.set(nativeCallId, exec.token);
      let result;
      try { result = await executeNative({ name: nativeName, callId: nativeCallId,
        rootCallId: exec.rootCallId, parent: exec.token, agent: exec.agent, signal: exec.signal,
        arguments: { ...input, ...(options?.targetName ? { description: `${options.targetName} · ${input.description}` } : {}), ...selectedRoute, run_in_background: true } }); }
      finally { dispatched.delete(nativeCallId); }
      for (const deferred of result.additionalContexts ?? []) exec.deferContext(deferred);
      if (result.isError) throw new Error(result.error.message);
      // A successful background handoff ends this spoken turn immediately.
      // The native child owns its own lifetime and later completion notice.
      exec.concludeTurn?.();
      return result.value;
    },
  }); } catch (error) { offSchemas?.(); offGuard(); throw error; }
  if (!tools.get?.(VOICE_TASK_TOOL, agent)) { active = false; off(); offGuard(); offSchemas?.(); return; }
  const release:VoiceTaskAttachment=async () => { if (active) { active = false; off(); offGuard(); offSchemas?.(); } };
  release.allowNested=exec=>active&&exec.agent===agent&&((exec.name===nativeName&&dispatched.has(exec.callId)&&dispatched.get(exec.callId)===exec.parent)||!!options?.allowNested?.(exec));
  return release;
}
