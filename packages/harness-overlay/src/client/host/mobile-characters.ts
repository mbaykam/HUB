import { defineOverlayStyle } from "../shared/style-runtime.ts";
import type { HarnessClientContext } from "../core/context.ts";
import { charactersStateSchema, type HubCharacter, type HubCharactersState } from "../../character-contract.ts";
import { installMobileModels } from "./mobile-models.ts";
import { installMobileWidgetBack } from "./mobile-widget-back.ts";
import { createSpeechEditor } from "./mobile-speech-editor.ts";
import {speechSettingsSchema,characterSpeech,type SpeechSettings} from "../../speech-settings-contract.ts";
import styles from "./mobile-characters.css";
const installStyles=defineOverlayStyle("hub-characters",styles);

/** Local vector portraits stay readable offline and never fetch avatar trackers. */
export function characterAvatar(character:Pick<HubCharacter,"avatar"|"name">){
  const palettes={hub:["#233552","#95beff"],voice:["#173e38","#8be0c6"],devil:["#431e39","#ed92bc"],mint:["#293c3b","#b5d8ad"],rose:["#402d40","#dcb2df"],amber:["#433421","#f3cc80"]};
  const [bg,fg]=palettes[character.avatar];
  const extra=character.avatar==="devil"?'<path d="M21 24 19 9 32 20M43 24 45 9 32 20" fill="'+fg+'"/>':character.avatar==="voice"?'<path d="M18 31v8m28-8v8" stroke="'+fg+'" stroke-width="3" stroke-linecap="round"/>':'';
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="18" fill="${bg}"/>${extra}<path d="M13 64c1-16 8-23 19-23s18 7 19 23" fill="${fg}" opacity=".4"/><ellipse cx="32" cy="29" rx="13" ry="15" fill="${fg}"/><path d="M20 28c-1-15 22-21 26-4-7-1-12-6-14-8-3 6-8 9-12 12" fill="${bg}"/><path d="M27 34q5 5 10 0" fill="none" stroke="${bg}" stroke-width="2" stroke-linecap="round"/><circle cx="27" cy="29" r="1.4" fill="${bg}"/><circle cx="37" cy="29" r="1.4" fill="${bg}"/></svg>`;
  return "data:image/svg+xml,"+encodeURIComponent(svg);
}
export function installCharactersClient(ctx:HarnessClientContext,root:Document=document){
  const view=root.defaultView!;const lifetime=new AbortController(),removeStyles=installStyles(root);
  const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const n=root.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const button=(text:string,run:()=>void)=>{const b=el("button",text);b.type="button";b.addEventListener("click",run);return b;};
  const dialog=el("dialog");dialog.setAttribute("data-hub-characters","");dialog.setAttribute("aria-label","Characters");
  const header=el("header");const heading=el("h2","Characters"),close=button("Done",()=>dialog.close());header.append(heading,close);
  const status=el("p");status.setAttribute("role","status");const content=el("div");content.className="hub-character-content";
  dialog.append(header,status,content);root.body.append(dialog);
  const removeBack=installMobileWidgetBack(dialog,header,()=>dialog.close());
  let state:HubCharactersState|undefined,toolCatalog:{name:string;description:string}[]=[],busy=false,epoch=0,warningMessage="",editorCleanup:(()=>void)|undefined;
  let speechSettings:SpeechSettings|undefined;
  dialog.addEventListener("close",()=>{editorCleanup?.();editorCleanup=undefined;});
  const picture=(c:HubCharacter)=>{const image=el("img");image.src=characterAvatar(c);image.alt="";image.width=64;image.height=64;return image;};
  async function request(command?:unknown){
    const response=await view.fetch("/api/hub/characters",{method:command?"POST":"GET",credentials:"same-origin",cache:"no-store",headers:{"x-hub-characters":"1",...(command?{"content-type":"application/json"}:{})},body:command?JSON.stringify(command):undefined,signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(15000)])});
    if(!response.ok)throw new Error(response.status===409?"Characters changed on another screen. Reopen before saving.":"Could not save this character. Check its model, speech and HUB connection.");
    const value=await response.json();if(value.tools)toolCatalog=value.tools;
    const {tools:_tools,warning,sharedSpeech,...record}=value;if(sharedSpeech)speechSettings=speechSettingsSchema.parse(sharedSpeech);warningMessage=typeof warning==="string"?warning:"";state=charactersStateSchema.parse(record);return state;
  }
  function grid(){
    editorCleanup?.();editorCleanup=undefined;heading.textContent="Characters";content.replaceChildren();status.textContent=warningMessage||"HUB handles writing and Telegram messages. Your voice assistant delegates complex work to HUB. Ask for other characters by name.";dialog.scrollTop=0;
    if(!state)return;
    const list=el("div");list.className="hub-character-grid";
    for(const c of state.characters){
      const card=button("",()=>edit(c));card.setAttribute("data-character-id",c.id);card.append(picture(c),el("strong",c.name),el("span",c.description));
      const roles=[c.id===state.mainId?"Writing · Telegram":"",c.id===state.voiceId?"Voice conversations":"",!c.route?"Model not configured":""].filter(Boolean);card.append(el("small",roles.join(" · ")));list.append(card);
    }
    content.append(list,button("Create character",()=>edit()));
  }
  async function change(command:Record<string,unknown>){if(busy||!state)return;busy=true;status.textContent="Saving…";try{await request({...command,revision:command.revision??state.revision});grid();}catch(e){status.textContent=(e as Error).message;}finally{busy=false;}}
  function edit(character?:HubCharacter){
    if(!state)return;editorCleanup?.();const editingRevision=state.revision;const seed=structuredClone(character??{id:"",name:"",avatar:"mint",description:"",instructions:"",route:null,speech:null,tools:{mode:"inherit"},delegateTo:state.mainId}) as HubCharacter;
    heading.textContent=character?.name??"New character";content.replaceChildren();status.textContent="Changes apply to the next turn or call; current work keeps its existing configuration.";dialog.scrollTop=0;
    content.append(button("‹ All characters",grid));const form=el("form");form.className="hub-character-form";form.noValidate=true;
    const tabbar=el("nav");tabbar.setAttribute("role","tablist");tabbar.className="hub-character-tabs";
    const panes=new Map<string,HTMLElement>(),tabs=new Map<string,HTMLButtonElement>();
    const tab=(name:string)=>{const pane=el("section");pane.setAttribute("role","tabpanel");pane.dataset.characterPane=name;panes.set(name,pane);const b=button(name,()=>selectTab(name));b.setAttribute("role","tab");tabs.set(name,b);tabbar.append(b);return pane;};
    const basics=tab("Profile"),modelPane=tab("Model"),voicePane=tab("Voice"),advanced=tab("Capabilities");
    function selectTab(name:string){for(const [key,pane]of panes)pane.hidden=key!==name;for(const [key,b]of tabs)b.setAttribute("aria-selected",String(key===name));}
    form.append(tabbar,...panes.values());selectTab("Profile");
    basics.append(el("p",seed.id===state.mainId?`${seed.name} · your assistant for writing and Telegram messages.`:seed.id===state.voiceId?`${seed.name} · your voice assistant. Complex requests go to HUB.`:"A specialist you can request by name in text or voice."));

    const field=(name:string,input:HTMLElement,parent:HTMLElement=basics)=>{const label=el("label");label.append(el("span",name),input);parent.append(label);};
    const input=(value:string,max:number)=>{const n=el("input");n.value=value;n.maxLength=max;return n;};
    const name=input(seed.name,60);name.required=true;field("Name",name);
    const description=input(seed.description,240);field("About this character",description);
    const avatar=el("select");for(const value of ["hub","voice","devil","mint","rose","amber"]){const o=el("option",value[0]!.toUpperCase()+value.slice(1));o.value=value;avatar.append(o);}avatar.value=seed.avatar;field("Portrait",avatar);
    const preview=picture(seed);basics.prepend(preview);avatar.addEventListener("change",()=>{seed.avatar=avatar.value as HubCharacter["avatar"];preview.src=characterAvatar(seed);});
    const instructions=el("textarea");instructions.rows=4;instructions.value=seed.instructions;instructions.maxLength=12000;field("Personality & instructions",instructions);
    const brain=el("section");brain.append(el("h3","Model"));const modelLabel=el("p",seed.route?`${seed.route.provider} · ${seed.route.model}${seed.route.reasoningEffort?" · "+seed.route.reasoningEffort:""}`:"No model configured");brain.append(modelLabel);modelPane.append(brain);
    editorCleanup=installMobileModels(brain,root,()=>ctx.sessions.list.getSnapshot().current,{initialRoute:seed.route??undefined,choose(m,effort,parameters){seed.route={provider:m.provider,model:m.id,...(effort?{reasoningEffort:effort}:{}),...parameters};modelLabel.textContent=`${m.name} · ${m.provider}${effort?" · "+effort:""}${parameters.maxTokens?" · "+parameters.maxTokens+" output tokens":""}`;}});
    const clearModel=button("Leave unconfigured",()=>{seed.route=null;modelLabel.textContent="No model configured";});brain.append(clearModel);
    clearModel.disabled=seed.id===state.mainId||seed.id===state.voiceId;
    const delegate=el("select");const none=el("option","No default delegation target");none.value="";delegate.append(none);
    for(const c of state.characters.filter(c=>c.id!==seed.id)){const o=el("option",c.name+(c.route?"":" · not configured"));o.value=c.id;delegate.append(o);}delegate.value=seed.delegateTo??"";field("Delegate complex work to",delegate,advanced);
    const tools=el("details");tools.append(el("summary","Tools & capabilities"));const inherit=el("input");inherit.type="checkbox";inherit.checked=seed.tools.mode==="inherit";field("Use existing permitted tools",inherit,tools);
    const choices=el("div");const selected=new Set(seed.tools.mode==="allow"?seed.tools.names:[]);const checkboxes=new Map<string,HTMLInputElement>();
    const names=new Map(toolCatalog.map(t=>[t.name,t.description]));for(const n of selected)if(!names.has(n))names.set(n,"Not currently available");
    for(const [n,d]of names){const checkbox=el("input");checkbox.type="checkbox";checkbox.checked=selected.has(n);checkboxes.set(n,checkbox);field(n,checkbox,choices);checkbox.parentElement!.title=d;}
    const showPolicy=()=>{for(const [n,checkbox]of checkboxes){checkbox.disabled=inherit.checked;checkbox.checked=inherit.checked||selected.has(n);}};showPolicy();inherit.addEventListener("change",showPolicy);tools.append(choices,el("p","Tools remain subject to HUB’s existing permissions. Delegated work uses the target character’s configured tools."));advanced.append(tools);
    const speechEditor=createSpeechEditor(root,speechSettings?characterSpeech(speechSettings.speech,seed.speech):seed.speech,{voiceOnly:true});voicePane.append(speechEditor.panel);
    if(speechSettings&&seed.speech&&seed.speech.tts.engine!==speechSettings.speech.tts.engine)voicePane.prepend(el("p","This character’s previous voice belongs to a different engine. Calls use the shared default voice until you choose a voice below."));
    const modelCleanup=editorCleanup;editorCleanup=()=>{modelCleanup?.();speechEditor.dispose();};
    const save=el("button","Save character");save.type="submit";form.append(save);content.append(form);
    form.addEventListener("submit",event=>{event.preventDefault();if(!name.value.trim()){selectTab("Profile");name.focus();status.textContent="Give this character a name.";return;}seed.name=name.value;seed.description=description.value;seed.instructions=instructions.value;seed.delegateTo=delegate.value||null;seed.tools=inherit.checked?{mode:"inherit"}:{mode:"allow",names:[...checkboxes].filter(([,c])=>c.checked).map(([n])=>n)};
      try{seed.speech=speechEditor.value();}catch(error){status.textContent=(error as Error).message;return;}
      if(character)void change({action:"save",revision:editingRevision,character:seed});else{const {id:_id,...value}=seed;void change({action:"create",revision:editingRevision,character:value});}});
    if(character){
      const actions=el("div");actions.className="hub-character-actions";
      const remove=button("Delete character",()=>void change({action:"delete",id:character.id}));remove.disabled=character.id===state.mainId||character.id===state.voiceId;actions.append(remove);advanced.append(actions);
    }
  }
  async function open(id?:string){const own=++epoch;if(!dialog.open)dialog.showModal();status.textContent="Loading characters…";try{await request();if(own!==epoch||!dialog.open)return;const c=state?.characters.find(c=>c.id===id);if(c)edit(c);else grid();}catch(e){status.textContent=(e as Error).message;}}
  const openEvent=()=>void open();view.addEventListener("hub:characters-open",openEvent);root.documentElement.setAttribute("data-hub-characters-enabled","");
  void request().catch(()=>{});
  return ()=>{lifetime.abort();view.removeEventListener("hub:characters-open",openEvent);editorCleanup?.();removeBack();dialog.remove();root.documentElement.removeAttribute("data-hub-characters-enabled");removeStyles();};
}
