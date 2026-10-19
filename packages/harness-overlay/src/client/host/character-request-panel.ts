export function characterRequestPanel(root:Document,characterId:string){
  const view=root.defaultView!,life=new AbortController(),panel=root.createElement("section");panel.dataset.characterRequest="";
  const text=root.createElement("p"),info=root.createElement("p"),body=root.createElement("pre"),actions=root.createElement("div");body.tabIndex=0;body.setAttribute("aria-label","Complete model request");
  const button=(label:string,run:()=>void)=>{const b=root.createElement("button");b.type="button";b.textContent=label;b.addEventListener("click",run);return b;};
  let json="",loaded=false,epoch=0;
  const download=button("Download full request",()=>{if(!json)return;const blob=new view.Blob([json],{type:"application/json"}),url=view.URL.createObjectURL(blob),a=root.createElement("a");a.href=url;a.download="hub-model-request.json";a.click();view.setTimeout(()=>view.URL.revokeObjectURL(url),1000);});download.disabled=true;
  const refresh=button("Refresh",()=>void load());actions.append(refresh,download);panel.append(text,actions,info,body);
  async function load(){const own=++epoch;loaded=true;refresh.disabled=true;text.textContent="Loading the last model request…";body.textContent="";json="";download.disabled=true;
    try{const response=await view.fetch("/api/hub/character-request?characterId="+encodeURIComponent(characterId),{credentials:"same-origin",cache:"no-store",headers:{"x-hub-characters":"1"},signal:AbortSignal.any([life.signal,AbortSignal.timeout(15000)])});if(!response.ok)throw Error();const data=await response.json();if(life.signal.aborted||own!==epoch)return;
      info.textContent=data.boundary+" "+data.retention;
      if(data.record?.json){json=data.record.json;body.textContent=json;download.disabled=false;text.textContent="Actual request · "+new Date(data.record.at).toLocaleString()+" · "+data.record.sessionId;}
      else text.textContent=data.record?.unavailable??"No request captured for this character yet. Send this character a message, then refresh. Unsaved character edits are not applied to past requests.";
    }catch{if(!life.signal.aborted&&own===epoch)text.textContent="Couldn’t load the request. Refresh to retry.";}finally{if(!life.signal.aborted&&own===epoch)refresh.disabled=false;}
  }
  return {panel,open:()=>{if(!loaded)void load();},dispose:()=>{epoch++;life.abort();json="";body.textContent="";}};
}
