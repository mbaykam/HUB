import {readFile,mkdir,writeFile,rename,rm,lstat} from "node:fs/promises";
import {join} from "node:path";
import {randomUUID,createHash} from "node:crypto";
import type {IncomingMessage,ServerResponse} from "node:http";
import type {PlannerItem,WorkPlan,PlannerSnapshot,PlannerCommand} from "../planner-contract.ts";
import {plannerDate} from "../planner-contract.ts";
import {effectiveKnowledgeCharacter} from "./knowledge-identity.ts";

const uuid=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const version=(v:unknown):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0;
const text=(v:unknown,max:number):v is string=>typeof v==="string"&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
const session=(v:unknown):v is string=>typeof v==="string"&&v.length>0&&v.length<=200&&!/[\s\u0000-\u001f]/.test(v);
const timestamp=(v:unknown):v is string=>typeof v==="string"&&/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v));
function timeZone(value:unknown){if(typeof value!=="string"||value.length>100)throw Error("Choose a timezone");new Intl.DateTimeFormat("en",{timeZone:value});return value;}
function itemDraft(value:any){
  if(!value||Object.keys(value).some(k=>!["id","version","kind","title","details","horizon","date","start","end","timeZone"].includes(k))||!uuid(value.id)||!version(value.version)||!["todo","event"].includes(value.kind)||!text(value.title,180)||!value.title.trim()||!text(value.details,4000)||!["near","later"].includes(value.horizon))throw Error("Enter a title and valid item details");
  const zone=timeZone(value.timeZone);
  if(value.date!==undefined&&!plannerDate(value.date)||value.start!==undefined&&!timestamp(value.start)||value.end!==undefined&&!timestamp(value.end)||value.date!==undefined&&value.start!==undefined||value.end!==undefined&&value.start===undefined||value.start&&value.end&&Date.parse(value.end)<=Date.parse(value.start)||value.kind==="event"&&!value.date&&!value.start)throw Error("Choose a valid date or time range; end must follow start");
  return {...value,title:value.title.trim(),details:value.details.trim(),timeZone:zone,...(value.start?{start:new Date(value.start).toISOString()}:{}),...(value.end?{end:new Date(value.end).toISOString()}:{})};
}

/** One private durable ledger; per-item revisions let concurrent personal edits
 * and agent work-plan updates proceed without clobbering each other. */
export class PlannerStore {
  #state:PlannerSnapshot={revision:0,items:[],plans:[]};#writes:Promise<unknown>=Promise.resolve();
  constructor(readonly root:string){}
  async load(){
    await mkdir(this.root,{recursive:true,mode:0o700});if((await lstat(this.root)).isSymbolicLink())throw Error("Planner storage must be a regular directory");
    try{const state=JSON.parse(await readFile(join(this.root,"planner.json"),"utf8"));
      if(!version(state.revision)||!Array.isArray(state.items)||!Array.isArray(state.plans))throw Error("Planner needs repair; the saved file was preserved");
      for(const item of state.items){itemDraft(Object.fromEntries(Object.entries(item).filter(([k])=>["id","version","kind","title","details","horizon","date","start","end","timeZone"].includes(k))));if(!["open","done"].includes(item.state)||typeof item.deleted!=="boolean"||!Number.isFinite(item.createdAt)||!Number.isFinite(item.updatedAt))throw Error("Invalid saved planner item");}
      for(const plan of state.plans){if(!session(plan.id)||!session(plan.sessionId)||!session(plan.rootSessionId)||!version(plan.version)||!text(plan.title,180)||!Array.isArray(plan.steps)||plan.steps.length>1000||plan.steps.some((s:any)=>!text(s.title,240)||!["pending","active","done","blocked"].includes(s.state))||!["active","paused","completed","blocked"].includes(plan.state))throw Error("Invalid saved work plan");}
      if(new Set(state.items.map((i:PlannerItem)=>i.id)).size!==state.items.length||new Set(state.plans.map((p:WorkPlan)=>p.id)).size!==state.plans.length)throw Error("Duplicate planner identity");this.#state=state;
    }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  }
  snapshot(rootSessionId?:string){return structuredClone({...this.#state,plans:rootSessionId?this.#state.plans.filter(p=>p.rootSessionId===rootSessionId):[]});}
  private mutate<T>(run:(state:PlannerSnapshot)=>T){const result=this.#writes.then(async()=>{const next=structuredClone(this.#state),value=run(next);next.revision++;const file=join(this.root,"planner.json"),temp=`${file}.${randomUUID()}.tmp`;
    try{await writeFile(temp,JSON.stringify(next),{flag:"wx",mode:0o600});await rename(temp,file);}finally{await rm(temp,{force:true});}this.#state=next;return structuredClone(value);});this.#writes=result.catch(()=>{});return result;}
  change(command:PlannerCommand,sourceSessionId?:string){return this.mutate(state=>{
    if(!command||typeof command!=="object")throw Error("Invalid planner command");
    if(command.action==="save"){
      if(Object.keys(command).some(k=>!["action","item"].includes(k)))throw Error("Invalid planner command");
      const draft=itemDraft(command.item),old=state.items.find(i=>i.id===draft.id);
      const editable=(v:PlannerItem|typeof draft)=>Object.fromEntries(["id","kind","title","details","horizon","date","start","end","timeZone"].map(k=>[k,v[k]]).filter(([,v])=>v!==undefined));
      if(old&&draft.version===0&&old.version===1&&!old.deleted&&JSON.stringify(editable(old))===JSON.stringify(editable(draft)))return old;
      if(old?.deleted)throw Error("Restore this item before editing it");
      if(old?old.version!==draft.version:draft.version!==0)throw Error("This item changed. Reload before saving; your edit has not been applied.");
      if(!old&&state.items.length>=10000)throw Error("Planner is full. Existing items are preserved.");
      const next:PlannerItem={...draft,version:(old?.version??0)+1,state:old?.state??"open",deleted:false,createdAt:old?.createdAt??Date.now(),updatedAt:Date.now(),...(old?.sourceSessionId||sourceSessionId?{sourceSessionId:old?.sourceSessionId??sourceSessionId}:{})};
      if(old)state.items[state.items.indexOf(old)]=next;else state.items.push(next);return next;
    }
    if(!["complete","reopen","remove","restore"].includes(command.action)||Object.keys(command).some(k=>!["action","id","version"].includes(k))||!uuid(command.id)||!version(command.version))throw Error("Invalid planner command");
    const item=state.items.find(i=>i.id===command.id);if(!item||item.version!==command.version)throw Error("This item changed. Reload and retry.");
    if(["complete","reopen"].includes(command.action)&&item.deleted)throw Error("Restore this item first");
    if(command.action==="remove")item.deleted=true;else if(command.action==="restore")item.deleted=false;else item.state=command.action==="complete"?"done":"open";
    item.version++;item.updatedAt=Date.now();return item;
  });}
  plan(input:{sessionId:string;rootSessionId:string;characterId?:string;version:number;title:string;steps:WorkPlan["steps"]},allowParallel=false){return this.mutate(state=>{
    if(!session(input.sessionId)||!session(input.rootSessionId)||!version(input.version)||!text(input.title,180)||!input.title.trim()||!Array.isArray(input.steps)||input.steps.length>1000||input.steps.some(s=>!text(s.title,240)||!s.title.trim()||!["pending","active","done","blocked"].includes(s.state))||!allowParallel&&input.steps.filter(s=>s.state==="active").length>1)throw Error("Use a short plan with at most one active step");
    const old=state.plans.find(p=>p.id===input.sessionId);if(old?old.version!==input.version:input.version!==0)throw Error("The work plan changed; read it before updating");
    if(old&&old.rootSessionId!==input.rootSessionId)throw Error("Work plan lineage changed");
    const plan:WorkPlan={...input,id:input.sessionId,version:(old?.version??0)+1,state:input.steps.every(s=>s.state==="done")?"completed":input.steps.some(s=>s.state==="blocked")?"blocked":"active",updatedAt:Date.now()};
    if(old)state.plans[state.plans.indexOf(old)]=plan;else{if(state.plans.length>=10000)throw Error("Work plan storage is full; existing plans were preserved");state.plans.push(plan);}return plan;
  });}
  settle(sessionId:string,failed:boolean){if(!this.#state.plans.some(p=>p.sessionId===sessionId&&p.state==="active"))return Promise.resolve();return this.mutate(state=>{const p=state.plans.find(p=>p.sessionId===sessionId)!;p.state=failed?"blocked":p.steps.every(s=>s.state==="done")?"completed":"paused";p.updatedAt=Date.now();p.version++;});}
  async drain(){await this.#writes;}
}

export const PLANNER_GUIDE = `Personal agenda and work steps are separate. When available, hub_planner lists, adds, edits, completes or removes the user's personal to-dos and calendar events. Read first to avoid duplicates; preserve existing IDs and versions, use the user's timezone, distinguish intentions from completed actions, and only change personal commitments when requested. Removed items can be restored. Near/later is a personal planning horizon, not a background execution queue. Calendar entries do not start agent work; hub_goals_manage / hub_automation_manage handle goals and recurring or conditional execution. For a multi-step task, hub_work_plan shows your own concise observable plan beside the user's to-dos in the current conversation; update steps as work actually progresses, mark blockers honestly, never expose private reasoning, and do not mark success before results exist. Delegated workers get their own plan attached to the durable parent conversation. Read the plan/version before replacing it. Never turn your internal steps into the user's personal to-dos. Tool availability and saved permissions remain binding.`;
export const CHARACTER_TOOL_GUIDE = `## Daily tools and collaboration\n${PLANNER_GUIDE}\n\nOther available tools: hub_delegate assigns substantial work to a configured character by stable ID; hub_task is the voice assistant's immediate background-task alias. Keep the core task yourself when your specialist instructions require it; delegation is not a way to evade your task. list_agents checks observed progress, send_message supplies a follow-up to an existing worker, and interrupt_agent stops that worker when requested; never treat an unstarted task as completed. hub_switch_character changes the active text/Telegram speaker when the user asks to talk to another role. hub_present publishes a useful live visual; it does not run a background job. camofox_search / camofox_open / camofox_snapshot research current websites; cite what you actually observed and close task tabs. hub_knowledge_search finds saved information; hub_knowledge_read reads exact originals and sourced relationships; hub_memory_index navigates domains, chat archives and skills. hub_knowledge_write_note creates an explicitly requested note without rewriting chat originals. hub_skill_read loads a reusable workflow; hub_skill_save stores a verified workflow without granting permissions. hub_media_inspect inspects supported attached audio/video or a public clip, with stated sampling and access limits; a caption is not watched video. Native todo_write records a whole internal checklist and its observed steps also appear in the conversation work-plan area; do not copy them into personal to-dos. read/glob/grep inspect local files; edit changes a known passage and write replaces a file, so inspect first and preserve unrelated content. pwsh runs an authorized local command; job_list/job_output observe background processes and job_kill stops a selected process. browser_open/browser_snapshot/browser_find/browser_click/browser_fill/browser_scroll/browser_wait operate the task browser using fresh page observations; browser_close releases it. web_search/minke_web_search find current sources and web_fetch reads a specific URL. read_image/view_image inspect actual images; codex_image_generate/codex_image_edit produce image assets only when requested. skill loads the applicable saved skill before using it. ask_user_question requests genuinely missing information. For other tools use the exact current schema and description in your request. Never invent a tool name, capability or successful result. These instructions explain tools; they do not grant tools missing from your actual allowed schemas.`;

export function installPlanner(ctx:any,characters:any){
  const store=new PlannerStore(join(characters.store.root,"..","hub-planner")),ready=store.load();void ready.catch(()=>{});
  const roots=new Map<string,string>();
  const rootSession=async(id:string,agent?:any)=>{if(!session(id))throw Error("Invalid conversation");if(roots.has(id))return roots.get(id)!;let current=id,header=agent?.session.header;const seen=new Set<string>();
    for(let depth=0;depth<16;depth++){
      if(seen.has(current))throw Error("Conversation lineage contains a cycle");seen.add(current);
      if(roots.has(current)){current=roots.get(current)!;break;}
      if(!header){const live=ctx.agents.get?.(current)??ctx.agents.list?.().find((a:any)=>a.id===current);header=live?.session.header??(await ctx.sessionPersistence.inspect(current,AbortSignal.timeout(3000))).meta;}
      if(!header.parentSession)break;current=header.parentSession;header=undefined;if(depth===15)throw Error("Conversation lineage is too deep");
    }
    for(const key of seen)roots.set(key,current);if(roots.size>2000)roots.delete(roots.keys().next().value!);return current;
  };
  const output={schema:{type:"object"},render:(_a:any,v:any)=>[{type:"text",text:JSON.stringify(v)}]};
  const check=(exec:any,name:string)=>{if(!exec.agent)throw Error("This tool needs an active agent");const character=effectiveKnowledgeCharacter(ctx,exec.agent);if(character?.tools.mode==="allow"&&!character.tools.names.includes(name))throw Error("This tool is disabled for this character");return character;};
  const offTools=[ctx.tools.register({name:"hub_planner",description:"Manage the user's personal to-dos and calendar agenda. List first; save edits a complete item with its id/version; omit id/version for a new item. Use explicit UTC/offset times and an IANA timezone, or date for an all-day event. Near/later groups personal to-dos. Complete/reopen/remove/restore require id/version; removal is recoverable. Calendar entries do not execute tasks. Keep internal work steps in hub_work_plan. Do not add commitments without the user's intent.",parameters:{type:"object",properties:{action:{enum:["list","save","complete","reopen","remove","restore"]},item:{type:"object",properties:{id:{type:"string"},version:{type:"integer"},kind:{enum:["todo","event"]},title:{type:"string"},details:{type:"string"},horizon:{enum:["near","later"]},date:{type:"string"},start:{type:"string"},end:{type:"string"},timeZone:{type:"string"}},required:["kind","title","details","horizon","timeZone"],additionalProperties:false},id:{type:"string"},version:{type:"integer"}},required:["action"],additionalProperties:false},output,async execute(args:any,exec:any){check(exec,"hub_planner");await ready;exec.signal.throwIfAborted();if(args.action==="list")return {items:store.snapshot().items,meaning:"Personal agenda only; execution schedules are in Tasks."};if(args.action==="save"&&args.item?.id===undefined){if(!exec.callId)throw Error("A new item needs its native operation identity");const hash=createHash("sha256").update(exec.agent.session.header.id+":"+exec.callId).digest("hex"),id=hash.slice(0,8)+"-"+hash.slice(8,12)+"-"+hash.slice(12,16)+"-"+hash.slice(16,20)+"-"+hash.slice(20,32);args={...args,item:{...args.item,id,version:0}};}return store.change(args,exec.agent.session.header.id);}}),
    ctx.tools.register({name:"hub_work_plan",description:"Read or update YOUR observable work steps for the current conversation. Use read to get the saved version (0 if absent). Update with a short title, version and complete steps (pending/active/done/blocked), at most one active step. Host binds this to your actual agent and durable parent; never supply another session. Explain actions/results, not private reasoning. Keep the user's personal to-dos in hub_planner.",parameters:{type:"object",properties:{action:{enum:["read","update"]},version:{type:"integer"},title:{type:"string"},steps:{type:"array",maxItems:30,items:{type:"object",properties:{title:{type:"string"},state:{enum:["pending","active","done","blocked"]}},required:["title","state"],additionalProperties:false}}},required:["action"],additionalProperties:false},output,async execute(args:any,exec:any){const character=check(exec,"hub_work_plan");await ready;exec.signal.throwIfAborted();const sessionId=exec.agent.session.header.id,rootSessionId=await rootSession(sessionId,exec.agent),old=store.snapshot(rootSessionId).plans.find(p=>p.sessionId===sessionId);if(args.action==="read")return {plan:old??null,version:old?.version??0};if(args.action!=="update"||Object.keys(args).some(k=>!["action","version","title","steps"].includes(k)))throw Error("Invalid work plan update");return store.plan({sessionId,rootSessionId,characterId:character?.id,version:args.version,title:args.title,steps:args.steps});}})];
  const offPrompt=ctx.systemPrompt.section({name:"hub:planner-guide",order:92,text:(context:any)=>{const identity=context.scope&&effectiveKnowledgeCharacter(ctx,context.scope),character=identity&&characters.store.snapshot?.().characters.find((c:any)=>c.id===identity.id);return character?.instructions.includes("## Daily tools and collaboration")?"":CHARACTER_TOOL_GUIDE;}});
  let events=Promise.resolve();
  const offEvents=ctx.on("session/event",(source:any,event:any)=>{
    if(!["todo/write","turn/end"].includes(event.type))return;
    events=events.then(async()=>{await ready;
      if(event.type==="turn/end"){await store.settle(source.header.id,event.data?.reason?.kind!=="completed");return;}
      const todos=event.data?.todos;if(!Array.isArray(todos)||todos.length>1000)return;
      const rootSessionId=await rootSession(source.header.id,{session:source}),old=store.snapshot(rootSessionId).plans.find(p=>p.sessionId===source.header.id);
      await store.plan({sessionId:source.header.id,rootSessionId,version:old?.version??0,title:old?.title??"Current task",steps:todos.map((t:any)=>({title:typeof t.content==="string"&&t.content.length>240?t.content.slice(0,239)+"…":t.content,state:t.status==="completed"?"done":t.status==="in_progress"?"active":"pending"}))},true);
    }).catch(()=>{});
  },{global:true});
  const offRoute=ctx.webServer.register({kind:"exact",path:"/api/hub/planner",async handler(req:IncomingMessage,res:ServerResponse){
    const send=(code:number,data:unknown)=>{res.writeHead(code,{"content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff"});res.end(JSON.stringify(data));};
    const rejected=ctx.connection.requestRejection(req);if(rejected||req.headers["sec-fetch-site"]==="cross-site"||req.headers["x-hub-planner"]!=="1"){send(rejected??403,{error:"unauthorized"});return;}
    try{await ready;await events;if(req.method==="POST"){
      if(!req.headers["content-type"]?.startsWith("application/json")){send(415,{error:"json-required"});return;}
      const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>16000)throw Error("Planner edit is too large");chunks.push(chunk);}await store.change(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    }else if(req.method!=="GET"){send(405,{error:"method-not-allowed"});return;}
    const id=new URL(req.url??"/","http://hub.invalid").searchParams.get("sessionId");let root:string|undefined;
    if(id){try{root=await rootSession(id);}catch{/* Personal agenda still loads if an ended conversation is unavailable. */}}
    send(200,store.snapshot(root));
    }catch(error){send(409,{error:"planner-operation-failed",detail:(error as Error).message.slice(0,300)});}
  }});
  return async()=>{offRoute();offEvents();offPrompt();offTools.forEach(off=>off());await ready.catch(()=>{});await events;await store.drain();};
}
