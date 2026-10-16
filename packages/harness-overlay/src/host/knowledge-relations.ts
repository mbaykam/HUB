import {randomUUID,createHash} from "node:crypto";
import type {KnowledgeDomainState} from "../knowledge-domain-contract.ts";
import type {KnowledgeEvidence,KnowledgeRelation,KnowledgeRelationScope} from "../knowledge-relation-contract.ts";
import type {KnowledgeCuration,KnowledgeSource} from "../knowledge-contract.ts";
import type {ConversationMessage} from "../knowledge-contract.ts";
import {sourceReference,nodeReference} from "./knowledge-provenance.ts";
const digest=(text:string)=>createHash("sha256").update(text).digest("hex");
export interface RelationRecord {relation:KnowledgeRelation;supports:{revisionId:string;evidence:KnowledgeEvidence[]}[]}
export interface RelationRevision {id:string;sourceId:string;source:KnowledgeSource;plan:KnowledgeCuration;at:number;undone?:boolean}
export function relationRoots(state:Pick<KnowledgeDomainState,"domains"|"memberships">){
  const domains=new Map(state.domains.map(d=>[d.id,d])),roots=new Map<string,Set<string>>();
  for(const m of state.memberships){let d=domains.get(m.domainId);const seen=new Set<string>();while(d&&!seen.has(d.id)){seen.add(d.id);if(d.mergedInto){d=domains.get(d.mergedInto);continue;}if(d.parentId){d=domains.get(d.parentId);continue;}if(!roots.has(m.nodeId))roots.set(m.nodeId,new Set());roots.get(m.nodeId)!.add(d.id);break;}}
  return roots;
}
export function relationScope(sourceId:string,targetId:string,roots:Map<string,Set<string>>):KnowledgeRelationScope{const a=roots.get(sourceId),b=roots.get(targetId);if(!a?.size||!b?.size)return "unclassified";return [...a].some(id=>b.has(id))?"short":"long";}
const key=(r:Pick<KnowledgeRelation,"sourceId"|"targetId"|"predicate"|"direction"|"origin">)=>JSON.stringify([r.sourceId,r.targetId,r.predicate,r.direction,r.origin]);
export function addRevisionRelations(records:RelationRecord[],revision:RelationRevision,targets:{id:string;body:string;kind?:string;messages?:ConversationMessage[]}[],legacy=false){
  if(!revision.source.conversationId)return records;
  for(const [index,p]of revision.plan.relations.entries()){
    const target=targets.find(n=>n.id===p.targetId),predicate=p.predicate??(p.label||"legacy relationship"),direction=p.direction??"undirected";
    if(!legacy&&revision.plan.version===2&&(!target||!p.targetEvidence||!target.body.includes(p.targetEvidence)||p.targetHash!==digest(target.body)))throw Error("Relation target evidence changed; read the current source before organizing again");
    const refs=[sourceReference(revision.source,p.evidence)];
    if(target&&p.targetEvidence)refs.push(nodeReference(target,p.targetEvidence));
    // Legacy evidence remains honest: no target citation is manufactured.
    const identity={sourceId:revision.source.conversationId,targetId:p.targetId,predicate,direction,origin:"curator" as const};let record=records.find(r=>key(r.relation)===key(identity));
    if(!record){const id=legacy?"legacy-"+digest(revision.id+":"+index).slice(0,32):randomUUID();record={relation:{...identity,id,interpretation:true,evidence:[],createdAt:revision.at,updatedAt:revision.at,status:"active"},supports:[]};records.push(record);}
    if(!record.supports.some(s=>s.revisionId===revision.id))record.supports.push({revisionId:revision.id,evidence:refs});
  }
  return records;
}
export function activeRelations(records:RelationRecord[],revisions:RelationRevision[]){const active=new Map(revisions.filter(r=>!r.undone).map(r=>[r.id,r.at]));return records.flatMap(record=>{const supports=record.supports.filter(s=>active.has(s.revisionId));if(!supports.length)return [];const evidence=[...new Map(supports.flatMap(s=>s.evidence).map(e=>[JSON.stringify(e),e])).values()];return [{...record.relation,status:"active" as const,evidence,updatedAt:supports.reduce((at,s)=>Math.max(at,active.get(s.revisionId)!),record.relation.createdAt)}];});}
export function validateRelationRecords(records:RelationRecord[],revisions:RelationRevision[]){
  if(!Array.isArray(records))throw Error("Invalid canonical relations");const known=new Set(revisions.map(r=>r.id)),ids=new Set<string>();
  for(const record of records){const r=record?.relation;if(!r||typeof r.id!=="string"||!r.id||ids.has(r.id)||![r.sourceId,r.targetId,r.predicate].every(s=>typeof s==="string"&&s.length>0&&s.length<=200)||r.sourceId===r.targetId||!["directed","undirected"].includes(r.direction)||!["human","document","curator"].includes(r.origin)||typeof r.interpretation!=="boolean"||!Number.isFinite(r.createdAt)||!Number.isFinite(r.updatedAt)||!["active","retired"].includes(r.status)||!Array.isArray(record.supports)||!record.supports.every(s=>known.has(s.revisionId)&&Array.isArray(s.evidence)&&s.evidence.length>0&&s.evidence.every(e=>typeof e.sourceId==="string"&&/^[0-9a-f]{64}$/.test(e.contentHash)&&typeof e.quote==="string"&&e.quote.length>0&&e.quote.length<=1200&&(e.start===undefined||Number.isInteger(e.start)&&e.start>=0)&&(e.end===undefined||Number.isInteger(e.end)&&e.end>(e.start??-1)))))throw Error("Invalid canonical relation evidence");ids.add(r.id);}
}
