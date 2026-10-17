import type {KnowledgeRelation,KnowledgeRelationScope,KnowledgeEvidence} from "../../knowledge-relation-contract.ts";
import type {KnowledgeNode} from "../../knowledge-contract.ts";
interface Neighborhood {recordId:string;total:number;items:(KnowledgeRelation&{scope:KnowledgeRelationScope;node:KnowledgeNode})[];nextCursor:string|null}
interface ConnectionPath {found:boolean;complete:boolean;limitedBy?:string;meaning:string;nodes:KnowledgeNode[];relations:(KnowledgeRelation&{scope:KnowledgeRelationScope})[]}
type Request=<T>(query:string,command?:unknown)=>Promise<T>;
/** Paging is a display budget. Every persisted relationship remains reachable. */
export function createKnowledgeNeighbors(root:Document,request:Request,onOpen:(id:string)=>void,onEvidence:(relationId:string,index:number,evidence:KnowledgeEvidence)=>void){
  const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const n=root.createElement(tag);if(text!==undefined)n.textContent=text;return n;},pane=el("section"),status=el("p"),items=el("div"),trace=el("details"),search=el("input"),targets=el("div"),pathStatus=el("p"),pathBody=el("div");pane.dataset.knowledgeNeighbors="";status.setAttribute("role","status");pathStatus.setAttribute("role","status");
  search.type="search";search.placeholder="Find another record…";search.setAttribute("aria-label","Find a connection target");
  trace.append(el("summary","Trace connections to another record"),el("p","Choose an existing record to see the sourced chain between them."),search,targets,pathStatus,pathBody);pane.append(el("h4","Connections"),trace,status,items);
  let current:string|undefined,disposed=false,shown=0,version=0,queryVersion=0,pathVersion=0,paging=false;
  const button=(label:string,run:()=>void)=>{const b=el("button",label);b.type="button";b.addEventListener("click",run);return b;};
  async function load(id:string,cursor=""){
    if(cursor&&paging)return;
    if(!cursor){current=id;shown=0;version++;queryVersion++;pathVersion++;items.replaceChildren();targets.replaceChildren();pathBody.replaceChildren();pathStatus.textContent="";search.value="";paging=false;}
    const generation=version;paging=true;const oldMore=items.querySelector<HTMLButtonElement>("[data-more-connections]");if(oldMore)oldMore.disabled=true;status.textContent="Loading sourced connections…";
    try{const data=await request<Neighborhood>(`view=neighbors&id=${encodeURIComponent(id)}&cursor=${encodeURIComponent(cursor)}`);if(disposed||current!==id||generation!==version)return;
      items.querySelector("[data-more-connections]")?.remove();for(const relation of data.items){const card=el("article");card.className="knowledge-domain-card";card.append(button(relation.node.title,()=>onOpen(relation.node.id)),el("p",`${relation.scope==="short"?"Within a domain":relation.scope==="long"?"Across domains":relation.scope==="archive"?"Chat archive link":"Domain unassigned"} · ${relation.predicate}`),el("small",relation.interpretation?"Knowledge AI interpretation":relation.id.startsWith("source-")?"Recorded source conversation":"Link in the original document"));if(relation.evidence.length){const why=el("details");why.append(el("summary","Source excerpts"));for(const [index,ref]of relation.evidence.entries()){why.append(el("blockquote",ref.quote),el("p",[ref.role,ref.occurredAt?new Date(ref.occurredAt).toLocaleString():undefined].filter(Boolean).join(" · ")),button("Inspect this source",()=>onEvidence(relation.id,index,ref)));}card.append(why);}items.append(card);}shown+=data.items.length;status.textContent=data.total?`${shown} / ${data.total} connections shown` :"No sourced connections yet. Similarity alone does not establish a relationship.";
      if(data.nextCursor){const more=button("More connections",()=>void load(id,data.nextCursor!));more.dataset.moreConnections="";items.append(more);}
    }catch(e){if(!disposed&&generation===version)status.textContent=(e as Error).message;}
    finally{if(generation===version){paging=false;if(oldMore?.isConnected)oldMore.disabled=false;}}
  }
  async function targetSearch(){
    const query=search.value.trim(),generation=++queryVersion,id=current;targets.replaceChildren();if(query.length<2||!id)return;pathStatus.textContent="Finding matching records…";
    try{const result=await request<{nodes:KnowledgeNode[]}>(`view=search&q=${encodeURIComponent(query)}`);if(disposed||generation!==queryVersion||current!==id)return;const matches=result.nodes.filter(node=>node.id!==id);for(const node of matches.slice(0,8))targets.append(button(node.title,()=>void findPath(id,node)));pathStatus.textContent=matches.length>8?"Showing the first 8 matches. Refine your search to find another record.":matches.length?"Choose a record to trace its connections.":"No matching record found.";}catch(e){if(!disposed&&generation===queryVersion)pathStatus.textContent=(e as Error).message;}
  }
  async function findPath(id:string,target:KnowledgeNode){
    const generation=++pathVersion;pathBody.replaceChildren();pathStatus.textContent="Following sourced connections…";
    try{const path=await request<ConnectionPath>(`view=path&id=${encodeURIComponent(id)}&target=${encodeURIComponent(target.id)}`);if(disposed||generation!==pathVersion||current!==id)return;if(!path.found){pathStatus.textContent=path.complete?"No sourced connection chain was found.":"The bounded search did not reach this record. A connection may exist beyond the search limit.";return;}pathStatus.textContent=path.nodes.map(node=>node.title).join(" → ");pathBody.append(el("p",path.meaning));for(const [i,relation]of path.relations.entries()){const card=el("article");card.className="knowledge-domain-card";card.append(button(path.nodes[i+1]!.title,()=>onOpen(path.nodes[i+1]!.id)),el("p",relation.predicate),el("small",relation.interpretation?"Knowledge AI interpretation":relation.id.startsWith("source-")?"Recorded source conversation":"Link in the original document"));for(const [index,ref]of relation.evidence.entries())card.append(el("blockquote",ref.quote),button("Inspect this source",()=>onEvidence(relation.id,index,ref)));pathBody.append(card);}}catch(e){if(!disposed&&generation===pathVersion)pathStatus.textContent=(e as Error).message;}
  }
  let timer:ReturnType<typeof setTimeout>|undefined;search.addEventListener("input",()=>{queryVersion++;pathVersion++;targets.replaceChildren();pathBody.replaceChildren();pathStatus.textContent="";clearTimeout(timer);timer=setTimeout(()=>void targetSearch(),250);});
  return {pane,load,dispose(){disposed=true;version++;queryVersion++;pathVersion++;clearTimeout(timer);}};
}
