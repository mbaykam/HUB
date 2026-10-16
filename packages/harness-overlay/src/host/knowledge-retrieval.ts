import type {KnowledgeSemanticHit} from "../knowledge-contract.ts";
import type {KnowledgeDomainState} from "../knowledge-domain-contract.ts";
import {knowledgeTextForms} from "./knowledge-recall.ts";
import type {KnowledgeLexicalIndex} from "./knowledge-lexical-index.ts";
const stop=new Set("the and for with this that what which about have has how your you are was were ben bir bu ile ve için ne hangi şey gibi daha bana bunu şunu mı mi mu mü".split(" "));
const terms=(query:string)=>[...new Set(knowledgeTextForms(query).flatMap(q=>q.match(/[\p{L}\p{N}]{2,40}/gu)??[]))].filter(t=>!stop.has(t)).slice(0,80);
const words=(text:string)=>" "+text.replace(/[^\p{L}\p{N}]+/gu," ").trim()+" ";
export interface RankedKnowledge {kind:"lexical"|"semantic"|"domain-navigation";score:number;chunk?:KnowledgeSemanticHit["chunk"]}
export function fuseKnowledgeRanks<T extends {id:string;title:string;body:string;modifiedAt:number}>(notes:T[],query:string,registry:KnowledgeDomainState,semantic:KnowledgeSemanticHit[],limit:number,index?:KnowledgeLexicalIndex){
  const tokens=terms(query),queries=knowledgeTextForms(query).map(words),requested=new Set(registry.domains.filter(d=>[d.title,...d.aliases].some(alias=>knowledgeTextForms(alias).some(a=>a.length>=2&&queries.some(q=>q.includes(words(a)))))).map(d=>d.id));
  const domains=new Map(registry.domains.map(d=>[d.id,d])),memberships=new Map<string,Set<string>>();
  for(const m of registry.memberships){if(!memberships.has(m.nodeId))memberships.set(m.nodeId,new Set());const seen=new Set<string>();let d=domains.get(m.domainId);while(d&&!seen.has(d.id)){seen.add(d.id);memberships.get(m.nodeId)!.add(d.id);d=domains.get(d.parentId??d.mergedInto??"");}}
  const lexical=index?index.rank(notes,tokens):notes.map(n=>{const titles=knowledgeTextForms(n.title),bodies=knowledgeTextForms(n.body),count=tokens.reduce((s,t)=>s+(titles.some(v=>v.includes(t))?7:0)+(bodies.some(v=>v.includes(t))?1:0),0);return {id:n.id,score:count/(1+Math.log1p(n.body.length/2000)*.12)};}).filter(n=>n.score>0).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
  const lex=new Map(lexical.map((n,i)=>[n.id,i+1])),known=new Set(notes.map(n=>n.id)),sem=new Map(semantic.filter(h=>known.has(h.id)&&Number.isFinite(h.score)&&h.score>=.4).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).map((n,i)=>[n.id,{...n,rank:i+1}]));
  return notes.map(note=>{const ids=memberships.get(note.id)??new Set<string>(),l=lex.get(note.id),s=sem.get(note.id),navigation=[...ids].some(id=>requested.has(id));let score=(l?1/(60+l):0)+(s?1.1/(60+s.rank):0);if(navigation)score+=.16/61;if(score>0&&[...ids].some(id=>domains.get(id)?.status==="active"))score+=.0001;const chunk=s?.chunk&&s.chunk.kind==="body"&&Number.isInteger(s.chunk.start)&&s.chunk.start>=0&&s.chunk.end>s.chunk.start&&s.chunk.end<=note.body.length?s.chunk:undefined;return {...note,retrieval:{kind:s?"semantic":l?"lexical":"domain-navigation",score,...(chunk?{chunk}:{})} as RankedKnowledge};}).filter(n=>n.retrieval.score>0).sort((a,b)=>b.retrieval.score-a.retrieval.score||b.modifiedAt-a.modifiedAt||a.id.localeCompare(b.id)).slice(0,limit);
}
export function knowledgeExcerptSpans(body:string,query:string,budget=1200,chunk?:KnowledgeSemanticHit["chunk"]){
  if(body.length<=budget)return [{start:0,end:body.length,text:body}];
  const positions=chunk?.kind==="body"&&chunk.start>=0&&chunk.end<=body.length?[chunk.start]:terms(query).map(t=>body.toLocaleLowerCase("tr").lastIndexOf(t)).filter(p=>p>=0).sort((a,b)=>b-a);
  let start=Math.max(0,(positions[0]??0)-Math.min(200,Math.floor(budget/4)));if(start>0&&/[\uDC00-\uDFFF]/.test(body[start]!))start--;let end=Math.min(body.length,start+budget);if(end<body.length&&/[\uDC00-\uDFFF]/.test(body[end]!))end--;
  return [{start,end,text:body.slice(start,end)}];
}
/** The runtime has no exposed tokenizer here; estimate explicitly and enforce
 * an independent hard UTF-8 ceiling. Sparse results retain a read action. */
export function boundKnowledgePayload<T extends {id:string;title:string;reason:string}>(records:T[],maxTokens=2000,maxBytes=12800){const kept:(T|{id:string;title:string;reason:string;readRequired:true})[]=[];for(const record of records.slice(0,7)){const candidates=[record,{id:record.id,title:record.title,reason:record.reason,readRequired:true as const}];for(const candidate of candidates){const bytes=Buffer.byteLength(JSON.stringify([...kept,candidate]));if(bytes<=maxBytes&&Math.ceil(bytes/3)<=maxTokens){kept.push(candidate);break;}}}const bytes=Buffer.byteLength(JSON.stringify(kept));return {records:kept,bytes,tokens:Math.ceil(bytes/3),measurement:"estimated-from-utf8" as const};}
