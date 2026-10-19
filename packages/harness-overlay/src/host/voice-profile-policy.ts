import type { ToolGuard } from "@deepseek-ai/dsh-tools";
import { voiceProfileSchema, type VoiceProfile } from "../voice-profile-contract.ts";

interface ProfileAgent {
  ctx: {
    tools?: { guard?: (guard: ToolGuard) => () => void };
    systemPrompt: { section(section: { name: string; order: number; text: string }): () => void };
  };
}

/** A call owns a detached policy snapshot. Editing/selecting a saved profile
 * cannot change permissions underneath an in-flight tool or audio turn.
 * The native monotonic guard also covers scope-local tools and nested dispatch;
 * it never overrides another permission guard or grants a new capability. */
export function attachVoiceProfilePolicy(agent: ProfileAgent, value: VoiceProfile,allowNested?: (execution:Parameters<ToolGuard>[0])=>boolean): () => void {
  const profile = voiceProfileSchema.parse(value);
  let offGuard: (() => void) | undefined;
  if (profile.tools.mode === "allow") {
    if (!agent.ctx.tools?.guard) throw new Error("Native voice tool permissions are unavailable");
    const allowed = new Set(profile.tools.names);
    offGuard = agent.ctx.tools.guard(execution => allowed.has(execution.name)||allowNested?.(execution) ? undefined : "This tool is disabled for the active voice personality.");
  }
  try {
    const speech = profile.speech.tts;
    const outputLanguage = speech.engine === "bilingual" || speech.engine === "supertonic" ? speech.language ?? "auto" : speech.engine === "piper" && speech.voice.startsWith("tr_") ? "tr" : "en";
    const languageInstruction = outputLanguage === "en" ? "The user selected English speech output. Reply in English even when the user speaks Turkish, unless they explicitly request a language change." : outputLanguage === "tr" ? "The user selected Turkish speech output. Reply in Turkish even when the user speaks English, unless they explicitly request a language change." : "The user selected automatic bilingual speech output. Follow their current English or Turkish language.";
    const offPrompt = agent.ctx.systemPrompt.section({ name: "hub:voice-personality", order: 999,
      text: `Voice personality: ${profile.name}.\n${profile.instructions}\n${languageInstruction}\n` +
        "Speak like a natural conversation partner: answer the actual point directly, with no emoji, flags, repeated introductions, canned offers of help or announcements about which language you are using. Do not promise a permanent language choice from unclear speech. If recognition is unclear, ask one short, neutral clarification instead of guessing an instruction or blaming the user. Keep an ordinary conversational answer brief; add detail when the user asks for it.\n" +
        (profile.tools.mode === "allow" ? `The active personality permits only these tools: ${profile.tools.names.join(", ") || "none"}. Native permissions still apply. Do not work around disabled tools through another capability or delegation.` : "Use only the tools permitted by the existing native session permissions."),
    });
    let closed = false;
    return () => { if (!closed) { closed = true; try { offPrompt(); } finally { offGuard?.(); } } };
  } catch (error) { offGuard?.(); throw error; }
}
