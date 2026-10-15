import {installMobileGoals} from "./mobile-goals.ts";
import {installMobileAutomations} from "./mobile-automations.ts";
import {installMobileMemoryGraph} from "./mobile-memory-graph.ts";
import {defineOverlayStyle} from "../shared/style-runtime.ts";
const style=defineOverlayStyle("hub-desktop-secondary-panel",`
[data-hub-desktop-panel-open]{position:fixed;right:10px;top:64px;z-index:40;border:1px solid #bac7ee33;background:#171e30c9;backdrop-filter:blur(18px);color:#e6edff;border-radius:12px;padding:10px 15px;font:inherit;cursor:pointer}
[data-hub-desktop-right-panel]{position:fixed;right:12px;top:112px;bottom:20px;width:320px;max-width:90vw;z-index:41;padding:18px;border:1px solid #bac7ee33;border-radius:22px;background:radial-gradient(ellipse at 90% 0%,#836ab72b,transparent 70%),#111724f5;backdrop-filter:blur(24px);box-shadow:0 20px 60px #0008;overflow:auto;color:#ecf0ff}
[data-hub-desktop-right-panel][hidden]{display:none!important}[data-hub-desktop-right-panel]>header{display:flex;align-items:center;justify-content:space-between;font:inherit}[data-hub-desktop-right-panel]>header button{border:1px solid #bac7ee33;border-radius:10px;background:#ffffff08;color:#ecf0ff;padding:9px 12px;font:inherit;cursor:pointer}
@media(max-width:1023px){[data-hub-desktop-panel-open],[data-hub-desktop-right-panel]{display:none!important}}
`);
/** The same right-panel features are reachable in the desktop and wide PWA.
 * Keep the native tool-detail column intact; this is a secondary global panel. */
export function installDesktopRightPanel(root:Document=document){const removeStyle=style(root),button=root.createElement("button"),panel=root.createElement("aside"),header=root.createElement("header"),label=root.createElement("strong"),close=root.createElement("button"),body=root.createElement("div");
  button.type="button";button.textContent="Panel";button.setAttribute("data-hub-desktop-panel-open","");button.setAttribute("aria-label","Open Knowledge, Automations and Goals");button.setAttribute("aria-expanded","false");panel.setAttribute("data-hub-desktop-right-panel","");panel.setAttribute("aria-label","Knowledge, automations and goals");panel.hidden=true;label.textContent="Your workspace";close.type="button";close.textContent="Close";header.append(label,close);panel.append(header,body);root.body.append(button,panel);
  const setOpen=(open:boolean)=>{panel.hidden=!open;button.setAttribute("aria-expanded",String(open));};button.addEventListener("click",()=>setOpen(!!panel.hidden));close.addEventListener("click",()=>setOpen(false));const dismiss=(event:KeyboardEvent)=>{if(event.key==="Escape"&&!root.querySelector("dialog[open]")){setOpen(false);button.focus();}};root.addEventListener("keydown",dismiss);
  const disposers=[installMobileMemoryGraph(body,root),installMobileAutomations(body,root),installMobileGoals(body,root)];return ()=>{for(const dispose of disposers)dispose();root.removeEventListener("keydown",dismiss);button.remove();panel.remove();removeStyle();};
}
