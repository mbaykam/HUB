import type {IncomingMessage,ServerResponse} from "node:http";
import {effectiveKnowledgeCharacter} from "./knowledge-identity.ts";

/** Private, process-local snapshots at the real LLM dispatch seam. Inspection
 * never assembles a hypothetical prompt, creates an agent or calls a model. */
export function installCharacterRequests(ctx:any,characters:any){
  const latest=new Map<string,{characterId:string;sessionId:string;at:number;json?:string;unavailable?:string;bytes:number}>();
  let bytes=0;
  const off=ctx.on("llm/stream",(options:any,next:()=>unknown)=>{
    try{
      const agent=options.sessionId&&ctx.agents.get(options.sessionId),character=agent&&effectiveKnowledgeCharacter(ctx,agent);
      // Title generation and compaction are auxiliary requests, not the
      // character's conversational input shown in this inspector.
      if(character&&!options.purpose){
        const {signal:_signal,...input}=options;
        const json=JSON.stringify(input,null,2),size=Buffer.byteLength(json,"utf8"),prior=latest.get(character.id);
        if(prior){bytes-=prior.bytes;latest.delete(character.id);}
        const record={characterId:character.id,sessionId:options.sessionId,at:Date.now(),bytes:size<=32*1024*1024?size:0,...(size<=32*1024*1024?{json}:{unavailable:"This request exceeds the 32 MB inspection limit. Nothing has been truncated or substituted."})};
        latest.set(character.id,record);bytes+=record.bytes;
        while(bytes>64*1024*1024||latest.size>32){const key=latest.keys().next().value!;bytes-=latest.get(key)!.bytes;latest.delete(key);}
      }
    }catch{/* Inspection cannot break inference or retain partial snapshots. */}
    return next();
  },{global:true});
  const route=ctx.webServer.register({kind:"exact",path:"/api/hub/character-request",async handler(req:IncomingMessage,res:ServerResponse){
    const send=(code:number,data:unknown)=>{res.writeHead(code,{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"});res.end(JSON.stringify(data));};
    const rejection=ctx.connection.requestRejection(req);
    if(rejection||req.headers["sec-fetch-site"]==="cross-site"||req.headers["x-hub-characters"]!=="1"){send(rejection??403,{error:"unauthorized"});return;}
    if(req.method!=="GET"){send(405,{error:"method-not-allowed"});return;}
    await characters.ready;
    const id=new URL(req.url??"/","http://hub.invalid").searchParams.get("characterId");
    if(!id||!characters.store.snapshot().characters.some((c:any)=>c.id===id)){send(404,{error:"character-not-found"});return;}
    send(200,{record:latest.get(id)??null,boundary:"Complete HUB request at LLM dispatch, before provider-adapter translation. Includes system text, messages, tool schemas and model options. HTTP credentials are not part of this request. Provider-added hidden instructions and exact server token IDs are not exposed by providers.",retention:"Latest conversational request per character since this host started; kept in memory only. Auxiliary title and compaction calls are excluded. Inspection makes no model call."});
  }});
  return ()=>{off();route();latest.clear();bytes=0;};
}
