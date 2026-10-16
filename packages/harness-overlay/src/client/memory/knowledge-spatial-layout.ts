/** Canonical memberships are many-to-many. Coordinates are only a view. */
export interface LayoutGraph {
  nodes:{id:string;title:string}[];edges:{source:string;target:string}[];
  similarities?:{source:string;target:string;score:number}[];
  domains?:{id:string;title:string;parentId?:string;status:string;mergedInto?:string;createdAt?:number}[];
  memberships?:{nodeId:string;domainId:string}[];
}
export interface CloudPosition {id:string;label:string;group:number;domainId:string;domainIds:string[];rootIds:string[];color:string;x:number;y:number;z:number}
export interface CloudGroup {id:string;name:string;parentId?:string;level:number;status:string;members:string[];color:string;radius:number;x:number;y:number;z:number}
export function knowledgeHash(s:string){let h=2166136261;for(const c of s)h=Math.imul(h^c.charCodeAt(0),16777619);h=Math.imul(h^(h>>>16),0x85ebca6b);h=Math.imul(h^(h>>>13),0xc2b2ae35);return (h^(h>>>16))>>>0;}
const unit=(s:string)=>knowledgeHash(s)/0xffffffff;
export const knowledgeColor=(id:string)=>`hsl(${Math.round(unit(id+":color")*360)} 53% 72%)`;
function vector(id:string,r:number){const z=unit(id+":z")*2-1,a=unit(id+":a")*Math.PI*2,v=Math.sqrt(Math.max(0,1-z*z));return {x:Math.cos(a)*v*r,y:Math.sin(a)*v*r,z:z*r};}

export function knowledgeLayout(graph:LayoutGraph,options:{focusDomain?:string;displayDomainByNode?:Record<string,string>}={}){
  const nodes=[...graph.nodes].sort((a,b)=>a.id.localeCompare(b.id)),known=new Set(nodes.map(n=>n.id)),domains=new Map((graph.domains??[]).filter(d=>d.status!=="merged").map(d=>[d.id,d]));
  const ancestors=new Map<string,string[]>();for(const d of domains.values()){const path:string[]=[];let current:typeof d|undefined=d;while(current&&!path.includes(current.id)&&path.length<5){path.push(current.id);current=domains.get(current.parentId??"");}ancestors.set(d.id,path);}
  const memberships=new Map<string,Set<string>>();for(const m of graph.memberships??[])if(known.has(m.nodeId)&&domains.has(m.domainId)){if(!memberships.has(m.nodeId))memberships.set(m.nodeId,new Set());memberships.get(m.nodeId)!.add(m.domainId);}
  const weights=new Map(nodes.map(n=>[n.id,new Map<string,number>()]));const connect=(a:string,b:string,w:number)=>{if(a===b||!known.has(a)||!known.has(b))return;weights.get(a)!.set(b,Math.max(w,weights.get(a)!.get(b)??0));weights.get(b)!.set(a,Math.max(w,weights.get(b)!.get(a)??0));};
  for(const e of [...graph.edges].sort((a,b)=>(a.source+":"+a.target).localeCompare(b.source+":"+b.target)))connect(e.source,e.target,2.4);
  for(const e of [...(graph.similarities??[])].sort((a,b)=>(a.source+":"+a.target).localeCompare(b.source+":"+b.target)))if(e.score>=.56)connect(e.source,e.target,e.score);
  const labels=new Map(nodes.map(n=>[n.id,"unassigned"]));
  if(!domains.size){
    // Display-only affinities never create factual links or canonical domains.
    for(const n of nodes)if(weights.get(n.id)!.size)labels.set(n.id,n.id);
    for(let pass=0;pass<6;pass++)for(const n of nodes){const counts=new Map<string,number>();for(const [id,w]of weights.get(n.id)!){const key=labels.get(id)!;counts.set(key,(counts.get(key)??0)+w);}const best=[...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0];if(best)labels.set(n.id,best[0]);}
  }else for(const n of nodes){
    const ids=[...(memberships.get(n.id)??[])],preferred=options.displayDomainByNode?.[n.id],focused=ids.filter(id=>ancestors.get(id)?.includes(options.focusDomain??"")),choices=focused.length?focused:ids;
    // Rendezvous hashing is a stable presentation choice, not UUID primacy.
    choices.sort((a,b)=>(ancestors.get(b)?.length??0)-(ancestors.get(a)?.length??0)||knowledgeHash(n.id+b)-knowledgeHash(n.id+a));labels.set(n.id,preferred&&choices.includes(preferred)?preferred:choices[0]??"unassigned");
  }
  const groups:CloudGroup[]=[],byGroup=new Map<string,CloudGroup>(),occupied:CloudGroup[]=[];
  const roots=[...domains.values()].filter(d=>!d.parentId).sort((a,b)=>(a.createdAt??0)-(b.createdAt??0)||a.id.localeCompare(b.id));
  for(const d of roots){let p=vector(d.id+":anchor",230+unit(d.id)*100);for(let attempt=0;attempt<64&&occupied.some(g=>Math.hypot(p.x-g.x,p.y-g.y,p.z-g.z)<245);attempt++)p=vector(d.id+":anchor:"+attempt,260+attempt*9);const g:CloudGroup={id:d.id,name:d.title,level:0,status:d.status,members:[],color:knowledgeColor(d.id),radius:112,...p};groups.push(g);byGroup.set(g.id,g);occupied.push(g);}
  const ordered=[...domains.values()].filter(d=>d.parentId).sort((a,b)=>(ancestors.get(a.id)?.length??0)-(ancestors.get(b.id)?.length??0)||(a.createdAt??0)-(b.createdAt??0)||a.id.localeCompare(b.id));
  for(const d of ordered){const parent=byGroup.get(d.parentId!);if(!parent)continue;const siblings=groups.filter(g=>g.parentId===parent.id);let offset=vector(d.id+":anchor",parent.radius*.62);for(let attempt=0;attempt<48&&siblings.some(g=>Math.hypot(parent.x+offset.x-g.x,parent.y+offset.y-g.y)<parent.radius*.66);attempt++)offset=vector(d.id+":anchor:"+attempt,parent.radius*.62);const rootId=ancestors.get(d.id)?.at(-1)??d.id,g:CloudGroup={id:d.id,name:d.title,parentId:d.parentId,level:parent.level+1,status:d.status,members:[],color:knowledgeColor(rootId),radius:parent.radius*.32,x:parent.x+offset.x,y:parent.y+offset.y,z:parent.z+offset.z};groups.push(g);byGroup.set(g.id,g);}
  const legacyIds=[...new Set([...labels.values()].filter(id=>!byGroup.has(id)))].sort();for(const id of legacyIds){const central=nodes.find(n=>labels.get(n.id)===id),p=domains.size||legacyIds.length>1?vector(id+":anchor",id==="unassigned"?0:260):{x:0,y:0,z:0},g:CloudGroup={id,name:id==="unassigned"?"Unassigned":central?.title??"Related records",level:0,status:"active",members:[],color:knowledgeColor(id),radius:112,...p};groups.push(g);byGroup.set(id,g);}
  const rootIds=groups.filter(g=>!g.parentId).map(g=>g.id),rootIndex=new Map(rootIds.map((id,i)=>[id,i]));
  const points:CloudPosition[]=nodes.map(n=>{const domainId=labels.get(n.id)!,g=byGroup.get(domainId)!,domainIds=[...(memberships.get(n.id)??[])].sort(),recordRoots=[...new Set(domainIds.map(id=>ancestors.get(id)?.at(-1)??id))].sort(),rootId=ancestors.get(domainId)?.at(-1)??domainId,offset=vector(n.id,Math.cbrt(unit(n.id+":radius"))*g.radius*.88);g.members.push(n.id);return {id:n.id,label:n.title,group:rootIndex.get(rootId)??0,domainId,domainIds,rootIds:recordRoots,color:knowledgeColor(rootId),x:g.x+offset.x,y:g.y+offset.y,z:g.z+offset.z};});
  for(const g of [...groups].sort((a,b)=>b.level-a.level))if(g.parentId){const parent=byGroup.get(g.parentId);if(parent)parent.members.push(...g.members);}
  return {points,groups};
}
export function projectKnowledgePreview(graph:LayoutGraph){
  const {points,groups}=knowledgeLayout(graph),byId=new Map(points.map(p=>[p.id,p])),roots=groups.filter(g=>!g.parentId),selected:CloudPosition[]=[],seen=new Set<string>();
  for(let i=0;selected.length<64;i++){let added=false;for(const g of roots){const p=byId.get(g.members[i]??"");if(p&&!seen.has(p.id)){selected.push(p);seen.add(p.id);added=true;if(selected.length===64)break;}}if(!added)break;}
  const projected=selected.map(p=>({...p,px:p.x*.94-p.z*.3,py:p.y*.94+p.z*.12}));let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;for(const p of projected){minX=Math.min(minX,p.px);maxX=Math.max(maxX,p.px);minY=Math.min(minY,p.py);maxY=Math.max(maxY,p.py);}const scale=Math.min(210/Math.max(180,maxX-minX),84/Math.max(120,maxY-minY)),cx=selected.length?(minX+maxX)/2:0,cy=selected.length?(minY+maxY)/2:0;
  return projected.map(p=>({id:p.id,group:p.group,color:p.color,x:120+(p.px-cx)*scale,y:55+(p.py-cy)*scale,depth:p.z}));
}
