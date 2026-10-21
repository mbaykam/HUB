import {defineOverlayStyle} from "../shared/style-runtime.ts";
import styles from "./response-typography.css";

const installStyles=defineOverlayStyle("hub-response-typography",styles);

/** Style native rendered Markdown without rewriting messages or reparenting
 * React-owned nodes. User messages, tool results and reasoning stay separate. */
export function installResponseTypography(root:Document=document){
  const view=root.defaultView!,offStyle=installStyles(root);
  const owned=new Map<HTMLElement,Map<string,string|null>>();
  let frame:number|undefined,disposed=false;
  function attribute(el:HTMLElement,name:string,value:string){
    let prior=owned.get(el);if(!prior){prior=new Map();owned.set(el,prior);}
    if(!prior.has(name))prior.set(name,el.getAttribute(name));
    if(el.getAttribute(name)!==value)el.setAttribute(name,value);
  }
  function restore(el:HTMLElement,prior:Map<string,string|null>){
    for(const [name,value]of prior)if(value===null)el.removeAttribute(name);else el.setAttribute(name,value);
    owned.delete(el);
  }
  function scan(){
    frame=undefined;if(disposed)return;
    for(const [el,prior]of owned)if(!el.isConnected)restore(el,prior);
    for(const row of root.querySelectorAll('[data-chat-flow-kind="assistant-step"]')){
      for(const el of row.querySelectorAll<HTMLElement>('[class*="markdown"]')){
        if(![...el.classList].some(c=>/(?:^|_)markdown(?:_|$)/.test(c))||el.closest('[data-turn-process-inline],[data-variant="think"]'))continue;
        attribute(el,"data-hub-response-markdown","");
        for(const table of el.querySelectorAll("table")){
          const wrap=table.parentElement;if(!wrap||wrap===el)continue;
          attribute(wrap,"data-hub-response-table","");
          if(!wrap.hasAttribute("tabindex"))attribute(wrap,"tabindex","0");
          if(!wrap.hasAttribute("aria-label"))attribute(wrap,"aria-label","Scrollable table");
          if(!wrap.hasAttribute("role"))attribute(wrap,"role","region");
        }
      }
    }
  }
  const schedule=()=>{if(!disposed&&frame===undefined)frame=view.requestAnimationFrame(scan);};
  const observer=new view.MutationObserver(schedule);observer.observe(root.body,{childList:true,subtree:true});scan();
  return()=>{disposed=true;observer.disconnect();if(frame!==undefined)view.cancelAnimationFrame(frame);for(const [el,prior]of owned)restore(el,prior);offStyle();};
}
