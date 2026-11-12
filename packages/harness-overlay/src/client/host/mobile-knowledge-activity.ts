import type { KnowledgeActivityPage, KnowledgeActivityEntry } from "../../knowledge-activity-contract.ts";

/** Read-only activity dialog. Opening or refreshing never queues model work. */
export function createKnowledgeActivity(root:Document,openRecord:(id:string)=>void){
  const view=root.defaultView!,el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const node=root.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  const tile=el("button"),title=el("strong",root.documentElement.lang.startsWith("tr")?"Günlük":"Activity"),hint=el("span","Knowledge AI logs");tile.type="button";tile.dataset.hubKnowledgeActivityTile="";tile.append(title,hint);
  const dialog=el("dialog");dialog.dataset.hubKnowledgeActivity="";dialog.setAttribute("aria-label","Knowledge AI activity");
  const header=el("header"),heading=el("h2","Knowledge AI · Activity"),close=el("button","Close"),summary=el("p","Loading activity…"),timing=el("p"),notice=el("p"),list=el("div"),footer=el("footer"),refresh=el("button","Refresh"),more=el("button","Older activity");
  close.type=refresh.type=more.type="button";summary.setAttribute("role","status");notice.className="hub-knowledge-activity-notice";header.append(heading,close);footer.append(refresh,more);dialog.append(header,summary,timing,notice,list,footer);root.body.append(dialog);more.hidden=true;
  let disposed=false,flight:AbortController|undefined,timer:number|undefined,next:number|undefined,generation=0;
  const date=(value?:number)=>value?new Date(value).toLocaleString(root.documentElement.lang||undefined):"Not recorded";
  const state=(value:string)=>({ready:"Idle",working:"Working",processing:"Working",queued:"Waiting",review:"Awaiting review",done:"Completed",failed:"Failed","waiting-credit":"Waiting for credit / provider limit","needs-attention":"Needs attention","budget-paused":"Budget paused","restored-work-paused":"Restored work paused","model-unavailable":"Model unavailable","projection-pending":"Saved · projection needs repair"}[value]??value);
  function closeDialog(){generation++;flight?.abort();flight=undefined;view.clearInterval(timer);timer=undefined;if(dialog.open){if(typeof dialog.close==="function")dialog.close();else dialog.removeAttribute("open");}tile.focus();}
  function recordButton(id:string,label:string){const button=el("button",label);button.type="button";button.className="hub-knowledge-activity-link";button.addEventListener("click",()=>{closeDialog();openRecord(id);});return button;}
  function renderEntry(entry:KnowledgeActivityEntry){
    const card=el("details"),label=el("summary",`${state(entry.status)} · ${entry.outcome??entry.source.channel} · ${date(entry.updatedAt)}`);card.dataset.activityEntry=entry.id;card.append(label);card.open=entry.status==="working"||entry.status==="failed"||!!entry.error;
    card.append(el("p",entry.reason??(entry.status==="working"?"Processing this source. The result has not been saved yet.":entry.status==="queued"?"Queued under the existing Knowledge policy.":"No explanation was recorded.")));
    card.append(el("p",`Started: ${date(entry.startedAt)} · Ended: ${date(entry.finishedAt)} · Model attempts: ${entry.attempts}`));
    if(entry.retryAt)card.append(el("p",`Last retry: ${date(entry.retryAt)}. Saved receipts are reused when available; this log does not retry work.`));
    if(entry.error)card.append(el("p",`${entry.error.phase} · ${entry.error.code}: ${entry.error.message}`));
    const changes=el("ul");for(const change of entry.changes){const row=el("li",`${change.kind} · ${change.action}: `);if(change.kind==="note"&&change.id)row.append(recordButton(change.id,change.title));else row.append(root.createTextNode(change.title));if(change.kind==="link"&&change.targetId)row.append(recordButton(change.targetId,"Open linked record"));changes.append(row);}if(entry.changes.length)card.append(changes);else card.append(el("p",entry.status==="done"&&!entry.error?"No committed note, domain, tag or link changes are recorded for this job.":"No additional committed changes are recorded yet."));
    const sources=el("nav");sources.setAttribute("aria-label","Activity sources");if(entry.source.sessionId){const link=el("a","Open source conversation");link.href="/?hubSession="+encodeURIComponent(entry.source.sessionId);sources.append(link);}else if(entry.source.recordId)sources.append(recordButton(entry.source.recordId,"Read source record"));
    for(const asset of entry.source.assets){const link=el("a",asset.name);link.href="/api/hub/memory?view=asset&id="+encodeURIComponent(asset.id);link.target="_blank";link.rel="noopener";sources.append(link);}if(sources.childNodes.length)card.append(sources);
    for(const attempt of entry.previousAttempts){card.append(el("p",`Earlier attempt ${attempt.attempt} · ${state(attempt.status)} · ${date(attempt.startedAt)} → ${date(attempt.finishedAt)}${attempt.reason?" · "+attempt.reason:""}`));}
    for(const warning of entry.warnings)card.append(el("p",warning));return card;
  }
  async function load(offset=0){
    if(disposed||!dialog.open||root.hidden||flight)return;const current=++generation,controller=flight=new AbortController();refresh.disabled=more.disabled=true;
    if(offset===0)summary.textContent="Loading activity…";
    try{
      const response=await view.fetch(`/api/hub/memory?view=activity&offset=${offset}`,{credentials:"same-origin",cache:"no-store",headers:{"x-hub-memory":"1"},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
      if(!response.ok)throw Error("Unavailable");const data=await response.json() as KnowledgeActivityPage;
      if(data.version!==1||!Array.isArray(data.entries)||typeof data.historyNotice!=="string")throw Error("Invalid activity response");if(disposed||controller.signal.aborted||current!==generation)return;
      const expanded=new Map(Array.from(list.querySelectorAll("details")).map(card=>[card.dataset.activityEntry,card.open]));
      const scroll=dialog.scrollTop;
      if(!offset)list.replaceChildren();for(const entry of data.entries){const card=renderEntry(entry);if(expanded.has(entry.id))card.open=expanded.get(entry.id)!;list.append(card);}dialog.scrollTop=scroll;
      summary.textContent=(data.enabled?state(data.state):"Paused")+` · ${data.total} saved jobs`;hint.textContent=data.enabled?state(data.state):"Paused";timing.textContent=`Last start: ${date(data.lastStartedAt)} · Last end: ${date(data.lastFinishedAt)}`;notice.textContent=data.historyNotice;
      if(!data.total)list.append(el("p","No activity has been recorded yet. Existing notes are not treated as evidence of past AI work."));next=data.nextOffset;more.hidden=next===undefined;
    }catch{if(!controller.signal.aborted&&current===generation)summary.textContent="Activity could not load. Refresh to retry; saved work is unchanged.";}
    finally{if(flight===controller)flight=undefined;if(current===generation)refresh.disabled=more.disabled=false;}
  }
  tile.addEventListener("click",()=>{if(disposed)return;if(!dialog.open){if(typeof dialog.showModal==="function")dialog.showModal();else dialog.setAttribute("open","");}void load();view.clearInterval(timer);timer=view.setInterval(()=>void load(),10000);});
  close.addEventListener("click",closeDialog);dialog.addEventListener("cancel",event=>{event.preventDefault();closeDialog();});dialog.addEventListener("close",()=>{generation++;flight?.abort();flight=undefined;view.clearInterval(timer);timer=undefined;});refresh.addEventListener("click",()=>void load());more.addEventListener("click",()=>{if(next!==undefined)void load(next);});
  const visible=()=>{if(dialog.open&&!root.hidden)void load();};root.addEventListener("visibilitychange",visible);
  return {tile,dialog,dispose(){disposed=true;closeDialog();root.removeEventListener("visibilitychange",visible);dialog.remove();tile.remove();}};
}
