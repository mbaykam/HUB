import {conversationArtifacts,artifactDocument} from "./conversation-artifacts.ts";
import {isKnowledgeEvaluation} from "./knowledge-evidence.ts";
/** Read-only native state, available before any chat has been opened in the
 * new PWA process. No task is resumed, repeated or cancelled by these reads. */
export function installDailyUseWeb(ctx:any){
  const ended=new Map<string,{version:number;kind:string}>();
  const off=["activity","artifacts"].map(action=>ctx.webServer.register({kind:"exact",path:"/api/hub/"+action,handler:async(req:any,res:any)=>{
    const send=(code:number,value:any)=>{res.writeHead(code,{"content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff"});res.end(JSON.stringify(value));};
    const reject=ctx.connection.requestRejection(req);if(reject||req.headers["sec-fetch-site"]==="cross-site"){send(reject??403,{error:"unauthorized"});return;}
    if(req.method!=="GET"){send(405,{error:"read-only"});return;}
    if(req.headers["x-hub-daily-use"]!=="1"){send(403,{error:"header-required"});return;}
    const signal=AbortSignal.timeout(15000);
    try{
      if(action==="activity"){
        const {items}=await ctx.sessionController.list({},signal),now=Date.now(),byId:Record<string,unknown>={},query=ctx.get?.("sessionQuery")??ctx.sessionQuery,archived=new Set(ctx.get?.("workspaceRegistry")?.archivedSessionIds??[]);
        const headers=items.some((s:any)=>s.origin==="subagent"&&(s.running||now-s.updatedAt<24*60*60000))&&query?.listSessions?await query.listSessions(signal):[],parents=new Map<string,string>(headers.map(({header}:any)=>[header.id,header.parentSession]));
        let inspected=0;
        for(const s of items){if(isKnowledgeEvaluation(s.sessionId)||s.blank||archived.has(s.sessionId))continue;const v=s.projections?.values??{},parentId=parents.get(s.sessionId)??v.subagent?.parentSessionId??v.subagent?.parentSession;
          const toolWork=(v.sessionStats?.toolMs??0)>0,recent=!s.running&&toolWork&&now-s.updatedAt<24*60*60000;
          if(recent&&ended.get(s.sessionId)?.version!==s.updatedAt&&inspected++<25){const observation=await query.observeSession(s.sessionId,{signal,projectionMode:"none"});try{const end=[...observation.events].reverse().find((e:any)=>e.type==="turn/end");ended.set(s.sessionId,{version:s.updatedAt,kind:end?.data?.reason?.kind??"unknown"});if(ended.size>2000)ended.delete(ended.keys().next().value!);}finally{observation[Symbol.dispose]();}}
          const kind=ended.get(s.sessionId)?.kind,completed=recent&&kind==="completed",failed=recent&&kind==="error",stopped=recent&&["aborted","interrupted"].includes(kind??"");
          if(s.running||recent||s.origin==="subagent")byId[s.sessionId]={title:v.title,running:s.running,completed,failed,stopped,origin:s.origin,parentId,updatedAt:s.updatedAt,blank:s.blank};
        }send(200,{byId,at:now});return;
      }
      const session=req.headers["x-hub-session"],id=req.headers["x-hub-artifact"];
      if(typeof session!=="string"||!/^[-\w.]{1,200}$/.test(session)){send(400,{error:"invalid-session"});return;}
      const query=ctx.get?.("sessionQuery")??ctx.sessionQuery,observation=await query.observeSession(session,{signal,projectionMode:"none"});
      try{const files=conversationArtifacts([...observation.events]),apps=files.filter(f=>/\.html?$/i.test(f.name));
        if(id===undefined){send(200,{artifacts:apps.map(({content,...item})=>item)});return;}
        const app=apps.find(f=>f.id===id);if(!app){send(404,{error:"artifact-unavailable"});return;}
        send(200,{document:artifactDocument(app,files),name:app.name,at:app.at});
      }finally{observation[Symbol.dispose]();}
    }catch{send(503,{error:"native-state-unavailable"});}
  }}));return()=>{ended.clear();off.forEach((f:any)=>f());};
}
