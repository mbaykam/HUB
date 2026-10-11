import { digest } from "./knowledge-store.ts";
import type { KnowledgeSource } from "../knowledge-contract.ts";
interface Message { role:"user"|"assistant"|"task"; text:string }
/** Typed native events determine authorship. Never split a role label away
 * from a long message, or import a fork's inherited history as new evidence. */
export function knowledgeTurnSources(header:{id:string;origin?:string},snapshot:readonly any[],end:any,inherited=0,forgetBefore=0):KnowledgeSource[]{
  if(end.type!=="turn/end"||end.data?.reason?.kind!=="completed"||!Number.isSafeInteger(end.time)||!Number.isSafeInteger(end.data?.turn)||/^(hub-memory-|hub-character-eval-|hub-character-check-)/.test(header.id))return [];
  const events=snapshot.slice(inherited),turn=end.data.turn;let start=-1;for(let i=events.length-1;i>=0;i--)if(events[i]?.type==="turn/start"&&events[i]?.data?.turn===turn){start=i;break;}if(start<0)return [];
  const worker=header.origin==="subagent";
  const extract=(e:any):Message|undefined=>{
    if(e.type==="user/message"&&(e.data?.source?.kind==="user"||worker&&e.data?.source?.kind==="plugin")){
      const text=e.data.content?.flatMap((b:any)=>b.type==="text"?[b.text??""]:b.type==="image"?["Attached image: "+(b.attachment?.name??"Image")]:[]).join("\n");return text?{role:e.data.source.kind==="user"?"user":"task",text}:undefined;
    }
    if(e.type==="assistant/message"&&e.data?.interrupted!==true){const text=e.data.message?.content?.filter((b:any)=>b.type==="text").map((b:any)=>b.text??"").join("\n");return text?{role:"assistant",text}:undefined;}
  };
  const current:Message[]=[];
  for(const e of events.slice(start+1)){if(e.type==="turn/end"||e.type==="turn/start")break;const m=extract(e);if(m)current.push(m);}
  if(!current.some(m=>m.role==="assistant")||!worker&&!current.some(m=>m.role==="user"))return [];
  const context=events.slice(0,start).filter(e=>!forgetBefore||Number.isSafeInteger(e.time)&&e.time>forgetBefore).flatMap(e=>{const m=extract(e);return m?[m]:[];}).slice(-4).map(m=>({...m,text:m.text.slice(-500)}));
  const chunks:Message[][]=[];let pending:Message[]=[];
  for(const m of current)for(let offset=0;offset<m.text.length;offset+=5000){const fragment={role:m.role,text:m.text.slice(offset,offset+5000)};if(JSON.stringify([...pending,fragment]).length>13000){chunks.push(pending);pending=[];}pending.push(fragment);}
  if(pending.length)chunks.push(pending);
  return chunks.map((messages,i)=>({id:`hub-${digest(header.id)}-turn-${turn}-${i}`,completedAt:end.time,channel:worker?"hub-worker-result":"hub",content:`Prior conversation context (not new facts): ${JSON.stringify(context)}\nCURRENT MESSAGES (author roles preserved; task is not a fresh human statement, assistant output is not proof of user facts or completed actions): ${JSON.stringify(messages)}`}));
}
