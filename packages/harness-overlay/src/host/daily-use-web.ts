import {conversationScreenshots,installScreenshotDelivery} from "./screenshot-delivery.ts";
import {conversationArtifacts,artifactDocument} from "./conversation-artifacts.ts";
import {isKnowledgeEvaluation} from "./knowledge-evidence.ts";
import {createHash} from "node:crypto";
import {helperWork} from "./helper-work.ts";
/** Read-only native state, available before any chat has been opened in the
 * new PWA process. No task is resumed, repeated or cancelled by these reads. */
export function installDailyUseWeb(ctx:any){
  const offScreenshot=installScreenshotDelivery(ctx);
  const ended=new Map<string,{version:number;kind:string}>();
  const off=["activity","artifacts","conversations","helper"].map(action=>ctx.webServer.register({kind:"exact",path:"/api/hub/"+action,handler:async(req:any,res:any)=>{
    const send=(code:number,value:any)=>{res.writeHead(code,{"content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff"});res.end(JSON.stringify(value));};
    const reject=ctx.connection.requestRejection(req);if(reject||req.headers["sec-fetch-site"]==="cross-site"){send(reject??403,{error:"unauthorized"});return;}
    if(req.method!=="GET"){send(405,{error:"read-only"});return;}
    if(req.headers["x-hub-daily-use"]!=="1"){send(403,{error:"header-required"});return;}
    const signal=AbortSignal.timeout(15000);
    try{
      if(action==="conversations"){
        const raw=req.headers["x-hub-session-query"];
        if(raw!==undefined&&(typeof raw!=="string"||raw.length>600)){send(400,{error:"invalid-search"});return;}
        let search:string;try{search=decodeURIComponent(raw??"").trim().toLocaleLowerCase();}catch{send(400,{error:"invalid-search"});return;}
        if(search.length>120){send(400,{error:"invalid-search"});return;}
        const {items}=await ctx.sessionController.list({},signal),archived=new Set(ctx.get?.("workspaceRegistry")?.archivedSessionIds??[]);
        const all=items.filter((s:any)=>!s.blank&&s.origin!=="subagent"&&!isKnowledgeEvaluation(s.sessionId)&&!archived.has(s.sessionId)&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(s.sessionId))
          .map((s:any)=>({sessionId:s.sessionId,title:typeof s.projections?.values?.title==="string"&&s.projections.values.title.trim()?s.projections.values.title.slice(0,240):"Untitled conversation",updatedAt:Number.isFinite(s.updatedAt)&&s.updatedAt>=0?s.updatedAt:0}))
          .filter((s:any)=>!search||s.title.toLocaleLowerCase().includes(search)).sort((a:any,b:any)=>b.updatedAt-a.updatedAt);
        send(200,{conversations:all.slice(0,50),hasMore:all.length>50});return;
      }
      if(action==="activity"){
        const {items}=await ctx.sessionController.list({},signal),now=Date.now(),byId:Record<string,unknown>={},query=ctx.get?.("sessionQuery")??ctx.sessionQuery,archived=new Set(ctx.get?.("workspaceRegistry")?.archivedSessionIds??[]);
        const headers=items.some((s:any)=>s.origin==="subagent"&&(s.running||now-s.updatedAt<24*60*60000))&&query?.listSessions?await query.listSessions(signal):[],parents=new Map<string,string>(headers.map(({header}:any)=>[header.id,header.parentSession]));
        let inspected=0;
        for(const s of items){if(isKnowledgeEvaluation(s.sessionId)||s.blank||archived.has(s.sessionId))continue;const v=s.projections?.values??{},parentId=parents.get(s.sessionId)??v.subagent?.parentSessionId??v.subagent?.parentSession;
          // Any chat used in the last day counts as recent work, not only ones that ran tools.
          const recent=!s.running&&now-s.updatedAt<24*60*60000;
          if(recent&&ended.get(s.sessionId)?.version!==s.updatedAt&&inspected++<25){const observation=await query.observeSession(s.sessionId,{signal,projectionMode:"none"});try{const end=[...observation.events].reverse().find((e:any)=>e.type==="turn/end");ended.set(s.sessionId,{version:s.updatedAt,kind:end?.data?.reason?.kind??"unknown"});if(ended.size>2000)ended.delete(ended.keys().next().value!);}finally{observation[Symbol.dispose]();}}
          const kind=ended.get(s.sessionId)?.kind,completed=recent&&kind==="completed",failed=recent&&kind==="error",stopped=recent&&["aborted","interrupted"].includes(kind??"");
          if(s.running||recent||s.origin==="subagent")byId[s.sessionId]={title:v.title,running:s.running,completed,failed,stopped,origin:s.origin,parentId,updatedAt:s.updatedAt,blank:s.blank};
        }send(200,{byId,at:now});return;
      }
      const session=req.headers["x-hub-session"],id=req.headers["x-hub-artifact"];
      if(typeof session!=="string"||!/^[-\w.]{1,200}$/.test(session)){send(400,{error:"invalid-session"});return;}
      const query=ctx.get?.("sessionQuery")??ctx.sessionQuery,observe=()=>query.observeSession(session,{signal,projectionMode:"none"});
      if(action==="helper"){
        // Only a helper (sub-agent) session is readable here.
        const {items}=await ctx.sessionController.list({},signal),item=items.find((s:any)=>s.sessionId===session);
        if(!item||item.origin!=="subagent"){send(404,{error:"helper-unavailable"});return;}
        const observation=await observe();
        try{const work=helperWork([...observation.events]),running=item.running===true;
          send(200,{sessionId:session,title:typeof item.projections?.values?.title==="string"?item.projections.values.title.slice(0,240):"Helper",...work,running,outcome:running?"running":work.outcome==="running"?"done":work.outcome});}
        finally{observation[Symbol.dispose]();}
        return;
      }
      let observation=await observe();
      // The iPhone asks for the screenshot list as soon as its live stream
      // shows a screenshot, which can be a moment before that result is
      // readable here; it then never asks again. While a reply is running,
      // let a just-taken screenshot settle before answering the list.
      if(req.headers["x-hub-screenshot"]===undefined&&id===undefined&&req.headers["x-hub-artifact-format"]!=="file")
        observation=await settledObservation(observation,observe,signal);
      try{const events=[...observation.events],screenshots=conversationScreenshots(events),imageId=req.headers["x-hub-screenshot"];
        if(imageId!==undefined){
          const screenshot=screenshots.find(item=>item.id===imageId);
          if(!screenshot){send(404,{error:"screenshot-unavailable"});return;}
          const stored=await ctx.attachments.readImage(screenshot.attachment,signal);
          if(stored.ref.mediaType!==screenshot.attachment.mediaType||stored.data.byteLength!==screenshot.attachment.bytes||stored.ref.attachmentId!==screenshot.attachment.attachmentId){send(404,{error:"screenshot-unavailable"});return;}
          res.writeHead(200,{"content-type":screenshot.attachment.mediaType,"content-length":stored.data.byteLength,"cache-control":"private, no-store","x-content-type-options":"nosniff","cross-origin-resource-policy":"same-origin"});
          res.end(stored.data);return;
        }
        const files=conversationArtifacts(events),apps=files.filter(f=>/\.html?$/i.test(f.name));
        if(req.headers["x-hub-artifact-format"]==="file"){
          const transferable=files.filter(file=>file.name&&file.name!=="."&&file.name!==".."&&
            file.name.length<=255&&!/[\\/\u0000-\u001f\u007f-\u009f]/u.test(file.name));
          const metadata=(file:typeof files[number])=>({id:file.id,name:file.name,at:file.at,bytes:Buffer.byteLength(file.content),
            sha256:createHash("sha256").update(file.content).digest("hex")});
          if(id===undefined){send(200,{files:transferable.sort((first,second)=>second.seq-first.seq).slice(0,250).map(metadata)});return;}
          const file=transferable.find(item=>item.id===id);
          if(!file){send(404,{error:"artifact-unavailable"});return;}
          send(200,{...metadata(file),data:Buffer.from(file.content).toString("base64")});return;
        }
        if(id===undefined){
          // Photos shared in messages, so Knowledge can show a chat's pictures.
          const seen=new Set<string>(),photos:any[]=[];
          for(const event of events){if(event.type!=="user/message"&&event.type!=="assistant/message")continue;
            for(const block of event.data?.message?.content??[]){const a=block?.type==="image"?block.attachment:undefined;
              if(a&&typeof a.attachmentId==="string"&&!seen.has(a.attachmentId)&&photos.length<60){seen.add(a.attachmentId);photos.push({attachmentId:a.attachmentId,mediaType:a.mediaType,bytes:a.bytes,...(typeof a.name==="string"?{name:a.name}:{})});}}}
          // Web photos the assistant showed as Markdown images.
          const imageLinks:{url:string;alt:string}[]=[],links=new Set<string>();
          for(const event of events){if(event.type!=="assistant/message")continue;
            for(const block of event.data?.message?.content??[]){if(block?.type!=="text"||typeof block.text!=="string")continue;
              for(const m of block.text.matchAll(/!\[([^\]]{0,200})\]\((https:\/\/[^)\s]{1,1000})\)/g)){if(!links.has(m[2])&&imageLinks.length<30){links.add(m[2]);imageLinks.push({url:m[2],alt:m[1]});}}}}
          send(200,{artifacts:apps.map(({content,...item})=>item),screenshots:screenshots.map(({attachment,...item})=>item),photos,imageLinks});return;}
        const app=apps.find(f=>f.id===id);if(!app){send(404,{error:"artifact-unavailable"});return;}
        send(200,{document:artifactDocument(app,files),name:app.name,at:app.at});
      }finally{observation[Symbol.dispose]();}
    }catch{send(503,{error:"native-state-unavailable"});}
  }}));return()=>{offScreenshot();ended.clear();off.forEach((f:any)=>f());};
}

const SCREENSHOT_TOOLS=new Set(["hub_capture_desktop","hub_show_screenshot"]);
const pause=(ms:number,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{const t=setTimeout(resolve,ms);signal.addEventListener("abort",()=>{clearTimeout(t);reject(signal.reason);},{once:true});});

/** Mid-turn, wait (up to 4 s) for a screenshot call to have its result, and
 * otherwise look once more after a second, so a list asked for right after a
 * capture includes it. Finished conversations answer at once. */
export async function settledObservation(observation:any,observe:()=>Promise<any>,signal:AbortSignal,wait={step:300,limit:4000,once:1000}){
  const state=(events:any[])=>{
    const last=events.at(-1),running=!!last&&last.type!=="turn/end";
    const results=new Set(events.filter(e=>e.type==="tool/result").map(e=>e.data?.message?.content?.[0]?.toolCallId));
    const pending=events.some(e=>e.type==="tool/call"&&SCREENSHOT_TOOLS.has(e.data?.name)&&!results.has(e.data?.callId));
    return {running,pending};
  };
  let {running,pending}=state([...observation.events]);
  if(!running)return observation;
  let waited=0;
  do{
    await pause(pending?wait.step:wait.once,signal);waited+=pending?wait.step:wait.once;
    observation[Symbol.dispose]();observation=await observe();
    ({running,pending}=state([...observation.events]));
  }while(pending&&running&&waited<wait.limit);
  return observation;
}
