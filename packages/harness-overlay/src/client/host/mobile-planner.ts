import type {PlannerItem,PlannerSnapshot,PlannerCommand} from "../../planner-contract.ts";
import {plannerDay,plannerItemDay,plannerLocalTime,plannerZonedInstant} from "../../planner-contract.ts";
import {installMobileWidgetBack} from "./mobile-widget-back.ts";

/** Personal commitments and agent-owned steps share a view, never a ledger entry. */
export function createMobilePlanner(root:Document,openSession:(id:string)=>void){
  const view=root.defaultView!,lifetime=new AbortController(),el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const n=root.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const button=(name:string,run:()=>void)=>{const b=el("button",name);b.type="button";b.addEventListener("click",run);return b;};
  const panel=el("section");panel.dataset.hubPlanner="";panel.setAttribute("aria-label","Agenda and to-dos");
  const header=el("header"),title=el("h2","Your day"),expand=button("Open planner",()=>open());header.append(title,expand);
  const status=el("p");status.setAttribute("role","status");status.className="hub-planner-status";
  const retry=button("Retry",()=>void load());retry.hidden=true;
  const body=el("div");body.className="hub-planner-body";
  const personal=el("div"),agenda=el("section"),todos=el("section"),work=el("section");personal.className="hub-planner-personal";work.className="hub-work-plans";work.hidden=true;
  const agendaHead=el("header"),monthButton=button("",()=>{calendarOpen=!calendarOpen;renderCalendar();}),prev=button("‹",()=>moveMonth(-1)),next=button("›",()=>moveMonth(1)),addEvent=button("+",()=>edit(undefined,"event"));
  prev.setAttribute("aria-label","Previous month");next.setAttribute("aria-label","Next month");addEvent.setAttribute("aria-label","Add calendar event");monthButton.setAttribute("aria-expanded","false");agendaHead.append(el("h3","Agenda"),addEvent);
  const calendarHead=el("div");calendarHead.className="hub-calendar-header";calendarHead.append(prev,monthButton,next);agendaHead.insertBefore(calendarHead,addEvent);
  const calendar=el("div");calendar.className="hub-calendar";const eventList=el("div");eventList.className="hub-agenda-events";
  agenda.append(agendaHead,calendar,eventList);
  const todoHead=el("header"),range=el("div");range.className="hub-todo-horizons";
  const soon=button("Soon",()=>{horizon="near";renderPersonal(true);}),later=button("Later",()=>{horizon="later";renderPersonal(true);});range.append(soon,later);todoHead.append(el("h3","To-dos"),range);
  const quick=el("form"),input=el("input"),addTodo=el("button","+");quick.className="hub-todo-quick";input.placeholder="Add a to-do";input.setAttribute("aria-label","New to-do");input.maxLength=180;addTodo.type="submit";addTodo.setAttribute("aria-label","Add to-do");quick.append(input,addTodo);
  const todoList=el("div"),history=el("details"),historyList=el("div");history.append(el("summary","Completed & removed"),historyList);todos.append(todoHead,quick,todoList,history);
  personal.append(agenda,todos);body.append(personal,work);panel.append(header,status,retry,body);
  const dialog=el("dialog"),dialogHeader=el("header"),close=button("Done",()=>dismiss());dialog.dataset.hubPlannerDialog="";dialog.setAttribute("aria-label","Agenda and to-dos");dialogHeader.append(el("h2","Agenda & to-dos"),close);dialog.append(dialogHeader);root.body.append(dialog);const removeBack=installMobileWidgetBack(dialog,dialogHeader,dismiss);
  const editor=el("dialog");editor.dataset.hubPlannerEditor="";editor.setAttribute("aria-label","Edit planner item");root.body.append(editor);
  let state:PlannerSnapshot={revision:0,items:[],plans:[]},sessionId:string|undefined,homeVisible=false,voice=false,busy=false,flight=false,disposed=false,horizon:"near"|"later"="near",calendarOpen=false,personalKey="",planKey="",timer:number|undefined;
  const browserZone=Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC";let selectedDate=plannerDay(new Date(),browserZone),month=selectedDate.slice(0,7),editing:PlannerItem|undefined;
  const homeSeat=el("div");homeSeat.dataset.hubPlannerSeat="";homeSeat.append(panel);
  let noticeTimer:number|undefined;
  function message(text:string,error=false){view.clearTimeout(noticeTimer);status.textContent=text;retry.hidden=!error;if(text&&!error&&text!=="Loading your day…")noticeTimer=view.setTimeout(()=>{if(status.textContent===text)status.textContent="";},5000);}
  function endpoint(){return "/api/hub/planner"+(sessionId?"?sessionId="+encodeURIComponent(sessionId):"");}
  async function request(command?:PlannerCommand){const r=await view.fetch(endpoint(),{method:command?"POST":"GET",credentials:"same-origin",cache:"no-store",headers:{"x-hub-planner":"1",...(command?{"content-type":"application/json"}:{})},body:command?JSON.stringify(command):undefined,signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(10_000)])});const data=await r.json();if(!r.ok)throw Error(data.detail??"Planner could not load. Retry when HUB is connected.");if(!Array.isArray(data.items)||!Array.isArray(data.plans))throw Error("Planner returned incomplete data. Retry.");return data as PlannerSnapshot;}
  async function load(){if(flight||busy||disposed||root.hidden||!homeVisible&&!dialog.open)return;flight=true;const own=sessionId;
    try{const value=await request();if(own!==sessionId||disposed)return;state=value;renderPersonal();renderPlans();if(retry.hidden===false||status.textContent==="Loading your day…")message("");}
    catch(e){if(!disposed)message((e as Error).message,true);}finally{flight=false;}
  }
  async function change(command:PlannerCommand,success:string){if(busy)return false;busy=true;addTodo.disabled=true;
    try{state=await request(command);renderPersonal(true);renderPlans();message(success);root.dispatchEvent(new view.Event("hub:planner-changed"));return true;}
    catch(e){message((e as Error).message,true);return false;}finally{busy=false;addTodo.disabled=false;}
  }
  function moveMonth(delta:number){const date=new Date(month+"-01T12:00:00Z");date.setUTCMonth(date.getUTCMonth()+delta);month=date.toISOString().slice(0,7);calendarOpen=true;renderCalendar();}
  function renderCalendar(){
    monthButton.textContent=new Intl.DateTimeFormat(undefined,calendarOpen?{month:"long",year:"numeric",timeZone:"UTC"}:{month:"short",day:"numeric",timeZone:"UTC"}).format(new Date((calendarOpen?month+"-01":selectedDate)+"T12:00Z"));monthButton.setAttribute("aria-expanded",String(calendarOpen));monthButton.setAttribute("aria-label",(calendarOpen?"Collapse":"Expand")+" calendar · "+monthButton.textContent);prev.hidden=next.hidden=!calendarOpen;calendar.replaceChildren();
    const start=new Date((calendarOpen?month+"-01":selectedDate)+"T12:00Z"),offset=(start.getUTCDay()+6)%7;start.setUTCDate(start.getUTCDate()-offset);
    const dates=new Set(state.items.filter(i=>!i.deleted&&i.state==="open").map(plannerItemDay).filter(Boolean));
    for(const label of ["M","T","W","T","F","S","S"]){const day=el("small",label);day.setAttribute("aria-hidden","true");calendar.append(day);}
    for(let n=0;n<(calendarOpen?42:7);n++){const d=new Date(start);d.setUTCDate(start.getUTCDate()+n);const key=d.toISOString().slice(0,10),b=button(String(d.getUTCDate()),()=>{selectedDate=key;month=key.slice(0,7);renderCalendar();renderPersonal(true);});b.setAttribute("aria-label",new Intl.DateTimeFormat(undefined,{dateStyle:"full",timeZone:"UTC"}).format(d));b.setAttribute("aria-pressed",String(key===selectedDate));b.toggleAttribute("data-outside",key.slice(0,7)!==month);b.toggleAttribute("data-has-events",dates.has(key));b.toggleAttribute("data-today",key===plannerDay(new Date(),browserZone));calendar.append(b);}
    eventList.replaceChildren();
    const events=state.items.filter(i=>!i.deleted&&i.state==="open"&&i.kind==="event"&&plannerItemDay(i)===selectedDate).sort((a,b)=>(a.start??a.date??"").localeCompare(b.start??b.date??""));
    for(const event of events){const row=button(event.title,()=>edit(event));row.className="hub-agenda-event";const time=el("small",event.start?new Intl.DateTimeFormat(undefined,{hour:"numeric",minute:"2-digit",timeZone:event.timeZone}).format(new Date(event.start))+" · "+event.timeZone:"All day");row.append(time);eventList.append(row);}
    if(!events.length)eventList.append(el("p","Nothing scheduled."));
  }
  function renderPersonal(force=false){const key=JSON.stringify([state.items,horizon]);if(!force&&key===personalKey)return;personalKey=key;renderCalendar();soon.setAttribute("aria-pressed",String(horizon==="near"));later.setAttribute("aria-pressed",String(horizon==="later"));todoList.replaceChildren();
    const items=state.items.filter(i=>i.kind==="todo"&&!i.deleted&&i.state==="open"&&i.horizon===horizon).sort((a,b)=>(plannerItemDay(a)??"9999").localeCompare(plannerItemDay(b)??"9999")||b.createdAt-a.createdAt);
    for(const item of items){const row=el("div"),done=el("input"),name=button(item.title,()=>edit(item));row.className="hub-todo-row";done.type="checkbox";done.setAttribute("aria-label","Complete "+item.title);done.addEventListener("change",()=>{done.disabled=true;void change({action:"complete",id:item.id,version:item.version},"To-do completed.").then(ok=>{if(!ok){done.checked=false;done.disabled=false;}});});if(item.date)name.append(el("small",item.date));row.append(done,name);todoList.append(row);}
    if(!items.length)todoList.append(el("p",horizon==="near"?"Room for what matters next.":"Keep longer-term ideas here."));
    historyList.replaceChildren();const past=state.items.filter(i=>i.deleted||i.state==="done").sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,50);
    for(const item of past){const row=el("div");row.className="hub-planner-history-row";row.append(el("span",item.title),button(item.deleted?"Restore":"Reopen",()=>void change({action:item.deleted?"restore":"reopen",id:item.id,version:item.version},"Item restored.")));historyList.append(row);}if(!past.length)historyList.append(el("p","No completed or removed items."));
  }
  function renderPlans(){const plans=state.plans.filter(p=>p.steps.length),key=JSON.stringify(plans);if(key===planKey)return;planKey=key;work.replaceChildren(el("h3","Assistant’s steps"));work.hidden=!voice||!plans.length;panel.toggleAttribute("data-has-work",!work.hidden);
    for(const plan of plans.slice().sort((a,b)=>b.updatedAt-a.updatedAt)){const card=el("details");card.open=plan.state!=="completed";const heading=el("summary",plan.title);heading.append(el("small",`${plan.steps.filter(s=>s.state==="done").length}/${plan.steps.length} · ${plan.state}`));card.append(heading);const steps=el("ol");for(const step of plan.steps){const row=el("li",step.title);row.dataset.stepState=step.state;row.append(el("small",step.state));steps.append(row);}card.append(steps,button("Open task",()=>{dismiss();openSession(plan.sessionId);}));work.append(card);}
  }
  function edit(item?:PlannerItem,kind:PlannerItem["kind"]="todo"){
    if(editor.open)return;editing=item;const draftId=item?.id??view.crypto.randomUUID();editor.replaceChildren();const heading=el("header"),form=el("form"),name=el("input"),detail=el("textarea"),type=el("select"),when=el("input"),timed=el("input"),start=el("input"),end=el("input"),zone=el("input"),range=el("select"),error=el("p"),footer=el("footer"),save=el("button","Save"),cancel=button("Cancel",()=>editor.close());heading.append(el("h2",item?"Edit item":"Add item"),cancel);error.setAttribute("role","status");
    const field=(label:string,input:HTMLElement)=>{const l=el("label");l.append(el("span",label),input);form.append(l);return l;};
    name.value=item?.title??"";name.required=true;name.maxLength=180;detail.value=item?.details??"";detail.maxLength=4000;
    for(const [value,label]of [["todo","To-do"],["event","Calendar event"]]){const o=el("option",label);o.value=value!;type.append(o);}type.value=item?.kind??kind;
    for(const [value,label]of [["near","Soon"],["later","Later"]]){const o=el("option",label);o.value=value!;range.append(o);}range.value=item?.horizon??horizon;
    when.type="date";when.value=item?.date??(type.value==="event"?selectedDate:"");timed.type="checkbox";timed.checked=!!item?.start;zone.value=item?.timeZone??browserZone;
    start.type=end.type="datetime-local";start.value=item?.start?plannerLocalTime(item.start,zone.value):selectedDate+"T09:00";end.value=item?.end?plannerLocalTime(item.end,zone.value):"";
    field("Title",name);field("Type",type);const r=field("Planning horizon",range),d=field(type.value==="event"?"Date":"Due date · optional",when),t=field("At a specific time",timed),s=field("Starts",start),e=field("Ends · optional",end);field("Details · optional",detail);
    const advanced=el("details"),z=el("label");z.append(el("span","Timezone"),zone);advanced.append(el("summary","Time options"),z,el("small","Calendar times use this timezone. Calendar entries do not run tasks or send reminders; configure scheduled work in Tasks."));form.append(advanced);
    const updateFields=()=>{r.hidden=type.value!=="todo";t.hidden=type.value!=="event";d.hidden=type.value==="event"&&timed.checked;s.hidden=e.hidden=type.value!=="event"||!timed.checked;when.required=type.value==="event"&&!timed.checked;start.required=type.value==="event"&&timed.checked;};type.addEventListener("change",updateFields);timed.addEventListener("change",updateFields);updateFields();
    if(item){footer.append(button("Remove",()=>{void change({action:"remove",id:item.id,version:item.version},"Item removed. Restore it in Completed & removed.").then(ok=>{if(ok)editor.close();else error.textContent=status.textContent;});}));if(item.sourceSessionId)footer.append(button("Source chat",()=>{editor.close();dismiss();openSession(item.sourceSessionId!);}));}
    save.type="submit";footer.append(save);form.append(error,footer);editor.append(heading,form);
    form.addEventListener("submit",event=>{event.preventDefault();if(busy)return;let input:PlannerCommand;try{const useTime=type.value==="event"&&timed.checked;input={action:"save",item:{id:draftId,version:editing?.version??0,kind:type.value as PlannerItem["kind"],title:name.value,details:detail.value,horizon:range.value as PlannerItem["horizon"],timeZone:zone.value,...(useTime?{start:plannerZonedInstant(start.value,zone.value),...(end.value?{end:plannerZonedInstant(end.value,zone.value)}:{})}:when.value?{date:when.value}:{})}};}catch(e){error.textContent=(e as Error).message;return;}save.disabled=true;void change(input,"Saved to your planner.").then(ok=>{save.disabled=false;if(ok)editor.close();else error.textContent=status.textContent;});});
    editor.showModal();name.focus();
  }
  let quickDraft:{title:string;horizon:string;id:string}|undefined;
  quick.addEventListener("submit",event=>{event.preventDefault();if(!input.value.trim()||busy)return;const title=input.value;if(!quickDraft||quickDraft.title!==title||quickDraft.horizon!==horizon)quickDraft={title,horizon,id:view.crypto.randomUUID()};void change({action:"save",item:{id:quickDraft.id,version:0,kind:"todo",title,details:"",horizon,timeZone:browserZone}},"To-do added.").then(ok=>{if(ok&&input.value===title){input.value="";quickDraft=undefined;}});});
  function schedule(){view.clearInterval(timer);if(homeVisible||dialog.open){void load();timer=view.setInterval(()=>void load(),voice?2500:15000);}}
  function open(){if(dialog.open)return;dialog.append(panel);expand.hidden=true;dialog.showModal();schedule();}
  function dismiss(){if(editor.open)return;dialog.close();homeSeat.append(panel);expand.hidden=false;panel.hidden=!homeVisible;schedule();}
  dialog.addEventListener("cancel",e=>{e.preventDefault();dismiss();});
  const changed=()=>void load(),visible=()=>{if(!root.hidden)void load();};root.addEventListener("hub:planner-changed",changed);root.addEventListener("visibilitychange",visible);
  message("Loading your day…");
  return{panel:homeSeat,open,update(context:{visible:boolean;voice:boolean;sessionId?:string}){const changed=context.visible!==homeVisible||context.voice!==voice||context.sessionId!==sessionId;homeVisible=context.visible;voice=context.voice;sessionId=context.sessionId;panel.hidden=!homeVisible&&!dialog.open;homeSeat.hidden=!homeVisible;panel.toggleAttribute("data-voice",voice);if(changed){planKey="";renderPlans();schedule();}},dispose(){disposed=true;lifetime.abort();view.clearInterval(timer);view.clearTimeout(noticeTimer);removeBack();root.removeEventListener("hub:planner-changed",changed);root.removeEventListener("visibilitychange",visible);editor.remove();dialog.remove();homeSeat.remove();}};
}
