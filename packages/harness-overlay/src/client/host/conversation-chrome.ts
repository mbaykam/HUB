import type {HarnessClientContext} from "../core/context.ts";
import {defineOverlayStyle} from "../shared/style-runtime.ts";
import styles from "./conversation-chrome.css";
const installStyles=defineOverlayStyle("hub-conversation-chrome",styles);
/** Keep native controls in their React owners. A small proxy opens the native
 * log action; statistics are a read-only view of its live rendered projection. */
export function installConversationChrome(ctx:HarnessClientContext,root:Document=document){
  const view=root.defaultView!,offStyle=installStyles(root),title=root.createElement("strong"),menu=root.createElement("details"),summary=root.createElement("summary"),body=root.createElement("div"),log=root.createElement("button"),stats=root.createElement("section");
  title.dataset.hubConversationTitle="";menu.dataset.hubActionMenu="Conversation actions";menu.dataset.hubIconMenu="";menu.dataset.hubConversationMenu="";summary.textContent="⋮";summary.setAttribute("aria-label","Conversation actions");log.type="button";log.textContent="Download session log";stats.setAttribute("aria-label","Session statistics");body.append(log,stats);menu.append(summary,body);
  log.addEventListener("click",()=>{root.querySelector<HTMLButtonElement>('[data-hub-native-log]')?.click();menu.open=false;});
  let frame:number|undefined,disposed=false,lastSession:string|undefined,lastStats:string|undefined;
  function render(){frame=undefined;if(disposed)return;const state=ctx.sessions.list.getSnapshot(),id=state.current,nav=root.querySelector('[data-hub-home-nav]');
    if(lastSession!==id){menu.open=false;lastSession=id;}
    if(!id||!nav){title.remove();menu.remove();return;}if(title.parentElement!==nav)nav.append(title);if(menu.parentElement!==nav)nav.append(menu);
    const text=state.byId[id]?.displayTitle??state.byId[id]?.title??"Conversation";if(title.textContent!==text){title.textContent=text;title.title=text;}
    for(const b of root.querySelectorAll<HTMLButtonElement>('[data-slot="conversation.session.header.utilities"] button'))if(/^(Session log|会话日志)$/.test(b.textContent?.trim()??"")&&!b.hasAttribute("data-hub-native-log"))b.setAttribute("data-hub-native-log","");
    // The native database glyph is a per-turn token popover, separate from
    // feedback actions. Its aggregate remains available in the session menu.
    for(const b of root.querySelectorAll<HTMLButtonElement>('[data-turn-tail] button[aria-haspopup="dialog"]'))if(/^(Usage\b|用量|使用量)/.test(b.textContent?.trim()??"")&&!b.hasAttribute("data-hub-turn-usage"))b.setAttribute("data-hub-turn-usage","");
    log.disabled=!root.querySelector('[data-hub-native-log]');
    const nativeStats=root.querySelector('[data-hub-chat-stats]'),values=nativeStats?[...nativeStats.querySelectorAll("span")].filter(e=>e.getAttribute("aria-hidden")!=="true").map(e=>e.textContent?.trim()).filter(Boolean):[];
    const key=values.join("\n");if(lastStats!==key){lastStats=key;stats.replaceChildren();if(!values.length)stats.textContent="No usage recorded yet.";else for(const [i,value]of values.entries()){if(i)stats.append(root.createTextNode("\n"));const row=root.createElement("p");row.textContent=value!;stats.append(row);}}
  }
  const schedule=()=>{if(!disposed&&frame===undefined)frame=view.requestAnimationFrame(render);};const observer=new view.MutationObserver(schedule);observer.observe(root.body,{childList:true,subtree:true,characterData:true});const off=ctx.sessions.list.subscribe(schedule);schedule();
  return()=>{disposed=true;off();observer.disconnect();if(frame!==undefined)view.cancelAnimationFrame(frame);title.remove();menu.remove();for(const e of root.querySelectorAll('[data-hub-native-log]'))e.removeAttribute("data-hub-native-log");for(const e of root.querySelectorAll('[data-hub-turn-usage]'))e.removeAttribute("data-hub-turn-usage");offStyle();};
}
