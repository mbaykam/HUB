import {defineOverlayStyle} from "../shared/style-runtime.ts";
import styles from "./mobile-artifacts.css";
const installStyles=defineOverlayStyle("hub-artifacts",styles);

/** Same-origin authenticated reads; app code only enters an opaque iframe. */
export function openHtmlAppViewer(root:Document,title:string,load:(signal:AbortSignal)=>Promise<{document:string;name:string}>){
  const lifetime=new AbortController(),removeStyles=installStyles(root),opener=root.activeElement as HTMLElement|null;
  const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const e=root.createElement(tag);if(text)e.textContent=text;return e;};
  const dialog=el("dialog"),header=el("header"),label=el("strong",title),close=el("button","Close"),status=el("p","Opening app…"),stage=el("section"),keys=el("details"),buttons=el("div");
  dialog.dataset.hubAppsDialog="";dialog.setAttribute("aria-label","HTML app");close.type="button";status.setAttribute("role","status");keys.hidden=true;keys.append(el("summary","Game controls"),buttons);
  for(const [text,key]of [["↑","ArrowUp"],["←","ArrowLeft"],["↓","ArrowDown"],["→","ArrowRight"],["Enter","Enter"],["Restart","r"]]){const b=el("button",text);b.type="button";b.addEventListener("click",()=>stage.querySelector("iframe")?.contentWindow?.postMessage({hubArtifactKey:key},"*"));buttons.append(b);}
  header.append(label,close);dialog.append(header,status,stage,keys);root.body.append(dialog);dialog.showModal();close.focus();
  close.addEventListener("click",()=>dialog.close());dialog.addEventListener("close",()=>{lifetime.abort();stage.replaceChildren();dialog.remove();removeStyles();if(opener?.isConnected)opener.focus();},{once:true});
  void load(lifetime.signal).then(result=>{
    if(lifetime.signal.aborted||!dialog.open)return;
    if(typeof result.document!=="string"||result.document.length>6_000_000)throw Error("Invalid app document");
    label.textContent=result.name;const frame=el("iframe");frame.title=result.name;frame.setAttribute("sandbox","allow-scripts");frame.setAttribute("allow","camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'");frame.referrerPolicy="no-referrer";frame.srcdoc=result.document;stage.replaceChildren(frame);keys.hidden=false;status.textContent="";
  }).catch(()=>{if(!lifetime.signal.aborted){status.textContent="This app couldn’t open. If your sign-in expired, reopen HUB, then try the app again. Your original file is still available to download.";}});
  return ()=>{if(dialog.open)dialog.close();};
}
