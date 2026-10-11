export const HUB_AGENT_ACTIVITY_CHANNEL="hub:agent-activity";
export interface HubAgentActivity { channel:typeof HUB_AGENT_ACTIVITY_CHANNEL;version:1;rootSessionId:string;taskId:string;eventId:string;status:"started"|"running"|"completed"|"failed";label:string;text?:string; }
export function parseHubAgentActivity(value:unknown):HubAgentActivity|undefined{
  if(!value||typeof value!=="object"||Array.isArray(value))return;
  const v=value as Record<string,unknown>;
  if(v.channel!==HUB_AGENT_ACTIVITY_CHANNEL||v.version!==1||Object.keys(v).some(k=>!["channel","version","rootSessionId","taskId","eventId","status","label","text"].includes(k)))return;
  if(typeof v.rootSessionId!=="string"||!/^minke-im-telegram-[a-f0-9]{32}$/.test(v.rootSessionId))return;
  if(typeof v.taskId!=="string"||!/^[A-Za-z0-9._-]{1,200}$/.test(v.taskId)||typeof v.eventId!=="string"||!/^[A-Za-z0-9:._-]{1,260}$/.test(v.eventId))return;
  if(!["started","running","completed","failed"].includes(String(v.status))||typeof v.label!=="string"||!v.label.trim()||v.label.length>200||/[\u0000-\u001f]/.test(v.label))return;
  if(v.text!==undefined&&(typeof v.text!=="string"||v.text.length>8000))return;
  return v as unknown as HubAgentActivity;
}
