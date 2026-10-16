import type {KnowledgeGraph,KnowledgeNode} from "../knowledge-contract.ts";

/** A name may be ambiguous; an index must not turn that into a guessed link. */
export class KnowledgeLinkIndex<T extends {id:string;title:string;permalink:string}> {
  private readonly paths=new Map<string,T[]>();
  private readonly names=new Map<string,Map<string,T>>();
  constructor(notes:readonly T[]){
    for(const note of notes){
      const path=this.paths.get(note.permalink)??[];path.push(note);this.paths.set(note.permalink,path);
      for(const name of [note.title,note.permalink.split("/").at(-1)!]){
        if(!this.names.has(name))this.names.set(name,new Map());
        this.names.get(name)!.set(note.id,note);
      }
    }
  }
  resolve(target:string,from?:T){
    const value=target.split("|")[0]!.split("#")[0]!.replace(/\.md$/,"").trim();
    if(!value)return undefined;
    const relative=from?.permalink.includes("/")?from.permalink.slice(0,from.permalink.lastIndexOf("/"))+"/"+value:value;
    const exact=new Map([...(this.paths.get(value)??[]),...(this.paths.get(relative)??[])].map(note=>[note.id,note]));
    if(exact.size===1)return exact.values().next().value;
    const named=this.names.get(value);
    return named?.size===1?named.values().next().value:undefined;
  }
}

type Relation=NonNullable<KnowledgeGraph["relationships"]>[number];
export interface KnowledgeConnectionPath {
  sourceId:string;targetId:string;found:boolean;complete:boolean;
  nodes:KnowledgeNode[];relations:Relation[];visited:number;inspectedRelations:number;
  limitedBy?:"depth"|"records"|"relations"|"source-coverage";
  meaning:"A chain of recorded relationships, not proof of causation or a new fact";
}

/** Generation-local adjacency preserves every relation identity and predicate.
 * Graphify's seed/traversal approach informed this index; no upstream code is
 * copied here. Similarity and domain containment are not factual paths. */
export class KnowledgeTopology {
  readonly nodes:Map<string,KnowledgeNode>;
  private readonly incidence=new Map<string,Relation[]>();
  private readonly partial:boolean;
  constructor(graph:Pick<KnowledgeGraph,"nodes"|"relationships">&{partial?:boolean}){
    this.partial=!!graph.partial;
    this.nodes=new Map(graph.nodes.map(node=>[node.id,node]));
    for(const relation of graph.relationships??[]){
      if(!this.nodes.has(relation.sourceId)||!this.nodes.has(relation.targetId)||relation.status!=="active")continue;
      for(const id of new Set([relation.sourceId,relation.targetId])){
        const edges=this.incidence.get(id)??[];edges.push(relation);this.incidence.set(id,edges);
      }
    }
    for(const edges of this.incidence.values())edges.sort((a,b)=>a.id.localeCompare(b.id));
  }
  neighbors(id:string){return this.incidence.get(id)??[];}

  path(sourceId:string,targetId:string,limits:{depth?:number;records?:number;relations?:number;directed?:boolean}={}):KnowledgeConnectionPath{
    if(!this.nodes.has(sourceId)||!this.nodes.has(targetId))throw Error("Choose two existing Knowledge records");
    const maxDepth=limits.depth??4,maxRecords=limits.records??600,maxRelations=limits.relations??4000;
    if(!Number.isSafeInteger(maxDepth)||maxDepth<1||maxDepth>8||!Number.isSafeInteger(maxRecords)||maxRecords<2||maxRecords>5000||!Number.isSafeInteger(maxRelations)||maxRelations<1||maxRelations>20000)throw Error("Invalid connection search budget");
    const parents=new Map<string,{id:string;relation:Relation}>(),depths=new Map([[sourceId,0]]),queue=[sourceId];
    let inspected=0,limitedBy:KnowledgeConnectionPath["limitedBy"],found=sourceId===targetId;
    for(let head=0;head<queue.length&&!found;head++){
      const id=queue[head]!,depth=depths.get(id)!;
      const edges=this.neighbors(id);
      if(depth>=maxDepth){if(edges.some(edge=>(!limits.directed||edge.direction!=="directed"||edge.sourceId===id)&&!depths.has(edge.sourceId===id?edge.targetId:edge.sourceId)))limitedBy??="depth";continue;}
      // A directly connected target takes precedence over generic hub traffic.
      const ordered=[...edges].sort((a,b)=>Number(b.sourceId===targetId||b.targetId===targetId)-Number(a.sourceId===targetId||a.targetId===targetId)||a.id.localeCompare(b.id));
      for(const edge of ordered){
        if(inspected>=maxRelations){limitedBy="relations";break;}
        inspected++;
        if(limits.directed&&edge.direction==="directed"&&edge.sourceId!==id)continue;
        const next=edge.sourceId===id?edge.targetId:edge.sourceId;
        if(depths.has(next))continue;
        if(depths.size>=maxRecords){limitedBy="records";break;}
        depths.set(next,depth+1);parents.set(next,{id,relation:edge});queue.push(next);
        if(next===targetId){found=true;break;}
      }
      if(limitedBy==="records"||limitedBy==="relations")break;
    }
    const ids=found?[targetId]:[],relations:Relation[]=[];
    if(found){let id=targetId;while(id!==sourceId){const parent=parents.get(id)!;relations.unshift(parent.relation);ids.unshift(parent.id);id=parent.id;}}
    if(!found&&this.partial)limitedBy??="source-coverage";
    return {sourceId,targetId,found,complete:found||!limitedBy,nodes:ids.map(id=>this.nodes.get(id)!),relations,visited:depths.size,inspectedRelations:inspected,...(!found&&limitedBy?{limitedBy}:{}),meaning:"A chain of recorded relationships, not proof of causation or a new fact"};
  }
}
