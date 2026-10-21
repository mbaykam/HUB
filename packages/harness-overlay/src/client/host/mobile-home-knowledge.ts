import type {KnowledgeGraph} from "../../knowledge-contract.ts";
import {knowledgeRecordCounts} from "../../knowledge-record-scope.ts";
import {createKnowledgeCloud} from "../memory/knowledge-cloud.ts";
import {openMemoryGraph} from "../memory/graph-browser.ts";

export function createHomeKnowledge(root:Document){
  const view=root.defaultView!,panel=root.createElement("section"),stats=root.createElement("div"),preview=root.createElement("div"),title=root.createElement("h2"),numbers=root.createElement("dl"),status=root.createElement("p"),open=root.createElement("button");
  panel.dataset.hubHomeKnowledge="";panel.setAttribute("aria-label","Knowledge overview");stats.className="hub-home-knowledge-stats";preview.className="hub-home-knowledge-map";title.textContent="Knowledge";open.type="button";open.textContent="Explore knowledge";status.setAttribute("role","status");stats.append(title,numbers,status,open);panel.append(stats,preview);
  let enabled=false,graph:KnowledgeGraph|undefined,cloud:ReturnType<typeof createKnowledgeCloud>|undefined,flight:AbortController|undefined,timer:number|undefined,disposeGraph:(()=>void)|undefined,disposed=false,retrying=false;
  open.addEventListener("click",()=>{if(retrying){void load();return;}if(!graph)return;disposeGraph?.();disposeGraph=openMemoryGraph(panel,root,graph as any,()=>{disposeGraph=undefined;});});
  async function load(){
    if(!enabled||root.hidden||flight)return;const controller=flight=new AbortController();
    try{status.textContent=graph?"":"Loading your knowledge…";const r=await view.fetch("/api/hub/memory?view=graph",{credentials:"same-origin",cache:"no-store",signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15_000)])});if(!r.ok)throw Error();const next=await r.json() as KnowledgeGraph;
      if(!enabled||controller.signal.aborted||disposed)return;if(!next.secondBrain||!Array.isArray(next.nodes)||!Array.isArray(next.edges))throw Error();graph=next;
      const count=knowledgeRecordCounts(next.nodes),domains=next.domains?.filter(d=>!d.parentId&&d.status==="active").length??0;numbers.replaceChildren();
      for(const [label,value]of [["Brain notes",count.brain],["Domains",domains],["Connections",next.edges.length],["Chat archive",count.chats]] as const){const row=root.createElement("div"),term=root.createElement("dt"),number=root.createElement("dd");term.textContent=label;number.textContent=value.toLocaleString();row.append(number,term);numbers.append(row);}
      status.textContent=next.partial?"Showing the indexed part of your knowledge.":next.nodes.length?"":"Your saved knowledge will grow here.";
      if(!cloud){cloud=createKnowledgeCloud(root,()=>open.click());preview.append(cloud.canvas);cloud.canvas.setAttribute("aria-label","3D knowledge preview. Drag to rotate; explore knowledge to read records.");}cloud.update(next);cloud.resize();open.disabled=false;retrying=false;open.textContent="Explore knowledge";
    }catch{if(enabled&&!controller.signal.aborted){status.textContent="Knowledge could not load. Tap to retry.";open.textContent="Retry knowledge";retrying=true;}}
    finally{if(flight===controller)flight=undefined;}
  }
  function update(active:boolean){if(enabled===active)return;enabled=active;panel.hidden=!active;view.clearInterval(timer);if(active){void load();timer=view.setInterval(()=>void load(),60000);}else{flight?.abort();flight=undefined;cloud?.dispose();cloud=undefined;preview.replaceChildren();}}
  const visible=()=>{if(enabled&&!root.hidden)void load();};root.addEventListener("visibilitychange",visible);panel.hidden=true;
  return{panel,update,dispose(){disposed=true;update(false);root.removeEventListener("visibilitychange",visible);disposeGraph?.();panel.remove();}};
}
