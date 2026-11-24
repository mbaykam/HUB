import type {HubCharacter, HubCharactersState} from "../character-contract.ts";

export type BillingBasis = "subscription" | "api" | "unknown";
export type HelperTaskKind = "code" | "research" | "brief" | "general";
export interface HelperRouting {
  preset: string;
  provider: string;
  model: string;
  billingBasis: BillingBasis;
  reason: string;
  taskKind: HelperTaskKind;
}
export interface HelperRouteArgs {model?: unknown; character?: unknown; taskKind?: unknown}

/** Provider IDs describe the configured transport, not the model's brand name.
 * Never infer a subscription from a model containing "Claude" or "GPT". */
export function billingBasis(route: {provider?: string} | undefined): BillingBasis {
  if (route?.provider === "openai-codex" || route?.provider === "claude-code") return "subscription";
  if (["openrouter", "openai", "anthropic", "deepseek", "google", "google-ai", "unlid"].includes(route?.provider ?? "")) return "api";
  return "unknown";
}

export function helperDispatchBlockReason(routing: Pick<HelperRouting, "billingBasis">): string | undefined {
  return routing.billingBasis === "subscription" ? undefined : "No helper started. This explicitly selected route has API or unknown billing. Per-task user consent is required, but this native continuable worker cannot enforce a one-shot total spending bound; approval alone is not a budget. Metered helpers are disabled until a bounded runner is available. Choose an existing subscription slot explicitly; no route was silently changed.";
}

export function withinHelperScope(candidate: HubCharacter, current: HubCharacter) {
  return current.tools.mode === "inherit" || candidate.tools.mode === "allow" && candidate.tools.names.every(name => current.tools.mode === "allow" && current.tools.names.includes(name));
}

export function selectHelperRoute(state: HubCharactersState, args: HelperRouteArgs, current: HubCharacter): {character: HubCharacter; routing: HelperRouting} {
  const taskKind: HelperTaskKind = ["code", "research", "brief", "general"].includes(String(args.taskKind)) ? args.taskKind as HelperTaskKind : "general";
  let character: HubCharacter | undefined, reason: string;
  const explicitCharacter = typeof args.character === "string" && args.character.trim() && args.model === undefined;
  const preset = explicitCharacter ? String(args.character) : typeof args.model === "string" ? args.model : "auto";
  if (explicitCharacter) {
    const key = String(args.character).trim().toLowerCase();
    character = state.characters.find(c => c.id === args.character || c.name.toLowerCase() === key);
    reason = "Explicit configured helper selection.";
  } else if (preset === "fast") {
    character = state.characters.find(c => c.id === state.voiceId);
    reason = "Explicit Fast selection; speed does not imply lower cost.";
  } else if (preset === "chat") {
    character = current;
    reason = "Explicit Chat selection; uses this turn's active configured route.";
  } else if (preset === "unrestricted") {
    if (!state.unrestrictedId || current.id !== state.unrestrictedId) throw Error("The unrestricted model is only for a chat the user unlocked. Ask them to tap the lock in this chat first.");
    character = current;
    reason = "Explicit Unrestricted selection in an unlocked chat; permissions unchanged.";
  } else if (preset === "auto") {
    const configured = state.characters.map(c => c.id === current.id ? current : c);
    const candidates = configured.filter(c => c.route && c.id !== state.unrestrictedId && withinHelperScope(c, current) && billingBasis(c.route) === "subscription");
    const preferred = taskKind === "code" ? "openai-codex" : "claude-code";
    character = candidates.find(c => c.route?.provider === preferred) ?? candidates.find(c => c.id === current.id) ?? candidates[0];
    if (!character) throw Error("No subscription helper with compatible tool permissions is configured. Choose a configured route explicitly; API or unknown billing needs approval for this exact task. No helper started.");
    reason = `Subscription-first ${taskKind} task: existing ${character.route!.provider} slot with compatible tool permissions. No paid fallback or automatic escalation.`;
  } else throw Error("Choose auto, chat, fast or unrestricted.");
  if (!character?.route) throw Error("That helper model is not configured. Choose one in Settings → Models.");
  if (character.id === state.unrestrictedId && current.id !== state.unrestrictedId) throw Error("Unlock this chat before explicitly selecting the unrestricted helper.");
  if (!withinHelperScope(character, current)) throw Error("That helper would expand this chat's tool permissions. Choose a compatible configured helper; no helper started.");
  return {character, routing: {preset, provider: character.route.provider, model: character.route.model, billingBasis: billingBasis(character.route), reason, taskKind}};
}
