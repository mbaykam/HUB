import {defineOverlayStyle} from "../shared/style-runtime.ts";
import {uploadFile} from "./uploads.ts";
import styles from "./voice-camera.css";
const installStyles=defineOverlayStyle("hub-voice-camera",styles);
interface Owner {callId:string;sessionId:string}

/** Owns VIDEO tracks only. The voice client and its microphone are independent
 * and are never stopped, muted, or reacquired by this camera view. */
export function createVoiceCamera(root:Document){
  const view=root.defaultView!,removeStyles=installStyles(root);
  const button=root.createElement("button");button.type="button";button.textContent="Camera";button.hidden=true;button.setAttribute("data-voice-camera","");
  const dialog=root.createElement("dialog");dialog.setAttribute("data-voice-camera-dialog","");dialog.setAttribute("aria-label","Share your camera with HUB");
  const header=root.createElement("header"),title=root.createElement("strong"),close=root.createElement("button");title.textContent="Show HUB";close.type="button";close.textContent="Close";header.append(title,close);
  const hint=root.createElement("p");hint.textContent="Your conversation with Mira continues. Each shutter press shares one photo with HUB.";
  const stage=root.createElement("div");stage.setAttribute("data-camera-stage","");
  const video=root.createElement("video");video.autoplay=true;video.muted=true;video.playsInline=true;video.setAttribute("playsinline","");video.setAttribute("aria-label","Camera preview");
  const preview=root.createElement("img");preview.alt="Captured photo";preview.hidden=true;stage.append(video,preview);
  const label=root.createElement("label");label.textContent="What should HUB do?";
  const instruction=root.createElement("textarea");instruction.rows=2;instruction.maxLength=4000;instruction.placeholder="Describe this, read the label, help me with…";label.append(instruction);
  const status=root.createElement("p");status.setAttribute("role","status");status.setAttribute("data-camera-status","");
  const actions=root.createElement("footer"),flip=root.createElement("button"),shutter=root.createElement("button"),retry=root.createElement("button"),again=root.createElement("button");
  for(const item of [flip,shutter,retry,again])item.type="button";
  flip.textContent="Switch camera";shutter.textContent="●";shutter.setAttribute("aria-label","Take photo and send to HUB");shutter.setAttribute("data-camera-shutter","");
  retry.textContent="Retry sending";retry.hidden=true;again.textContent="Take another";again.hidden=true;actions.append(flip,shutter,retry,again);
  dialog.append(header,hint,stage,label,status,actions);root.body.append(dialog);
  let owner:Owner|undefined,stream:MediaStream|undefined,epoch=0,disposed=false,busy=false,starting=false,facing:"environment"|"user"="environment";
  let pending:AbortController|undefined,url:string|undefined;
  let shot:{owner:Owner;id:string;requestId:string;file:File;instruction:string;uploaded?:string}|undefined;
  const stopVideo=()=>{for(const track of stream?.getVideoTracks()??[])track.stop();stream=undefined;video.srcObject=null;};
  function releasePreview(){if(url)view.URL.revokeObjectURL(url);url=undefined;preview.removeAttribute("src");preview.hidden=true;}
  function reset(){epoch++;pending?.abort();pending=undefined;stopVideo();releasePreview();shot=undefined;busy=false;starting=false;retry.hidden=true;again.hidden=true;shutter.disabled=true;flip.disabled=false;instruction.disabled=false;}
  async function start(){
    if(!owner||disposed||starting||!dialog.open)return;
    starting=true;const version=++epoch;stopVideo();releasePreview();shot=undefined;video.hidden=false;shutter.disabled=true;flip.disabled=true;retry.hidden=true;again.hidden=true;status.textContent="Opening camera…";
    try{
      if(!view.navigator.mediaDevices?.getUserMedia)throw Error("Camera access needs HTTPS and a browser with camera support.");
      const next=await view.navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:facing},width:{ideal:1280},height:{ideal:960}}});
      if(disposed||version!==epoch||!dialog.open||!owner){for(const track of next.getVideoTracks())track.stop();return;}
      stream=next;video.srcObject=next;await video.play();
      if(version!==epoch)return;
      status.textContent="Frame your photo, then tap the shutter.";shutter.disabled=false;flip.disabled=false;
      for(const track of stream.getVideoTracks())track.addEventListener("ended",()=>{if(version===epoch&&dialog.open){shutter.disabled=true;status.textContent="Camera stopped. Close and reopen it; your conversation can continue.";}},{once:true});
    }catch(err){if(version!==epoch)return;stopVideo();status.textContent=err instanceof Error&&err.name==="NotAllowedError"?"Camera permission was declined. Allow camera access in your browser settings and reopen Camera.":err instanceof Error?err.message:"The camera could not open. Your voice call is still connected.";flip.disabled=false;}
    finally{if(version===epoch)starting=false;}
  }
  async function send(){
    const item=shot;if(!item||busy||!owner||owner.callId!==item.owner.callId)return;
    busy=true;retry.hidden=true;again.hidden=true;shutter.disabled=true;flip.disabled=true;instruction.disabled=true;
    pending=new AbortController();const signal=AbortSignal.any([pending.signal,AbortSignal.timeout(90000)]),version=epoch;
    try{
      if(!item.uploaded){status.textContent="Uploading photo…";const receipt=await uploadFile(view.fetch.bind(view),item.owner.sessionId,item.id,item.file,signal);if(!receipt.image)throw Error("The captured photo could not be prepared for visual analysis.");item.uploaded=receipt.id;}
      if(!owner||owner.callId!==item.owner.callId||version!==epoch)return;
      status.textContent="Sending to Mira…";
      const response=await view.fetch("/api/hub/voice/share",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json","x-hub-voice-share":"1"},body:JSON.stringify({callId:item.owner.callId,requestId:item.requestId,uploads:[item.uploaded],instruction:item.instruction}),signal});
      const result=await response.json().catch(()=>({}));if(!response.ok)throw Error(result.error||"Sharing could not be confirmed. Retry with the same photo.");
      if(version!==epoch)return;
      status.textContent="Sent to Mira. HUB’s work will appear with your tasks; keep talking.";again.hidden=false;
    }catch(err){if(version!==epoch)return;status.textContent=err instanceof Error&&err.name==="TimeoutError"?"Sending wasn’t confirmed. Retry this photo to check the same request; it won’t be duplicated.":err instanceof Error?err.message:"Couldn’t send. Retry this photo.";retry.hidden=false;again.hidden=false;}
    finally{if(version===epoch){busy=false;pending=undefined;instruction.disabled=false;}}
  }
  shutter.addEventListener("click",async()=>{
    if(busy||!owner||!video.videoWidth||!video.videoHeight)return;
    shutter.disabled=true;const version=epoch,call={...owner},canvas=root.createElement("canvas");
    const scale=Math.min(1,1600/Math.max(video.videoWidth,video.videoHeight));canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);
    try{
      const context=canvas.getContext("2d");if(!context)throw Error("Photo capture is unavailable in this browser.");context.drawImage(video,0,0,canvas.width,canvas.height);
      const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,"image/jpeg",.88));
      if(version!==epoch||!owner||owner.callId!==call.callId)return;if(!blob)throw Error("Photo capture failed. Try again.");
      const file=new File([blob],`Camera ${new Date().toISOString().replace(/[:.]/g,"-")}.jpg`,{type:"image/jpeg"});
      shot={owner:call,id:view.crypto.randomUUID(),requestId:view.crypto.randomUUID(),file,instruction:instruction.value};
      url=view.URL.createObjectURL(file);preview.src=url;preview.hidden=false;video.hidden=true;stopVideo();await send();
    }catch(err){if(version===epoch){status.textContent=err instanceof Error?err.message:"Couldn’t take the photo.";shutter.disabled=false;}}
  });
  retry.addEventListener("click",()=>void send());again.addEventListener("click",()=>void start());
  flip.addEventListener("click",()=>{facing=facing==="environment"?"user":"environment";void start();});
  button.addEventListener("click",()=>{if(!owner||disposed)return;if(!dialog.open){dialog.showModal();close.focus();void start();}});
  close.addEventListener("click",()=>dialog.close());dialog.addEventListener("close",()=>{reset();button.focus();});
  return {button,dialog,setCall(next:Owner|undefined){if(owner?.callId===next?.callId&&owner?.sessionId===next?.sessionId)return;reset();owner=next;button.hidden=!owner;if(dialog.open)dialog.close();},dispose(){disposed=true;owner=undefined;reset();dialog.close();dialog.remove();button.remove();removeStyles();}};
}
