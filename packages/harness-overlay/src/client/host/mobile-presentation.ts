import { parsePresentationSummary, type PresentationSummary } from "../../presentation-contract.ts";
import { defineOverlayStyle } from "../shared/style-runtime.ts";
import styles from "./mobile-presentation.css";
import type { HarnessClientContext } from "../core/context.ts";
const installStyles = defineOverlayStyle("hub-mobile-presentation", styles);

/** One nonmodal canvas in the conversation; expansion uses the top layer without
 * moving/recreating the iframe. Controls never request models or own audio. */
export function createMobilePresentation(root: Document) {
  const view=root.defaultView!,removeStyles=installStyles(root);
  const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const node=root.createElement(tag);if(text)node.textContent=text;return node;};
  const button=el("button","Canvas"),dialog=el("dialog"),toolbar=el("header"),title=el("strong","Canvas"),expand=el("button","Expand"),hide=el("button","Hide"),options=el("details"),menu=el("div"),follow=el("button","Live updates"),update=el("button","Show latest"),reset=el("button","Reset visual"),status=el("p"),stage=el("div");
  button.hidden=true;button.dataset.hubOpenVisual="";dialog.dataset.hubVisualDialog="";dialog.setAttribute("aria-label","Conversation canvas");stage.dataset.visualStage="";status.setAttribute("role","status");follow.setAttribute("aria-pressed","true");update.hidden=true;
  for(const b of [button,expand,hide,follow,update,reset])b.type="button";
  options.append(el("summary","Options"),menu);menu.append(follow,update,reset,el("small","Inputs stay in this visual. Reset, reload or a new version starts it over."));toolbar.append(title,expand,hide);dialog.append(toolbar,options,status,stage);root.body.append(dialog);
  let owner:string|undefined,sessionId:string|undefined,selectedCall:string|undefined,latest:PresentationSummary|undefined,showing:string|undefined;
  let following=true,expanded=false,ignoredCloses=0,disposed=false,epoch=0,busy=false,opening=false;
  let controller:AbortController|undefined,documentLoad:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  const seen=new Set<string>();
  function schedule(delay=1500){clearTimeout(timer);if(!disposed&&owner&&!root.hidden)timer=setTimeout(()=>void refresh(),delay);}
  async function request(action:string,identity:string,signal:AbortSignal,id?:string){
    const voice=identity.startsWith("voice:");
    const response=await view.fetch(`/api/hub/${voice?"voice/":""}${action}`,{credentials:"same-origin",cache:"no-store",headers:{[voice?"x-hub-voice-call":"x-hub-session"]:identity.slice(identity.indexOf(":")+1),...(id?{"x-hub-presentation":id}:{})},signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});
    if(!response.ok)throw Error("Canvas unavailable");return response.json();
  }
  function setExpanded(next:boolean){
    if(!dialog.open)return;
    closeInternally();expanded=next;dialog.toggleAttribute("data-expanded",next);expand.textContent=next?"Back to chat":"Expand";if(next){dialog.showModal();expand.focus();}else{dialog.setAttribute("open","");reveal();}
  }
  function reveal(){view.requestAnimationFrame(()=>{if(!disposed&&dialog.open&&!expanded)dialog.scrollIntoView?.({block:"start",behavior:"smooth"});});}
  // Browsers dispatch close asynchronously. A temporary flag would mistake a
  // queued internal close for Escape and immediately collapse full-screen.
  function closeInternally(){if(dialog.open){ignoredCloses++;dialog.close();}}
  async function open(bringIntoView=false){
    if(!owner||!latest||opening||disposed)return;
    // Reopening a visible canvas is navigation, not a reset of its local inputs.
    if(dialog.open&&showing===latest.id){if(bringIntoView)reveal();return;}
    const identity=owner,item=latest,version=epoch;opening=true;seen.add(item.id);if(seen.size>128)seen.delete(seen.values().next().value!);
    title.textContent=item.title;status.textContent="Opening visual…";if(!dialog.open)dialog.setAttribute("open","");if(bringIntoView)reveal();
    documentLoad?.abort();const pending=new AbortController();documentLoad=pending;
    try{
      const result=await request("presentation-document",identity,pending.signal,item.id);
      if(disposed||pending.signal.aborted||version!==epoch||owner!==identity||!dialog.open)return;
      if(typeof result.document!=="string"||result.document.length>3000000)throw Error("Invalid visual document");
      const frame=el("iframe");frame.title=item.title;frame.setAttribute("sandbox","allow-scripts");frame.setAttribute("allow","camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'");frame.referrerPolicy="no-referrer";frame.srcdoc=result.document;
      stage.replaceChildren(frame);showing=item.id;update.hidden=true;status.textContent="";
    }catch{if(!pending.signal.aborted&&!disposed&&version===epoch&&dialog.open)status.textContent="This visual couldn’t open. Use Canvas to try again; your conversation stays available.";}
    finally{if(version===epoch)opening=false;if(documentLoad===pending)documentLoad=undefined;}
  }
  async function refresh(){
    if(!owner||busy||disposed||root.hidden)return;busy=true;controller=new AbortController();const identity=owner,version=epoch;
    try{
      const result=await request("presentation",identity,controller.signal);if(disposed||version!==epoch||identity!==owner)return;
      latest=result.presentation===null?undefined:parsePresentationSummary(result.presentation);button.hidden=!latest;
      if(latest){button.setAttribute("aria-label",`Open canvas · ${latest.title}`);button.title=latest.title;update.hidden=!dialog.open||showing===latest.id;
        if(dialog.open&&showing!==latest.id&&following&&!opening)void open();
        if(!seen.has(latest.id)&&!dialog.open&&!root.querySelector("dialog[open][data-expanded]"))void open(true);
      }
    }catch{/* Canvas availability must never interrupt chat, tools or audio. */}
    finally{busy=false;controller=undefined;schedule();}
  }
  function dismiss(restoreFocus=true){documentLoad?.abort();opening=false;closeInternally();expanded=false;dialog.removeAttribute("data-expanded");expand.textContent="Expand";stage.replaceChildren();showing=undefined;if(restoreFocus)button.focus();}
  hide.addEventListener("click",()=>dismiss());expand.addEventListener("click",()=>setExpanded(!expanded));button.addEventListener("click",()=>void open(true));
  follow.addEventListener("click",()=>{following=!following;follow.setAttribute("aria-pressed",String(following));if(following&&latest?.id!==showing)void open();});update.addEventListener("click",()=>void open());
  reset.addEventListener("click",()=>{const frame=stage.querySelector("iframe");if(frame)frame.srcdoc=frame.srcdoc;options.open=false;});
  dialog.addEventListener("close",()=>{if(ignoredCloses){ignoredCloses--;return;}if(disposed)return;if(expanded){expanded=false;dialog.removeAttribute("data-expanded");expand.textContent="Expand";dialog.setAttribute("open","");}else{documentLoad?.abort();opening=false;stage.replaceChildren();showing=undefined;}});
  const visibility=()=>{if(root.hidden){clearTimeout(timer);controller?.abort();}else schedule(0);};root.addEventListener("visibilitychange",visibility);
  function selectOwner(){
    const next=selectedCall?"voice:"+selectedCall:sessionId?"session:"+sessionId:undefined;if(next===owner)return;
    epoch++;controller?.abort();documentLoad?.abort();clearTimeout(timer);owner=next;latest=undefined;showing=undefined;opening=false;button.hidden=true;update.hidden=true;dismiss(false);schedule(0);
  }
  return {button,dialog,setCall(next:string|undefined){selectedCall=next;selectOwner();},setSession(next:string|undefined){sessionId=next;selectOwner();},dispose(){disposed=true;epoch++;owner=undefined;controller?.abort();documentLoad?.abort();clearTimeout(timer);root.removeEventListener("visibilitychange",visibility);dialog.close();dialog.remove();button.remove();removeStyles();}};
}

/** Native scroll content contains the inline card before, never over, the input. */
export function installConversationPresentation(ctx:HarnessClientContext,root:Document=document){
  const canvas=createMobilePresentation(root),view=root.defaultView!;canvas.button.dataset.hubChatVisual="";
  let voiceCall:string|undefined,frame:number|undefined;
  function place(){
    frame=undefined;const current=ctx.sessions.list.getSnapshot().current;
    const target=current?root.querySelector('[data-slot="conversation.session.header.utilities"]'):voiceCall?root.querySelector('[data-hub-voice-hub]'):null;
    if(target&&canvas.button.parentElement!==target)target.append(canvas.button);else if(!target)canvas.button.remove();
    const scroll=current?root.querySelector('[data-conversation-scroll]'):voiceCall?root.querySelector('[data-hub-home-surface]')??root.querySelector('[data-hub-voice-hub]')?.parentElement:null;
    if(scroll&&canvas.dialog.parentElement!==scroll){const seat=scroll.querySelector('[data-composer-seat]');scroll.insertBefore(canvas.dialog,seat?.parentElement===scroll?seat:null);}
  }
  const schedule=()=>{if(frame===undefined)frame=view.requestAnimationFrame(place);};
  const observer=new view.MutationObserver(schedule);observer.observe(root.body,{childList:true,subtree:true});
  const selected=()=>{canvas.setSession(ctx.sessions.list.getSnapshot().current);schedule();};const off=ctx.sessions.list.subscribe(selected);selected();
  const call=(event:Event)=>{voiceCall=(event as CustomEvent<{callId?:string}>).detail?.callId;canvas.setCall(voiceCall);schedule();};root.addEventListener("hub:presentation-call",call);
  return()=>{off();observer.disconnect();if(frame!==undefined)view.cancelAnimationFrame(frame);root.removeEventListener("hub:presentation-call",call);canvas.dispose();};
}
