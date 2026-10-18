import {defineOverlayStyle} from "../shared/style-runtime.ts";
import styles from "./panel-navigation.css";
const installStyles=defineOverlayStyle("hub-panel-navigation",styles);

/** Preserve the existing handlers and draft guards. A native select supplies
 * compact, keyboard-accessible section navigation on narrow PWA screens. */
export function installPanelNavigation(root:Document=document){
  const view=root.defaultView!,offStyle=installStyles(root),mounted=new Map<HTMLElement,{label:HTMLLabelElement;select:HTMLSelectElement;buttons:HTMLButtonElement[];signature:string}>();let frame:number|undefined;
  const selectors='[data-hub-mobile-settings] [role="tablist"],[data-hub-instructions] .instruction-sections,[data-knowledge-menu] [role="tablist"],[data-hub-goals] [role="tablist"]';
  function scan(){frame=undefined;for(const nav of root.querySelectorAll<HTMLElement>(selectors)){
    const buttons=[...nav.querySelectorAll<HTMLButtonElement>('button[role="tab"],button[data-instruction-section]')];if(buttons.length<4)continue;
    let state=mounted.get(nav);if(!state){const label=root.createElement("label"),select=root.createElement("select");label.setAttribute("data-hub-tab-picker","");const title=nav.getAttribute("aria-label")??(nav.closest("[data-knowledge-menu]")?"Knowledge AI section":nav.closest("[data-hub-goals]")?"Goal section":"Settings section");label.append(root.createTextNode(title),select);select.setAttribute("aria-label",title);state={label,select,buttons:[],signature:""};const owned=state;select.addEventListener("change",()=>{owned.buttons[Number(select.value)]?.click();view.queueMicrotask(scan);});mounted.set(nav,state);nav.setAttribute("data-hub-compact-navigation","");}
    if(state.label.nextElementSibling!==nav)nav.before(state.label);state.buttons=buttons;
    const labels=buttons.map(b=>(b.querySelector("strong")?.textContent??b.textContent??"").trim()),signature=JSON.stringify(labels.map((label,i)=>[label,buttons[i]!.disabled]));
    if(signature!==state.signature){state.select.replaceChildren(...labels.map((text,index)=>{const option=root.createElement("option");option.textContent=text;option.value=String(index);option.disabled=buttons[index]!.disabled;return option;}));state.signature=signature;}
    const selected=buttons.findIndex(b=>b.getAttribute("aria-selected")==="true"||b.getAttribute("aria-pressed")==="true");if(selected>=0)state.select.value=String(selected);
  }for(const [nav,state]of mounted)if(!nav.isConnected){state.label.remove();mounted.delete(nav);}}
  const schedule=()=>{if(frame===undefined)frame=view.requestAnimationFrame(scan);};
  const observer=new view.MutationObserver(schedule);observer.observe(root.body,{childList:true,subtree:true,attributes:true,attributeFilter:["aria-selected","aria-pressed","disabled"]});scan();
  return ()=>{observer.disconnect();if(frame!==undefined)view.cancelAnimationFrame(frame);for(const [nav,state]of mounted){state.label.remove();nav.removeAttribute("data-hub-compact-navigation");}mounted.clear();offStyle();};
}
