import {createKnowledgeImportsPanel,uploadKnowledgeArchive} from "./knowledge-imports-panel.ts";
type Request=<T>(query:string,command?:unknown)=>Promise<T>;
interface Backup {id:string;at:number;records:number;bytes:number;path:string}
interface BackupList {items:Backup[];storage:string;total:number;nextOffset:number|null;incompleteCopies?:number;restoreHold?:{queued:number;mode:string;provider:string;model:string}}
export function createKnowledgeDataPanel(root:Document,request:Request){
  const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const n=root.createElement(tag);if(text!==undefined)n.textContent=text;return n;},pane=el("section"),status=el("p"),list=el("div"),recovery=el("section"),locations=el("div");pane.className="knowledge-domains-panel";pane.dataset.knowledgeData="";pane.hidden=true;status.setAttribute("role","status");let busy=false,disposed=false,loadVersion=0,pageBusy=false;
  const button=(label:string,run:()=>void)=>{const b=el("button",label);b.type="button";b.addEventListener("click",run);return b;};
  const size=(n:number)=>(n/1024/1024).toFixed(1)+" MB";
  const imports=createKnowledgeImportsPanel(root,request,(file,signal)=>uploadKnowledgeArchive(root,file,signal));
  const backupPane=el("section"),importButton=button("Conversation archives",()=>{if(busy)return;backupPane.hidden=true;void imports.show();}),backupButton=button("Backups",()=>{if(!imports.canLeave())return;imports.pane.hidden=true;backupPane.hidden=false;});
  const create=button("Create verified backup",()=>void operation({action:"backup-create"},result=>`Verified ${result.records} records (${size(result.bytes)}). The saved copy is listed below.`)),refresh=button("Refresh backups",()=>void load().catch(e=>{if(!disposed)status.textContent=e.message;}));
  const folder=(title:string,paths:string[])=>{const details=el("details");details.append(el("summary",title),...paths.map(path=>el("p",path)));return details;};
  backupPane.append(el("p","Verified backups keep original conversations, notes, attachments, domains and sourced relationships together. Copies are saved on your PC; keep each folder and its snapshot.json together."),recovery,create,refresh,status,locations,list);
  pane.append(el("h3","Your Knowledge data"),backupButton,importButton,imports.pane,backupPane);
  function canLeave(){if(busy){status.textContent="The verified copy is still being prepared. Please let it finish.";return false;}return imports.canLeave();}
  function disabled(value:boolean){for(const b of pane.querySelectorAll<HTMLButtonElement>("button"))b.disabled=value;}
  async function operation(command:unknown,message:(value:any)=>string){if(busy)return;busy=true;disabled(true);locations.replaceChildren();status.textContent="Checking and copying original data…";try{const result=await request<any>("",command);if(disposed)return;await load();status.textContent=message(result);}catch(e){if(!disposed)status.textContent=(e as Error).message;}finally{busy=false;disabled(false);}}
  async function load(offset=0){
    if(offset&&pageBusy)return;const generation=++loadVersion;pageBusy=true;
    const oldMore=list.querySelector<HTMLButtonElement>("[data-older-backups]");if(oldMore)oldMore.disabled=true;
    try{const data=await request<BackupList>("view=backups&offset="+offset);if(disposed||generation!==loadVersion)return;
      if(!offset)list.replaceChildren(el("p",`${data.total} saved copies`),folder("Backup storage on your PC",[data.storage]));else oldMore?.remove();
      if(!offset&&data.incompleteCopies)list.append(el("p",`${data.incompleteCopies} incomplete or unreadable copies are retained on your PC and are not counted as verified backups.`));
      recovery.replaceChildren();if(data.restoreHold){const h=data.restoreHold;recovery.append(el("h4","Restored work is paused"),el("p",`${h.queued} saved organization jobs · ${h.mode} · ${h.provider}/${h.model}. Review your Knowledge AI settings before resuming.`),button("Resume saved Knowledge work",()=>void operation({action:"resume-restored-work"},()=>"Saved work may resume under your existing Knowledge AI settings.")));}
      for(const item of data.items){const card=el("article");card.className="knowledge-domain-card";card.append(el("h4",new Date(item.at).toLocaleString()),el("p",`${item.records} records · ${size(item.bytes)}`),folder("Saved copy folder",[item.path]),button("Verify integrity",()=>void operation({action:"backup-verify",id:item.id},r=>`Verified ${r.files} files against their saved hashes.`)),button("Restore as a separate copy",()=>void operation({action:"backup-restore-copy",id:item.id},r=>{locations.replaceChildren(folder("Restored copy folders",[r.vault,r.root]));return "Verified separate copy restored. Saved background work is paused for review. Your current dataset is still active.";})));list.append(card);}
      if(data.nextOffset!==null){const more=button("Older backups",()=>void load(data.nextOffset!).catch(e=>{if(!disposed)status.textContent=e.message;}));more.dataset.olderBackups="";list.append(more);}
    }finally{if(generation===loadVersion){pageBusy=false;if(oldMore?.isConnected)oldMore.disabled=false;}}
  }
  return {pane,canLeave,async show(){pane.hidden=false;try{await load();}catch(e){if(!disposed)status.textContent=(e as Error).message;}},dispose(){disposed=true;loadVersion++;imports.dispose();}};
}
