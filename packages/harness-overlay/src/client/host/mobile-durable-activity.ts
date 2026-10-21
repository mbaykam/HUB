import type {ActivitySnapshot,ActivitySession} from "./mobile-activity.ts";
/** A new browser receives running work and recent results from the host,
 * including descendants whose chat histories have never been opened here. */
export function createDurableActivity(root:Document,changed:()=>void){
  const view=root.defaultView!,lifetime=new AbortController();let byId:Record<string,ActivitySession>={},active=false,busy=false,known=false,failed=false;
  async function refresh(){if(!active||root.hidden||busy)return;busy=true;
    try{const r=await view.fetch("/api/hub/activity",{credentials:"same-origin",cache:"no-store",headers:{"x-hub-daily-use":"1"},signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(16000)])});if(!r.ok)throw Error();const result=await r.json();if(!result.byId||typeof result.byId!=="object")throw Error();byId=result.byId;known=true;failed=false;changed();}
    catch{if(!lifetime.signal.aborted){failed=true;changed();}}finally{busy=false;}
  }
  const timer=view.setInterval(()=>void refresh(),5000),visible=()=>void refresh();root.addEventListener("visibilitychange",visible);view.addEventListener("online",visible);
  return {update(enabled:boolean){if(active===enabled)return;active=enabled;if(enabled)void refresh();},
    read(snapshot:ActivitySnapshot):ActivitySnapshot{const merged={...snapshot.byId};for(const [id,s]of Object.entries(byId))merged[id]={...merged[id],...s};return {...snapshot,phase:known?snapshot.phase:"pending",byId:merged};},
    get failed(){return failed;},dispose(){lifetime.abort();view.clearInterval(timer);root.removeEventListener("visibilitychange",visible);view.removeEventListener("online",visible);}};
}
