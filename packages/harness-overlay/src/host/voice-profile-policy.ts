import type { ToolGuard } from "@deepseek-ai/dsh-tools";
import { voiceProfileSchema, type VoiceProfile } from "../voice-profile-contract.ts";

interface ProfileAgent {
  ctx: {
    tools?: { guard?: (guard: ToolGuard) => () => void };
    systemPrompt: { section(section: { name: string; order: number; text: string }): () => void };
    on?: Function;
  };
}

/** A call owns a detached policy snapshot. Editing a saved profile cannot change
 * an in-flight turn. Explicit character navigation supplies a new snapshot for
 * future requests; native children keep their original delegation policy.
 * The native monotonic guard also covers scope-local tools and nested dispatch;
 * it never overrides another permission guard or grants a new capability. */
export function attachVoiceProfilePolicy(agent: ProfileAgent, value: VoiceProfile,allowNested?: (execution:Parameters<ToolGuard>[0])=>boolean,currentProfile?:()=>VoiceProfile): () => void {
  const profile = voiceProfileSchema.parse(value);
  const current=()=>currentProfile?voiceProfileSchema.parse(currentProfile()):profile;
  let offGuard: (() => void) | undefined;
  if (profile.tools.mode === "allow" || currentProfile) {
    if (!agent.ctx.tools?.guard) throw new Error("Native voice tool permissions are unavailable");
    offGuard = agent.ctx.tools.guard(execution => {
      // Navigation has its own human-turn authorization, like text handoffs.
      // All action tools still follow the selected character's exact policy.
      if(execution.name==="hub_switch_character"||execution.name==="hub_research"||allowNested?.(execution))return;
      const policy=current().tools;
      return policy.mode==="inherit"||policy.names.includes(execution.name)?undefined:"This tool is disabled for the active voice personality.";
    });
  }
  try {
    const text=(profile:VoiceProfile)=>{
    const speech = profile.speech.tts;
    const outputLanguage = speech.engine === "bilingual" || speech.engine === "supertonic" ? speech.language ?? "auto" : speech.engine === "piper" && speech.voice.startsWith("tr_") ? "tr" : "en";
    const languageInstruction = outputLanguage === "en" ? "The user selected English speech output. Reply in English even when the user speaks Turkish, unless they explicitly request a language change." : outputLanguage === "tr" ? "The user selected Turkish speech output. Reply in Turkish even when the user speaks English, unless they explicitly request a language change." : "The user selected automatic bilingual speech output. Follow their current English or Turkish language.";
    return `Voice personality: ${profile.name}.\n${profile.instructions}\n${languageInstruction}\n` +
        "Speak like a natural conversation partner: answer the actual point directly, with no emoji, flags, repeated introductions, canned offers of help or announcements about which language you are using. Do not promise a permanent language choice from unclear speech. If recognition is unclear, ask one short, neutral clarification instead of guessing an instruction or blaming the user. Keep an ordinary conversational answer brief; add detail when the user asks for it.\n" +
        (profile.tools.mode === "allow" ? `The active personality permits only these action tools: ${profile.tools.names.join(", ") || "none"}. Explicit user character navigation uses hub_switch_character. Native permissions still apply. Do not work around disabled tools through another capability or delegation.` : "Use only the tools permitted by the existing native session permissions.");
    };
    const offPrompt = agent.ctx.systemPrompt.section({ name: "hub:voice-personality", order: 999,
      text: text(profile),
    });
    let offAssembly:(()=>void)|undefined;
    try{
      if(currentProfile){
        if(!agent.ctx.on)throw new Error("Live voice character assembly is unavailable");
        offAssembly=agent.ctx.on("system-prompt/assemble",async(_assembly:unknown,_context:unknown,next:()=>Promise<any>)=>{
          const pinned=current(),assembly=await next();
          return {...assembly,sections:assembly.sections.map((section:any)=>section.name==="hub:voice-personality"?{...section,text:text(pinned)}:section)};
        },{prepend:true});
      }
    }catch(error){offPrompt();throw error;}
    let closed = false;
    return () => { if (!closed) { closed = true; try { offAssembly?.();offPrompt(); } finally { offGuard?.(); } } };
  } catch (error) { offGuard?.(); throw error; }
}
