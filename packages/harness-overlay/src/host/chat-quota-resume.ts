import {createHash,randomUUID} from "node:crypto";
import {mkdir,readFile,rename,writeFile} from "node:fs/promises";
import {homedir} from "node:os";
import {dirname,join} from "node:path";
import type {IncomingMessage,ServerResponse} from "node:http";
import {readClaudeCodeUsage} from "./claude-code-provider.ts";

export const CHAT_QUOTA_RESUME_PATH="/api/hub/chat-resume";
export const QUOTA_RESUME_INSTRUCTION="This is an automatic continuation from the recorded subscription-quota checkpoint, not a new user request or grant. Continue only unfinished work from the recorded conversation and tool results. Never repeat completed actions or replay the original prompt. Do not make purchases, send messages, publish, delete user data, grant access or perform any external consequential action without fresh explicit user approval. Existing tool authority remains unchanged; do not expand tools, change model/provider, start fallback workers or infer new permission. If an action's outcome is uncertain, stop and ask the user to review it.";
export type ResumeState="waiting"|"waiting-unknown"|"dispatching"|"consumed"|"cancelled"|"needs-review";
export type ResumeReason="disabled"|"new-user-message"|"route-changed"|"authority-changed"|"manual-stop"|"active-session"|"archived"|"unsafe-tools"|"history-changed"|"uncertain-dispatch"|"attempt-exhausted"|"unavailable";
export interface ResumeRoute {provider:string;model:string;reasoningEffort?:string}
export interface ResumeEvent {seq:number;type:string;data?:any}
export interface ResumeInspection {sessionId:string;route:ResumeRoute;authority:string;toolAuthority?:string;active:boolean;archived:boolean;eligible:boolean;events:readonly ResumeEvent[]}
export interface ResumeCheckpoint {
  endSeq:number;failedTurn:number;route:ResumeRoute;authority:string;toolAuthority?:string;lastUser:{seq:number;digest:string};
  historyDigest:string;completedToolIds:string[];resetsAt?:number;availableAt?:number;requestId:string;state:ResumeState;
  reason?:ResumeReason;attempts:number;usageChecks:number;nextUsageCheck:number;
}
export interface ResumeRecord {sessionId:string;revision:number;enabled:boolean;checkpoint?:ResumeCheckpoint}
export interface ResumePort {
  inspect(sessionId:string):Promise<ResumeInspection|undefined>;
  prompt(request:{requestId:string;sessionId:string;mode:"queue";content:{type:"text";text:string}[]}):Promise<{accepted:boolean}>;
  usage(route:ResumeRoute):Promise<{resetsAt?:number;available?:boolean;blocked?:boolean}|undefined>;
  publish?(sessionId:string,data:{state:ResumeState;endSeq:number;provider:string;model:string;resetsAt?:number;reason?:ResumeReason}):void|Promise<void>;
}
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const validTime=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>0&&value<8640000000000000;
const routeKey=(route:ResumeRoute)=>JSON.stringify([route.provider,route.model,route.reasoningEffort??null]);
export const subscriptionRoute=(route:ResumeRoute)=>["claude-code","openai-codex"].includes(route.provider)&&!!route.model;
const waiting=(c:ResumeCheckpoint)=>c.state==="waiting"||c.state==="waiting-unknown";
const genuineUser=(e:ResumeEvent)=>e.type==="user/message"&&e.data?.source?.kind==="user";
const userEvidence=(events:readonly ResumeEvent[])=>{const e=[...events].reverse().find(genuineUser);return e?{seq:e.seq,digest:hash(e.data)}:undefined;};
const historyEvidence=(events:readonly ResumeEvent[],endSeq:number)=>hash(events.filter(e=>e.seq<=endSeq&&e.type!=="hub/quota-resume"));

/** Only a provider's explicit subscription quota code can create a checkpoint.
 * HTTP 429, auth, network, API credits and prose mentioning limits are not enough. */
export function quotaReset(reason:any,route:ResumeRoute):{resetsAt?:number}|undefined{
  if(!subscriptionRoute(route)||!["error","blocked"].includes(reason?.kind))return;
  const error=reason.error??reason.failure??reason;
  const quota=error.subscriptionLimit??error.details?.subscriptionLimit??error.metadata?.subscriptionLimit;
  if(error.code==="subscription-limit"){
    if(quota&&!(quota.kind==="subscription-quota"&&quota.provider===route.provider&&quota.model===route.model))return;
    // Native LlmFailure serialization preserves code/message but may discard
    // adapter extension fields. Recover absolute reset only from public usage.
    return validTime(quota?.resetsAt)?{resetsAt:quota.resetsAt}:{};
  }
  if(route.provider==="openai-codex"&&error.code==="QUOTA"&&/^You have hit your ChatGPT usage limit\b/i.test(error.message??""))return {};
  // Codex OAuth reports usage_limit_reached; do not accept insufficient_quota (API billing).
  if(route.provider==="openai-codex"&&["usage_limit_reached","codex_usage_limit_reached"].includes(error.code)){
    const at=error.resetsAt??error.details?.resetsAt;
    const seconds=error.resets_at??error.details?.resets_at;
    return validTime(at)?{resetsAt:at}:validTime(seconds)&&validTime(seconds*1000)?{resetsAt:seconds*1000}:{};
  }
}

/** Every call must have one durable successful result. Error/unknown results
 * may hide a consequential side effect, so automatic continuation fails closed. */
export function toolCheckpoint(events:readonly ResumeEvent[]):{safe:boolean;completed:string[]}{
  const calls=new Set<string>(),results=new Map<string,boolean>();let safe=true;
  for(const e of events){
    if(e.type==="tool/call"){
      if(typeof e.data?.callId!=="string"||calls.has(e.data.callId))safe=false;
      else calls.add(e.data.callId);
    }
    if(e.type==="tool/result"){
      const blocks=e.data?.message?.content;
      if(!Array.isArray(blocks)){safe=false;continue;}
      for(const result of blocks){if(result?.type!=="tool-result")continue;
        if(typeof result.toolCallId!=="string"||results.has(result.toolCallId))safe=false;
        else results.set(result.toolCallId,result.isError!==true&&Array.isArray(result.content));
      }
    }
  }
  for(const id of calls)if(results.get(id)!==true)safe=false;
  for(const id of results.keys())if(!calls.has(id))safe=false;
  return {safe,completed:[...calls].filter(id=>results.get(id)===true).sort()};
}

/** Serialized, durable, session-scoped optimistic revisions. No tool exposes
 * preference mutation. A crash after dispatching is never automatically retried. */
export class ChatQuotaResume {
  private records=new Map<string,ResumeRecord>();private serial:Promise<unknown>=Promise.resolve();private unavailable=false;
  readonly ready:Promise<void>;
  constructor(readonly file:string,readonly port:ResumePort,readonly now=()=>Date.now()){
    this.ready=this.load();void this.ready.catch(()=>{});
  }
  private async load(){
    let saved:any;try{saved=JSON.parse(await readFile(this.file,"utf8"));}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return;throw e;}
    if(saved?.version!==1||!Array.isArray(saved.records))throw Error("Invalid quota resume store");
    for(const r of saved.records){
      if(!r||typeof r.sessionId!=="string"||!Number.isSafeInteger(r.revision)||r.revision<0||typeof r.enabled!=="boolean")throw Error("Invalid quota resume record");
      if(r.checkpoint){const c=r.checkpoint;
        if(!Number.isSafeInteger(c.endSeq)||!Number.isSafeInteger(c.failedTurn)||typeof c.requestId!=="string"||!c.route||!subscriptionRoute(c.route)||typeof c.authority!=="string"||!c.lastUser||typeof c.historyDigest!=="string"||!Array.isArray(c.completedToolIds)||!Number.isSafeInteger(c.attempts)||!Number.isSafeInteger(c.usageChecks)||!Number.isFinite(c.nextUsageCheck)||!["waiting","waiting-unknown","dispatching","consumed","cancelled","needs-review"].includes(c.state)||c.resetsAt!==undefined&&!validTime(c.resetsAt)||c.availableAt!==undefined&&!validTime(c.availableAt)||!Number.isSafeInteger(c.lastUser.seq)||typeof c.lastUser.digest!=="string"||!c.completedToolIds.every((id:unknown)=>typeof id==="string")||c.attempts<0||c.attempts>1||c.usageChecks<0||c.usageChecks>288)throw Error("Invalid quota checkpoint");
        if(c.state==="dispatching"){c.state="needs-review";c.reason="uncertain-dispatch";r.revision++;}
      }
      if(this.records.has(r.sessionId))throw Error("Duplicate quota resume record");this.records.set(r.sessionId,r);
    }
    await this.save();
  }
  private async save(){try{await mkdir(dirname(this.file),{recursive:true});const temp=this.file+"."+randomUUID()+".tmp";await writeFile(temp,JSON.stringify({version:1,records:[...this.records.values()]}),{mode:0o600});await rename(temp,this.file);}catch(e){this.unavailable=true;throw e;}}
  private run<T>(fn:()=>Promise<T>):Promise<T>{const next=this.serial.then(async()=>{await this.ready;if(this.unavailable)throw Error("Quota resume persistence unavailable");return fn();});this.serial=next.catch(()=>{});return next;}
  private record(id:string){return this.records.get(id)??{sessionId:id,revision:0,enabled:false};}
  read(id:string){return this.run(async()=>structuredClone(this.record(id)));}
  private async transition(record:ResumeRecord,state:ResumeState,reason?:ResumeReason){
    const c=record.checkpoint!;c.state=state;c.reason=reason;record.revision++;this.records.set(record.sessionId,record);await this.save();
    await this.port.publish?.(record.sessionId,{state,endSeq:c.endSeq,provider:c.route.provider,model:c.route.model,...(c.resetsAt?{resetsAt:c.resetsAt}:{}),...(reason?{reason}:{})});
  }
  setEnabled(id:string,revision:number,enabled:boolean){return this.run(async()=>{
    const r=this.record(id);if(r.revision!==revision)throw Object.assign(Error("Settings changed; reload and try again."),{code:"revision-conflict"});
    if(r.enabled===enabled)return structuredClone(r);
    r.enabled=enabled;r.revision++;this.records.set(id,r);
    if(!enabled&&r.checkpoint&&["waiting","waiting-unknown","dispatching","consumed"].includes(r.checkpoint.state))await this.transition(r,"cancelled","disabled");else await this.save();
    return structuredClone(r);
  });}
  invalidate(id:string,reason:ResumeReason){return this.run(async()=>{const r=this.records.get(id);if(r?.checkpoint&&(waiting(r.checkpoint)||r.checkpoint.state==="dispatching"||r.checkpoint.state==="consumed"))await this.transition(r,"cancelled",reason);});}
  cancelPending(id:string,revision:number){return this.run(async()=>{
    const r=this.record(id);if(r.revision!==revision)throw Object.assign(Error("Settings changed; reload and try again."),{code:"revision-conflict"});
    if(r.checkpoint&&(waiting(r.checkpoint)||r.checkpoint.state==="dispatching"||r.checkpoint.state==="consumed"))await this.transition(r,"cancelled","manual-stop");
    return structuredClone(r);
  });}
  observeEnd(id:string,endSeq:number){return this.run(async()=>{
    const r=this.records.get(id);if(!r?.enabled)return;
    const s=await this.port.inspect(id);if(!s||!s.eligible||s.archived)return;
    const end=s.events.find(e=>e.seq===endSeq&&e.type==="turn/end");if(!end)return;
    let reset=quotaReset(end.data?.reason,s.route);
    const failure=end.data?.reason?.error??end.data?.reason?.failure;
    // pi-ai currently erases the structured Codex HTTP error. Its friendly
    // usage-limit string alone also covers generic 429s: require independent
    // fresh, exhausted subscription-window evidence before arming that case.
    let usage;
    if(!reset&&s.route.provider==="openai-codex"&&failure?.code==="PI_AI_ERROR"&&/^You have hit your ChatGPT usage limit(?: \([^\n]{1,40} plan\))?\.(?: Try again in ~\d+ min\.)?$/.test(failure.message??"")){
      try{usage=await this.port.usage(s.route);}catch{return;}
      if(usage?.blocked===true)reset={};
    }
    if(!reset)return;
    if(!reset.resetsAt){try{usage??=await this.port.usage(s.route);}catch{}if(validTime(usage?.resetsAt))reset={resetsAt:usage.resetsAt};}
    if(r.checkpoint?.endSeq===endSeq)return;
    const lastUser=userEvidence(s.events);if(!lastUser)return;
    // One dispatch per quota episode. A controller-generated continuation is
    // not fresh user intent and cannot arm another attempt.
    const last=s.events.find(e=>e.seq===lastUser.seq);
    if(last?.data?.source?.rpcId?.startsWith("hub-quota-resume-"))return;
    const start=[...s.events].reverse().find(e=>e.type==="turn/start"&&e.seq<endSeq);
    if(!start||!Number.isSafeInteger(end.data?.turn)||lastUser.seq<start.seq)return;
    const tools=toolCheckpoint(s.events.filter(e=>e.seq>start.seq&&e.seq<endSeq));
    r.checkpoint={endSeq,failedTurn:end.data.turn,route:structuredClone(s.route),authority:s.authority,...(s.toolAuthority?{toolAuthority:s.toolAuthority}:{}),lastUser,historyDigest:historyEvidence(s.events,endSeq),completedToolIds:tools.completed,...reset,
      requestId:"hub-quota-resume-"+hash([id,endSeq,s.route,lastUser]).slice(0,32),state:"waiting-unknown",attempts:0,usageChecks:0,nextUsageCheck:this.now()+300000};
    await this.transition(r,tools.safe?(reset.resetsAt?"waiting":"waiting-unknown"):"needs-review",tools.safe?undefined:"unsafe-tools");
  });}
  private mismatch(s:ResumeInspection|undefined,c:ResumeCheckpoint):ResumeReason|undefined{
    if(!s||!s.eligible)return "unavailable";
    if(s.archived)return "archived";
    if(s.active)return "active-session";
    if(routeKey(s.route)!==routeKey(c.route))return "route-changed";
    if(s.authority!==c.authority)return "authority-changed";
    if(hash(userEvidence(s.events))!==hash(c.lastUser))return "new-user-message";
    if(historyEvidence(s.events,c.endSeq)!==c.historyDigest||s.events.some(e=>e.seq>c.endSeq&&["turn/start","turn/end","model/selection","session/archive","session/archived"].includes(e.type)))return "history-changed";
  }
  tick(){return this.run(async()=>{
    for(const r of this.records.values()){
      const c=r.checkpoint;if(!r.enabled||!c||!waiting(c))continue;
      let s:ResumeInspection|undefined;try{s=await this.port.inspect(r.sessionId);}catch{await this.transition(r,"needs-review","unavailable");continue;}
      const mismatch=this.mismatch(s,c);if(mismatch){await this.transition(r,"cancelled",mismatch);continue;}
      if(!c.resetsAt&&!c.availableAt){
        // Metadata-only refresh. Bounded lifetime and cadence, never a model call.
        if(c.usageChecks>=288||this.now()<c.nextUsageCheck)continue;
        c.usageChecks++;c.nextUsageCheck=this.now()+300000;await this.save();
        let usage;try{usage=await this.port.usage(c.route);}catch{continue;}
        if(validTime(usage?.resetsAt)){c.resetsAt=usage.resetsAt;await this.transition(r,"waiting");}
        else if(usage?.available===true){c.availableAt=this.now();await this.transition(r,"waiting");}
        continue;
      }
      if(this.now()<(c.resetsAt??c.availableAt!))continue;
      if(c.attempts!==0){await this.transition(r,"needs-review","attempt-exhausted");continue;}
      c.attempts=1;await this.transition(r,"dispatching");
      // Recheck after persistence (an actual user/selection may have arrived).
      const current=await this.port.inspect(r.sessionId),changed=this.mismatch(current,c);
      if(changed){await this.transition(r,"cancelled",changed);continue;}
      try{
        const result=await this.port.prompt({requestId:c.requestId,sessionId:r.sessionId,mode:"queue",content:[{type:"text",text:`[HUB subscription continuation at recorded turn ${c.failedTurn}, end sequence ${c.endSeq}. Continue unfinished work from recorded history; this is not a new user request. Do not repeat completed tools or external actions. Completed tool call IDs: ${c.completedToolIds.join(", ")||"none"}.]`}]});
        if(result?.accepted!==true)await this.transition(r,"needs-review","uncertain-dispatch");else await this.transition(r,"consumed");
      }catch{await this.transition(r,"needs-review","uncertain-dispatch");}
    }
  });}
  /** Used synchronously at the native system-prompt assembly boundary. This
   * blocks a queued resume if a genuine user/route/authority change raced it. */
  assertToolAuthority(sessionId:string,requestId:string,tools:unknown){
    const c=this.records.get(sessionId)?.checkpoint;
    if(!c||c.requestId!==requestId||!c.toolAuthority||c.toolAuthority!==hash(tools))throw Error("Subscription continuation tool authority changed; user review required.");
  }
  assertRequestRoute(sessionId:string,requestId:string,route:ResumeRoute){
    const r=this.records.get(sessionId),c=r?.checkpoint;
    if(this.unavailable||!r?.enabled||!c||c.requestId!==requestId||!["dispatching","consumed"].includes(c.state)||routeKey(route)!==routeKey(c.route))throw Error("Subscription continuation route changed; no model request was sent.");
  }
  assertContinuation(s:ResumeInspection,requestId:string){
    const r=this.records.get(s.sessionId),c=r?.checkpoint;
    if(this.unavailable||!r?.enabled||!c||c.requestId!==requestId||!["dispatching","consumed"].includes(c.state)||s.archived||!s.eligible||s.authority!==c.authority||routeKey(s.route)!==routeKey(c.route))throw Error("Subscription continuation cancelled; user review required.");
    const later=s.events.filter(e=>e.seq>c.endSeq&&genuineUser(e));
    if(later.length!==1||later[0]?.data?.source?.rpcId!==requestId||historyEvidence(s.events,c.endSeq)!==c.historyDigest||s.events.some(e=>e.seq>c.endSeq&&["model/selection","session/archive","session/archived"].includes(e.type)))throw Error("Subscription continuation history changed; user review required.");
  }
}

export function publicResumeRecord(record:ResumeRecord,eligible:boolean){const c=record.checkpoint;return {sessionId:record.sessionId,revision:record.revision,enabled:record.enabled,eligible,state:c?.state??"idle",...(c?{endSeq:c.endSeq,provider:c.route.provider,model:c.route.model,...(c.resetsAt?{resetsAt:c.resetsAt}:{}),...(c.reason?{reason:c.reason}:{})}:{})};}

/** Reads public provider-owned usage only, never credentials or a probe prompt. */
export async function readSubscriptionReset(ctx:any,route:ResumeRoute):Promise<{resetsAt?:number;available?:boolean;blocked?:boolean}|undefined>{
  if(route.provider==="claude-code"){
    const usage=await readClaudeCodeUsage();if(usage.state!=="ready")return;
    const blocked=usage.windows.filter(w=>w.status==="rejected");
    if(blocked.length&&blocked.every(w=>typeof w.resetsAt==="number"&&validTime(w.resetsAt*1000)))return {resetsAt:Math.max(...blocked.map(w=>w.resetsAt!*1000))};return {};
  }
  if(route.provider!=="openai-codex"||!Number.isSafeInteger(ctx.webServer?.port))return;
  const response=await (ctx.fetch??fetch)(`http://127.0.0.1:${ctx.webServer.port}/plugins/dsh-openai-codex/auth/status`,{headers:{accept:"application/json","cache-control":"no-store"},redirect:"error",signal:AbortSignal.timeout(10000)});
  if(!response.ok)return;const status=await response.json();if(status?.status!=="signed-in")return;
  // Provider-owned parser omits reset timestamps. Fresh availability evidence
  // is usable; a window duration is never treated as time until reset.
  if(status.quotaError||!Array.isArray(status.usage?.rateLimits))return;
  const limits=status.usage.rateLimits;
  if(!limits.some((l:any)=>l.id==="codex"))return;
  const windows=limits.flatMap((l:any)=>Array.isArray(l.windows)?l.windows:[]);
  if(!windows.length||windows.some((w:any)=>typeof w.remainingPercent!=="number"||!Number.isFinite(w.remainingPercent)||w.remainingPercent<0||w.remainingPercent>100))return;
  const individual=status.usage.individualLimit;
  if(individual&&(typeof individual.remainingPercent!=="number"||!Number.isFinite(individual.remainingPercent)))return;
  const blocked=windows.some((w:any)=>w.remainingPercent===0)||individual?.remainingPercent===0;
  return {blocked,available:!blocked&&windows.every((w:any)=>w.remainingPercent>0)&&(!individual||individual.remainingPercent>0)};
}

export function installChatQuotaResume(ctx:any,characters:any):()=>void{
  const root=join(process.env.DSH_HOME??join(homedir(),".dsh"),"hub-chat-resume","state.json");
  let disposed=false;const attached=new Map<string,()=>void>(),toolAuthorities=new Map<string,string>();
  const inspection=(agent:any):ResumeInspection|undefined=>{
    const id=agent?.id;if(typeof id!=="string")return;
    const events=agent.session.snapshotEvents(),c=characters.effectiveCharacter(id),selected=characters.store.selected(id,characters.store.snapshot());
    const config=agent.session.requestHeader?.()?.config;
    const route:ResumeRoute|undefined=typeof config?.provider==="string"&&typeof config?.model==="string"?{provider:config.provider,model:config.model,...(typeof config.reasoningEffort==="string"?{reasoningEffort:config.reasoningEffort}:{})}:selected?.route;
    if(!route)return;
    const header=agent.session.header;
    const eligible=header.origin!=="subagent"&&!header.parentSession&&characters.pickerAllowed(id)&&subscriptionRoute(route);
    const registry=ctx.get?.("workspaceRegistry")??ctx.workspaceRegistry;
    // Archival lives in the workspace registry, not in the session journal.
    // Missing archive authority is not evidence that a chat is unarchived.
    const archived=registry?.archivedSessionIds===undefined||[...registry.archivedSessionIds].includes(id)||header.archived===true;
    return {sessionId:id,route,toolAuthority:toolAuthorities.get(id),authority:hash({character:selected,admitted:c,agentPreset:header.agentPreset,toolPolicy:agent.session.requestHeader?.()?.config?.tools}),eligible,archived,active:agent.status!=="idle"||!!agent.inbox?.nextTurn?.length||!!agent.inbox?.nextStep?.length,events};
  };
  const inspect=async(id:string)=>{await characters.ready;const found=await ctx.sessionController.resolveAgent(id);return "error"in found?undefined:inspection(found.agent);};
  const engine=new ChatQuotaResume(root,{inspect,prompt:r=>ctx.sessionController.prompt(r),usage:r=>readSubscriptionReset(ctx,r),publish:async(id,data)=>{
    const a=ctx.agents.get(id);if(a)await a.session.append("hub/quota-resume",data);
  }});
  const attach=(agent:any)=>{
    if(attached.has(agent.id)||agent.session.header.origin==="subagent")return;
    const off=agent.ctx.on("system-prompt/assemble",async(_assembly:any,_context:any,next:()=>Promise<any>)=>{
      const s=inspection(agent),last=s?[...s.events].reverse().find(genuineUser):undefined,id=last?.data?.source?.rpcId;
      if(typeof id!=="string"||!id.startsWith("hub-quota-resume-"))return next();
      if(disposed||!s)throw Error("Subscription continuation unavailable.");
      engine.assertContinuation(s,id);return next();
    },{prepend:true});
    const offGuide=agent.ctx.systemPrompt.section({name:"hub:quota-resume",order:998,text:()=>{
      const last=agent.session.snapshotEvents().findLast(genuineUser);return last?.data?.source?.rpcId?.startsWith("hub-quota-resume-")?QUOTA_RESUME_INSTRUCTION:"";
    }});
    const offRequest=agent.ctx.on("agent/request",async({agent:subject}:any,next:()=>Promise<any>)=>{
      const config=await next();if(subject.id!==agent.id)return config;
      const last=[...agent.session.snapshotEvents()].reverse().find(genuineUser),id=last?.data?.source?.rpcId;
      if(typeof id==="string"&&id.startsWith("hub-quota-resume-")){
        try{engine.assertRequestRoute(agent.id,id,config);}catch(e){void engine.invalidate(agent.id,"route-changed").catch(()=>{});throw e;}
      }
      return config;
    },{prepend:true});
    attached.set(agent.id,()=>{off?.();offGuide?.();offRequest?.();});
  };
  for(const agent of ctx.agents.list())attach(agent);
  const offCreated=ctx.on("agent/created",({agent}:any)=>attach(agent),{global:true});
  const offEvents=ctx.on("session/event",(session:any,event:ResumeEvent)=>{
    if(disposed)return;const id=session.header.id;
    if(event.type==="user/message"&&genuineUser(event)&&!event.data?.source?.rpcId?.startsWith("hub-quota-resume-"))void engine.invalidate(id,"new-user-message").catch(()=>{});
    else if(event.type==="model/selection")void engine.invalidate(id,"route-changed").catch(()=>{});
    else if(["session/archive","session/archived"].includes(event.type))void engine.invalidate(id,"archived").catch(()=>{});
    else if(event.type==="turn/end"){
      if(["aborted","interrupted"].includes(event.data?.reason?.kind))void engine.invalidate(id,"manual-stop").catch(()=>{});
      else void engine.observeEnd(id,event.seq).catch(()=>{});
    }
  },{global:true});
  const offStream=ctx.on("llm/stream",(options:any,next:()=>unknown)=>{
    const agent=options.sessionId&&ctx.agents.get(options.sessionId);
    if(agent&&!options.purpose){
      const last=[...agent.session.snapshotEvents()].reverse().find(genuineUser),id=last?.data?.source?.rpcId;
      if(typeof id==="string"&&id.startsWith("hub-quota-resume-")){
        const current=inspection(agent);if(!current)throw Error("Subscription continuation unavailable.");
        try{engine.assertContinuation(current,id);engine.assertRequestRoute(agent.id,id,options);engine.assertToolAuthority(agent.id,id,options.tools??[]);}
        catch(e){void engine.invalidate(agent.id,"authority-changed").catch(()=>{});throw e;}
      }
      toolAuthorities.set(agent.id,hash(options.tools??[]));
    }
    return next();
  },{global:true,prepend:true});
  const timer=setInterval(()=>{if(!disposed)void engine.tick().catch(()=>{});},15000);timer.unref?.();
  const offWeb=ctx.webServer.register({kind:"exact",path:CHAT_QUOTA_RESUME_PATH,handler:async(req:IncomingMessage,res:ServerResponse)=>{
    const send=(code:number,value:unknown)=>{res.writeHead(code,{"content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff"});res.end(JSON.stringify(value));};
    const rejected=ctx.connection.requestRejection(req);
    let crossOrigin=false;try{if(req.headers.origin)crossOrigin=new URL(req.headers.origin).host!==req.headers.host;}catch{crossOrigin=true;}
    if(rejected||req.headers["sec-fetch-site"]==="cross-site"||crossOrigin){send(rejected??403,{error:"unauthorized"});return;}
    if(req.headers["x-hub-chat-resume"]!=="1"){send(403,{error:"forbidden"});return;}
    if(!["GET","POST"].includes(req.method??"")){send(405,{error:"method-not-allowed"});return;}
    try{
      let body:any;let id:string|null;
      if(req.method==="POST"){
        let text="";for await(const chunk of req){text+=String(chunk);if(Buffer.byteLength(text)>4096){send(413,{error:"too-large"});return;}}
        try{body=JSON.parse(text);}catch{send(400,{error:"invalid-json"});return;}
        const cancel=body?.action==="cancel"&&body.enabled===undefined;
        if(!body||Object.keys(body).some(k=>!["sessionId","revision","enabled","action"].includes(k))||(!cancel&&(typeof body.enabled!=="boolean"||body.action!==undefined))||!Number.isSafeInteger(body.revision)||body.revision<0){send(400,{error:"invalid-command"});return;}id=body.sessionId;
      }else id=new URL(req.url??"/","http://127.0.0.1").searchParams.get("sessionId");
      if(typeof id!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)){send(400,{error:"invalid-session"});return;}
      const s=await inspect(id);if(!s){send(404,{error:"session-unavailable"});return;}
      if(req.method==="POST"&&body.enabled&&(!s.eligible||s.archived)){send(409,{error:"subscription-chat-required"});return;}
      const record=req.method==="POST"?(body.action==="cancel"?await engine.cancelPending(id,body.revision):await engine.setEnabled(id,body.revision,body.enabled)):await engine.read(id);
      send(200,publicResumeRecord(record,s.eligible&&!s.archived));
    }catch(e){send((e as any)?.code==="revision-conflict"?409:503,{error:(e as any)?.code==="revision-conflict"?"revision-conflict":"resume-unavailable"});}
  }});
  return ()=>{disposed=true;clearInterval(timer);offWeb();offCreated?.();offEvents?.();offStream?.();for(const off of attached.values())off();attached.clear();toolAuthorities.clear();};
}
