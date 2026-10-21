import {knowledgeLayout} from "./knowledge-layout.ts";
import type {KnowledgeGraph} from "../../knowledge-contract.ts";

/** Lightweight, actual 2D overview. No WebGL, animation or model requests. */
export function createKnowledgePreview2D(root:Document,onOpen:(id:string)=>void){
  const ns="http://www.w3.org/2000/svg",panel=root.createElement("div"),svg=root.createElementNS(ns,"svg"),controls=root.createElement("div");
  panel.className="hub-knowledge-preview-2d";svg.setAttribute("role","group");svg.setAttribute("aria-label","2D brain preview. Select a note to read it.");controls.className="hub-knowledge-preview-controls";
  let bounds=[0,0,400,220],zoom=1;
  function fit(){const [x,y,w,h]=bounds;svg.setAttribute("viewBox",`${x+w/2-w/zoom/2} ${y+h/2-h/zoom/2} ${w/zoom} ${h/zoom}`);}
  for(const [label,text,factor]of [["Zoom out preview","−",.8],["Fit preview","Fit",0],["Zoom in preview","+",1.25]] as const){const b=root.createElement("button");b.type="button";b.textContent=text;b.setAttribute("aria-label",label);b.addEventListener("click",()=>{zoom=factor?Math.min(4,Math.max(.5,zoom*factor)):1;fit();});controls.append(b);}
  panel.append(svg,controls);
  return{panel,update(graph:KnowledgeGraph){
    const layout=knowledgeLayout(graph),byId=new Map(layout.points.map(p=>[p.id,p])),selected=new Set<string>();
    const groups=layout.groups.filter(g=>!g.parentId&&g.members.length);
    for(let i=0;selected.size<128;i++){let added=false;for(const g of groups){const id=g.members[i];if(id&&!selected.has(id)){selected.add(id);added=true;if(selected.size===128)break;}}if(!added)break;}
    const points=layout.points.filter(p=>selected.has(p.id)).map(p=>({...p,px:(p.x*.94-p.z*.3)*2.4,py:(p.y*.94+p.z*.12)*2.4})),positions=new Map(points.map(p=>[p.id,p]));
    svg.replaceChildren();svg.setAttribute("data-visible-notes",String(points.length));
    const xs=points.map(p=>p.px),ys=points.map(p=>p.py),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
    bounds=points.length?[minX-65,minY-65,Math.max(160,maxX-minX+130),Math.max(130,maxY-minY+130)]:[0,0,400,220];zoom=1;fit();
    for(const edge of graph.edges){const a=positions.get(edge.source),b=positions.get(edge.target);if(!a||!b)continue;const line=root.createElementNS(ns,"line");for(const [k,v]of Object.entries({x1:a.px,y1:a.py,x2:b.px,y2:b.py}))line.setAttribute(k,String(v));line.setAttribute("stroke","#a4b5cf");line.setAttribute("stroke-opacity",".28");line.setAttribute("stroke-width","1");line.setAttribute("vector-effect","non-scaling-stroke");svg.append(line);}
    const unit=Math.max(bounds[2]/400,bounds[3]/230);
    for(const group of groups.filter(g=>g.id!=="unassigned")){
      const members=points.filter(p=>group.members.includes(p.id));if(!members.length)continue;
      const label=root.createElementNS(ns,"text"),x=members.reduce((n,p)=>n+p.px,0)/members.length,y=Math.min(...members.map(p=>p.py))-22*unit;
      label.textContent=group.name;label.setAttribute("x",String(x));label.setAttribute("y",String(Math.max(bounds[1]+18*unit,y)));label.setAttribute("text-anchor","middle");label.setAttribute("fill",group.color);label.setAttribute("font-size",String(12*unit));label.setAttribute("pointer-events","none");svg.append(label);
    }
    for(const p of points){const g=root.createElementNS(ns,"g"),hit=root.createElementNS(ns,"circle"),dot=root.createElementNS(ns,"circle"),title=root.createElementNS(ns,"title");g.setAttribute("transform",`translate(${p.px} ${p.py})`);g.setAttribute("role","button");g.setAttribute("tabindex","0");g.setAttribute("aria-label","Read "+p.label);hit.setAttribute("r",String(18*unit));hit.setAttribute("fill","transparent");dot.setAttribute("r",String(5*unit));dot.setAttribute("fill",p.color);title.textContent=p.label;g.append(hit,dot,title);g.addEventListener("click",()=>onOpen(p.id));g.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();onOpen(p.id);}});svg.append(g);}
    panel.setAttribute("aria-description",`${points.length} of ${byId.size} brain notes shown. Chat originals are in Explore knowledge.`);
  },dispose(){panel.remove();}};
}
