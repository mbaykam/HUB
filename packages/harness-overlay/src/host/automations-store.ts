import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {atomicJson,digest} from "./knowledge-store.ts";
import {isQuotaFailure} from "./operation-failure.ts";
import type {AutomationInput,AutomationTrigger,HubAutomation,AutomationRun} from "../automation-contract.ts";
import type {ProviderGate} from "./provider-gate.ts";
interface State {revision:number;automations:HubAutomation[];blocked:Record<string,string>}
export interface AutomationPorts {now():number;route(characterId:string):Promise<string>;read(url:string,signal:AbortSignal):Promise<string>;run(job:HubAutomation,run:AutomationRun,signal:AbortSignal):Promise<string>}
/** HUB-owned durable service, independent of whether any chat is open. Every
 * dispatch has a receipt before native execution. Uncertain runs never replay. */
export class AutomationsStore {
  private state:State={revision:0,automations:[],blocked:{}};
  private committed:State=structuredClone(this.state);
  private writes:Promise<unknown>=Promise.resolve();private working?:Promise<void>;
  private active?:{id:string;abort:AbortController};readonly lifetime=new AbortController();
  constructor(readonly root:string,readonly ports:AutomationPorts,readonly gate?:ProviderGate){}
  private exclusive<T>(fn:()=>Promise<T>){const p=this.writes.then(fn,fn);this.writes=p.catch(()=>{});return p;}
  private async save(){this.state.revision++;const next=structuredClone(this.state);await atomicJson(join(this.root,"automations.json"),next);this.committed=next;}
  async initialize(){
    try{this.state=JSON.parse(await readFile(join(this.root,"automations.json"),"utf8"));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    let changed=false;for(const job of this.state.automations){validateAutomation(job);if(["checking","running"].includes(job.status)&&!job.runs.some(r=>r.status==="running")){job.status="scheduled";changed=true;}for(const run of job.runs)if(run.status==="running"){run.status="interrupted";run.error="Host stopped during execution. Inspect the recorded task before retrying; external effects may already have happened.";run.finishedAt=this.ports.now();job.status="failed";job.lastError=run.error;job.state="paused";changed=true;}}
    if(changed)await this.save();else this.committed=structuredClone(this.state);
  }
  snapshot(){return structuredClone({revision:this.committed.revision,automations:this.committed.automations,hostRunsOnlyWhileOnline:true as const,blockedRoutes:Object.entries(this.committed.blocked).map(([route,message])=>({route,message}))});}
  async change(command:any){return this.exclusive(async()=>{
    if(command.revision!==this.state.revision)throw Error("Automations changed; refresh before editing");
    const now=this.ports.now(),job=this.state.automations.find(j=>j.id===command.id);
    if(command.action==="save"){
      const input=validateAutomation(command.automation);await this.ports.route(input.characterId);
      if(job?.status==="running"||job?.status==="checking")throw Error("Pause this task before changing it");
      if(!job&&this.state.automations.length>=200)throw Error("Automation limit reached; cancel and reuse a task");
      const next:HubAutomation={...input,id:job?.id??randomUUID(),revision:(job?.revision??0)+1,state:"active",status:"scheduled",createdAt:job?.createdAt??now,updatedAt:now,nextAt:nextOccurrence(input.trigger,now),runs:job?.runs??[]};
      if(job)this.state.automations[this.state.automations.indexOf(job)]=next;else this.state.automations.push(next);
    }else if(command.action==="resume-credit"){
      if(!job)throw Error("Task missing");const route=await this.ports.route(job.characterId);delete this.state.blocked[route];
      await this.gate?.clear(route.split("/")[0]!);
      for(const j of this.state.automations)if(j.state==="active"&&j.status==="waiting-credit"&&await this.ports.route(j.characterId)===route){j.status="scheduled";j.lastError=undefined;}
    }else{
      if(!job)throw Error("Task missing");
      if(command.action==="pause"||command.action==="cancel"){if(this.active?.id===job.id)this.active.abort.abort();job.state=command.action==="pause"?"paused":"cancelled";job.status=job.state;}
      else if(command.action==="resume"){if(job.state==="cancelled")throw Error("Edit a cancelled task to reactivate it");job.state="active";job.status="scheduled";job.nextAt=nextOccurrence(job.trigger,now);}
      else if(command.action==="run-once"){if(job.status==="running"||job.status==="checking")throw Error("Already running");if(job.state==="cancelled")throw Error("Cancelled task");job.state="active";job.status="scheduled";job.pendingEvent="Manual test requested by the user";job.nextAt=now;}
      else throw Error("Unknown automation command");job.revision++;job.updatedAt=now;
    }
    await this.save();return this.snapshot();
  });}
  async event(type:string,data:unknown){return this.exclusive(async()=>{
    let changed=false;for(const job of this.state.automations)if(job.state==="active"&&job.trigger.kind==="event"&&job.trigger.event===type&&conditionMatches(job.trigger,data)){
      job.pendingEvent=JSON.stringify({event:type,data}).slice(0,8000);job.nextAt=this.ports.now();changed=true;
    }if(changed)await this.save();
  });}
  tick(){if(this.working||this.lifetime.signal.aborted)return this.working;this.working=this.runDue().finally(()=>this.working=undefined);return this.working;}
  private async runDue(){
    let selected:HubAutomation|undefined,run:AutomationRun|undefined;
    const now=this.ports.now();
    await this.exclusive(async()=>{
      const candidates=this.state.automations.filter(j=>j.state==="active"&&j.nextAt!==undefined&&j.nextAt<=now&&!['running','checking'].includes(j.status)).sort((a,b)=>a.nextAt!-b.nextAt!);
      let due:HubAutomation|undefined,changed=false;
      for(const candidate of candidates){
        let route:string;try{route=await this.ports.route(candidate.characterId);}catch(e){candidate.status="failed";candidate.state="paused";candidate.lastError=String((e as Error).message);changed=true;continue;}
        const blocked=this.state.blocked[route]??await this.gate?.reason(route.split("/")[0]!);if(blocked){if(candidate.status!=="waiting-credit"){candidate.status="waiting-credit";candidate.lastError=blocked;changed=true;}continue;}
        due=candidate;break;
      }
      if(changed)await this.save();if(!due)return;
      if(!due.pendingEvent&&due.missed==="skip"&&now-due.nextAt!>60000){due.nextAt=nextOccurrence(due.trigger,now);due.status="delayed";if(due.trigger.kind==="once"){due.state="completed";due.status="completed";due.lastError="Missed while host was offline; skipped by your policy.";}await this.save();return;}
      due.status=due.trigger.kind==="watch"&&!due.pendingEvent?"checking":"running";selected=structuredClone(due);await this.save();
    });
    if(!selected)return;
    const job=selected,abort=new AbortController();this.active={id:job.id,abort};const signal=AbortSignal.any([this.lifetime.signal,abort.signal,AbortSignal.timeout(150000)]);
    try{
      let watchValue:string|undefined,watchMatch:boolean|undefined,fire=true;
      if(job.trigger.kind==="watch"&&!job.pendingEvent){
        const body=await this.ports.read(job.trigger.url,signal),value=watchValue=watchContent(body,job.trigger.jsonPath);
        watchMatch=job.trigger.rule==="changed"?true:conditionValue(job.trigger.rule,value,job.trigger.value??"");
        fire=job.lastValue===undefined?!!job.trigger.fireOnFirst&&watchMatch:job.trigger.rule==="changed"?job.lastValue!==digest(value):watchMatch&&job.lastMatch!==true;
        job.pendingEvent=fire?`Observed public source: ${job.trigger.url}\n${value.slice(0,16000)}`:undefined;
      }
      await this.exclusive(async()=>{
        const current=this.state.automations.find(j=>j.id===job.id)!;if(current.state!=="active"||signal.aborted)return;
        if(watchValue!==undefined){current.lastValue=digest(watchValue);current.lastMatch=watchMatch;current.lastCheckAt=now;}
        if(!fire){current.nextAt=nextOccurrence(job.trigger,now);current.status="scheduled";await this.save();return;}
        const estimate=job.maxSteps*((Buffer.byteLength(job.prompt+(job.pendingEvent??""))+32000)*job.inputPrice+job.maxOutputTokens*job.outputPrice)/1e6;
        const today=new Date(now).toISOString().slice(0,10),runs=current.runs.filter(r=>new Date(r.at).toISOString().slice(0,10)===today);
        if(runs.length>=job.dailyMaxRuns||runs.reduce((s,r)=>s+r.estimatedCost,0)+estimate>job.dailyBudget){current.status="budget-paused";current.lastError="Daily task budget/run limit reached; original task retained.";current.nextAt=Date.parse(today+"T00:00:00Z")+86400000;await this.save();return;}
        const id=randomUUID();run={id,at:now,dueAt:current.nextAt??now,sessionId:`hub-automation-${current.id}-${id}`,route:await this.ports.route(current.characterId),status:"running",estimatedCost:estimate};current.runs.push(run);current.status="running";current.pendingEvent=undefined;await this.save();
      });
      if(!run)return;
      let result:string|undefined,error:any;try{result=await this.ports.run(job,run,signal);}catch(e){error=e;}
      await this.exclusive(async()=>{
        const current=this.state.automations.find(j=>j.id===job.id)!,requestedState=current.state,receipt=current.runs.find(r=>r.id===run!.id)!;
        receipt.finishedAt=this.ports.now();
        if(error){receipt.code=String(error.code??"AUTOMATION_FAILED").slice(0,80);receipt.error=String(error.message??"Task failed").slice(0,1500);receipt.status=isQuotaFailure(error)?"waiting-credit":"failed";current.lastError=receipt.error;
          if(receipt.status==="waiting-credit"){this.state.blocked[receipt.route!]=receipt.error;await this.gate?.block(receipt.route!.split("/")[0]!,receipt.error);current.status="waiting-credit";current.pendingEvent=job.pendingEvent;if(current.allowWrites){current.state="paused";current.lastError+=" Inspect prior external actions before manually resuming.";}}
          else{current.status="failed";current.state=current.state==="cancelled"?"cancelled":"paused";}
        }else{receipt.status="completed";receipt.result=result?.slice(0,64000);current.lastError=undefined;if(current.state==="active"){current.nextAt=current.trigger.kind==="once"?undefined:nextOccurrence(current.trigger,now);if(current.trigger.kind==="once"){current.state="completed";current.status="completed";}else current.status="scheduled";}}
        if(requestedState==="paused"||requestedState==="cancelled")current.status=requestedState;
        await this.save();
      });
    }catch(error){await this.exclusive(async()=>{const current=this.state.automations.find(j=>j.id===job.id)!;if(current.state==="active"){current.status="failed";current.state="paused";current.lastError=String((error as Error).message).slice(0,1500);}await this.save();});}
    finally{this.active=undefined;}
  }
  async dispose(){this.lifetime.abort();await this.working;await this.writes;}
}
export function validateAutomation(value:any):AutomationInput {
  if(!value||typeof value.title!=="string"||!value.title.trim()||value.title.length>160||typeof value.prompt!=="string"||!value.prompt.trim()||value.prompt.length>12000||typeof value.characterId!=="string"||value.characterId.length>100)throw Error("Task needs a title, purpose and configured character");
  if(!["skip","catch-up"].includes(value.missed)||typeof value.allowWrites!=="boolean"||!Array.isArray(value.tools)||value.tools.length>50||value.tools.some((n:any)=>typeof n!=="string"||!n||n.length>160))throw Error("Invalid task permissions");
  const readOnly=new Set(["web_search","web_fetch","camofox_search","camofox_open","camofox_snapshot","camofox_close","hub_knowledge_search","hub_knowledge_read"]);
  if(!value.allowWrites&&value.tools.some((n:string)=>!readOnly.has(n)))throw Error("Additional tools require explicit external-action permission");
  for(const [key,min,max]of [["maxOutputTokens",256,8192],["maxSteps",1,6],["dailyMaxRuns",1,48]] as const)if(!Number.isInteger(value[key])||value[key]<min||value[key]>max)throw Error("Invalid task limit: "+key);
  for(const key of ["dailyBudget","inputPrice","outputPrice"])if(!Number.isFinite(value[key])||value[key]<=0||value[key]>100)throw Error("Invalid usage estimate");
  if(!["pwa","telegram"].includes(value.notification)||value.notification==="telegram"&&!/^minke-im-telegram-[a-f0-9]{32}$/.test(value.sourceSessionId??""))throw Error("Telegram notifications require the originating authorized Telegram chat");
  const t=value.trigger;if(!t||!["once","interval","calendar","watch","event"].includes(t.kind))throw Error("Choose a trigger");
  if(t.kind==="once"&&(!Number.isSafeInteger(t.at)||t.at<=0))throw Error("Invalid execution time");
  if(["interval","watch"].includes(t.kind)&&(!Number.isInteger(t.seconds)||t.seconds<300||t.seconds>31536000))throw Error("Intervals must be at least five minutes");
  if(t.kind==="calendar"){if(!Number.isInteger(t.hour)||t.hour<0||t.hour>23||!Number.isInteger(t.minute)||t.minute<0||t.minute>59||!Array.isArray(t.days)||!t.days.length||t.days.some((d:any)=>!Number.isInteger(d)||d<0||d>6))throw Error("Invalid calendar rule");new Intl.DateTimeFormat("en",{timeZone:t.timezone}).format(0);}
  if(t.kind==="watch"){const url=new URL(t.url);if(url.protocol!=="https:"||url.username||url.password||url.port&&url.port!=="443")throw Error("Watch a public HTTPS source");if(!["changed","contains","not-contains","above","below"].includes(t.rule)||typeof (t.value??"")!=="string"||(t.value??"").length>1000)throw Error("Invalid watch condition");}
  if(t.kind==="event"&&(typeof t.event!=="string"||!/^[a-z][a-z0-9.-]{1,80}$/.test(t.event)||t.operator&&!['equals','contains','above','below'].includes(t.operator)))throw Error("Invalid event condition");
  const comparison=t.kind==="watch"&&t.rule!=="changed"?t.rule:t.kind==="event"?t.operator:undefined;
  if(comparison&&(typeof t.value!=="string"||!t.value.trim()||t.value.length>1000||["above","below"].includes(comparison)&&!Number.isFinite(Number(t.value))))throw Error("Set a nonempty valid comparison value");
  if(t.kind==="event"&&t.operator&&!t.path)throw Error("Choose the event field to compare");
  if(t.jsonPath||t.path)if(typeof (t.jsonPath??t.path)!=="string"||!/^[a-zA-Z0-9_.-]{1,100}$/.test(t.jsonPath??t.path))throw Error("Use a simple JSON field path");
  return structuredClone({title:value.title.trim(),prompt:value.prompt,characterId:value.characterId,trigger:t,missed:value.missed,tools:[...new Set(value.tools)] as string[],allowWrites:value.allowWrites,maxOutputTokens:value.maxOutputTokens,maxSteps:value.maxSteps,dailyMaxRuns:value.dailyMaxRuns,dailyBudget:value.dailyBudget,inputPrice:value.inputPrice,outputPrice:value.outputPrice,notification:value.notification,sourceSessionId:value.sourceSessionId});
}
export function nextOccurrence(trigger:AutomationTrigger,after:number):number|undefined{
  if(trigger.kind==="once")return trigger.at;
  if(trigger.kind==="interval"||trigger.kind==="watch")return after+trigger.seconds*1000;
  if(trigger.kind==="event")return;
  const fmt=new Intl.DateTimeFormat("en-US",{timeZone:trigger.timezone,weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}),days=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  // UTC scan handles nonexistent/repeated local hours without inventing dates.
  for(let at=Math.floor(after/60000)*60000+60000;at<=after+8*86400000;at+=60000){const parts=Object.fromEntries(fmt.formatToParts(at).map(p=>[p.type,p.value]));if(trigger.days.includes(days.indexOf(parts.weekday!))&&Number(parts.hour)===trigger.hour&&Number(parts.minute)===trigger.minute)return at;}
  throw Error("Calendar rule has no next occurrence");
}
function pathValue(value:any,path?:string){for(const key of path?.split(".")??[])value=value?.[key];return value;}
export function conditionValue(operator:string,actual:unknown,expected:string){if(operator==="contains")return String(actual).includes(expected);if(operator==="not-contains")return !String(actual).includes(expected);if(operator==="above"||operator==="below"){const n=Number(actual),v=Number(expected);return Number.isFinite(n)&&Number.isFinite(v)&&(operator==="above"?n>v:n<v);}return String(actual)===expected;}
export function conditionMatches(trigger:Extract<AutomationTrigger,{kind:"event"}>,data:unknown){return !trigger.operator||conditionValue(trigger.operator,pathValue(data,trigger.path),trigger.value??"");}
export function watchContent(text:string,path?:string){if(path){const value=pathValue(JSON.parse(text),path);if(value===undefined)throw Error("Watch field missing");return typeof value==="object"?JSON.stringify(value):String(value);}return text.replace(/<script\b[\s\S]*?<\/script>/gi,"").replace(/<style\b[\s\S]*?<\/style>/gi,"").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();}
