import cytoscape from "cytoscape";
import type { KnowledgeGraph, KnowledgeNote, KnowledgeNode } from "../../knowledge-contract.ts";
import { installMobileWidgetBack } from "../host/mobile-widget-back.ts";
import {createKnowledgeMedia} from "./knowledge-media.ts";
import {createKnowledgeCloud} from "./knowledge-cloud.ts";
import type {KnowledgeAsset} from "../../knowledge-contract.ts";

/** Full note workspace. DOM text rendering deliberately never executes vault
 * HTML. Useful wiki aliases display inline and open the real target note. */
export function openKnowledgeWorkspace(container:HTMLElement,root:Document,initial:KnowledgeGraph,onClose:()=>void){
  const view=root.defaultView!,lifetime=new AbortController();
  const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const node=root.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  const btn=(label:string,run:()=>void)=>{const b=el("button",label);b.type="button";b.addEventListener("click",run);return b;};
  const dialog=el("dialog");dialog.setAttribute("data-hub-graph-dialog","");dialog.setAttribute("data-knowledge-workspace","");dialog.setAttribute("aria-label","Knowledge workspace");
  const dark=root.documentElement.classList.contains("dark")||root.documentElement.hasAttribute("data-ds-dark-theme")||root.body.hasAttribute("data-ds-dark-theme");dialog.dataset.knowledgeTheme=dark?"dark":"light";
  const header=el("header"),heading=el("h2","Knowledge"),close=btn("Home",()=>dialog.close());header.append(heading,close);
  const status=el("p");status.setAttribute("role","status");
  const nav=el("nav"),layout=el("section");layout.className="knowledge-layout";
  const sidebar=el("aside"),search=el("input");search.type="search";search.placeholder="Search notes…";search.setAttribute("aria-label","Search knowledge");
  const tree=el("div");tree.setAttribute("data-knowledge-tree","");sidebar.append(search,tree);
  const graphPane=el("section"),canvas=el("div");canvas.setAttribute("data-graph-canvas","");graphPane.append(canvas);
  const media=createKnowledgeMedia(root),assetsPane=el("section"),assetCards=el("div");assetsPane.setAttribute("data-knowledge-assets","");assetsPane.hidden=true;assetsPane.append(el("h3","Attachments"),assetCards);
  const notePane=el("article");notePane.setAttribute("data-graph-note","");notePane.hidden=true;
  const title=el("h3"),body=el("div"),editor=el("textarea"),actions=el("nav"),meta=el("details"),metaHeading=el("summary","Links, sources & history"),metaBody=el("div");editor.hidden=true;editor.setAttribute("aria-label","Note Markdown");meta.append(metaHeading,metaBody);notePane.append(actions,title,body,editor,meta);
  layout.append(sidebar,graphPane,notePane,assetsPane);dialog.append(header,status,nav,layout);container.append(dialog);dialog.showModal();
  const cy=cytoscape({container:canvas,elements:[],minZoom:.15,maxZoom:4,pixelRatio:Math.min(view.devicePixelRatio||1,2),style:[
    {selector:"node",style:{label:"data(label)","background-color":"#70ad9b",width:22,height:22,color:dark?"#e5e9f1":"#72798a","font-size":12,"min-zoomed-font-size":8,"text-valign":"bottom","text-margin-y":8,"text-wrap":"ellipsis","text-max-width":"130px"}},
    {selector:"edge",style:{width:1.2,"line-color":"#8a95ab","curve-style":"bezier"}},
    {selector:".dim",style:{opacity:.15}},{selector:":selected",style:{"background-color":"#a28cdd"}}
  ]});
  const cloud=createKnowledgeCloud(root,id=>void open(id));graphPane.prepend(cloud.canvas);let use3D=true;canvas.hidden=true;
  let graph=initial,active:KnowledgeNote|undefined,noteRequest:AbortController|undefined,disposed=false,first=true,filterLocal=false,editing=false;
  const storageKey="hub-knowledge-positions-v1";let positions:Record<string,{x:number;y:number}>={};try{positions=JSON.parse(view.localStorage.getItem(storageKey)??"{}");}catch{}
  const graphButton=btn("Graph",()=>showGraph()),filesButton=btn("Notes",()=>{dialog.dataset.mobilePane="files";sidebar.hidden=false;search.focus();}),localButton=btn("Local graph",()=>{filterLocal=!filterLocal;localButton.setAttribute("aria-pressed",String(filterLocal));filter();showGraph();}),fit=btn("Fit",()=>{if(use3D)cloud.fit();else cy.fit(cy.elements().not(".dim"),40);}),refresh=btn("Refresh",()=>void load());const dimension=btn("3D",()=>{use3D=!use3D;dimension.textContent=use3D?"3D":"2D";cloud.canvas.hidden=!use3D;canvas.hidden=use3D;if(use3D)cloud.resize();else{cy.resize();cy.fit(undefined,40);}});nav.append(graphButton,filesButton);const graphOptions=el("details");graphOptions.className="knowledge-graph-options";graphOptions.append(el("summary","Graph options"),dimension,localButton,fit,refresh);graphPane.append(graphOptions);
  const back=btn("‹ Knowledge",()=>{if(editing){editor.hidden=true;body.hidden=false;editing=false;}else showGraph();});
  const edit=btn("Edit",()=>{if(!active)return;editing=!editing;editor.value=active.content;editor.hidden=!editing;body.hidden=editing;save.hidden=!editing;if(editing)editor.focus();});
  const save=btn("Save",()=>void saveNote());save.hidden=true;
  const upload=el("input");upload.type="file";upload.multiple=true;upload.hidden=true;upload.setAttribute("aria-label","Add knowledge files");dialog.append(upload);
  let attachToCurrent=false;
  const attach=btn("Attach file",()=>{if(editing){status.textContent="Save your note changes before attaching a file.";return;}attachToCurrent=true;upload.click();});actions.append(attach);
  const showAssets=async()=>{dialog.dataset.mobilePane="assets";assetsPane.hidden=false;sidebar.hidden=true;graphPane.hidden=true;notePane.hidden=true;const result=await request<{assets:KnowledgeAsset[]}>("view=assets");media.renderAssets(assetCards,result.assets);};
  nav.append(btn("Attachments",()=>void showAssets().catch(()=>{status.textContent="Couldn’t load attachments.";})),btn("Add files",()=>{attachToCurrent=false;upload.click();}));
  const obsidian=el("a","Open in Obsidian");obsidian.className="knowledge-obsidian";actions.append(back,edit,save,obsidian);
  const forgetSelection=btn("Forget selected passage",()=>void forget());actions.append(forgetSelection);
  function showGraph(){dialog.dataset.mobilePane="graph";assetsPane.hidden=true;graphPane.hidden=false;notePane.hidden=true;sidebar.hidden=false;save.hidden=true;editing=false;view.requestAnimationFrame(()=>cy.resize());}
  async function request<T>(query:string,command?:unknown):Promise<T>{const response=await view.fetch(`/api/hub/memory${query?"?"+query:""}`,{method:command?"POST":"GET",credentials:"same-origin",cache:"no-store",headers:{"x-hub-memory":"1",...(command?{"content-type":"application/json"}:{})},body:command?JSON.stringify(command):undefined,signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(30000)])});if(!response.ok)throw new Error("Knowledge request failed");return response.json();}
  function list(nodes:KnowledgeNode[]){tree.replaceChildren();const folders=new Map<string,HTMLDetailsElement>();for(const n of nodes){const folder=n.permalink.includes("/")?n.permalink.slice(0,n.permalink.lastIndexOf("/")):"Notes";let group=folders.get(folder);if(!group){group=el("details");group.open=true;group.append(el("summary",folder));tree.append(group);folders.set(folder,group);}const b=btn(n.title,()=>void open(n.id));b.setAttribute("data-note-id",n.id);group.append(b);}}
  function filter(){cloud.select(active?.id,filterLocal);cy.elements().removeClass("dim");if(filterLocal&&active){const selected=cy.getElementById(active.id);cy.elements().not(selected.closedNeighborhood()).addClass("dim");}}
  function render(next:KnowledgeGraph){
    graph=next;cloud.update(next);cy.batch(()=>{
      const nodeIds=new Set(next.nodes.map(n=>n.id));cy.nodes().filter(n=>!nodeIds.has(n.id())).remove();
      for(const n of next.nodes){const old=cy.getElementById(n.id);if(old.length)old.data("label",n.title);else{const adjacent=next.edges.find(e=>e.source===n.id||e.target===n.id);const other=adjacent?cy.getElementById(adjacent.source===n.id?adjacent.target:adjacent.source):undefined;const center=other?.length?other.position():{x:Math.cos(cy.nodes().length*2.4)*140,y:Math.sin(cy.nodes().length*2.4)*140};cy.add({data:{id:n.id,label:n.title},position:positions[n.id]??{x:center.x+60,y:center.y+50}});}}
      const edges=new Set(next.edges.map(e=>`link:${e.source}:${e.target}`));cy.edges().filter(e=>!edges.has(e.id())).remove();
      for(const e of next.edges){const id=`link:${e.source}:${e.target}`;if(!cy.getElementById(id).length)cy.add({data:{id,source:e.source,target:e.target}});}
    });
    if(first){first=false;if(!Object.keys(positions).length)cy.layout({name:next.edges.length?"cose":"grid",animate:false,randomize:false,fit:true,padding:40,nodeDimensionsIncludeLabels:true}).run();else cy.fit(undefined,40);}
    filter();if(!search.value.trim())list(next.nodes);status.textContent=`${next.nodes.length} notes · ${next.edges.length} connections${next.omittedRelations?` · ${next.omittedRelations} unresolved legacy links`:""}`;
  }
  function renderBody(content:string){if(active)media.renderBody(body,{...active,content},id=>void open(id),graph.nodes);}
  async function open(id:string){if(editing){status.textContent="Save or cancel your note edit first.";return;}noteRequest?.abort();const controller=noteRequest=new AbortController();try{const note=await request<KnowledgeNote>(`view=note&id=${encodeURIComponent(id)}`);if(controller.signal.aborted||disposed)return;active=note;edit.disabled=!!note.protected;attach.disabled=!!note.protected;forgetSelection.disabled=!!note.protected;title.textContent=note.title;renderBody(note.content);body.hidden=false;editor.hidden=true;save.hidden=true;metaBody.replaceChildren();
      for(const [label,nodes] of [["Backlinks",note.backlinks],["Outgoing links",note.links]] as const){metaBody.append(el("h4",label));for(const n of nodes)metaBody.append(btn(n.title,()=>void open(n.id)));if(!nodes.length)metaBody.append(el("p","No links yet."));}
      metaBody.append(el("h4","Sources"));for(const s of note.sources)metaBody.append(btn(`${s.channel} · ${new Date(s.completedAt).toLocaleString()}`,()=>void showSource(s.id)));
      const uri=await request<{vault:string}>("");obsidian.href=`obsidian://open?vault=${encodeURIComponent(uri.vault.split(/[\\/]/).at(-1)!)}&file=${encodeURIComponent(note.permalink)}`;
      assetsPane.hidden=true;notePane.hidden=false;dialog.dataset.mobilePane="note";if(view.innerWidth<900){graphPane.hidden=true;sidebar.hidden=true;}filter();
    }catch{if(!disposed)status.textContent="Couldn’t open this note. Refresh to retry.";}}
  async function showSource(id:string){try{const s=await request<{content:string;assets?:KnowledgeAsset[];urls?:string[]}>(`view=source&id=${encodeURIComponent(id)}`);const text=el("pre",s.content);text.className="knowledge-source";metaBody.append(text);for(const asset of s.assets??[])media.file(metaBody,asset.name,asset.path,asset.mediaType);for(const url of s.urls??[]){if(!/^https?:\/\//i.test(url))continue;const link=el("a",url);link.href=url;link.target="_blank";link.rel="noopener noreferrer";metaBody.append(link);}}catch{status.textContent="Source unavailable.";}}
  upload.addEventListener("change",async()=>{const files=[...(upload.files??[])];if(!files.length)return;status.textContent="Saving your files…";try{for(const file of files){if(file.size>25000000)throw Error("Choose files smaller than 25 MB.");const selected=attachToCurrent?active:undefined;const query="action=upload-asset"+(selected?"&noteId="+encodeURIComponent(selected.id)+"&hash="+selected.hash:"");const response=await view.fetch("/api/hub/memory?"+query,{method:"POST",credentials:"same-origin",headers:{"x-hub-memory":"1","x-hub-filename":encodeURIComponent(file.name),"content-type":"application/octet-stream"},body:file,signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(60000)])});if(!response.ok)throw Error("Couldn’t attach the file. Refresh the note and try again.");const result=await response.json();if(result.note){active=result.note;renderBody(active!.content);}}status.textContent="Original files saved in your Obsidian vault. Knowledge AI will process useful content in the background.";if(!attachToCurrent)await showAssets();}catch(error){status.textContent=(error as Error).message;}finally{upload.value="";}});
  async function saveNote(){if(!active)return;save.disabled=true;try{active=await request<KnowledgeNote>("",{action:"save-note",id:active.id,hash:active.hash,content:editor.value});editing=false;editor.hidden=true;body.hidden=false;save.hidden=true;renderBody(active.content);status.textContent="Saved to the Obsidian vault.";await load();}catch{status.textContent="The note changed elsewhere. Your draft is preserved; reload before saving.";}finally{save.disabled=false;}}
  async function forget(){if(!active)return;const selection=view.getSelection(),passage=selection?.toString();if(!passage?.trim()||!selection?.anchorNode||!body.contains(selection.anchorNode)){status.textContent="Select the exact passage in the note to forget.";return;}if(!view.confirm("Forget this passage? Earlier conversations will not relearn it automatically."))return;try{active=await request<KnowledgeNote>("",{action:"forget",id:active.id,hash:active.hash,passage});renderBody(active.content);status.textContent="Forgotten. Earlier evidence is retired.";await load();}catch{status.textContent="The passage changed or contains a formatted link. Edit the note or reload before forgetting.";}}
  async function load(){if(disposed||root.hidden)return;try{render(await request<KnowledgeGraph>("view=graph"));}catch{if(!disposed)status.textContent="Knowledge is unavailable. Refresh to retry.";}}
  let searchTimer:number|undefined;search.addEventListener("input",()=>{view.clearTimeout(searchTimer);searchTimer=view.setTimeout(async()=>{try{if(!search.value.trim())list(graph.nodes);else list((await request<{nodes:KnowledgeNode[]}>(`view=search&q=${encodeURIComponent(search.value)}`)).nodes);}catch{status.textContent="Search unavailable.";}},250);});
  cy.on("tap","node",event=>{void open(event.target.id());});cy.on("dragfree","node",()=>{for(const n of cy.nodes())positions[n.id()]=n.position();try{view.localStorage.setItem(storageKey,JSON.stringify(positions));}catch{}});
  let resizeFrame=0,lastSize="";const resize=new view.ResizeObserver(entries=>{const rect=entries[0]?.contentRect,key=`${rect?.width}:${rect?.height}`;if(key===lastSize)return;lastSize=key;view.cancelAnimationFrame(resizeFrame);resizeFrame=view.requestAnimationFrame(()=>{if(!disposed)cy.resize();});});resize.observe(canvas);
  const removeBack=installMobileWidgetBack(dialog,header,()=>{if(!notePane.hidden)showGraph();else dialog.close();});
  const timer=view.setInterval(()=>void load(),5000);
  function dispose(){if(disposed)return;disposed=true;lifetime.abort();noteRequest?.abort();view.clearTimeout(searchTimer);view.clearInterval(timer);view.cancelAnimationFrame(resizeFrame);resize.disconnect();removeBack();cloud.dispose();cy.destroy();dialog.remove();onClose();}
  dialog.addEventListener("close",dispose);dialog.addEventListener("cancel",event=>{if(!notePane.hidden){event.preventDefault();showGraph();}});
  render(initial);showGraph();return dispose;
}
