import type {KnowledgeGraph} from "../../knowledge-contract.ts";
type Point={id:string;label:string;group:number;x:number;y:number;z:number;sx:number;sy:number;r:number;depth:number};
/** A real 3D projection. Semantic proximity groups notes; solid edges remain actual links. */
export function createKnowledgeCloud(root:Document,onOpen:(id:string)=>void){
  const view=root.defaultView!,canvas=root.createElement("canvas");canvas.setAttribute("data-knowledge-cloud","");canvas.setAttribute("aria-label","3D knowledge cloud. Drag to rotate; pinch or scroll to zoom. Use Notes to select with the keyboard.");
  let graph:KnowledgeGraph,points:Point[]=[],groups:{name:string;members:Point[]}[]=[],yaw=.2,pitch=.12,zoom=1,frame=0,disposed=false,active:string|undefined,local=false;
  const colors=["#80cbbd","#a79adf","#86b9e8","#dfad89","#db99bc","#bad290"];
  const hash=(value:string)=>{let result=2166136261;for(const c of value)result=Math.imul(result^c.charCodeAt(0),16777619);return result>>>0;};
  function update(next:KnowledgeGraph){
    graph=next;const weights=new Map(next.nodes.map(n=>[n.id,new Map<string,number>()]));
    const edge=(a:string,b:string,w:number)=>{weights.get(a)?.set(b,Math.max(w,weights.get(a)?.get(b)??0));weights.get(b)?.set(a,Math.max(w,weights.get(b)?.get(a)??0));};
    for(const e of next.edges)edge(e.source,e.target,2.4);
    for(const e of next.similarities??[])if(e.score>=.56)edge(e.source,e.target,e.score*3.2);
    const labels=new Map(next.nodes.map(n=>[n.id,n.id]));
    for(let pass=0;pass<8;pass++)for(const n of [...next.nodes].sort((a,b)=>a.id.localeCompare(b.id))){const counts=new Map<string,number>();for(const [id,w]of weights.get(n.id)??[]){const key=labels.get(id)!;counts.set(key,(counts.get(key)??0)+w);}const best=[...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0];if(best)labels.set(n.id,best[0]);}
    const ids=[...new Set(labels.values())].sort();
    points=next.nodes.map(n=>{const group=ids.indexOf(labels.get(n.id)!),h=hash(n.id),angle=(h%10000)/10000*Math.PI*2,spread=18+Math.sqrt((h>>>8)%1000)*1.3;const vertical=ids.length>1?(1-2*(group+.5)/ids.length):0,centerAngle=group*2.39996,radius=ids.length>1?230*Math.sqrt(1-vertical*vertical):0;return {id:n.id,label:n.title,group,x:Math.cos(centerAngle)*radius+Math.cos(angle)*spread,y:vertical*230+Math.sin(angle)*spread*.8,z:Math.sin(centerAngle)*radius+((h>>>17)%100-50)*.6,sx:0,sy:0,r:0,depth:0};});
    groups=ids.map((_id,index)=>{const members=points.filter(p=>p.group===index);const central=[...members].sort((a,b)=>next.edges.filter(e=>e.source===b.id).length-next.edges.filter(e=>e.source===a.id).length||a.label.localeCompare(b.label))[0];return {name:central?.label??"Topic",members};});canvas.dataset.topicCount=String(groups.length);drawSoon();
  }
  function drawSoon(){if(!frame&&!disposed)frame=view.requestAnimationFrame(draw);}
  function draw(){
    frame=0;const rect=canvas.getBoundingClientRect();if(rect.width<1||rect.height<1||!graph)return;
    const dpi=Math.min(view.devicePixelRatio||1,2);canvas.width=Math.round(rect.width*dpi);canvas.height=Math.round(rect.height*dpi);const ctx=canvas.getContext("2d")!;ctx.scale(dpi,dpi);const dark=root.body.hasAttribute("data-ds-dark-theme")||root.documentElement.classList.contains("dark"),w=rect.width,h=rect.height;
    ctx.clearRect(0,0,w,h);const scale=Math.min(w,h)/520*zoom;
    const neighbours=new Set([active,...graph.edges.filter(e=>e.source===active||e.target===active).flatMap(e=>[e.source,e.target])]);
    for(const p of points){const x=p.x*Math.cos(yaw)-p.z*Math.sin(yaw),z=p.x*Math.sin(yaw)+p.z*Math.cos(yaw),y=p.y*Math.cos(pitch)-z*Math.sin(pitch);p.depth=p.y*Math.sin(pitch)+z*Math.cos(pitch);const perspective=600/(600+p.depth);p.sx=w/2+x*scale*perspective;p.sy=h/2+y*scale*perspective;p.r=(p.id===active?9:5)*perspective;}
    for(const [index,group]of groups.entries()){
      if(!group.members.length)continue;const x=group.members.reduce((s,p)=>s+p.sx,0)/group.members.length,y=group.members.reduce((s,p)=>s+p.sy,0)/group.members.length;
      const radius=Math.max(55,...group.members.map(p=>Math.hypot(p.sx-x,p.sy-y)+34));const gradient=ctx.createRadialGradient(x,y,3,x,y,radius);gradient.addColorStop(0,colors[index%colors.length]+(dark?"25":"30"));gradient.addColorStop(1,colors[index%colors.length]+"00");ctx.fillStyle=gradient;ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);ctx.fill();
      if(group.members.length>1){ctx.font="12px system-ui";ctx.textAlign="center";ctx.fillStyle=dark?"#b8c9df":"#647896";ctx.fillText(group.name.slice(0,32),x,y-radius+20);}
    }
    for(const e of graph.edges){const a=points.find(p=>p.id===e.source),b=points.find(p=>p.id===e.target);if(!a||!b)continue;ctx.strokeStyle=dark?"#b1bce04a":"#597aa650";ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(a.sx,a.sy);ctx.lineTo(b.sx,b.sy);ctx.stroke();}
    for(const p of [...points].sort((a,b)=>b.depth-a.depth)){
      ctx.globalAlpha=local&&active&&!neighbours.has(p.id)?.18:1;ctx.fillStyle=colors[p.group%colors.length]!;ctx.shadowColor=ctx.fillStyle;ctx.shadowBlur=12;ctx.beginPath();ctx.arc(p.sx,p.sy,p.r,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
      if(points.length<=12||p.id===active||zoom>=1.7){ctx.font=`${p.id===active?"600 ":""}12px system-ui`;ctx.textAlign="center";ctx.fillStyle=dark?"#e7edf8":"#354965";ctx.fillText(p.label.length>30?p.label.slice(0,28)+"…":p.label,p.sx,p.sy+p.r+17);}
    }ctx.globalAlpha=1;
  }
  const touches=new Map<number,{x:number;y:number}>();let previous:{x:number;y:number}|undefined,start:{x:number;y:number}|undefined,pinch=0,moved=false;
  canvas.style.touchAction="none";
  canvas.addEventListener("pointerdown",e=>{canvas.setPointerCapture(e.pointerId);touches.set(e.pointerId,{x:e.clientX,y:e.clientY});previous={x:e.clientX,y:e.clientY};start=previous;moved=false;});
  canvas.addEventListener("pointermove",e=>{if(!touches.has(e.pointerId))return;touches.set(e.pointerId,{x:e.clientX,y:e.clientY});if(touches.size>1){const [a,b]=[...touches.values()];const distance=Math.hypot(a!.x-b!.x,a!.y-b!.y);if(pinch)zoom=Math.min(4,Math.max(.35,zoom*distance/pinch));pinch=distance;moved=true;}else if(previous){yaw+=(e.clientX-previous.x)*.008;pitch=Math.max(-1.3,Math.min(1.3,pitch+(e.clientY-previous.y)*.008));if(start&&Math.hypot(e.clientX-start.x,e.clientY-start.y)>6)moved=true;}previous={x:e.clientX,y:e.clientY};drawSoon();});
  canvas.addEventListener("pointerup",e=>{touches.delete(e.pointerId);if(!moved){const rect=canvas.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;const point=[...points].sort((a,b)=>a.depth-b.depth).find(p=>Math.hypot(p.sx-x,p.sy-y)<Math.max(18,p.r+8));if(point){active=point.id;drawSoon();onOpen(point.id);}}previous=undefined;pinch=0;});canvas.addEventListener("pointercancel",e=>{touches.delete(e.pointerId);previous=undefined;pinch=0;});
  canvas.addEventListener("wheel",e=>{e.preventDefault();zoom=Math.min(4,Math.max(.35,zoom*Math.exp(-e.deltaY*.001)));drawSoon();},{passive:false});
  const resize=new view.ResizeObserver(drawSoon);resize.observe(canvas);
  return {canvas,update,fit(){zoom=1;yaw=.2;pitch=.12;drawSoon();},select(id?:string,filter=false){active=id;local=filter;drawSoon();},resize:drawSoon,dispose(){disposed=true;resize.disconnect();if(frame)view.cancelAnimationFrame(frame);canvas.remove();}};
}
