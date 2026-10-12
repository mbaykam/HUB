import {useEffect,useRef} from "react";
import {defineOverlayStyle} from "../shared/style-runtime.ts";
import styles from "./instructions.css";
const installStyles=defineOverlayStyle("hub-instructions",styles);

/** One editor for the actual shared files and existing character/curator stores. */
export function installInstructionEditor(container:HTMLElement,root:Document,currentSession:()=>string|undefined){
  const view=root.defaultView!,lifetime=new AbortController(),offStyle=installStyles(root);
  const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const n=root.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  container.setAttribute("data-hub-instructions","");
  const status=el("p"),selector=el("select"),scope=el("p"),editor=el("textarea"),save=el("button","Kaydet"),refresh=el("button","Yenile"),matrix=el("div"),matrixDetails=el("details"),path=el("p"),builtIn=el("details"),builtText=el("pre"),last=el("details"),lastText=el("pre");
  matrixDetails.append(el("summary","Hangi AI hangi talimatları kullanıyor?"),matrix);
  status.setAttribute("role","status");selector.setAttribute("aria-label","Talimat kaynağı");editor.setAttribute("aria-label","Talimat içeriği");editor.rows=12;save.type=refresh.type="button";builtIn.append(el("summary","Knowledge AI’ın sabit işleme kuralları"),builtText);last.append(el("summary","Bu sohbette son gönderilen talimatlar"),lastText);
  const controls=el("div");controls.className="instruction-actions";controls.append(save,refresh);
  container.append(el("h2","AI talimatları"),el("p","Ortak dosyaları ve her karakterin kendi talimatlarını burada görebilir, düzenleyebilirsin. Talimatlar karaktere bağlıdır; modelini değiştirmek yeni bir kişilik dosyası oluşturmaz."),matrixDetails,selector,scope,path,editor,controls,status,builtIn,last);
  let sources:any[]=[],selected:any,dirty=false,curator:any;
  async function request(url:string,marker:string,command?:unknown){const response=await view.fetch(url,{method:command?"POST":"GET",credentials:"same-origin",cache:"no-store",headers:{[marker]:"1",...(command?{"content-type":"application/json"}:{})},body:command?JSON.stringify(command):undefined,signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(20000)])});const value=await response.json();if(!response.ok)throw new Error(value.detail??"Talimatlar yüklenemedi");return value;}
  function choose(){selected=sources.find(s=>s.id===selector.value);if(!selected)return;editor.value=selected.content;editor.readOnly=!selected.editable;save.disabled=true;dirty=false;scope.textContent=selected.scope;path.textContent=selected.path;builtIn.hidden=selected.id!=="curator";builtText.textContent=curator?.builtIn??"";}
  selector.addEventListener("change",choose);editor.addEventListener("input",()=>{dirty=true;save.disabled=editor.readOnly;status.textContent="Kaydedilmemiş değişiklikler";});
  async function load(){status.textContent="Talimatlar yükleniyor…";try{
    const id=currentSession();const data=await request("/api/hub/instructions"+(id?"?sessionId="+encodeURIComponent(id):""),"x-hub-instructions");
    try{curator=await request("/api/hub/memory?view=instructions","x-hub-memory");}catch{curator=undefined;}
    const previous=selector.value;sources=[...data.shared,...data.characters.map((c:any)=>c.instructions),...(curator?[{id:"curator",name:"Knowledge AI · özel talimatlar",path:curator.path+" → instructions",content:curator.instructions,hash:curator.hash,editable:true,scope:"Yalnız Knowledge AI. SOUL.md, USER.md ve sohbet karakterinin kişiliği curator’a uygulanmaz."}]:[])];
    selector.replaceChildren();for(const source of sources){const option=el("option",source.name);option.value=source.id;selector.append(option);}if(sources.some(s=>s.id===previous))selector.value=previous;
    matrix.replaceChildren();for(const c of data.characters){const card=el("article");card.append(el("strong",c.name+" · "+c.role),el("p",c.route?c.route.provider+" / "+c.route.model+(c.route.reasoningEffort?" · "+c.route.reasoningEffort:""):"Model seçilmedi"),el("small","Ortak: SOUL.md, USER.md ve native AGENTS.md · Özel: "+c.name+" talimatları"));matrix.append(card);}
    if(curator){const card=el("article");card.append(el("strong","Knowledge AI · Curator"),el("p",curator.provider+" / "+curator.model+" · "+curator.reasoningEffort),el("small","Native AGENTS.md + sabit not işleme kuralları + kendi özel talimatları. Sohbet kişilikleri ayrı tutulur."));matrix.append(card);}
    last.hidden=!data.lastRequest?.system;lastText.textContent=data.lastRequest?`${data.lastRequest.provider??""} / ${data.lastRequest.model??""}\n\n${data.lastRequest.system}\n\n${data.lastRequest.workspace?.join("\n\n")??""}`:"";
    if(!dirty)choose();status.textContent=dirty?"Değişikliklerin editörde duruyor. Kaydetmeden kaynak değiştirmek onları bırakır.":"Boş SOUL.md ve USER.md ek talimat uygulamaz. Ortak dosyalar bir sonraki yanıtta okunur. Karakter değişiklikleri için açık sesli seansı yeniden başlat.";
  }catch(error){status.textContent=(error as Error).message;}}
  save.addEventListener("click",async()=>{if(!selected?.editable)return;save.disabled=true;try{
    if(selected.id==="curator")await request("/api/hub/memory","x-hub-memory",{action:"instructions",hash:selected.hash,instructions:editor.value});
    else await request("/api/hub/instructions","x-hub-instructions",{id:selected.id,hash:selected.hash,content:editor.value});
    dirty=false;await load();status.textContent="Talimatlar kaydedildi.";
  }catch(error){status.textContent=(error as Error).message;save.disabled=false;}});
  refresh.addEventListener("click",()=>void load());void load();
  return ()=>{lifetime.abort();offStyle();container.replaceChildren();};
}

export function InstructionSettings({currentSession}:{currentSession:()=>string|undefined}){
  const ref=useRef<HTMLDivElement>(null);
  const current=useRef(currentSession);current.current=currentSession;
  useEffect(()=>{if(ref.current)return installInstructionEditor(ref.current,ref.current.ownerDocument,()=>current.current());},[]);
  return <div ref={ref}/>;
}
