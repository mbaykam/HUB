import cytoscape from "cytoscape";
import type { KnowledgeGraph, KnowledgeNote, KnowledgeNode } from "../../knowledge-contract.ts";
import { installMobileWidgetBack } from "../host/mobile-widget-back.ts";
import {createKnowledgeMedia} from "./knowledge-media.ts";
import {createKnowledgeCloud} from "./knowledge-cloud.ts";
import {isArchivedConversation,matchesKnowledgeScope,knowledgeRecordCounts,type KnowledgeRecordScope} from "../../knowledge-record-scope.ts";
import {knowledgeLayout} from "./knowledge-layout.ts";
import {createKnowledgeDomainsPanel} from "./knowledge-domains-panel.ts";
import {createKnowledgeDataPanel} from "./knowledge-data-panel.ts";
import {createKnowledgeSkillsPanel} from "./knowledge-skills-panel.ts";
import {createKnowledgeNeighbors} from "./knowledge-neighbors.ts";
import type {KnowledgeEvidence} from "../../knowledge-relation-contract.ts";
import type {KnowledgeAsset} from "../../knowledge-contract.ts";

/** Full note workspace. DOM text rendering deliberately never executes vault
 * HTML. Useful wiki aliases display inline and open the real target note. */
export function openKnowledgeWorkspace(_container:HTMLElement,root:Document,initial:KnowledgeGraph,onClose:()=>void){
  const view=root.defaultView!,lifetime=new AbortController();
  const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const node=root.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  const btn=(label:string,run:()=>void)=>{const b=el("button",label);b.type="button";b.addEventListener("click",run);return b;};
  const dialog=el("dialog");dialog.setAttribute("data-hub-graph-dialog","");dialog.setAttribute("data-knowledge-workspace","");dialog.setAttribute("aria-label","Knowledge workspace");
  const dark=root.documentElement.classList.contains("dark")||root.documentElement.hasAttribute("data-ds-dark-theme")||root.body.hasAttribute("data-ds-dark-theme");dialog.dataset.knowledgeTheme=dark?"dark":"light";
  const header=el("header"),heading=el("h2","Knowledge"),close=btn("Home",()=>requestClose());header.append(heading,close);
  const status=el("p");status.setAttribute("role","status");
  const nav=el("nav"),layout=el("section");layout.className="knowledge-layout";
  const sidebar=el("aside"),search=el("input");search.type="search";search.placeholder="Search notes…";search.setAttribute("aria-label","Search knowledge");
  const scope=el("select");scope.setAttribute("aria-label","Record collection");for(const [value,label]of [["all","All records"],["brain","Brain notes"],["archive","Chat archive"]]){const option=el("option",label);option.value=value!;scope.append(option);}
  const tree=el("div");tree.setAttribute("data-knowledge-tree","");sidebar.append(scope,search,tree);
  const graphPane=el("section"),canvas=el("div");canvas.setAttribute("data-graph-canvas","");canvas.setAttribute("role","img");canvas.setAttribute("aria-label","2D knowledge graph. Drag to pan, drag records to arrange them, or use the zoom controls.");graphPane.append(canvas);
  const media=createKnowledgeMedia(root),assetsPane=el("section"),assetCards=el("div");assetsPane.setAttribute("data-knowledge-assets","");assetsPane.hidden=true;assetsPane.append(el("h3","Attachments"),assetCards);
  const notePane=el("article");notePane.setAttribute("data-graph-note","");notePane.hidden=true;
  const citationPreview=el("section");citationPreview.dataset.knowledgeCitation="";citationPreview.hidden=true;
  const title=el("h3"),body=el("div"),editor=el("textarea"),actions=el("nav"),meta=el("details"),metaHeading=el("summary","Links, sources & history"),metaBody=el("div");editor.hidden=true;editor.setAttribute("aria-label","Note Markdown");meta.append(metaHeading,metaBody);const sourceTrail=el("section");sourceTrail.dataset.knowledgeSourceTrail="";notePane.append(actions,title,sourceTrail,body,editor,meta);
  // A full-screen reader must survive its launching drawer becoming hidden
  // or inert at a responsive breakpoint. Its lifecycle still belongs to caller.
  layout.append(sidebar,graphPane,notePane,assetsPane);dialog.append(header,status,nav,layout);root.body.append(dialog);dialog.showModal();
  const cy=cytoscape({container:canvas,elements:[],minZoom:.15,maxZoom:4,pixelRatio:Math.min(view.devicePixelRatio||1,2),style:[
    {selector:"node",style:{label:"data(displayLabel)","background-color":"data(color)",width:22,height:22,color:dark?"#e5e9f1":"#72798a","font-size":12,"min-zoomed-font-size":8,"text-valign":"bottom","text-margin-y":8,"text-wrap":"ellipsis","text-max-width":"130px"}},
    {selector:"edge",style:{width:1.2,"line-color":"#8a95ab","curve-style":"bezier"}},
    {selector:'node[layer = "archive"]',style:{shape:"round-rectangle"}},
    {selector:'edge[layer = "archive"]',style:{"line-color":"#83c8dc","line-style":"dashed"}},
    {selector:".dim",style:{opacity:.15}},{selector:":selected",style:{"background-color":"#a28cdd"}}
  ]});
  const cloud=createKnowledgeCloud(root,id=>void open(id));graphPane.prepend(cloud.canvas,cloud.controls);let use3D=false;cloud.canvas.hidden=true;cloud.controls.hidden=true;
  const domainPanel=createKnowledgeDomainsPanel(root,request,load,id=>{showGraph();if(use3D)cloud.focusDomain(id);else{focus2DDomain=id;scheduleGraph2D();}},id=>void open(id));layout.append(domainPanel.pane);
  const dataPanel=createKnowledgeDataPanel(root,async<T>(query:string,command?:unknown)=>{const result=await request<T>(query,command);if(["start-import","withdraw-import"].includes((command as {action?:string})?.action??""))await load();return result;});layout.append(dataPanel.pane);
  const skillsPanel=createKnowledgeSkillsPanel(root,()=>void load());layout.append(skillsPanel.pane);
  const neighbors=createKnowledgeNeighbors(root,request,id=>void open(id),(relationId,index,evidence)=>void inspectEvidence(relationId,index,evidence));
  const connectionsAction=btn("Connections",()=>{noteActions.open=false;meta.open=true;neighbors.pane.tabIndex=-1;neighbors.pane.focus({preventScroll:true});neighbors.pane.scrollIntoView?.({block:"start"});});
  notePane.insertBefore(citationPreview,body);
  let graph=initial,active:KnowledgeNote|undefined,noteRequest:AbortController|undefined,disposed=false,filterLocal=false,editing=false;
  let fit2DNeeded=true,layout2DFrame=0,focus2DDomain:string|undefined;
  let returnPane:"graph"|"files"="graph",returnNoteId:string|undefined,listScroll=0;
  const storageKey="hub-knowledge-positions-v1";let positions:Record<string,{x:number;y:number}>={};try{positions=JSON.parse(view.localStorage.getItem(storageKey)??"{}");}catch{}
  const controls2D=el("div"),count2D=el("span");controls2D.className="knowledge-brain-controls";controls2D.setAttribute("aria-label","2D graph controls");controls2D.hidden=false;
  const archiveLabel=btn("Chat archive",()=>{const records=cy.nodes().filter(n=>n.data("layer")==="archive");if(records.length)cy.fit(records,60);});archiveLabel.dataset.chatArchiveLabel="";archiveLabel.hidden=true;graphPane.append(archiveLabel);
  const zoom2D=(factor:number)=>cy.zoom({level:cy.zoom()*factor,renderedPosition:{x:cy.width()/2,y:cy.height()/2}});
  const zoomOut2D=btn("−",()=>zoom2D(1/1.25)),zoomIn2D=btn("+",()=>zoom2D(1.25));zoomOut2D.setAttribute("aria-label","Zoom out");zoomIn2D.setAttribute("aria-label","Zoom in");
  controls2D.append(zoomOut2D,zoomIn2D,btn("Fit graph",()=>fitGraph2D()),count2D);graphPane.append(controls2D);
  function labelsGraph2D(){
    if(disposed||use3D||canvas.hidden)return;
    const zoom=cy.zoom(),occupied:{x:number;y:number;w:number;h:number}[]=[];
    const archived=cy.nodes().filter(n=>n.data("layer")==="archive");archiveLabel.hidden=!archived.length;if(archived.length){const box=archived.renderedBoundingBox();archiveLabel.textContent=`Chat archive · ${archived.length}`;archiveLabel.style.left=`${Math.max(80,Math.min(canvas.clientWidth-80,(box.x1+box.x2)/2))}px`;archiveLabel.style.top=`${Math.max(92,Math.min(canvas.clientHeight-130,box.y1-32))}px`;}
    cy.batch(()=>{for(const node of cy.nodes()){
      let label="";const p=node.renderedPosition(),text=String(node.data("label")),w=Math.min(130,text.length*7)*zoom,h=16*zoom,x=p.x-w/2,y=p.y+19*zoom;
      if(12*zoom>=8&&occupied.length<80&&x>=4&&x+w<canvas.clientWidth-4&&y>=64&&y+h<canvas.clientHeight-54&&!occupied.some(b=>x<b.x+b.w+6&&x+w+6>b.x&&y<b.y+b.h+4&&y+h+4>b.y)){label=text;occupied.push({x,y,w,h});}
      if(node.data("displayLabel")!==label)node.data("displayLabel",label);
    }});
  }
  function fitGraph2D(){fit2DNeeded=true;scheduleGraph2D();}
  function scheduleGraph2D(){
    view.cancelAnimationFrame(layout2DFrame);layout2DFrame=view.requestAnimationFrame(()=>{
      if(disposed||use3D||graphPane.hidden||dialog.dataset.mobilePane!=="graph"||canvas.clientWidth<=0||canvas.clientHeight<=0)return;
      cy.resize();
      // Fit only after the 2D canvas is visible. Positions share the brain's
      // stable domain layout, so sparse/disconnected records cannot pack into
      // a hidden canvas's zero-width strip.
      if(focus2DDomain){const members=new Set(knowledgeLayout(graph).groups.find(g=>g.id===focus2DDomain)?.members??[]),nodes=cy.nodes().filter(n=>members.has(n.id()));if(nodes.length)cy.fit(nodes,60);focus2DDomain=undefined;fit2DNeeded=false;}
      else if(fit2DNeeded){cy.fit(cy.elements().not(".dim"),40);fit2DNeeded=false;}
      labelsGraph2D();
    });
  }
  const reset2D=btn("Reset 2D layout",()=>{
    cy.batch(()=>{for(const p of knowledgeLayout(graph).points){delete positions[p.domainId==="hub:chat-archive"?"archive:"+p.id:p.id];cy.getElementById(p.id).position({x:(p.x*.94-p.z*.3)*2.4,y:(p.y*.94+p.z*.12)*2.4});}});
    try{view.localStorage.setItem(storageKey,JSON.stringify(positions));}catch{}fitGraph2D();
  });reset2D.hidden=false;reset2D.title="Restore the default positions for these records. Notes and connections stay unchanged.";
  const graphButton=btn("Graph",()=>showGraph()),filesButton=btn("Notes",()=>showFiles()),localButton=btn("Local graph",()=>{if(!canLeaveNote())return;filterLocal=!filterLocal;localButton.setAttribute("aria-pressed",String(filterLocal));filter();showGraph();if(!use3D)fitGraph2D();}),fit=btn("Fit",()=>{if(use3D)cloud.fit();else fitGraph2D();}),refresh=btn("Refresh",()=>void load());const dimension=btn("2D",()=>{use3D=!use3D;dimension.textContent=use3D?"3D":"2D";cloud.canvas.hidden=!use3D;cloud.controls.hidden=!use3D;controls2D.hidden=use3D;reset2D.hidden=use3D;canvas.hidden=use3D;archiveLabel.hidden=use3D;if(use3D)cloud.resize();else fitGraph2D();});nav.append(graphButton,filesButton,btn("Chat archive",()=>showFiles(true,"archive")));const graphOptions=el("details");graphOptions.className="knowledge-graph-options";graphOptions.append(el("summary","Graph options"),dimension,localButton,fit,reset2D,refresh);graphPane.append(graphOptions);
  nav.append(btn("Domains",()=>{if(!canLeaveNote())return;dialog.dataset.mobilePane="domains";dataPanel.pane.hidden=true;sidebar.hidden=true;graphPane.hidden=true;notePane.hidden=true;assetsPane.hidden=true;void domainPanel.show();}),btn("Data",()=>{if(!canLeaveNote())return;dialog.dataset.mobilePane="data";domainPanel.pane.hidden=true;sidebar.hidden=true;graphPane.hidden=true;notePane.hidden=true;assetsPane.hidden=true;void dataPanel.show();}));
  const back=btn("‹ Knowledge",()=>returnFromNote());
  const edit=btn("Edit",()=>{if(!active)return;if(editing){discardEdit();return;}editing=true;editor.value=active.content;editor.hidden=false;body.hidden=true;save.hidden=false;edit.textContent="Discard changes";editor.focus();});
  const save=btn("Save",()=>void saveNote());save.hidden=true;
  const upload=el("input");upload.type="file";upload.multiple=true;upload.hidden=true;upload.setAttribute("aria-label","Add knowledge files");dialog.append(upload);
  let attachToCurrent=false;
  const attach=btn("Attach file",()=>{noteActions.open=false;if(editing){status.textContent="Save your note changes before attaching a file.";return;}attachToCurrent=true;upload.click();});
  const showAssets=async()=>{if(!canLeaveNote())return;dialog.dataset.mobilePane="assets";domainPanel.pane.hidden=true;dataPanel.pane.hidden=true;assetsPane.hidden=false;sidebar.hidden=true;graphPane.hidden=true;notePane.hidden=true;const result=await request<{assets:KnowledgeAsset[]}>("view=assets");media.renderAssets(assetCards,result.assets);};
  nav.append(btn("Attachments",()=>void showAssets().catch(()=>{status.textContent="Couldn’t load attachments.";})),btn("Add files",()=>{if(!canLeaveNote())return;attachToCurrent=false;upload.click();}));
  nav.append(btn("Skills",()=>{if(!canLeaveNote())return;dialog.dataset.mobilePane="skills";domainPanel.pane.hidden=true;dataPanel.pane.hidden=true;sidebar.hidden=true;graphPane.hidden=true;notePane.hidden=true;assetsPane.hidden=true;void skillsPanel.show();}));
  nav.setAttribute("aria-label","Knowledge navigation");
  const views=el("select");views.setAttribute("aria-label","Knowledge view");views.setAttribute("data-knowledge-view-select","");
  const routes=new Map<string,HTMLButtonElement>();
  for(const [value,label]of [["graph","Graph"],["files","Notes"],["archive","Chat archive"],["domains","Domains"],["data","Data"],["assets","Attachments"],["skills","Skills"]]){
    const target=[...nav.querySelectorAll("button")].find(b=>b.textContent===label)!;target.setAttribute("data-knowledge-view-route","");routes.set(value!,target);
    const option=el("option",label);option.value=value!;views.append(option);
  }
  nav.prepend(views);let selectedView="graph";
  const syncView=()=>{const pane=dialog.dataset.mobilePane;if(pane&&pane!=="note"){selectedView=pane==="files"&&scope.value==="archive"?"archive":pane;views.value=selectedView;}skillsPanel.pane.hidden=pane!=="skills";};
  views.addEventListener("change",()=>{const previous=selectedView;routes.get(views.value)?.click();syncView();if(dialog.dataset.mobilePane==="note")views.value=previous;});
  const navigationObserver=new view.MutationObserver(syncView);navigationObserver.observe(dialog,{attributes:true,attributeFilter:["data-mobile-pane"]});
  const obsidian=el("a","Open in Obsidian");obsidian.className="knowledge-obsidian";
  const forgetSelection=btn("Forget selected passage",()=>{noteActions.open=false;void forget();}),noteActions=el("details"),noteActionsBody=el("div");noteActions.setAttribute("data-hub-action-menu","More actions");noteActions.append(el("summary","More actions"),noteActionsBody);noteActionsBody.append(connectionsAction,attach,obsidian,forgetSelection);actions.append(back,edit,save,noteActions);
  function discardEdit(){editing=false;editor.value=active?.content??"";editor.hidden=true;body.hidden=false;save.hidden=true;edit.textContent="Edit";}
  function canLeaveNote(){if(!domainPanel.pane.hidden&&!domainPanel.canLeave()||!dataPanel.pane.hidden&&!dataPanel.canLeave()||!skillsPanel.pane.hidden&&!skillsPanel.canLeave())return false;if(editing&&editor.value!==active?.content){status.textContent="Save or discard your note changes before leaving.";editor.focus();return false;}if(editing)discardEdit();return true;}
  function requestClose(){if(canLeaveNote())dialog.close();}
  function showGraph(){if(!canLeaveNote())return;dialog.dataset.mobilePane="graph";domainPanel.pane.hidden=true;dataPanel.pane.hidden=true;assetsPane.hidden=true;graphPane.hidden=false;notePane.hidden=true;sidebar.hidden=false;view.requestAnimationFrame(()=>{if(disposed)return;if(use3D)cloud.resize();else scheduleGraph2D();});}
  function showFiles(focusSearch=true,collection:KnowledgeRecordScope="brain"){if(!canLeaveNote())return;dialog.dataset.mobilePane="files";domainPanel.pane.hidden=true;dataPanel.pane.hidden=true;assetsPane.hidden=true;graphPane.hidden=false;notePane.hidden=true;sidebar.hidden=false;scope.value=collection;updateSearchHint();void refreshList();if(focusSearch)search.focus();}
  function returnFromNote(){if(!canLeaveNote())return;if(returnPane==="files"){showFiles(false,scope.value as KnowledgeRecordScope);sidebar.scrollTop=listScroll;const origin=[...tree.querySelectorAll<HTMLButtonElement>("button[data-note-id]")].find(button=>button.dataset.noteId===returnNoteId);origin?.focus({preventScroll:true});}else showGraph();}
  async function request<T>(query:string,command?:unknown):Promise<T>{const response=await view.fetch(`/api/hub/memory${query?"?"+query:""}`,{method:command?"POST":"GET",credentials:"same-origin",cache:"no-store",headers:{"x-hub-memory":"1",...(command?{"content-type":"application/json"}:{})},body:command?JSON.stringify(command):undefined,signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(30000)])});if(!response.ok){const error=await response.json().catch(()=>({}));throw new Error(error.detail??"Knowledge request failed. Refresh to retry.");}return response.json();}
  function list(nodes:KnowledgeNode[]){nodes=nodes.filter(n=>matchesKnowledgeScope(n,scope.value as KnowledgeRecordScope));tree.replaceChildren();if(!nodes.length){tree.append(el("p",scope.value==="archive"?"No conversations here yet.":scope.value==="brain"?"No brain notes yet. Ask HUB to save information when you want it here.":"No matching records."));return;}const folders=new Map<string,HTMLDetailsElement>();for(const n of nodes){const folder=isArchivedConversation(n)?"Chat archive":n.permalink.includes("/")?n.permalink.slice(0,n.permalink.lastIndexOf("/")):"Brain notes";let group=folders.get(folder);if(!group){group=el("details");group.open=true;group.append(el("summary",folder));tree.append(group);folders.set(folder,group);}const b=btn(n.title,()=>void open(n.id));b.setAttribute("data-note-id",n.id);group.append(b);}}
  function filter(){cloud.select(active?.id,filterLocal);cy.elements().removeClass("dim");if(filterLocal&&active){const selected=cy.getElementById(active.id);cy.elements().not(selected.closedNeighborhood()).addClass("dim");}}
  function render(next:KnowledgeGraph){
    graph=next;cloud.update(next);const spatial=knowledgeLayout(next);const points=new Map(spatial.points.map(p=>[p.id,p]));cy.batch(()=>{
      const nodeIds=new Set(next.nodes.map(n=>n.id));cy.nodes().filter(n=>!nodeIds.has(n.id())).remove();
      for(const n of next.nodes){const point=points.get(n.id)!,old=cy.getElementById(n.id),color=point.color.replaceAll(" ",",");if(old.length)old.data({label:n.title,color,layer:isArchivedConversation(n)?"archive":"brain"});else{const saved=positions[isArchivedConversation(n)?"archive:"+n.id:n.id],position=Number.isFinite(saved?.x)&&Number.isFinite(saved?.y)?saved:{x:(point.x*.94-point.z*.3)*2.4,y:(point.y*.94+point.z*.12)*2.4};cy.add({data:{id:n.id,label:n.title,displayLabel:"",color,layer:isArchivedConversation(n)?"archive":"brain"},position});}}
      const edges=new Set(next.edges.map(e=>`link:${e.source}:${e.target}`));cy.edges().filter(e=>!edges.has(e.id())).remove();
      const archiveIds=new Set(next.nodes.filter(isArchivedConversation).map(n=>n.id));
      for(const e of next.edges){const id=`link:${e.source}:${e.target}`;const layer=archiveIds.has(e.source)||archiveIds.has(e.target)?"archive":"brain";if(!cy.getElementById(id).length)cy.add({data:{id,source:e.source,target:e.target,layer}});else cy.getElementById(id).data("layer",layer);}
    });
    count2D.textContent=`${next.nodes.length} records · ${next.edges.length} connections`;if(!use3D)scheduleGraph2D();
    filter();if(!search.value.trim())list(next.nodes);const counts=knowledgeRecordCounts(next.nodes);status.textContent=`${counts.brain} brain notes · ${counts.chats} chats · ${next.edges.length} connections${next.sourceCoverage?.omitted?` · ${next.sourceCoverage.omitted} large files retained but not indexed`:""}${next.omittedRelations?` · ${next.omittedRelations} unresolved legacy links`:""}`;
  }
  function renderBody(content:string){if(active)media.renderBody(body,{...active,content},id=>void open(id),graph.nodes);}
  async function open(id:string){if(!canLeaveNote())return;if(notePane.hidden){returnPane=dialog.dataset.mobilePane==="files"?"files":"graph";returnNoteId=id;listScroll=sidebar.scrollTop;}noteRequest?.abort();const controller=noteRequest=new AbortController();try{const note=await request<KnowledgeNote>(`view=note&id=${encodeURIComponent(id)}`);if(controller.signal.aborted||disposed)return;active=note;citationPreview.hidden=true;edit.disabled=!!note.protected;attach.disabled=!!note.protected;forgetSelection.disabled=!!note.protected;title.textContent=note.title;sourceTrail.replaceChildren(el("small",isArchivedConversation(note)?"Original conversation · Chat archive":"Brain note"));
      const sourceIds=new Set(note.sources.map(s=>s.conversationId).filter((id):id is string=>!!id)),linked=[...new Map([...note.links,...note.backlinks].map(n=>[n.id,n])).values()];
      const related=isArchivedConversation(note)?linked.filter(n=>!isArchivedConversation(n)):[...new Map([...linked.filter(isArchivedConversation),...graph.nodes.filter(n=>sourceIds.has(n.id)&&isArchivedConversation(n))].map(n=>[n.id,n])).values()];
      if(related.length){sourceTrail.append(el("h4",isArchivedConversation(note)?"Linked brain notes":"Source conversations"));for(const n of related){const link=btn(n.title,()=>void open(n.id));link.dataset.sourceLink=n.id;sourceTrail.append(link);}}
      renderBody(note.content);body.hidden=false;editor.hidden=true;save.hidden=true;metaBody.replaceChildren(neighbors.pane);void neighbors.load(id);
      for(const [label,nodes] of [["Backlinks",note.backlinks],["Outgoing links",note.links]] as const){metaBody.append(el("h4",label));for(const n of nodes)metaBody.append(btn(n.title,()=>void open(n.id)));if(!nodes.length)metaBody.append(el("p","No links yet."));}
      metaBody.append(el("h4","Sources"));for(const s of note.sources)metaBody.append(btn(`${s.channel} · ${new Date(s.completedAt).toLocaleString()}`,()=>s.conversationId?void open(s.conversationId):void showSource(s.id)));
      const uri=await request<{vault:string}>("");obsidian.href=`obsidian://open?vault=${encodeURIComponent(uri.vault.split(/[\\/]/).at(-1)!)}&file=${encodeURIComponent(note.permalink)}`;
      assetsPane.hidden=true;domainPanel.pane.hidden=true;dataPanel.pane.hidden=true;notePane.hidden=false;dialog.dataset.mobilePane="note";if(view.innerWidth<900){graphPane.hidden=true;sidebar.hidden=true;}filter();
    }catch{if(!disposed)status.textContent="Couldn’t open this note. Refresh to retry.";}}
  async function inspectEvidence(relationId:string,index:number,evidence:KnowledgeEvidence){if(!canLeaveNote())return;const from=active?.id;try{const data=await request<{version:string;sourceTitle:string;excerpt?:{text:string}}>(`view=evidence&relation=${encodeURIComponent(relationId)}&index=${index}`);if(disposed||notePane.hidden||active?.id!==from)return;await open(evidence.sourceId);if(active?.id!==evidence.sourceId)return;citationPreview.replaceChildren(el("h4",`Source excerpt · ${data.version}`),el("blockquote",evidence.quote),el("p",[evidence.role,evidence.occurredAt?new Date(evidence.occurredAt).toLocaleString():undefined].filter(Boolean).join(" · ")));if(data.excerpt)citationPreview.append(el("pre",data.excerpt.text));else citationPreview.append(el("p","The retained quote is available; the complete original version is unavailable."));citationPreview.hidden=false;citationPreview.scrollIntoView?.({block:"start"});}catch(e){status.textContent=(e as Error).message;}}
  async function showSource(id:string){try{const s=await request<{content:string;assets?:KnowledgeAsset[];urls?:string[]}>(`view=source&id=${encodeURIComponent(id)}`);const text=el("pre",s.content);text.className="knowledge-source";metaBody.append(text);for(const asset of s.assets??[])media.file(metaBody,asset.name,asset.path,asset.mediaType);for(const url of s.urls??[]){if(!/^https?:\/\//i.test(url))continue;const link=el("a",url);link.href=url;link.target="_blank";link.rel="noopener noreferrer";metaBody.append(link);}}catch{status.textContent="Source unavailable.";}}
  upload.addEventListener("change",async()=>{const files=[...(upload.files??[])];if(!files.length)return;status.textContent="Saving your files…";try{for(const file of files){if(file.size>25000000)throw Error("Choose files smaller than 25 MB.");const selected=attachToCurrent?active:undefined;const query="action=upload-asset"+(selected?"&noteId="+encodeURIComponent(selected.id)+"&hash="+selected.hash:"");const response=await view.fetch("/api/hub/memory?"+query,{method:"POST",credentials:"same-origin",headers:{"x-hub-memory":"1","x-hub-filename":encodeURIComponent(file.name),"content-type":"application/octet-stream"},body:file,signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(60000)])});if(!response.ok)throw Error("Couldn’t attach the file. Refresh the note and try again.");const result=await response.json();if(result.note){active=result.note;renderBody(active!.content);}}status.textContent="Original files saved in your Obsidian vault. Knowledge AI will process useful content in the background.";if(!attachToCurrent)await showAssets();}catch(error){status.textContent=(error as Error).message;}finally{upload.value="";}});
  async function saveNote(){if(!active||!editing)return;save.disabled=true;try{active=await request<KnowledgeNote>("",{action:"save-note",id:active.id,hash:active.hash,content:editor.value});discardEdit();renderBody(active.content);status.textContent="Saved to the Obsidian vault.";await load();}catch{status.textContent="The note changed elsewhere. Your draft is preserved; reload before saving.";}finally{save.disabled=false;}}
  async function forget(){if(!active)return;const selection=view.getSelection(),passage=selection?.toString();if(!passage?.trim()||!selection?.anchorNode||!body.contains(selection.anchorNode)){status.textContent="Select the exact passage in the note to forget.";return;}if(!view.confirm("Forget this passage? Earlier conversations will not relearn it automatically."))return;try{active=await request<KnowledgeNote>("",{action:"forget",id:active.id,hash:active.hash,passage});renderBody(active.content);status.textContent="Forgotten. Earlier evidence is retired.";await load();}catch{status.textContent="The passage changed or contains a formatted link. Edit the note or reload before forgetting.";}}
  async function load(){if(disposed||root.hidden)return;try{render(await request<KnowledgeGraph>("view=graph"));}catch{if(!disposed)status.textContent="Knowledge is unavailable. Refresh to retry.";}}
  function updateSearchHint(){search.placeholder=scope.value==="archive"?"Search chats…":scope.value==="brain"?"Search brain notes…":"Search all records…";}
  let searchTimer:number|undefined,searchRevision=0;
  async function refreshList(){const revision=++searchRevision;try{const nodes=!search.value.trim()?graph.nodes:(await request<{nodes:KnowledgeNode[]}>(`view=search&q=${encodeURIComponent(search.value)}&scope=${scope.value}`)).nodes;if(revision===searchRevision&&!disposed)list(nodes);}catch{if(revision===searchRevision&&!disposed)status.textContent="Search unavailable.";}}
  scope.addEventListener("change",()=>{updateSearchHint();void refreshList();});
  search.addEventListener("input",()=>{searchRevision++;view.clearTimeout(searchTimer);searchTimer=view.setTimeout(()=>void refreshList(),250);});
  cy.on("tap","node",event=>{void open(event.target.id());});cy.on("dragfree","node",()=>{for(const n of cy.nodes())positions[n.data("layer")==="archive"?"archive:"+n.id():n.id()]=n.position();try{view.localStorage.setItem(storageKey,JSON.stringify(positions));}catch{}});
  cy.on("zoom pan resize dragfree",labelsGraph2D);
  let lastSize="";const resize=new view.ResizeObserver(entries=>{const rect=entries[0]?.contentRect,key=`${rect?.width}:${rect?.height}`;if(key===lastSize)return;lastSize=key;if(!use3D)fitGraph2D();});resize.observe(canvas);
  const removeBack=installMobileWidgetBack(dialog,header,()=>{if(!notePane.hidden)returnFromNote();else requestClose();});
  const timer=view.setInterval(()=>void load(),5000);
  function dispose(){if(disposed)return;disposed=true;lifetime.abort();noteRequest?.abort();view.clearTimeout(searchTimer);view.clearInterval(timer);view.cancelAnimationFrame(layout2DFrame);resize.disconnect();navigationObserver.disconnect();removeBack();neighbors.dispose();skillsPanel.dispose();dataPanel.dispose();domainPanel.dispose();cloud.dispose();cy.destroy();dialog.remove();onClose();}
  dialog.addEventListener("close",dispose);dialog.addEventListener("cancel",event=>{if(!canLeaveNote())event.preventDefault();else if(!notePane.hidden){event.preventDefault();returnFromNote();}});
  render(initial);showGraph();return dispose;
}
