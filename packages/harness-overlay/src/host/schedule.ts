import {defaultAutomation,type AutomationTrigger,type HubAutomation} from "../automation-contract.ts";

/** The simple face of HUB's automation engine, modelled on OpenClaw: a few
 * scheduled jobs (a reminder sent at a time, or a task HUB runs) and one
 * heartbeat that checks a short checklist and stays silent unless something
 * needs the user. Watches, events and goal links stay in the engine; they are
 * listed here read-only. */
export type ScheduleWhen=
  |{kind:"once";at:number}
  |{kind:"every";minutes:number}
  |{kind:"daily";hour:number;minute:number;days:number[];timezone:string}
  |{kind:"other";summary:string};
export interface ScheduleRun {at:number;status:string;text?:string}
export interface ScheduleJob {id:string;name:string;kind:"task"|"reminder";text:string;when:ScheduleWhen;enabled:boolean;state:string;status:string;nextAt?:number;last?:ScheduleRun;error?:string;sessionId?:string}
export interface ScheduleHeartbeat {enabled:boolean;everyMinutes:number;start:string;end:string;timezone:string;checklist:string;nextAt?:number;last?:ScheduleRun;error?:string}
export interface ScheduleView {revision:number;heartbeat:ScheduleHeartbeat;jobs:ScheduleJob[]}
interface Store {snapshot():{revision:number;automations:HubAutomation[]};change(command:any):Promise<{revision:number;automations:HubAutomation[]}>}

const MANAGED=["id","revision","state","status","createdAt","updatedAt","nextAt","lastCheckAt","lastValue","lastMatch","pendingEvent","lastError","runs"];
const hhmm=(m:number)=>String(Math.floor(m/60)).padStart(2,"0")+":"+String(m%60).padStart(2,"0");
function minutes(text:string){
  const m=/^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if(!m||Number(m[1])>23||Number(m[2])>59)throw Error("Times are HH:MM, for example 08:30");
  return Number(m[1])*60+Number(m[2]);
}
function whenOf(t:AutomationTrigger):ScheduleWhen{
  if(t.kind==="once")return {kind:"once",at:t.at};
  if(t.kind==="interval")return {kind:"every",minutes:Math.round(t.seconds/60)};
  if(t.kind==="calendar")return {kind:"daily",hour:t.hour,minute:t.minute,days:t.days,timezone:t.timezone};
  if(t.kind==="watch")return {kind:"other",summary:"When "+t.url+" changes"};
  return {kind:"other",summary:"On "+t.event};
}
export function triggerOf(when:any,timezone:string):AutomationTrigger{
  if(when?.kind==="once"){
    const at=typeof when.at==="string"?Date.parse(when.at):Number(when.at);
    if(!Number.isSafeInteger(at)||at<=0)throw Error("when.at must be an ISO date and time with its UTC offset, for example 2026-11-21T09:00:00+03:00");
    return {kind:"once",at};
  }
  if(when?.kind==="every"){
    const m=Math.round(Number(when.minutes));
    if(!(m>=5&&m<=525600))throw Error("Repeat every 5 minutes or more");
    return {kind:"interval",seconds:m*60};
  }
  if(when?.kind==="daily"){
    const time=typeof when.time==="string"?minutes(when.time):Number(when.hour)*60+Number(when.minute);
    if(!Number.isInteger(time)||time<0||time>=1440)throw Error("Give the time as HH:MM");
    const days=Array.isArray(when.days)&&when.days.length?[...new Set(when.days.map(Number))].sort():[0,1,2,3,4,5,6];
    return {kind:"calendar",hour:Math.floor(time/60),minute:time%60,days:days as number[],timezone:typeof when.timezone==="string"&&when.timezone?when.timezone:timezone};
  }
  throw Error("when.kind is once, every or daily");
}
function last(job:HubAutomation):ScheduleRun|undefined{
  const run=job.runs.at(-1);
  return run?{at:run.finishedAt??run.at,status:run.status,text:(run.result??run.error)?.slice(0,600)}:undefined;
}
function strip(value:any){const copy={...value};for(const key of MANAGED)delete copy[key];return copy;}
const heartbeatOf=(automations:HubAutomation[])=>automations.find(j=>j.kind==="heartbeat"&&j.state!=="cancelled");

export function scheduleView(snapshot:{revision:number;automations:HubAutomation[]},timezone:string,now=Date.now()):ScheduleView{
  const beat=heartbeatOf(snapshot.automations);
  const heartbeat:ScheduleHeartbeat=beat
    ?{enabled:beat.state==="active",everyMinutes:Math.round((beat.trigger as {seconds:number}).seconds/60),start:hhmm(beat.activeHours?.start??480),end:hhmm(beat.activeHours?.end??1380),
      timezone:beat.activeHours?.timezone??timezone,checklist:beat.prompt,nextAt:beat.state==="active"?beat.nextAt:undefined,last:last(beat),error:beat.lastError}
    :{enabled:false,everyMinutes:30,start:"08:00",end:"23:00",timezone,checklist:""};
  const jobs=snapshot.automations
    .filter(j=>j.kind!=="heartbeat"&&j.state!=="cancelled"&&!j.goalId&&!(j.state==="completed"&&now-j.updatedAt>3*86400000))
    .map(j=>({id:j.id,name:j.title,kind:j.kind==="reminder"?"reminder" as const:"task" as const,text:j.prompt,when:whenOf(j.trigger),
      enabled:j.state==="active",state:j.state,status:j.status,nextAt:j.state==="active"?j.nextAt:undefined,last:last(j),error:j.lastError,
      sessionId:j.kind==="reminder"?undefined:j.runs.at(-1)?.sessionId}))
    .sort((a,b)=>(a.nextAt??Number.MAX_SAFE_INTEGER)-(b.nextAt??Number.MAX_SAFE_INTEGER));
  return {revision:snapshot.revision,heartbeat,jobs};
}

/** One simple command against the engine. Store revisions are handled here,
 * so a phone or a chat never has to carry them. */
export async function changeSchedule(store:Store,mainId:string,command:any,options:{timezone:string;sourceSessionId?:string}){
  const state=store.snapshot(),revision=state.revision;
  const find=(id:unknown)=>state.automations.find(j=>j.id===id&&j.kind!=="heartbeat"&&j.state!=="cancelled");
  if(command?.action==="save"){
    const input=command.job??{},kind=input.kind==="reminder"?"reminder":"task";
    const name=String(input.name??"").trim(),text=String(input.text??"").trim();
    if(!name||!text)throw Error(kind==="reminder"?"A reminder needs a name and the text to send":"A job needs a name and what HUB should do");
    const existing=input.id?find(input.id):undefined;
    if(input.id&&!existing)throw Error("That job no longer exists; list the jobs first");
    if(existing&&(existing.status==="running"||existing.status==="checking"))throw Error("This job is running now; try again when it finishes");
    const base=existing??{...defaultAutomation,dailyMaxRuns:24,dailyBudget:.5,maxSteps:4};
    const automation={...strip(base),title:name.slice(0,160),prompt:text.slice(0,12000),characterId:existing?.characterId??mainId,
      trigger:triggerOf(input.when,options.timezone),kind,maxSteps:kind==="reminder"?1:Math.max(base.maxSteps,4),
      notification:"pwa",sourceSessionId:existing?.sourceSessionId??options.sourceSessionId};
    return store.change({action:"save",id:existing?.id,revision,automation});
  }
  if(["pause","resume","delete","run-once"].includes(command?.action)){
    const job=find(command.id);if(!job)throw Error("That job no longer exists; list the jobs first");
    if(command.action==="resume"&&job.state==="completed"&&job.trigger.kind==="once"&&(job.nextAt??0)<Date.now())throw Error("This one-time job already ran; change its time to use it again");
    return store.change({action:command.action,id:job.id,revision});
  }
  if(command?.action==="heartbeat"){
    const h=command.heartbeat??{},beat=heartbeatOf(state.automations);
    const every=Math.round(Number(h.everyMinutes??(beat?(beat.trigger as {seconds:number}).seconds/60:30)));
    if(!(every>=30&&every<=1440))throw Error("The heartbeat runs every 30 to 1440 minutes");
    const checklist=String(h.checklist??beat?.prompt??"").trim().slice(0,4000);
    const enabled=h.enabled===undefined?beat?.state==="active":h.enabled===true;
    if(enabled&&!checklist)throw Error("Add at least one thing to check before turning the heartbeat on");
    if(!checklist){
      // Nothing to check: no model call is ever made; just make sure it is off.
      if(beat?.state==="active")return store.change({action:"pause",id:beat.id,revision});
      return store.snapshot();
    }
    const hours={start:minutes(String(h.start??hhmm(beat?.activeHours?.start??480))),end:minutes(String(h.end??hhmm(beat?.activeHours?.end??1380))),
      timezone:String(h.timezone??beat?.activeHours?.timezone??options.timezone)};
    const base=beat??{...defaultAutomation,dailyMaxRuns:48,dailyBudget:1,maxSteps:4,missed:"skip" as const};
    const automation={...strip(base),title:"Heartbeat",prompt:checklist,characterId:beat?.characterId??mainId,trigger:{kind:"interval",seconds:every*60},
      kind:"heartbeat",activeHours:hours,missed:"skip",notification:"pwa"};
    if(beat&&(beat.status==="running"||beat.status==="checking"))throw Error("The heartbeat is checking right now; try again in a moment");
    let snap=await store.change({action:"save",id:beat?.id,revision,automation});
    const saved=heartbeatOf(snap.automations);
    if(saved&&enabled&&saved.state!=="active")snap=await store.change({action:"resume",id:saved.id,revision:snap.revision});
    if(saved&&!enabled&&saved.state==="active")snap=await store.change({action:"pause",id:saved.id,revision:snap.revision});
    return snap;
  }
  throw Error("Unknown action: use list, save, pause, resume, delete, run or heartbeat");
}

export const SCHEDULE_TOOL_DESCRIPTION="Scheduled jobs and the heartbeat (like cron), for things that must happen or notify the user at a time. "+
  "kind reminder: at the time the text goes to the user's phone as a notification, with no AI run; use it for \"remind me…\". "+
  "kind task: at the time HUB runs the text as an instruction in a fresh background session with read-only web and Knowledge tools, and notifies the user only if something needs them. "+
  "when: {kind:\"once\",at:\"2026-11-21T09:00:00+03:00\"} (always include the user's UTC offset), {kind:\"every\",minutes:120}, or {kind:\"daily\",time:\"08:30\",days:[1,2,3,4,5]} (0 is Sunday; omit days for every day). "+
  "The heartbeat is one periodic check, every 30 or more minutes within active hours, of a short checklist; it stays silent unless something needs the user. Change it only when the user asks. "+
  "Actions: list; save (job: name, kind, text, when; include id to edit); pause, resume, delete or run (now) with id; heartbeat (heartbeat: enabled, everyMinutes, start, end as HH:MM, checklist). "+
  "Personal to-dos and calendar entries belong in hub_planner instead; a planner entry does not notify by itself, so add a reminder job when the user wants to be told at a time.";
