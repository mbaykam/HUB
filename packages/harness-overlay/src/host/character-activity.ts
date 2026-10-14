import { readFile,writeFile,rename,mkdir } from "node:fs/promises";
import { join } from "node:path";
import { HUB_AGENT_ACTIVITY_CHANNEL,parseHubAgentActivity,type HubAgentActivity } from "../agent-activity-contract.ts";
import {operationFailure} from "./operation-failure.ts";

/** Project observed child actions/results, never reasoning or tool arguments.
 * The Electron parent chooses the already-authorized Telegram destination. */
export function installCharacterActivity(ctx:any,root:string){
  const tasks=new Map<string,{rootSessionId:string;label:string;lastText:string;seq:number}>();
  let queue=Promise.resolve(),closed=false;
  const ready=(async()=>{try{const saved=JSON.parse(await readFile(join(root,"activity.json"),"utf8"));for(const t of saved)if(typeof t.id==="string"&&parseHubAgentActivity({channel:HUB_AGENT_ACTIVITY_CHANNEL,version:1,rootSessionId:t.rootSessionId,taskId:t.id,eventId:t.id+":restore",status:"started",label:t.label}))if(!tasks.has(t.id))tasks.set(t.id,{rootSessionId:t.rootSessionId,label:t.label,lastText:"",seq:Number.isSafeInteger(t.seq)?t.seq:-1});}catch{/* Missing or corrupt metadata cannot authorize a destination. New tasks still use observed native lineage. */}})();
  const publish=(activity:HubAgentActivity)=>{
    if(!parseHubAgentActivity(activity))return;
    queue=queue.then(async()=>{
      await ready;if(closed)return;
      await mkdir(root,{recursive:true});const temp=join(root,"activity.tmp");
      await writeFile(temp,JSON.stringify([...tasks].slice(-1000).map(([id,t])=>({id,rootSessionId:t.rootSessionId,label:t.label,seq:t.seq}))),{mode:0o600});await rename(temp,join(root,"activity.json"));
      if(process.connected&&process.send)process.send(activity,()=>{});
    }).catch(()=>{});
  };
  const created=ctx.on("agent/created",({agent}:any)=>{
    const parent=agent.session.header.parentSession;if(agent.session.header.origin!=="subagent"||typeof parent!=="string")return;
    const ancestor=tasks.get(parent),rootSessionId=ancestor?.rootSessionId??parent;
    if(!/^minke-im-telegram-[a-f0-9]{32}$/.test(rootSessionId))return;
    const previous=tasks.get(agent.id);const title=agent.session.snapshotEvents?.().filter((e:any)=>e.type==="session/title").at(-1)?.data?.title;const task={rootSessionId,label:typeof title==="string"?title.replace(/[\u0000-\u001f]/g," ").slice(0,200)||"Specialist":previous?.label??"Specialist",lastText:"",seq:previous?.seq??-1};tasks.set(agent.id,task);if(tasks.size>1000)tasks.delete(tasks.keys().next().value!);
    publish({channel:HUB_AGENT_ACTIVITY_CHANNEL,version:1,rootSessionId,taskId:agent.id,eventId:agent.id+":started:"+(agent.session.firstLiveSeq??0),status:"started",label:task.label});
  },{global:true});
  const events=ctx.on("session/event",(session:any,event:any)=>{
    const task=tasks.get(session.header.id);if(!task||!Number.isSafeInteger(event.seq)||event.seq<=task.seq)return;
    if(event.type==="session/title"&&typeof event.data?.title==="string")task.label=event.data.title.replace(/[\u0000-\u001f]/g," ").slice(0,200)||"Specialist";
    if(event.type==="assistant/message")task.lastText=(event.data?.message?.content??[]).filter((c:any)=>c.type==="text").map((c:any)=>c.text).join("\n").slice(0,8000);
    if(event.type==="tool/call"){
      task.seq=event.seq;const action=typeof event.data?.name==="string"?event.data.name:typeof event.data?.call?.name==="string"?event.data.call.name:"Working";
      publish({channel:HUB_AGENT_ACTIVITY_CHANNEL,version:1,rootSessionId:task.rootSessionId,taskId:session.header.id,eventId:session.header.id+":"+event.seq,status:"running",label:(task.label+" · "+action).replace(/[\u0000-\u001f]/g," ").slice(0,200)});
    }
    if(event.type==="turn/end"){
      task.seq=event.seq;const failure=operationFailure(event.data?.reason??event.data?.endReason);
      if(!task.lastText){const last=session.snapshotEvents?.().filter((e:any)=>e.type==="assistant/message").at(-1);task.lastText=(last?.data?.message?.content??[]).filter((c:any)=>c.type==="text").map((c:any)=>c.text).join("\n").slice(0,8000);}
      const failed=!!failure;
      publish({channel:HUB_AGENT_ACTIVITY_CHANNEL,version:1,rootSessionId:task.rootSessionId,taskId:session.header.id,eventId:session.header.id+":"+event.seq,status:failed?"failed":"completed",label:task.label,text:task.lastText||undefined});task.lastText="";
    }
  },{global:true});
  return async()=>{closed=true;created();events();await queue;};
}
