import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import type {KnowledgeGraph} from "../knowledge-contract.ts";
import type {KnowledgeCommunitySnapshot} from "../knowledge-community-contract.ts";
import {atomicJson} from "./knowledge-store.ts";
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
function brainGraph(graph:KnowledgeGraph):KnowledgeGraph{
  const nodes=graph.nodes.filter(n=>n.kind!=="conversation"),ids=new Set(nodes.map(n=>n.id));
  return {...graph,nodes,edges:graph.edges.filter(e=>ids.has(e.source)&&ids.has(e.target)),relationships:graph.relationships?.filter(e=>ids.has(e.sourceId)&&ids.has(e.targetId)),similarities:graph.similarities?.filter(e=>ids.has(e.source)&&ids.has(e.target)),memberships:graph.memberships?.filter(m=>ids.has(m.nodeId))};
}
function inputFingerprint(graph:KnowledgeGraph){return hash({algorithm:"weighted-label-propagation-v1",scope:"brain-only-v1",nodes:graph.nodes.map(n=>[n.id,n.title]).sort((a,b)=>a[0]!.localeCompare(b[0]!)),edges:graph.relationships?graph.relationships.map(r=>[r.sourceId,r.targetId,r.status,r.interpretation]).sort():graph.edges.map(e=>[e.source,e.target]).sort(),similarities:graph.similarities?.map(e=>[e.source,e.target,e.score]).sort(),memberships:graph.memberships?.map(m=>[m.nodeId,m.domainId]).sort(),source:graph.sourceCoverage,partial:graph.partial,semantic:graph.similarityCoverage});}

/** Derived suggestions only. Confidence weights and a degree normalization
 * prevent tentative links and generic hubs from dominating dense local groups.
 * This bounded deterministic label propagation is NOT a Leiden implementation. */
export function discoverKnowledgeCommunities(graph:KnowledgeGraph,previous?:KnowledgeCommunitySnapshot,at=Date.now()):KnowledgeCommunitySnapshot{
  graph=brainGraph(graph);
  const nodes=[...graph.nodes].sort((a,b)=>a.id.localeCompare(b.id)).slice(0,5000),known=new Set(nodes.map(n=>n.id)),pairs=new Map<string,{a:string;b:string;weight:number}>();
  const link=(source:string,target:string,weight:number)=>{
    if(source===target||!known.has(source)||!known.has(target)||!Number.isFinite(weight)||weight<=0)return;
    const [a,b]=[source,target].sort(),key=a+"\0"+b,old=pairs.get(key);if(!old||old.weight<weight)pairs.set(key,{a:a!,b:b!,weight});
  };
  if(graph.relationships)for(const r of graph.relationships){if(r.status==="active")link(r.sourceId,r.targetId,r.interpretation?.65:1);}
  else for(const edge of graph.edges)link(edge.source,edge.target,1);
  for(const edge of graph.similarities??[])if(edge.score>=.56)link(edge.source,edge.target,Math.max(.05,Math.min(1,(edge.score-.56)/.44))*.45);
  const rows=[...pairs.values()].sort((a,b)=>(a.a+"\0"+a.b).localeCompare(b.a+"\0"+b.b)),edges=rows.slice(0,30000),adjacency=new Map(nodes.map(n=>[n.id,new Map<string,number>()]));
  for(const edge of edges){adjacency.get(edge.a)!.set(edge.b,edge.weight);adjacency.get(edge.b)!.set(edge.a,edge.weight);}
  const labels=new Map(nodes.map(n=>[n.id,n.id]));
  for(let pass=0;pass<12;pass++){
    let changed=false;
    for(const node of nodes){
      const votes=new Map<string,number>(),neighbors=adjacency.get(node.id)!;
      for(const [id,weight]of neighbors){const label=labels.get(id)!,value=weight/Math.sqrt(Math.max(1,neighbors.size)*Math.max(1,adjacency.get(id)!.size));votes.set(label,(votes.get(label)??0)+value);}
      const best=[...votes].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0];
      if(best&&best[0]!==labels.get(node.id)){labels.set(node.id,best[0]);changed=true;}
    }
    if(!changed)break;
  }
  const buckets=new Map<string,string[]>();for(const node of nodes){if(!adjacency.get(node.id)!.size)continue;const label=labels.get(node.id)!,members=buckets.get(label)??[];members.push(node.id);buckets.set(label,members);}
  const groups=[...buckets.values()].filter(members=>members.length>1).sort((a,b)=>b.length-a.length||a[0]!.localeCompare(b[0]!));
  // Overlap reconciliation is adapted from Graphify cluster.py's
  // remap_communities_to_previous, commit10130e79 (Apache-2.0).
  // Copyright2026 Safi Shamsi and the Graphify contributors. HUB changes:
  // string identities, signatures, sparse overlap counts, no canonical changes.
  const oldByMember=new Map<string,string>();for(const group of previous?.groups??[])for(const id of group.memberIds)oldByMember.set(id,group.id);
  const overlaps:{count:number;oldId:string;next:number}[]=[];for(const [next,members]of groups.entries()){const counts=new Map<string,number>();for(const member of members){const id=oldByMember.get(member);if(id)counts.set(id,(counts.get(id)??0)+1);}for(const [oldId,count]of counts)overlaps.push({count,oldId,next});}
  overlaps.sort((a,b)=>b.count-a.count||a.oldId.localeCompare(b.oldId)||a.next-b.next);const identities=new Map<number,string>(),used=new Set<string>();for(const match of overlaps)if(!used.has(match.oldId)&&!identities.has(match.next)){used.add(match.oldId);identities.set(match.next,match.oldId);}
  const memberships=new Map<string,Set<string>>();for(const m of graph.memberships??[]){if(!memberships.has(m.nodeId))memberships.set(m.nodeId,new Set());memberships.get(m.nodeId)!.add(m.domainId);}
  const indexed=new Map(nodes.map(n=>[n.id,n])),inputHash=inputFingerprint(graph),groupOf=new Map<string,number>(),internalCounts=new Map<number,number>();for(const [i,members]of groups.entries())for(const id of members)groupOf.set(id,i);for(const edge of edges){const index=groupOf.get(edge.a);if(index!==undefined&&index===groupOf.get(edge.b))internalCounts.set(index,(internalCounts.get(index)??0)+1);}
  const candidateGroups=groups.map((memberIds,i)=>{
    const signature=hash(memberIds),hub=[...memberIds].sort((a,b)=>adjacency.get(b)!.size-adjacency.get(a)!.size||a.localeCompare(b))[0]!,internal=internalCounts.get(i)??0;
    return {id:identities.get(i)??"community-"+signature.slice(0,24),label:indexed.get(hub)!.title.slice(0,160),memberIds,signature,cohesion:internal/(memberIds.length*(memberIds.length-1)/2),domainIds:[...new Set(memberIds.flatMap(id=>[...(memberships.get(id)??[])]))].sort()};
  });
  const limitedBy:KnowledgeCommunitySnapshot["coverage"]["limitedBy"]=[];if(nodes.length<graph.nodes.length)limitedBy.push("records");if(edges.length<rows.length)limitedBy.push("edges");if(graph.partial)limitedBy.push("source-coverage");if(graph.similarityCoverage&&!graph.similarityCoverage.complete)limitedBy.push("similarity-coverage");
  return {version:1,algorithm:"weighted-label-propagation-v1",authoritative:false,inputHash,at,groups:candidateGroups,coverage:{totalRecords:graph.nodes.length,consideredRecords:nodes.length,totalEdges:rows.length,consideredEdges:edges.length,omittedSources:graph.sourceCoverage?.omitted??0,complete:!limitedBy.length,limitedBy}};
}

/** This rebuildable cache is excluded from portable canonical snapshots. */
function validCommunityCache(value:any):value is KnowledgeCommunitySnapshot{
  if(value?.version!==1||value.algorithm!=="weighted-label-propagation-v1"||value.authoritative!==false||!/^[a-f0-9]{64}$/.test(value.inputHash)||!Number.isSafeInteger(value.at)||!Array.isArray(value.groups)||value.groups.length>2500)return false;
  const coverage=value.coverage;if(!coverage||typeof coverage.complete!=="boolean"||![coverage.totalRecords,coverage.consideredRecords,coverage.totalEdges,coverage.consideredEdges,coverage.omittedSources].every(n=>Number.isSafeInteger(n)&&n>=0)||!Array.isArray(coverage.limitedBy)||coverage.limitedBy.some((v:any)=>!["records","edges","source-coverage","similarity-coverage"].includes(v)))return false;
  const ids=new Set<string>(),members=new Set<string>();for(const g of value.groups){if(typeof g?.id!=="string"||!/^community-[a-f0-9]{24}$/.test(g.id)||ids.has(g.id)||typeof g.label!=="string"||g.label.length>160||!/^[a-f0-9]{64}$/.test(g.signature)||!Number.isFinite(g.cohesion)||g.cohesion<0||g.cohesion>1||!Array.isArray(g.memberIds)||g.memberIds.length<2||g.memberIds.length>5000||!Array.isArray(g.domainIds)||g.domainIds.some((d:any)=>typeof d!=="string"||d.length>100))return false;ids.add(g.id);for(const id of g.memberIds){if(typeof id!=="string"||!id||id.length>100||members.has(id))return false;members.add(id);}}
  return members.size<=5000;
}
export class KnowledgeCommunities {
  private saved?:KnowledgeCommunitySnapshot;private loaded=false;private tail:Promise<unknown>=Promise.resolve();
  constructor(readonly root:string){}
  update(graph:KnowledgeGraph){graph=brainGraph(graph);const next=this.tail.then(async()=>{
    const path=join(this.root,"indexes","community-candidates.json");
    if(!this.loaded){this.loaded=true;try{const value=JSON.parse(await readFile(path,"utf8"));if(validCommunityCache(value))this.saved=value;}catch{/* Derived cache can be rebuilt; original records are unaffected. */}}
    if(this.saved?.inputHash===inputFingerprint(graph))return this.saved;
    const candidate=discoverKnowledgeCommunities(graph,this.saved);
    await atomicJson(path,candidate);this.saved=candidate;return candidate;
  });this.tail=next.catch(()=>{});return next;}
}
