import {conversationScreenshots,installScreenshotDelivery} from "./screenshot-delivery.ts";
import {conversationArtifacts,artifactDocument,sentFiles,readSendableFile} from "./conversation-artifacts.ts";
import {isAbsolute,resolve} from "node:path";
import {isKnowledgeEvaluation} from "./knowledge-evidence.ts";
import {createHash} from "node:crypto";
import {helperWork} from "./helper-work.ts";
/** Read-only native state, available before any chat has been opened in the
 * new PWA process. No task is resumed, repeated or cancelled by these reads. */
export function installDailyUseWeb(ctx:any){
  const offScreenshot=installScreenshotDelivery(ctx);
  // Files HUB makes on this PC reach the phone through the chat's outputs.
  const offSend=ctx.tools?.register?.({name:"hub_send_file",description:"Send a file you made to the user's phone: a 3D model (STL, OBJ, PLY, USDZ), PDF, image, spreadsheet, archive and so on. It appears in this chat's outputs, where the phone previews what it can (3D models open in a 3D viewer) and can save or share it. Up to 20 MB. path is absolute or relative to the working directory. Send what the user asked for; never secrets or credentials.",
    parameters:{type:"object",properties:{path:{type:"string",maxLength:1024}},required:["path"],additionalProperties:false},
    output:{schema:{type:"object"},render:(_a:any,v:any)=>[{type:"text",text:`Sent ${v.name} (${v.bytes} bytes) to the phone: it is in this chat's outputs.`}],presentationMeta:(_a:any,v:any)=>v},
    async execute(args:any,exec:any){
      const header=exec.agent?.session?.header;
      if(!header||exec.parent||header.origin==="subagent")throw Error("Send files from the conversation itself.");
      if(typeof args.path!=="string"||!args.path.trim()||/[\u0000-\u001f]/.test(args.path))throw Error("Give the file's path.");
      const file=await readSendableFile(isAbsolute(args.path)?args.path:resolve(header.cwd??process.cwd(),args.path));
      return {kind:"hub-file",path:file.path,name:file.name,bytes:file.data.length,sha256:file.sha256};
    }});
  const ended=new Map<string,{version:number;kind:string}>();
  // Listing every stored conversation takes over a second, and the phone asks
  // for the chat list and Your work at the same moment. Requests share a
  // listing, and a finished one is reused until any chat changes (a session
  // event) or 30 s pass, so reopening the app or the list is instant while
  // nothing has happened. Without session events only running listings are shared.
  let listing:{value:Promise<any>;generation:number;at:number;done:boolean}|undefined,generation=0;
  const observes=typeof ctx.on==="function";
  const offEvents=observes?ctx.on("session/event",()=>{generation++;},{global:true}):undefined;
  const listSessions=()=>{
    if(listing&&listing.generation===generation&&(!listing.done||observes&&Date.now()-listing.at<30000))return listing.value;
    const entry={value:ctx.sessionController.list({},AbortSignal.timeout(20000)),generation,at:Date.now(),done:false};listing=entry;
    entry.value.then(()=>{entry.done=true;},()=>{if(listing===entry)listing=undefined;});
    return entry.value;
  };
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
        const {items}=await listSessions(),archived=new Set(ctx.get?.("workspaceRegistry")?.archivedSessionIds??[]);
        const all=items.filter((s:any)=>!s.blank&&s.origin!=="subagent"&&!isKnowledgeEvaluation(s.sessionId)&&!archived.has(s.sessionId)&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(s.sessionId))
          .map((s:any)=>({sessionId:s.sessionId,title:typeof s.projections?.values?.title==="string"&&s.projections.values.title.trim()?s.projections.values.title.slice(0,240):"Untitled conversation",updatedAt:Number.isFinite(s.updatedAt)&&s.updatedAt>=0?s.updatedAt:0}))
          .filter((s:any)=>!search||s.title.toLocaleLowerCase().includes(search)).sort((a:any,b:any)=>b.updatedAt-a.updatedAt);
        send(200,{conversations:all.slice(0,50),hasMore:all.length>50});return;
      }
      if(action==="activity"){
        const {items}=await listSessions(),now=Date.now(),byId:Record<string,unknown>={},query=ctx.get?.("sessionQuery")??ctx.sessionQuery,archived=new Set(ctx.get?.("workspaceRegistry")?.archivedSessionIds??[]);
        const headers=items.some((s:any)=>s.origin==="subagent"&&(s.running||now-s.updatedAt<24*60*60000))&&query?.listSessions?await query.listSessions(signal):[],parents=new Map<string,string>(headers.map(({header}:any)=>[header.id,header.parentSession]));
        let inspected=0,running=0;
        for(const s of items){if(isKnowledgeEvaluation(s.sessionId)||s.blank||archived.has(s.sessionId))continue;const v=s.projections?.values??{},parentId=parents.get(s.sessionId)??v.subagent?.parentSessionId??v.subagent?.parentSession;
          // Any chat used in the last day counts as recent work, not only ones that ran tools.
          const recent=!s.running&&now-s.updatedAt<24*60*60000;
          if(recent&&ended.get(s.sessionId)?.version!==s.updatedAt&&inspected++<25){const observation=await query.observeSession(s.sessionId,{signal,projectionMode:"none"});try{const end=[...observation.events].reverse().find((e:any)=>e.type==="turn/end");ended.set(s.sessionId,{version:s.updatedAt,kind:end?.data?.reason?.kind??"unknown"});if(ended.size>2000)ended.delete(ended.keys().next().value!);}finally{observation[Symbol.dispose]();}}
          const kind=ended.get(s.sessionId)?.kind,completed=recent&&kind==="completed",failed=recent&&kind==="error",stopped=recent&&["aborted","interrupted"].includes(kind??"");
          // Running work: the tool in use right now and when the turn began, for the phone's Your work.
          let doing:string|undefined,since:number|undefined;
          if(s.running&&running++<8&&query?.observeSession){try{const observation=await query.observeSession(s.sessionId,{signal,projectionMode:"none"});try{const events=[...observation.events];for(let i=events.length-1;i>=0;i--){const e:any=events[i];if(!doing&&e.type==="tool/call"&&typeof e.data?.name==="string")doing=e.data.name.slice(0,80);if(e.type==="turn/start"){since=e.time;break;}}}finally{observation[Symbol.dispose]();}}catch{}}
          if(s.running||recent||s.origin==="subagent")byId[s.sessionId]={title:v.title,running:s.running,completed,failed,stopped,origin:s.origin,parentId,updatedAt:s.updatedAt,blank:s.blank,...(doing?{doing}:{}),...(since?{since}:{})};
        }send(200,{byId,at:now});return;
      }
      const session=req.headers["x-hub-session"],id=req.headers["x-hub-artifact"];
      if(typeof session!=="string"||!/^[-\w.]{1,200}$/.test(session)){send(400,{error:"invalid-session"});return;}
      const query=ctx.get?.("sessionQuery")??ctx.sessionQuery,observe=()=>query.observeSession(session,{signal,projectionMode:"none"});
      if(action==="helper"){
        // Only a helper (sub-agent) session is readable here.
        const {items}=await listSessions(),item=items.find((s:any)=>s.sessionId===session);
        if(!item||item.origin!=="subagent"){send(404,{error:"helper-unavailable"});return;}
        const observation=await observe();
        try{const work=helperWork([...observation.events],item.running===true);
          send(200,{sessionId:session,title:typeof item.projections?.values?.title==="string"?item.projections.values.title.slice(0,240):"Helper",...work});}
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
          const safeName=(name:string)=>name&&name!=="."&&name!==".."&&name.length<=255&&!/[\\/\u0000-\u001f\u007f-\u009f]/u.test(name);
          const transferable=files.filter(file=>safeName(file.name)),sent=sentFiles(events).filter(file=>safeName(file.name));
          const metadata=(file:typeof files[number])=>({id:file.id,name:file.name,at:file.at,bytes:Buffer.byteLength(file.content),
            sha256:createHash("sha256").update(file.content).digest("hex")});
          if(id===undefined){send(200,{files:[...transferable.map(f=>({seq:f.seq,item:metadata(f)})),...sent.map(f=>({seq:f.seq,item:{id:f.id,name:f.name,at:f.at,bytes:f.bytes,sha256:f.sha256}}))]
            .sort((first,second)=>second.seq-first.seq).slice(0,250).map(entry=>entry.item)});return;}
          const file=transferable.find(item=>item.id===id);
          if(file){send(200,{...metadata(file),data:Buffer.from(file.content).toString("base64")});return;}
          const delivered=sent.find(item=>item.id===id);
          if(!delivered){send(404,{error:"artifact-unavailable"});return;}
          // The file must still be exactly what was sent.
          let current;try{current=await readSendableFile(delivered.path);}catch{send(410,{error:"file-changed-or-removed"});return;}
          if(current.sha256!==delivered.sha256){send(410,{error:"file-changed-or-removed"});return;}
          send(200,{id:delivered.id,name:delivered.name,at:delivered.at,bytes:delivered.bytes,sha256:delivered.sha256,data:current.data.toString("base64")});return;
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
  }}));return()=>{offSend?.();offScreenshot();offEvents?.();ended.clear();off.forEach((f:any)=>f());};
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
