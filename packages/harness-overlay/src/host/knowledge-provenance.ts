import {createHash} from "node:crypto";
import type {KnowledgeSource,ConversationMessage} from "../knowledge-contract.ts";
import type {KnowledgeEvidence} from "../knowledge-relation-contract.ts";
const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
export const sourceContains=(source:KnowledgeSource,quote:string)=>source.spans?source.spans.some(s=>s.text.includes(quote)):source.content.includes(quote);
export function sourceReference(source:KnowledgeSource,quote:string,assetId?:string):KnowledgeEvidence{
  if(assetId){const excerpt=source.assetExcerpts?.find(e=>e.assetId===assetId&&e.text.includes(quote));if(!excerpt||!source.assets?.some(a=>a.id===assetId))throw Error("Attachment evidence is unavailable");const start=(excerpt.start??0)+excerpt.text.indexOf(quote);return {sourceId:source.conversationId??source.id,assetId,contentHash:excerpt.contentHash,quote,start,end:start+quote.length,locator:"asset:"+assetId,occurredAt:source.completedAt};}
  const span=source.spans?.find(s=>s.text.includes(quote)),sourceId=source.conversationId??source.id;
  if(span){const start=span.start+span.text.indexOf(quote);return {sourceId,contentHash:span.contentHash,messageId:span.messageId,quote,start,end:start+quote.length,role:span.role,occurredAt:span.occurredAt};}
  const rawNote=source.id.startsWith("record-")&&source.authorRole==="user",start=source.content.indexOf(quote);
  const offset=source.originalWindow?.start??0;return {sourceId,contentHash:rawNote?source.originalWindow?.contentHash??hash(source.content):hash(source.content),quote,role:source.authorRole,occurredAt:source.completedAt,...(rawNote&&start>=0?{start:offset+start,end:offset+start+quote.length}:{locator:"episode:"+source.id})};
}
export function nodeReference(node:{id:string;body:string;kind?:string;messages?:ConversationMessage[]},quote:string):KnowledgeEvidence{
  if(node.kind==="conversation"){
    const message=node.messages?.find(m=>m.text.includes(quote));if(!message)throw Error("Quote an original target message, not a projection heading or wrapper");const start=message.text.indexOf(quote);
    return {sourceId:node.id,contentHash:hash(message.text),messageId:message.id,quote,start,end:start+quote.length,role:message.role==="status"?"task":message.role,occurredAt:message.at};
  }
  const start=node.body.indexOf(quote);if(start<0)throw Error("Source quote no longer exists");return {sourceId:node.id,contentHash:hash(node.body),quote,start,end:start+quote.length};
}
