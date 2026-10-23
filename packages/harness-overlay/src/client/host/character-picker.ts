import {defineOverlayStyle} from "../shared/style-runtime.ts";
import styles from "./composer-controls.css";
export const installComposerControlStyles=defineOverlayStyle("hub-composer-controls",styles);
export function anchoredPopover(root:Document,button:HTMLButtonElement,label:string){
  const panel=root.createElement("div");panel.className="hub-composer-popover";panel.setAttribute("role","dialog");panel.setAttribute("aria-label",label);panel.tabIndex=-1;
  button.setAttribute("aria-haspopup","dialog");button.setAttribute("aria-expanded","true");root.body.append(panel);
  const place=()=>{const box=button.getBoundingClientRect(),v=root.defaultView!,above=box.top-20,below=v.innerHeight-box.bottom-20,up=above>=panel.scrollHeight||above>below;
    panel.style.left=Math.max(12,Math.min(box.left,v.innerWidth-panel.offsetWidth-12))+"px";
    panel.style.maxHeight=Math.max(60,Math.min(430,up?above:below))+"px";
    panel.style.bottom=up?Math.max(12,v.innerHeight-box.top+8)+"px":"auto";panel.style.top=up?"auto":Math.max(12,box.bottom+8)+"px";
  };
  const close=()=>{root.removeEventListener("pointerdown",outside);root.removeEventListener("keydown",key);root.removeEventListener("scroll",place,true);root.defaultView?.removeEventListener("resize",place);button.setAttribute("aria-expanded","false");panel.remove();button.focus();};
  const outside=(e:Event)=>{if(!panel.contains(e.target as Node)&&!button.contains(e.target as Node))close();};
  const key=(e:KeyboardEvent)=>{if(e.key==="Escape"){e.preventDefault();e.stopPropagation();close();}if(e.key==="Tab"){const items=[...panel.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];if(!items.length){e.preventDefault();return;}if(e.shiftKey&&root.activeElement===items[0]){e.preventDefault();items.at(-1)?.focus();}else if(!e.shiftKey&&root.activeElement===items.at(-1)){e.preventDefault();items[0]?.focus();}}};
  root.addEventListener("pointerdown",outside);root.addEventListener("keydown",key);root.addEventListener("scroll",place,true);root.defaultView?.addEventListener("resize",place);place();panel.focus();return {panel,close,place};
}
export function createCharacterPicker(root:Document,sessionId:()=>string|undefined){
  const removeStyle=installComposerControlStyles(root),button=root.createElement("button");button.type="button";button.className="hub-composer-button";button.setAttribute("aria-label","Choose character");button.title="Choose character";button.setAttribute("aria-expanded","false");
  button.innerHTML='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10" cy="8" r="3.5"/><path d="M3 20v-2a7 7 0 0 1 14 0v2M18 7l3 3-3 3"/></svg>';
  let popup:ReturnType<typeof anchoredPopover>|undefined,flight:AbortController|undefined,disposed=false;
  button.addEventListener("click",()=>{if(popup?.panel.isConnected){popup.close();popup=undefined;return;}const id=sessionId();if(!id)return;popup=anchoredPopover(root,button,"Choose character");const current=popup;flight?.abort();flight=new AbortController();
    const note=root.createElement("p");note.setAttribute("role","status");note.textContent="Loading characters…";current.panel.append(note);
    const close=root.createElement("button");close.type="button";close.textContent="Close";close.setAttribute("data-popup-close","");close.onclick=()=>current.close();
    void(async()=>{try{
      const response=await root.defaultView!.fetch(`/api/hub/characters?view=picker&sessionId=${encodeURIComponent(id)}`,{headers:{"x-hub-characters":"1"},signal:flight!.signal});if(!response.ok)throw Error("Characters could not load. Try again.");const data=await response.json();if(disposed||!current.panel.isConnected||id!==sessionId())return;
      note.textContent=data.canSelect?(data.pending?"Selection applies to the next reply.":"Choose who replies in this conversation."):"This task has an assigned character.";
      for(const c of data.characters){const row=root.createElement("button");row.type="button";row.setAttribute("role","radio");row.setAttribute("aria-checked",String(c.id===data.selectedId));row.disabled=!data.canSelect||!c.model;const name=root.createElement("strong"),meta=root.createElement("small");name.textContent=c.name;meta.textContent=c.model?`${c.role} · ${c.model}`:"Choose a model in Settings first";row.append(name,meta);current.panel.append(row);
        row.onclick=async()=>{for(const b of current.panel.querySelectorAll("button"))b.disabled=true;note.textContent="Switching…";try{const r=await root.defaultView!.fetch("/api/hub/characters",{method:"POST",headers:{"content-type":"application/json","x-hub-characters":"1"},body:JSON.stringify({action:"select",revision:data.revision,id:c.id,sessionId:id})});const result=await r.json();if(!r.ok)throw Error(r.status===409?"Characters changed. Close and reopen this picker.":"Couldn’t switch. Reopen the picker to check the current character.");root.dispatchEvent(new CustomEvent("hub:character-changed",{detail:{sessionId:id,characterId:c.id,pending:result.pending}}));note.textContent=result.pending?`${c.name} will reply next.`:`Now speaking with ${c.name}.`;for(const r of current.panel.querySelectorAll('[role="radio"]'))r.setAttribute("aria-checked",String(r===row));close.disabled=false;close.focus();}catch(e){note.textContent=e instanceof Error?e.message:"Couldn’t confirm the switch. Reopen to check.";close.disabled=false;close.focus();}};
      }
      current.panel.append(close);current.place();current.panel.querySelector<HTMLButtonElement>('button[aria-checked="true"]')?.focus();
    }catch(e){if(!current.panel.isConnected)return;note.textContent=e instanceof Error?e.message:"Characters unavailable.";current.panel.append(close);}})();
  });
  return {button,dispose(){disposed=true;flight?.abort();popup?.close();button.remove();removeStyle();}};
}
