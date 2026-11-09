import {knowledgeLayout,type LayoutGraph} from './knowledge-layout.ts';

/** A readable 2D projection of canonical memberships, never a domain migration.
 * Give small life domains room beside the much larger original-chat archive. */
export function knowledgeMap2D(graph:LayoutGraph,aspect=1){
  const spatial=knowledgeLayout(graph),byGroup=new Map(spatial.groups.map(g=>[g.id,g]));
  const roots=spatial.groups.filter(g=>!g.parentId&&g.members.length).sort((a,b)=>a.status==='archive'?1:b.status==='archive'?-1:a.id.localeCompare(b.id));
  const columns=roots.length<2?1:Math.max(2,Math.min(roots.length,Math.round(Math.sqrt(roots.length*Math.max(.45,Math.min(2,aspect))))));
  const centers=new Map(roots.map((g,i)=>[g.id,{x:(i%columns)*350,y:Math.floor(i/columns)*310}]));
  const rootOf=(id:string)=>{let g=byGroup.get(id);for(let i=0;g?.parentId&&i<5;i++)g=byGroup.get(g.parentId);return g;};
  const points=spatial.points.map(p=>{const group=rootOf(p.domainId)!,center=centers.get(group.id)!;
    const dx=p.x-group.x,dy=p.y-group.y,dz=p.z-group.z;
    return {...p,color:p.domainId==='unassigned'?'hsl(220 12% 66%)':p.color,x:center.x+(dx*.94-dz*.3),y:center.y+(dy*.94+dz*.12),z:0};
  });
  const byId=new Map(points.map(p=>[p.id,p]));
  const groups=spatial.groups.filter(g=>g.members.length).map(g=>{const center=centers.get(g.id),members=g.members.map(id=>byId.get(id)!).filter(Boolean);return {...g,...(center??{x:members.reduce((n,p)=>n+p.x,0)/members.length,y:members.reduce((n,p)=>n+p.y,0)/members.length}),z:0};});
  return {points,groups};
}
