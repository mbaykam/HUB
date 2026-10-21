import {useEffect,useRef} from "react";
import {defineOverlayStyle} from "../shared/style-runtime.ts";
import styles from "./tools.css";
import {isLegacyMemoryTool} from "../../memory-tool-groups.ts";
const installStyles=defineOverlayStyle("hub-tool-inventory",styles);
interface Tool {name:string;description:string;parameters:unknown;hostRegistered:boolean;contexts:number;characterContexts:string[]}
interface Catalog {tools:Tool[];characters:{id:string;name:string;configured:boolean;policy:{mode:"inherit"|"allow";names?:string[]}}[];services?:{browser:{ready:boolean;installed:boolean;version?:string}};meaning:string}

export function installToolBrowser(container:HTMLElement,root:Document){
  const view=root.defaultView!,lifetime=new AbortController(),offStyle=installStyles(root);
  const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const node=root.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  container.setAttribute("data-hub-tools","");const header=el("header"),refresh=el("button","Refresh");refresh.type="button";header.append(el("h2","Tools"),refresh);
  const filters=el("div"),character=el("select"),search=el("input"),access=el("select"),list=el("div"),status=el("p"),help=el("p");
  search.type="search";search.placeholder="Find a tool…";search.setAttribute("aria-label","Find a tool");character.setAttribute("aria-label","Character tool access");access.setAttribute("aria-label","Tool access filter");
  for(const [value,label]of [["all","Current tools"],["allowed","Allowed by character"],["denied","Disabled for character"],["unavailable","Not registered"],["retired","Retired tools"]]){const option=el("option",label);option.value=value!;access.append(option);}
  filters.append(character,search,access);status.setAttribute("role","status");list.className="hub-tool-list";container.append(header,el("p","Explore the harness tools and each character’s permissions. Select a character to see its access."),filters,status,list,help);
  let catalog:Catalog|undefined;
  function render(){if(!catalog)return;const owner=catalog.characters.find(c=>c.id===character.value),query=search.value.toLocaleLowerCase();list.replaceChildren();let count=0;
    for(const tool of catalog.tools){const retired=isLegacyMemoryTool(tool.name),allowed=!retired&&(!owner||owner.policy.mode==="inherit"||owner.policy.names?.includes(tool.name)),registered=tool.hostRegistered||tool.contexts>0;
      if(retired!== (access.value==="retired"))continue;
      if(!(tool.name+" "+tool.description).toLocaleLowerCase().includes(query)||access.value==="allowed"&&!allowed||access.value==="denied"&&allowed||access.value==="unavailable"&&registered)continue;
      count++;const row=el("details"),summary=el("summary"),name=el("strong",tool.name),badge=el("small",retired?"Retired · execution disabled":!allowed?"Disabled":!registered?"Not registered":tool.hostRegistered?"Allowed · host tool":tool.characterContexts.includes(owner?.id??"")?"Allowed · active context":"Allowed · context dependent");summary.append(name,badge);row.append(summary,el("p",retired?"This legacy store is retired. Use the current Knowledge and Skills tools. Saved permissions do not enable it.":tool.description));
      if(owner&&!owner.configured)row.append(el("p","Choose a model for this character before it can run."));
      if(tool.parameters){const schema=el("details"),pre=el("pre",JSON.stringify(tool.parameters,null,2));schema.append(el("summary","Tool inputs"),pre);row.append(schema);}
      row.append(el("small",registered?(tool.hostRegistered?"Registered in the host.":"Registered in "+tool.contexts+" active context(s).") :"This permission name currently has no registered tool."));list.append(row);
    }status.textContent=count+" tools"+(owner?" · "+owner.name:"")+(!owner?.configured&&owner?" · model not configured":"")+(catalog.services?.browser?(catalog.services.browser.ready?" · Browser ready":catalog.services.browser.installed?" · Browser offline; starts when needed":" · Browser setup needed on the HUB host"):"");if(!count)list.append(el("p","No matching tools. Try another filter."));help.textContent=catalog.meaning+" Change a character’s permissions in Settings → Assistants → Characters.";
  }
  async function load(){refresh.disabled=true;status.textContent="Loading tools…";try{const response=await view.fetch("/api/hub/tools",{credentials:"same-origin",cache:"no-store",headers:{"x-hub-tools":"1"},signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(10000)])});if(!response.ok)throw Error("Couldn’t load the tools. Try Refresh.");catalog=await response.json();const before=character.value;character.replaceChildren();for(const c of catalog!.characters){const option=el("option",c.name);option.value=c.id;character.append(option);}if(catalog!.characters.some(c=>c.id===before))character.value=before;render();}catch(error){if(!lifetime.signal.aborted)status.textContent=(error as Error).message;}finally{refresh.disabled=false;}}
  refresh.addEventListener("click",()=>void load());character.addEventListener("change",render);search.addEventListener("input",render);access.addEventListener("change",render);void load();
  return ()=>{lifetime.abort();container.replaceChildren();container.removeAttribute("data-hub-tools");offStyle();};
}
export function ToolsSettings(){const ref=useRef<HTMLDivElement>(null);useEffect(()=>ref.current?installToolBrowser(ref.current,ref.current.ownerDocument):undefined,[]);return <div ref={ref}/>;}
