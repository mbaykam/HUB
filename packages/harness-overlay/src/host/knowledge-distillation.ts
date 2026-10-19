import type {KnowledgeCuration,KnowledgeSettings,KnowledgeSource} from "../knowledge-contract.ts";
import {KNOWLEDGE_MESSAGE_LABEL} from "./knowledge-evidence.ts";
import {digest,validatePlan,type KnowledgeStore} from "./knowledge-store.ts";
import {redactKnowledgeSecrets} from "./knowledge-secrets.ts";

function userEvidence(source:KnowledgeSource):string[]{
  if(source.channel==="hub-worker-result"||source.authorRole==="assistant")return [];
  if(source.spans)return source.spans.filter(s=>s.role==="user").map(s=>s.text);
  const at=source.content.indexOf(KNOWLEDGE_MESSAGE_LABEL);
  if(at>=0)try{return JSON.parse(source.content.slice(at+KNOWLEDGE_MESSAGE_LABEL.length)).filter((m:any)=>m.role==="user"&&typeof m.text==="string").map((m:any)=>m.text);}catch{return [];}
  return source.authorRole==="user"?[source.content]:[];
}
export function validateMemories(value:unknown,source:KnowledgeSource){
  if(value===undefined)return;
  const quotes=userEvidence(source);
  if(!Array.isArray(value)||value.length>4)throw Error("At most four sourced memory excerpts per pass");
  for(const m of value){
    if(!m||Object.keys(m).some(k=>!["title","category","evidence"].includes(k))||typeof m.title!=="string"||m.title.trim().length<3||m.title.length>120||/[\[\]<>\r\n]/.test(m.title)||!["preferences","decisions","projects","learning"].includes(m.category)||typeof m.evidence!=="string"||m.evidence.trim().length<12||m.evidence.length>1200||!quotes.some(q=>q.includes(m.evidence)))throw Error("Memory must quote a genuine user passage; assistant guesses and background speech are not user facts");
    if(redactKnowledgeSecrets(m.evidence)!==m.evidence||redactKnowledgeSecrets(m.title)!==m.title||/\[REDACTED[_A-Z]*\]/.test(m.evidence))throw Error("Credentials do not belong in extracted memory notes");
  }
}
const normalized=(text:string)=>text.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu," ").trim();
/** New, extractive notes only. The host writes the exact user quote, never a
 * model-authored replacement for an existing note. Existing journal admission,
 * recovery, provenance, original protection and undo own all writes. */
export async function distillMemories(store:KnowledgeStore,plan:KnowledgeCuration,source:KnowledgeSource,settings:KnowledgeSettings,passId=source.id){
  validateMemories(plan.memories,source);
  if(!plan.memories?.length)return {count:0};
  if(settings.extractMemories===false)throw Error("Memory extraction is disabled");
  if(plan.decision!=="organize")throw Error("Skipped sources cannot create memories");
  await store.admission.assert(source);
  if((await store.retiredEvidence()).some(t=>t.recordId===source.conversationId&&source.completedAt<=t.at))throw Error("Retired conversation evidence cannot create new memories");
  const notes=(await store.scan()).filter(n=>n.kind!=="conversation"),titles=new Set(notes.map(n=>normalized(n.title))),quotes=notes.map(n=>normalized(n.body));
  const changes=[];
  for(const m of plan.memories){
    if(!settings.categories.includes(m.category))throw Error("Memory category is disabled");
    const body=m.evidence.trim(),quote=normalized(body),title=normalized(m.title);
    if(titles.has(title)||quotes.some(q=>q.includes(quote)))continue;
    titles.add(title);quotes.push(quote);
    changes.push({id:"memory-"+digest(passId+"\0"+quote).slice(0,32),title:m.title.trim(),body,expectedHash:null,category:m.category,links:[]});
  }
  const derived={...source,id:"distill-"+digest(passId)};
  // Recovery checks the durable receipt before deduplication, including undo;
  // replay never recreates a deleted or operator-reverted memory.
  const receipt=await store.revisionForSource(derived.id);
  if(receipt)return {revision:receipt.state==="committed"?receipt.id:undefined,count:receipt.state==="committed"?receipt.count:0};
  if(!changes.length)return {count:0};
  const notePlan={decision:"update-knowledge" as const,reason:"Selected user facts, verbatim from the source conversation.",changes};validatePlan(notePlan);
  const revision=await store.apply(notePlan,derived);
  return {revision:revision??undefined,count:changes.length};
}
