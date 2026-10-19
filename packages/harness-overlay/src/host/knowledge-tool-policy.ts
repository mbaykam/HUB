import {isLegacyMemoryTool} from "../memory-tool-groups.ts";
export function installKnowledgeToolPolicy(ctx:any){
  const prompt=ctx.on("system-prompt/assemble",async(_assembly:any,_context:any,next:()=>Promise<any>)=>{const assembled=await next();return {...assembled,tools:(assembled.tools??[]).filter((t:any)=>!isLegacyMemoryTool(t.name))};},{global:true,prepend:true});
  const guard=ctx.tools?.guard?.((exec:any)=>isLegacyMemoryTool(exec.name)?"Legacy memory is retired in this Knowledge profile. Use the current Knowledge and Skills tools.":undefined);
  return ()=>{prompt();guard?.();};
}
