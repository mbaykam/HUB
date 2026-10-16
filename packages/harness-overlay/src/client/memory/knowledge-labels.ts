export function knowledgeLabelStyle(kind:"root"|"domain"|"node",screenRadius:number,selected=false,wasVisible=false,sparse=false){
  if(!Number.isFinite(screenRadius)||screenRadius<=0)return {font:12,opacity:0};
  const threshold=kind==="root"?4:kind==="domain"?20:sparse?2:7.2,margin=kind==="node"?2.8:kind==="root"?8:14,start=threshold-(wasVisible?margin*.3:0);
  const opacity=selected?1:Math.max(0,Math.min(1,(screenRadius-start)/margin));
  const font=kind==="node"?Math.max(10,Math.min(16,10+screenRadius*.45)):Math.max(12,Math.min(21,11+Math.sqrt(screenRadius)*.8));
  return {font:selected?Math.max(14,font):font,opacity};
}
export interface KnowledgeLabelBox {x:number;y:number;width:number;height:number}
export function placeKnowledgeLabel(box:KnowledgeLabelBox,viewport:{width:number;height:number},occupied:readonly KnowledgeLabelBox[],kind:"root"|"domain"|"node",selected=false,preferred?:{dx:number;dy:number}){
  const offsets=kind==="node"?[{dx:0,dy:0}]:[...(preferred?[preferred]:[]),{dx:0,dy:0},...[1,-1,2,-2,3,-3,4,-4].flatMap(step=>[{dx:0,dy:step*(box.height+5)},{dx:step*(box.width*.55+5),dy:0}])];
  for(const offset of offsets){
    const candidate={...box,x:Math.max(6,Math.min(viewport.width-box.width-6,box.x+offset.dx)),y:box.y+offset.dy};
    if(candidate.y<4||candidate.y+candidate.height>viewport.height-4)continue;
    if(!selected&&occupied.some(other=>candidate.x<other.x+other.width&&candidate.x+candidate.width>other.x&&candidate.y<other.y+other.height&&candidate.y+candidate.height>other.y))continue;
    return {box:candidate,offset:{dx:candidate.x-box.x,dy:candidate.y-box.y}};
  }
  return undefined;
}
