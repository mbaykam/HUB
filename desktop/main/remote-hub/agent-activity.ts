import type { ChildProcess } from "node:child_process";
import { readFileSync,writeFileSync,renameSync,mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { GatewayCipher } from "@lencx/minke-im-gateway";
import { parseHubAgentActivity,type HubAgentActivity } from "@minke/harness-overlay/agent-activity-contract.ts";

export function bindHubAgentActivity(child:ChildProcess,receive:(activity:HubAgentActivity)=>Promise<void>){
  const listener=(value:unknown)=>{const parsed=parseHubAgentActivity(value);if(parsed)void receive(parsed).catch(()=>{});};
  child.on("message",listener);const close=()=>child.off("message",listener);child.once("exit",close);return close;
}
export interface ActivityDestination{sessionId:string;accountKey:string;generation:number;recipientId:string;conversationId:string;senderId:string;replyKey?:string;taskId?:string;}
export class AgentActivityDestinations{
  readonly routes=new Map<string,ActivityDestination>();#loaded=false;
  readonly path:string;readonly cipher:()=>GatewayCipher;
  constructor(path:string,cipher:()=>GatewayCipher){this.path=path;this.cipher=cipher;}
  load(){if(this.#loaded)return;if(!isAbsolute(this.path)){this.#loaded=true;return;}try{const value=JSON.parse(Buffer.from(this.cipher().open(readFileSync(this.path),"hub-agent-destinations")).toString("utf8"));if(!Array.isArray(value))throw new Error("Invalid activity destinations");for(const r of value)if(r&&typeof r.sessionId==="string"&&/^minke-im-telegram-[a-f0-9]{32}$/.test(r.sessionId)&&typeof r.accountKey==="string"&&Number.isSafeInteger(r.generation)&&r.generation>=0&&[r.recipientId,r.conversationId,r.senderId].every(v=>typeof v==="string"&&v.length>0&&v.length<500)&&(r.replyKey===undefined||/^[a-f0-9]{64}$/.test(r.replyKey))&&(r.taskId===undefined||(typeof r.taskId==="string"&&/^[A-Za-z0-9_-]{1,200}$/.test(r.taskId))))this.routes.set(r.taskId?"task:"+r.taskId:r.sessionId,r);this.#loaded=true;}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;this.#loaded=true;}}
  remember(route:ActivityDestination){this.load();this.routes.set(route.taskId?"task:"+route.taskId:route.sessionId,route);if(!isAbsolute(this.path))return;const value=[...this.routes.values()].slice(-1000);mkdirSync(dirname(this.path),{recursive:true});const temp=this.path+".tmp";writeFileSync(temp,this.cipher().seal(Buffer.from(JSON.stringify(value)),"hub-agent-destinations"),{mode:0o600});renameSync(temp,this.path);}
  get(sessionId:string){this.load();return this.routes.get(sessionId);}
}
