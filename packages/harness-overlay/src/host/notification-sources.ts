import {createHash} from "node:crypto";
import type {NativePushEvent,NativePushStore} from "./native-push.ts";
import {localMinutes} from "./native-push.ts";
import {isKnowledgeEvaluation} from "./knowledge-evidence.ts";
import {operationFailure} from "./operation-failure.ts";

/** Sessions that never notify on their own: background workers, Knowledge, goals,
 * automations, Telegram (which notifies itself) and live voice calls. */
const QUIET=/^(hub-(goal|memory|automation|voice|knowledge)-|minke-im-telegram-|hub-eval)/;

const textOf=(content:unknown):string=>typeof content==="string"?content:Array.isArray(content)?content.map(part=>typeof part==="string"?part:part?.type==="text"&&typeof part.text==="string"?part.text:"").join(" "):"";
/** The last thing the assistant said, as one plain short line. */
export function assistantExcerpt(events:readonly any[],max=220){
  for(let i=events.length-1;i>=0;i--){
    const event=events[i];if(event?.type==="user/message")break;
    if(event?.type!=="assistant/message")continue;
    const plain=textOf(event.data?.message?.content??event.data?.content)
      .replace(/```[\s\S]*?```/g," [code] ").replace(/!?\[([^\]]*)\]\([^)]*\)/g,"$1").replace(/[#*_`>|]+/g," ").replace(/\s+/g," ").trim();
    if(plain)return plain.length>max?plain.slice(0,max-1).replace(/\s+\S*$/,"")+"…":plain;
  }
  return "";
}
const eventTime=(event:any)=>Number(event?.time??event?.at??event?.timestamp??NaN);
/** How long the turn that just ended took, if its events carry times. */
export function turnMilliseconds(events:readonly any[]){
  const end=eventTime(events.at(-1));
  for(let i=events.length-1;i>=0;i--)if(events[i]?.type==="turn/start"){const start=eventTime(events[i]);return Number.isFinite(start)&&Number.isFinite(end)?end-start:NaN;}
  return NaN;
}

export const NOTIFY_GUIDE="hub_notify reaches the user's iPhone. Use it when something needs them or they would want to know now and may not be watching: a long task finished, a decision or answer is needed, something time-sensitive came up. Do not notify for replies they are reading in the open chat, and send one notification per event, never a stream. Title: a few words. Body: the result or the question itself, one or two plain sentences, no greeting. Set expects_reply when you are asking something; their reply arrives in this conversation. Use time-sensitive only for things that matter within the hour.";

export interface PlannerSource {snapshot():{items:any[]}}

/** Everything that turns HUB activity into iPhone notifications. */
export function installNotificationSources(ctx:any,characters:any,store:NativePushStore,publish:(event:NativePushEvent)=>void,effectiveCharacter:(ctx:any,agent:any)=>any){
  const cleanups:(()=>void)[]=[];
  // A reply that took a while: the user has likely put the phone down.
  cleanups.push(ctx.on("session/event",(record:any,event:any)=>{
    const header=record.header;
    if(event.type!=="turn/end"||header.origin==="subagent"||QUIET.test(header.id)||isKnowledgeEvaluation(header.id))return;
    const failure=operationFailure(event.data?.reason);if(failure&&["user","cancelled","canceled"].includes(failure.kind))return;
    const events=record.snapshotEvents?.()??[],took=turnMilliseconds(events);
    if(!(took>=20000))return;
    const excerpt=assistantExcerpt(events);
    publish({id:`reply:${header.id}:${String(event.seq??event.id??events.length)}`,sessionId:header.id,kind:"reply",status:failure?"failed":"completed",
      title:failure?"HUB stopped":"HUB replied",body:failure?"The reply did not finish. Open the chat to see what happened.":excerpt||"Your answer is ready.",category:"reply"});
  },{global:true}));

  // Assistants reach the user directly, within a small budget per conversation.
  const sent=new Map<string,number[]>();
  const output={schema:{type:"object"},render:(_a:any,v:any)=>[{type:"text",text:JSON.stringify(v)}]};
  cleanups.push(ctx.tools.register({name:"hub_notify",description:NOTIFY_GUIDE,parameters:{type:"object",properties:{
      title:{type:"string",description:"A few words."},body:{type:"string",description:"One or two sentences: the result or the question."},
      urgency:{type:"string",enum:["passive","active","time-sensitive"]},expects_reply:{type:"boolean"}},required:["title","body"],additionalProperties:false},
    output,async execute(args:any,exec:any){
      const agent=exec.agent;if(!agent)throw Error("This tool needs an active conversation.");
      const character=effectiveCharacter(ctx,agent);
      if(character?.tools?.mode==="allow"&&!character.tools.names.includes("hub_notify"))throw Error("Notifications are disabled for this character.");
      const title=String(args?.title??"").replace(/\s+/g," ").trim().slice(0,80),body=String(args?.body??"").replace(/\s+/g," ").trim().slice(0,400);
      if(!title||!body)throw Error("Give a short title and a body.");
      const header=agent.session.header,root=header.origin==="subagent"&&header.parentSession?header.parentSession:header.id;
      const now=Date.now(),recent=(sent.get(root)??[]).filter(at=>now-at<3600000);
      if(recent.length>=6||recent.some(at=>now-at<20000))throw Error("This conversation already notified the user recently. Wait, or put the update in the chat.");
      recent.push(now);sent.set(root,recent);if(sent.size>500)sent.delete(sent.keys().next().value!);
      const queued=await store.publish({id:"assistant:"+createHash("sha256").update(root+":"+now+":"+title).digest("hex").slice(0,24),sessionId:root,kind:"assistant",status:"info",
        title,body,level:args?.urgency==="passive"||args?.urgency==="time-sensitive"?args.urgency:"active",category:args?.expects_reply?"reply":"open"});
      return queued?{sent:true,delivery:"Queued for the user's iPhone; quiet hours may hold it until morning."}:{sent:false,reason:"The user turned these notifications off, or no iPhone is registered."};
    }}));
  const offPrompt=ctx.systemPrompt?.section?.({name:"hub:notify",order:93,text:(context:any)=>context.scope?.id?.startsWith?.("hub-memory-")?"":NOTIFY_GUIDE});
  if(offPrompt)cleanups.push(offPrompt);

  // The calendar watcher: reminders before events, and one morning brief.
  const watch=async()=>{
    const planner:PlannerSource|undefined=characters.planner;if(!planner)return;
    const prefs=store.preferences(),now=Date.now(),items=planner.snapshot().items.filter((i:any)=>!i.deleted&&i.state==="open");
    if(prefs.reminderMinutes>0)for(const item of items){
      if(item.kind!=="event"||!item.start)continue;
      const start=Date.parse(item.start),lead=prefs.reminderMinutes*60000;
      if(!(start-lead<=now&&now<start))continue;
      const key=`reminder:${item.id}:${item.start}`;if(store.remembered(key))continue;await store.remember(key);
      const minutes=Math.max(1,Math.round((start-now)/60000)),time=new Intl.DateTimeFormat("en-GB",{timeZone:item.timeZone||prefs.timeZone,hour:"2-digit",minute:"2-digit"}).format(start);
      publish({id:key,sessionId:item.sourceSessionId??"hub-agenda",kind:"reminder",status:"info",title:item.title,
        body:`${time} · in ${minutes} min${item.details?" · "+String(item.details).replace(/\s+/g," ").slice(0,160):""}`,category:"reminder",level:"time-sensitive",
        data:{itemId:item.id,itemVersion:item.version,start:item.start}});
    }
    const day=new Intl.DateTimeFormat("en-CA",{timeZone:prefs.timeZone,year:"numeric",month:"2-digit",day:"2-digit"}).format(now);
    const minute=localMinutes(now,prefs.timeZone),brief=Number(prefs.briefTime.slice(0,2))*60+Number(prefs.briefTime.slice(3));
    if(minute<brief||minute>brief+90||store.remembered("brief:"+day))return;
    await store.remember("brief:"+day);
    const today=(item:any)=>item.date===day||item.start&&new Intl.DateTimeFormat("en-CA",{timeZone:prefs.timeZone,year:"numeric",month:"2-digit",day:"2-digit"}).format(Date.parse(item.start))===day;
    const events=items.filter((i:any)=>i.kind==="event"&&today(i)).sort((a:any,b:any)=>String(a.start??"").localeCompare(String(b.start??"")));
    const todos=items.filter((i:any)=>i.kind==="todo"&&(i.horizon??"near")==="near");
    const due=todos.filter((i:any)=>i.date&&i.date<=day);
    const waiting=(characters.goals?.snapshot?.().goals??[]).filter((g:any)=>g.status==="needs-approval").length;
    const timeOf=(i:any)=>i.start?new Intl.DateTimeFormat("en-GB",{timeZone:prefs.timeZone,hour:"2-digit",minute:"2-digit"}).format(Date.parse(i.start)):"All day";
    const parts=[events.length?events.slice(0,3).map((e:any)=>`${timeOf(e)} ${e.title}`).join(", ")+(events.length>3?` and ${events.length-3} more`:""):"No events today",
      due.length?`${due.length} to-do${due.length===1?"":"s"} due`:todos.length?`${todos.length} open to-do${todos.length===1?"":"s"}`:"",
      waiting?`${waiting} approval${waiting===1?"":"s"} waiting`:""].filter(Boolean);
    publish({id:"brief:"+day,sessionId:"hub-agenda",kind:"brief",status:"info",title:"Your day",body:parts.join(" · "),category:"open",level:"active"});
  };
  let running=false;
  const timer=setInterval(()=>{if(running)return;running=true;void watch().catch(()=>{}).finally(()=>{running=false;});},60000);timer.unref();
  cleanups.push(()=>clearInterval(timer));
  return ()=>{for(const off of cleanups.splice(0))try{off();}catch{}};
}

/** A goal that is waiting on the user's decision, as an Approve/Deny notification. */
export function approvalEvent(goal:any):NativePushEvent|undefined{
  const approval=goal?.approvals?.find?.((a:any)=>a.status==="pending"&&a.revision===goal.revision);
  const cycle=goal?.cycles?.at?.(-1);if(!approval||!cycle?.sessionId)return;
  return {id:`approval:${goal.id}:${approval.id}`,sessionId:cycle.sessionId,kind:"approval",status:"attention",
    title:"Approve? · "+String(goal.title??"Goal").slice(0,60),body:String(approval.description??goal.reason??"An operation is waiting for your approval.").replace(/\s+/g," ").slice(0,300),
    category:"approval",level:"time-sensitive",data:{goalId:goal.id,approvalId:approval.id,revision:goal.revision}};
}
