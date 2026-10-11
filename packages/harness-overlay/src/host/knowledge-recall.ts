/** Transports may ignore AbortSignal. Late completions cannot inject context. */
export async function boundedKnowledgeRecall<T>(operation:Promise<T>,signal:AbortSignal):Promise<T>{
  if(signal.aborted){void operation.catch(()=>{});signal.throwIfAborted();}let abort!:()=>void;
  const cancelled=new Promise<never>((_resolve,reject)=>{abort=()=>reject(new Error("Knowledge recall deadline"));signal.addEventListener("abort",abort,{once:true});});
  try{return await Promise.race([operation,cancelled]);}finally{signal.removeEventListener("abort",abort);}
}
