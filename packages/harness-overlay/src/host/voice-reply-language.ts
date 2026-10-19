import {createUserMessage} from "@deepseek-ai/dsh-llm";
export type ReplyLanguage="en"|"tr";
/** The sidecar's final, correlated STT language is context for this utterance,
 * not a permanent user preference and not another user transcript line. */
export function voiceReplyLanguage(agent:any){
  const hints=new Map<string,ReplyLanguage>();let off:(()=>void)|undefined;
  return {
    admit(id:string,language:ReplyLanguage){
      if(hints.size>=64)hints.delete(hints.keys().next().value!);
      hints.set(id,language);
      off??=agent.ctx.on("agent/pre-step",async(_payload:any,next:any)=>{
        const decision=await next();if(decision.kind!=="enter")return decision;
        const human=decision.messages.filter((m:any)=>m.source?.kind==="user").at(-1);
        if(!human||!hints.has(human.source.rpcId))return decision;
        const language=hints.get(human.source.rpcId)!;hints.delete(human.source.rpcId);
        const message=createUserMessage({source:{kind:"plugin",plugin:"hub-voice-language"},content:[{type:"text",text:`For this spoken turn, speech recognition identified ${language==="en"?"English":"Turkish"}. Answer the user's actual message in ${language==="en"?"English":"Turkish"}, unless they explicitly request a different output language. This turn overrides older language guesses or historical preferences. Do not announce a language switch, introduce yourself again, or use emoji. If the words are unclear, ask one brief clarification; never turn an uncertain transcription into a permanent preference.`}]});
        return {...decision,messages:[...decision.messages,message]};
      },{prepend:true});
    },
    forget(id:string){hints.delete(id);},
    close(){off?.();off=undefined;hints.clear();},
  };
}
