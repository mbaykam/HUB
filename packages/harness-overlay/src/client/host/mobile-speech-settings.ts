import {speechSettingsSchema,type SpeechSettings} from "../../speech-settings-contract.ts";
import {createSpeechEditor} from "./mobile-speech-editor.ts";
import {installMobileWidgetBack} from "./mobile-widget-back.ts";
import {defineOverlayStyle} from "../shared/style-runtime.ts";
import styles from "./mobile-work.css";
const installStyles=defineOverlayStyle("hub-work",styles);

export function installSpeechSettings(container:HTMLElement,root:Document){
  const view=root.defaultView!,lifetime=new AbortController(),removeStyles=installStyles(root);
  const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const n=root.createElement(tag);if(text)n.textContent=text;return n;};
  const button=(text:string,run:()=>void)=>{const b=el("button",text);b.type="button";b.addEventListener("click",run);return b;};
  const dialog=el("dialog");dialog.setAttribute("data-hub-speech-settings","");dialog.setAttribute("aria-label","Speech settings");
  const header=el("header"),status=el("p"),body=el("section");status.setAttribute("role","status");
  header.append(el("h2","Speech"),button("Done",()=>dialog.close()));dialog.append(header,status,body);root.body.append(dialog);
  const launch=button("Speech",()=>void open());container.append(launch);const back=installMobileWidgetBack(dialog,header,()=>dialog.close());
  let state:SpeechSettings|undefined,editor:ReturnType<typeof createSpeechEditor>|undefined;
  async function request(value?:SpeechSettings){const response=await view.fetch("/api/hub/voice/settings",{method:value?"POST":"GET",credentials:"same-origin",cache:"no-store",headers:{"x-hub-speech-settings":"1",...(value?{"content-type":"application/json"}:{})},body:value?JSON.stringify(value):undefined,signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(30000)])});if(!response.ok)throw Error(response.status===409?"Settings changed on another screen. Reopen Speech before saving.":value?"Could not save speech settings. Your previous settings remain active.":"Speech settings are unavailable. Check the host connection, then reopen Speech.");return speechSettingsSchema.parse(await response.json());}
  async function open(){editor?.dispose();body.replaceChildren();status.textContent="Loading speech settings…";dialog.showModal();try{state=await request();if(!dialog.open)return;editor=createSpeechEditor(root,state.speech,{global:true});body.append(el("p","One speech system for PWA and Telegram calls. Characters choose their voices; recognition, language detection and synthesis settings apply to everyone."),editor.panel);const save=button("Save speech settings",()=>void saveSettings(save));body.append(save);status.textContent="Changes apply to the next call. An active call keeps its current settings.";}catch(e){status.textContent=(e as Error).message;}}
  async function saveSettings(save:HTMLButtonElement){if(!state||!editor)return;save.disabled=true;try{const speech=editor.value();if(!speech)throw Error("Choose speech models first.");state=await request({...state,speech});status.textContent="Saved. All new PWA and Telegram calls use these settings.";}catch(e){status.textContent=(e as Error).message;}finally{save.disabled=false;}}
  dialog.addEventListener("close",()=>{editor?.dispose();editor=undefined;});
  return ()=>{lifetime.abort();editor?.dispose();back();launch.remove();dialog.remove();removeStyles();};
}
