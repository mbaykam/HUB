import {defineOverlayStyle} from "../shared/style-runtime.ts";
import styles from "./chat-activity-groups.css";
const installStyles=defineOverlayStyle("hub-chat-activity-groups",styles);
interface Group {button:HTMLButtonElement;rows:HTMLElement[];open:boolean}

/** Fold adjacent tool/context activity without reparenting React-owned nodes.
 * Public messages, approvals, failures and the running action stay visible. */
export function installChatActivityGroups(root:Document=document){
  const view=root.defaultView!,offStyle=installStyles(root),groups=new Map<HTMLElement,Group>(),badges=new Map<HTMLElement,HTMLElement>(),nativeContexts=new Set<HTMLElement>();let frame:number|undefined,disposed=false;
  const isHidden=(row:HTMLElement)=>row.hidden||row.getAttribute("data-turn-process-hidden")==="true";
  function clear(group:Group){for(const row of group.rows)row.removeAttribute("data-hub-activity-folded");group.button.remove();}
  function update(first:HTMLElement,rows:HTMLElement[]){
    let group=groups.get(first);
    if(!group){const button=root.createElement("button");button.type="button";button.setAttribute("data-hub-chat-activity","");group={button,rows:[],open:false};const owned=group;button.addEventListener("click",()=>{owned.open=!owned.open;schedule();});groups.set(first,group);}
    for(const old of group.rows)if(!rows.includes(old))old.removeAttribute("data-hub-activity-folded");group.rows=rows;
    const calls=rows.filter(row=>row.dataset.chatFlowKind==="tool-call"),updates=rows.filter(row=>row.dataset.chatFlowKind!=="tool-call"&&row.textContent?.trim()),failed=calls.filter(row=>row.querySelector('[data-tool][data-state="error"]')),working=calls.some(row=>row.querySelector('[data-tool][data-state="running"],[data-tool][data-state="pending"]'));
    const parts=[working?"Working":"Activity",...(calls.length?[`${calls.length} tool ${calls.length===1?"call":"calls"}`]:[]),...(updates.length?[`${updates.length} ${updates.length===1?"update":"updates"}`]:[]),...(failed.length?[`${failed.length} failed`]:[]),group.open?"Hide details ▴":"Show details ▾"];
    const label=parts.join(" · ");if(group.button.textContent!==label)group.button.textContent=label;group.button.setAttribute("aria-expanded",String(group.open));
    if(group.button.nextElementSibling!==first)first.before(group.button);
    for(const row of rows){const protectedRow=!!row.querySelector('[role="alert"],[data-tool][data-state="error"],[data-tool][data-state="running"],[data-tool][data-state="pending"]');row.toggleAttribute("data-hub-activity-folded",!group.open&&!protectedRow);}
  }
  function scan(){frame=undefined;if(disposed)return;const fresh=new Set<HTMLElement>(),contextPlan=new Map<HTMLElement,boolean>();
    if(root.documentElement.hasAttribute("data-minke-mobile-web"))for(const flow of root.querySelectorAll<HTMLElement>('[data-chat-flow]')){
      const nativeGroups=new Map([...flow.querySelectorAll<HTMLElement>('[data-turn-process]')].map(button=>[button.dataset.turnProcess,button]));
      for(const [turn,button]of nativeGroups){
        const failures=[...flow.querySelectorAll<HTMLElement>('[data-chat-flow-kind="tool-call"]')].filter(row=>row.dataset.chatTurn===turn&&row.querySelector('[data-tool][data-state="error"]')).length;
        const contextRows=[...flow.querySelectorAll<HTMLElement>('[data-chat-flow-kind="system-prompt"],[data-chat-flow-kind="context"]')].filter(row=>row.dataset.chatTurn===turn&&!row.querySelector('[role="alert"]'));
        for(const row of contextRows)contextPlan.set(row,button.getAttribute("aria-expanded")!=="true");
        let badge=badges.get(button);const text=(contextRows.length?` · ${contextRows.length} updates`:"")+(failures?` · ${failures} failed`:"");if(text){if(!badge){badge=root.createElement("span");badge.setAttribute("data-hub-activity-failure","");badges.set(button,badge);button.append(badge);}if(badge.textContent!==text)badge.textContent=text;}else if(badge){badge.remove();badges.delete(button);}
      }
      let rows:HTMLElement[]=[],turn:string|undefined;
      const flush=()=>{const meaningful=rows.filter(row=>row.dataset.chatFlowKind==="tool-call"||row.textContent?.trim());if(meaningful.length>=2){fresh.add(rows[0]!);update(rows[0]!,rows);}rows=[];turn=undefined;};
      for(const row of [...flow.children].filter((n):n is HTMLElement=>n instanceof view.HTMLElement)){
        if(row.hasAttribute("data-hub-chat-activity"))continue;
        const kind=row.dataset.chatFlowKind,activity=kind==="tool-call"||kind==="context"||kind==="system-prompt"||kind==="assistant-step"&&!row.textContent?.trim();
        if(isHidden(row)||nativeGroups.has(row.dataset.chatTurn)||!activity||row.querySelector('[data-approval],[data-slot*="approval"]')){flush();continue;}
        if(rows.length&&turn!==row.dataset.chatTurn)flush();turn=row.dataset.chatTurn;rows.push(row);
      }flush();
    }
    for(const [first,group]of groups)if(!fresh.has(first)){clear(group);groups.delete(first);}
    for(const row of nativeContexts)if(!contextPlan.has(row))row.removeAttribute("data-hub-activity-folded");nativeContexts.clear();for(const [row,folded]of contextPlan){row.toggleAttribute("data-hub-activity-folded",folded);nativeContexts.add(row);}
    for(const [button,badge]of badges)if(!button.isConnected){badge.remove();badges.delete(button);}
  }
  function schedule(){if(!disposed&&frame===undefined)frame=view.requestAnimationFrame(scan);}
  const observer=new view.MutationObserver(records=>{if(records.some(r=>!(r.target instanceof view.Element&&r.target.closest('[data-hub-chat-activity],[data-hub-activity-failure]'))))schedule();});
  observer.observe(root.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:["data-state","aria-expanded","data-turn-process-hidden","data-chat-flow-kind","hidden","data-minke-mobile-web"]});scan();
  return ()=>{disposed=true;observer.disconnect();if(frame!==undefined)view.cancelAnimationFrame(frame);for(const group of groups.values())clear(group);groups.clear();for(const row of nativeContexts)row.removeAttribute("data-hub-activity-folded");nativeContexts.clear();for(const badge of badges.values())badge.remove();badges.clear();offStyle();};
}
