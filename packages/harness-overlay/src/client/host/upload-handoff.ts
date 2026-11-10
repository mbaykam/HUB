import {UPLOAD_MAX_BYTES,uploadId} from "../../upload-contract.ts";
type Receiver=(file:File)=>void;
interface Receipt{id:string;sessionId:string;name:string;bytes:number;mediaType:string}
const handoffs=new WeakMap<Document,{id:string;sessionId:string;receivers:Set<Receiver>;dispose:()=>void}>();

/** An explicit draft handoff, never a command. No native bridge is installed.
 * The native upload remains on HUB; only the normal composer can send a turn. */
export function installUploadHandoff(sessionId:string,add:(file:File)=>void,root:Document=document){
  const view=root.defaultView!,url=new URL(view.location.href),id=url.searchParams.get("hubUpload");
  if(url.searchParams.get("hubSession")!==sessionId||!id||!uploadId.test(id))return()=>{};
  const existing=handoffs.get(root);
  if(existing?.id===id&&existing.sessionId===sessionId){existing.receivers.add(add);return()=>{existing.receivers.delete(add);if(!existing.receivers.size)existing.dispose();};}
  existing?.dispose();
  const receivers=new Set<Receiver>([add]);
  const controller=new AbortController(),dialog=root.createElement("dialog");dialog.className="hub-upload-handoff";
  const title=root.createElement("h2");title.textContent="Add shared file";
  title.id="hub-upload-title-"+id;dialog.setAttribute("aria-labelledby",title.id);
  const message=root.createElement("p");message.textContent="Review this file before adding it to your message. Nothing is sent to an assistant until you press Send.";
  const status=root.createElement("p");status.setAttribute("role","status");
  const confirm=root.createElement("button");confirm.type="button";confirm.textContent="Add to message";
  const cancel=root.createElement("button");cancel.type="button";cancel.textContent="Keep for later";
  const clear=()=>{const current=new URL(view.location.href);if(current.searchParams.get("hubUpload")===id){current.searchParams.delete("hubUpload");if(current.searchParams.get("hubSession")===sessionId)current.searchParams.delete("hubSession");view.history.replaceState(view.history.state,"",current.href);}};
  let busy=false,receipt:Receipt|undefined;
  const dispose=()=>{controller.abort();dialog.remove();if(handoffs.get(root)?.receivers===receivers)handoffs.delete(root);};
  handoffs.set(root,{id,sessionId,receivers,dispose});
  cancel.onclick=()=>{if(!busy){clear();dispose();}};
  dialog.addEventListener("cancel",event=>{event.preventDefault();cancel.click();});
  async function review(){
    confirm.disabled=true;status.textContent="Checking the shared file…";
    try{
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]),headers={"x-hub-upload":"1","x-hub-upload-id":id!,"x-hub-session":sessionId};
      const meta=await view.fetch("/api/hub/uploads/draft",{credentials:"same-origin",cache:"no-store",headers,signal,redirect:"error"});
      if(!meta.ok)throw Error(meta.status===401||meta.status===403?"Sign in again, then retry.":"This file is unavailable in this conversation. Your saved copy is kept on the iPhone.");
      const value=await meta.json();
      if(value.id!==id||value.sessionId!==sessionId||typeof value.name!=="string"||!value.name||value.name.length>240||!Number.isInteger(value.bytes)||value.bytes<1||value.bytes>UPLOAD_MAX_BYTES||typeof value.mediaType!=="string")throw Error("The file receipt could not be verified.");
      if(controller.signal.aborted)return;receipt=value;title.textContent=value.name;status.textContent=`${Math.ceil(value.bytes/1024).toLocaleString()} KB · Ready to add to your message`;
      confirm.textContent="Add to message";confirm.disabled=false;
    }catch(error){if(!controller.signal.aborted){status.textContent=error instanceof Error?error.message:"Could not review the file.";confirm.textContent="Retry";confirm.disabled=false;}}
  }
  confirm.onclick=()=>{if(busy)return;if(!receipt){void review();return;}const verified=receipt;busy=true;confirm.disabled=true;cancel.disabled=true;status.textContent="Preparing your file…";
    void(async()=>{
      try{
        const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(30000)]);
        const response=await view.fetch("/api/hub/uploads/"+id,{credentials:"same-origin",cache:"no-store",signal,redirect:"error"});
        if(!response.ok)throw Error("The original file could not be read. Retry when connected.");
        const data=await response.arrayBuffer();
        if(data.byteLength!==verified.bytes)throw Error("The file size did not match its receipt. Please retry.");
        if(controller.signal.aborted)return;
        const receiver=[...receivers].at(-1);if(!receiver)return;
        receiver(new view.File([data],verified.name,{type:verified.mediaType}));clear();dispose();
      }catch(error){if(!controller.signal.aborted){status.textContent=error instanceof Error?error.message:"Could not add this file. Please retry.";busy=false;confirm.disabled=false;cancel.disabled=false;}}
    })();
  };
  dialog.append(title,message,status,confirm,cancel);root.body.append(dialog);dialog.showModal();
  void review();cancel.focus();
  return()=>{receivers.delete(add);if(!receivers.size)dispose();};
}
