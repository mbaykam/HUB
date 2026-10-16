/** Transports may ignore AbortSignal. Late completions cannot inject context. */
export function visibleKnowledgeReflections<T extends {scope:"user"|"character";characterId?:string}>(records:T[],characterId?:string){return records.filter(r=>r.scope==="user"||r.scope==="character"&&!!characterId&&r.characterId===characterId);}
/** Both folds matter: English AI/ai and Turkish I/ı must remain searchable. */
export function knowledgeTextForms(value:string){return [...new Set([value.normalize("NFKC").toLowerCase(),value.normalize("NFKC").toLocaleLowerCase("tr")])];}
export async function boundedKnowledgeRecall<T>(operation:Promise<T>,signal:AbortSignal):Promise<T>{
  if(signal.aborted){void operation.catch(()=>{});signal.throwIfAborted();}let abort!:()=>void;
  const cancelled=new Promise<never>((_resolve,reject)=>{abort=()=>reject(new Error("Knowledge recall deadline"));signal.addEventListener("abort",abort,{once:true});});
  try{return await Promise.race([operation,cancelled]);}finally{signal.removeEventListener("abort",abort);}
}
