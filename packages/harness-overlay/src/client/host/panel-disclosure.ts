import {defineOverlayStyle} from "../shared/style-runtime.ts";
import styles from "./panel-disclosure.css";
const installStyles=defineOverlayStyle("hub-panel-disclosure",styles);

/** Explicit close actions for expandable settings. Native details semantics
 * retain keyboard support. Folder trees and chat disclosures stay unchanged. */
export function installPanelDisclosure(root:Document=document){
  const view=root.defaultView!;const offStyle=installStyles(root),owned=new Map<HTMLDetailsElement,HTMLButtonElement>();
  const selector='[data-hub-graph-dialog] details,[data-hub-settings-controls] details,[data-hub-instructions] details,[data-hub-characters] details,[data-hub-work] details,[data-hub-goals] details,[data-hub-automations] details,[data-hub-models] details,[data-hub-speech-settings] details,[data-hub-tools] details,[data-knowledge-menu] details,dialog[aria-label="Telegram connection"] details,[data-slot="sidebar.settings"] details';
  function scan(){for(const details of root.querySelectorAll<HTMLDetailsElement>(selector)){
    if(details.hasAttribute("data-hub-action-menu")||details.hasAttribute("data-hub-compact-disclosure")||details.closest('[data-knowledge-tree]')||details.querySelector(':scope > [data-hub-collapse]'))continue;
    const summary=details.querySelector<HTMLElement>(":scope > summary");if(!summary)continue;
    details.setAttribute("data-hub-disclosure","");
    const close=root.createElement("button");close.type="button";close.textContent="Collapse";close.setAttribute("data-hub-collapse","");close.setAttribute("aria-label","Collapse "+summary.textContent);
    close.addEventListener("click",()=>{details.open=false;summary.focus();});summary.insertAdjacentElement("afterend",close);owned.set(details,close);
  }}
  const observer=new view.MutationObserver(scan);observer.observe(root.body,{childList:true,subtree:true});scan();
  const escape=(event:KeyboardEvent)=>{const menu=root.querySelector<HTMLDetailsElement>('[data-hub-action-menu][open]');if(event.key==="Escape"&&menu){event.preventDefault();event.stopImmediatePropagation();menu.open=false;menu.querySelector<HTMLElement>("summary")?.focus();}};
  const outside=(event:PointerEvent)=>{for(const menu of root.querySelectorAll<HTMLDetailsElement>('[data-hub-action-menu][open]'))if(event.target instanceof view.Node&&!menu.contains(event.target))menu.open=false;};
  const toggle=(event:Event)=>{const menu=event.target;if(menu instanceof view.HTMLDetailsElement&&menu.hasAttribute("data-hub-action-menu")){const summary=menu.querySelector("summary");if(summary&&!menu.hasAttribute("data-hub-icon-menu")){const label=menu.getAttribute("data-hub-action-menu")||"More actions";summary.textContent=menu.open?"Close actions":label;}}};
  root.addEventListener("keydown",escape,true);root.addEventListener("pointerdown",outside,true);root.addEventListener("toggle",toggle,true);
  return ()=>{observer.disconnect();root.removeEventListener("keydown",escape,true);root.removeEventListener("pointerdown",outside,true);root.removeEventListener("toggle",toggle,true);for(const [details,close]of owned){close.remove();details.removeAttribute("data-hub-disclosure");}offStyle();};
}
