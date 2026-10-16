import type {GoalsSnapshot} from "../../goal-contract.ts";
import type {AutomationsSnapshot} from "../../automation-contract.ts";
import {installMobileGoals,goalStatusLabels} from "./mobile-goals.ts";
import {installMobileAutomations} from "./mobile-automations.ts";
import type {WorkEditor} from "./work-editor.ts";
import {defineOverlayStyle} from "../shared/style-runtime.ts";
import {installMobileWidgetBack} from "./mobile-widget-back.ts";
import styles from "./mobile-work.css";
const installStyles=defineOverlayStyle("hub-work",styles);

/** A common inbox for finite outcomes and repeated/conditional work. Existing
 * job identities, schedules, permissions and checkpoints stay in their stores. */
export function installMobileWork(container:HTMLElement,root:Document){
  const view=root.defaultView!,lifetime=new AbortController(),removeStyles=installStyles(root);
  const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const n=root.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const button=(text:string,fn:()=>void)=>{const b=el("button",text);b.type="button";b.addEventListener("click",fn);return b;};
  const tile=button("",()=>{dialog.showModal();void overview();});tile.setAttribute("data-hub-work-tile","");const count=el("span","Goals, schedules & conditions");tile.append(el("strong","Tasks"),count);container.append(tile);
  const dialog=el("dialog");dialog.setAttribute("data-hub-work","");dialog.setAttribute("aria-label","Tasks");
  const header=el("header"),back=button("‹ Tasks",()=>void overview()),close=button("Done",()=>{if(active&&!active.canLeave())return;dialog.close();});back.hidden=true;header.append(back,el("h2","Tasks"),close);
  const status=el("p");status.setAttribute("role","status");const list=el("section"),editors=el("section"),launchers=el("div");launchers.hidden=true;editors.hidden=true;dialog.append(header,status,list,editors,launchers);root.body.append(dialog);
  let goals:GoalsSnapshot|undefined,automations:AutomationsSnapshot|undefined,active:WorkEditor|undefined,filter="all",busy=false;
  const goalEditor=installMobileGoals(launchers,root,{host:editors,back:()=>void overview()});
  const routineEditor=installMobileAutomations(launchers,root,{host:editors,back:()=>void overview()});
  async function request(kind:"goals"|"automations",command?:unknown){const response=await view.fetch(`/api/hub/${kind}`,{method:command?"POST":"GET",credentials:"same-origin",cache:"no-store",headers:{[`x-hub-${kind}`]:"1",...(command?{"content-type":"application/json"}:{})},body:command?JSON.stringify(command):undefined,signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(20000)])});const value=await response.json();if(!response.ok)throw Error(value.detail??"Tasks could not load. Try again.");return value;}
  async function load(){try{const [g,a]=await Promise.all([request("goals"),request("automations")]);if(lifetime.signal.aborted)return;goals=g;automations=a;count.textContent=`${g.goals.filter((j:any)=>j.state==="active").length+a.automations.filter((j:any)=>j.state==="active").length} active · goals & routines`;if(!active){render();status.textContent="";}}catch(e){status.textContent=(e as Error).message;}}
  async function overview(){if(active&&!active.canLeave())return;active=undefined;for(const d of editors.querySelectorAll<HTMLDialogElement>("dialog")){d.open=false;d.hidden=true;}editors.hidden=true;list.hidden=false;back.hidden=true;dialog.scrollTop=0;await load();}
  async function edit(kind:"goals"|"automations",id?:string){if(active&&!active.canLeave())return;active=kind==="goals"?goalEditor:routineEditor;list.hidden=true;editors.hidden=false;back.hidden=false;for(const d of editors.querySelectorAll<HTMLDialogElement>("dialog")){d.open=false;d.hidden=kind==="goals"?!d.hasAttribute("data-hub-goals"):!d.hasAttribute("data-hub-automations");}await active.open(id);dialog.scrollTop=0;}
  async function toggle(kind:"goals"|"automations",job:{id:string;state:string;revision?:number}){if(busy)return;busy=true;try{await request(kind,{action:job.state==="active"?"pause":"resume",id:job.id,revision:kind==="goals"?job.revision:automations!.revision});await load();}catch(e){status.textContent=(e as Error).message;}finally{busy=false;}}
  function render(){list.replaceChildren();const create=el("details"),choices=el("div");create.append(el("summary","New task"),choices);choices.append(button("Work toward a goal",()=>void edit("goals")),el("p","A result to reach over several work sessions, with a plan and completion criteria."),button("Run on a schedule or condition",()=>void edit("automations")),el("p","Repeat a task, watch a source or respond to an event."));list.append(create);
    const filters=el("nav");for(const [key,label]of [["all","All"],["goals","Goals"],["automations","Routines"],["waiting","Needs attention"],["finished","Finished"]]){const b=button(label!,()=>{filter=key!;render();});b.setAttribute("aria-pressed",String(filter===key));filters.append(b);}filters.append(button("Refresh",()=>void load()));list.append(filters);
    const rows=[...(goals?.goals??[]).map(j=>({kind:"goals" as const,job:j,title:j.title,owner:goals?.characters.find(c=>c.id===j.characterId)?.name,detail:j.objective})),...(automations?.automations??[]).map(j=>({kind:"automations" as const,job:j,title:j.title,owner:automations?.characters.find(c=>c.id===j.characterId)?.name,detail:j.prompt}))].sort((a,b)=>b.job.updatedAt-a.job.updatedAt);
    let shown=0;for(const row of rows){const j=row.job,finished=["completed","cancelled","archived","stopped"].includes(j.state),waiting=/waiting|needs-|failed|paused|interrupted|budget-paused/.test(j.status);if(filter==="goals"&&row.kind!=="goals"||filter==="automations"&&row.kind!=="automations"||filter==="waiting"&&!waiting||filter==="finished"&&!finished||filter==="all"&&j.state==="archived")continue;shown++;
      const card=el("article");card.dataset.workId=j.id;card.append(el("small",row.kind==="goals"?"Goal":"Routine"),el("h3",row.title),el("strong",goalStatusLabels[j.status]??j.status.replaceAll("-"," ")),el("p",row.detail),el("small",row.owner??"Character unavailable"));if(j.nextAt&&j.state==="active")card.append(el("small","Next: "+new Date(j.nextAt).toLocaleString()));const controls=el("nav");controls.append(button("Open",()=>void edit(row.kind,j.id)));if(j.state==="active"||j.state==="paused")controls.append(button(j.state==="active"?"Pause":"Resume",()=>void toggle(row.kind,j)));card.append(controls);list.append(card);
    }if(!shown)list.append(el("p","No tasks in this view. Create a goal for a longer outcome, or a routine for scheduled and conditional work."));list.append(el("small","Background work runs while your HUB computer is on. Closing the PWA keeps it running. Provider limits and permissions still apply."));
  }
  const removeBack=installMobileWidgetBack(dialog,header,()=>{if(active)void overview();else dialog.close();});dialog.addEventListener("cancel",event=>{if(active&&!active.canLeave())event.preventDefault();});dialog.addEventListener("close",()=>{for(const d of editors.querySelectorAll<HTMLDialogElement>("dialog"))d.open=false;});
  const timer=view.setInterval(()=>{if(dialog.open&&!active&&!root.hidden)void load();},10000);
  return ()=>{lifetime.abort();view.clearInterval(timer);goalEditor();routineEditor();removeBack();tile.remove();dialog.remove();removeStyles();};
}
