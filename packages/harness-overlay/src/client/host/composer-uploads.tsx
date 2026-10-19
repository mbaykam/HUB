import {useEffect,useRef,useState} from "react";
import type {HarnessClientContext} from "../core/context.ts";
import {defineOverlayStyle} from "../shared/style-runtime.ts";
import {UPLOAD_MAX_BYTES,UPLOAD_MAX_FILES} from "../../upload-contract.ts";
import {uploadFile} from "./uploads.ts";
import styles from "./composer-uploads.css";
const installStyles=defineOverlayStyle("hub-composer-uploads",styles);
const SOURCE="hub-file";
interface Input {
  state:{getSnapshot():{draft:string;draftRev:number;imageIds:readonly string[];occurrences:readonly {source:string;ref:string}[]}};
  addImages(ids:readonly string[]):boolean;
  setDraft(value:string):void;
  insertReference(ref:{source:string;ref:string;label:string;clipboardText:string},span:{start:number;end:number;draftRev:number}):boolean;
}
interface Composer {input:{for(scope:unknown):Input};createDraftImages(files:readonly File[]):readonly {id:string}[];releaseDraftImages(images:readonly {id:string}[]):void}
interface Triggers {registerSource(source:unknown):()=>void}
interface Props {sessionId:string;useInput:<T>(selector:(s:{phase:string})=>T)=>T;useProjection?:(key:"imageLimits")=>{mediaTypes:readonly string[];maxImagesPerMessage:number;maxImageBytes:number;maxMessageImageBytes:number}|undefined}

/** Native session-scoped input ownership also covers the Home hero composer.
 * Images use native drafts. Files use native reference serialization, so send
 * failure restores their chips together with the user's text. */
export function installComposerUploads(ctx:HarnessClientContext,conversation:Composer,triggers:Triggers,root:Document=document){
  const removeStyles=installStyles(root);
  const refs=new Map<string,{sessionId:string;file:File;uploaded?:string;status?:string}>();
  const listeners=new Set<()=>void>();const changed=()=>listeners.forEach(fn=>fn());
  const offSource=triggers.registerSource({trigger:"@",name:SOURCE,showGroupTitle:false,candidates:async()=>[],onPick:()=>undefined,codec:{
    clipboardText:(ref:string)=>`[${refs.get(ref)?.file.name??"Attachment"}]`,
    async serialize(ref:string,signal:AbortSignal){
      const item=refs.get(ref);if(!item)throw Error("This attachment draft expired. Remove it and select the file again.");
      if(item.uploaded)return item.uploaded;
      item.status=`Uploading ${item.file.name}…`;changed();
      try{const receipt=await uploadFile(root.defaultView!.fetch.bind(root.defaultView),item.sessionId,ref,item.file,signal);item.uploaded=receipt.text;return receipt.text;}
      finally{item.status=undefined;changed();}
    },
  }});
  function Control({sessionId,useInput,useProjection}:Props){
    const [open,setOpen]=useState(false),[error,setError]=useState(""),[,update]=useState(0);
    const photos=useRef<HTMLInputElement>(null),files=useRef<HTMLInputElement>(null),shell=useRef<HTMLDivElement>(null);
    const phase=useInput(s=>s.phase);
    const limits=useProjection?.("imageLimits");
    useEffect(()=>{const fn=()=>update(v=>v+1);listeners.add(fn);return()=>{listeners.delete(fn);};},[]);
    useEffect(()=>{if(!open)return;const close=(e:Event)=>{if(!shell.current?.contains(e.target as Node))setOpen(false);};const key=(e:KeyboardEvent)=>{if(e.key==="Escape")setOpen(false);};root.addEventListener("pointerdown",close);root.addEventListener("keydown",key);return()=>{root.removeEventListener("pointerdown",close);root.removeEventListener("keydown",key);};},[open]);
    function stage(list:FileList|null){
      setOpen(false);setError("");if(!list?.length)return;
      try{
        const scope=ctx.sessions.scope?.(sessionId);if(!scope)throw Error("This conversation is no longer available.");
        const input=conversation.input.for(scope),before=input.state.getSnapshot();
        const live=new Set(before.occurrences.filter(o=>o.source===SOURCE).map(o=>o.ref));
        for(const [id,item]of refs)if(item.sessionId===sessionId&&!live.has(id))refs.delete(id);
        const selected=Array.from(list);
        if(selected.length+live.size+before.imageIds.length>UPLOAD_MAX_FILES)throw Error(`Attach up to ${UPLOAD_MAX_FILES} items per message.`);
        if(selected.some(file=>!file.size||file.size>UPLOAD_MAX_BYTES))throw Error("Each file must be nonempty and 25 MB or smaller.");
        if(refs.size+selected.length>64)throw Error("Too many open attachment drafts. Send or remove some before adding more.");
        // Validate every selected image before changing the draft.
        const imageFiles=selected.filter(f=>/^image\/(png|jpeg|webp|gif)$/.test(f.type));
        if(selected.some(f=>f.type.startsWith("image/")&&!imageFiles.includes(f)))throw Error("Use JPEG, PNG, WebP or GIF photos. Convert HEIC photos to JPEG first.");
        if(limits){
          if(imageFiles.some(f=>!limits.mediaTypes.includes(f.type)))throw Error("This image format is unavailable on the host. Use JPEG or PNG.");
          if(imageFiles.length+before.imageIds.length>limits.maxImagesPerMessage)throw Error(`The host supports up to ${limits.maxImagesPerMessage} photos per message.`);
          if(imageFiles.some(f=>f.size>limits.maxImageBytes))throw Error(`Each photo must be ${Math.floor(limits.maxImageBytes/1_000_000)} MB or smaller.`);
          if(imageFiles.reduce((total,item)=>total+item.size,0)>limits.maxMessageImageBytes)throw Error("These photos exceed the host’s per-message image limit.");
        }
        const images=conversation.createDraftImages(imageFiles);
        if(images.length&&!input.addImages(images.map(i=>i.id))){conversation.releaseDraftImages(images);throw Error("The composer is busy. Try again in a moment.");}
        for(const file of selected.filter(f=>!imageFiles.includes(f))){
          const id=root.defaultView!.crypto.randomUUID(),label=file.name.slice(0,120),old=input.state.getSnapshot().draft;
          const prefix=old&&!/\s$/.test(old)?old+" ":old,token=`[${label}]`;
          refs.set(id,{sessionId,file});input.setDraft(prefix+token+" ");
          const state=input.state.getSnapshot();
          if(!input.insertReference({source:SOURCE,ref:id,label,clipboardText:token},{start:prefix.length,end:prefix.length+token.length,draftRev:state.draftRev})){refs.delete(id);input.setDraft(old);throw Error("The attachment could not be added. Please select it again.");}
        }
      }catch(err){setError(err instanceof Error?err.message:"Couldn’t add these files.");}
    }
    const status=[...refs.values()].find(item=>item.sessionId===sessionId&&item.status)?.status;
    return <div className="hub-upload-control" ref={shell}>
      <button type="button" aria-label="Attach photos or files" title="Attach photos or files" aria-expanded={open} disabled={phase!=="plain"} onClick={()=>setOpen(!open)}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9a6 6 0 0 1 8 8l-9 9"/></svg></button>
      {open&&<div className="hub-upload-menu" role="group" aria-label="Add attachment"><button type="button" onClick={()=>photos.current?.click()}>Photos</button><button type="button" onClick={()=>files.current?.click()}>Files</button><small>Up to 8 items · 25 MB each</small><button type="button" onClick={()=>setOpen(false)}>Close</button></div>}
      <input ref={photos} type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden onChange={e=>{stage(e.target.files);e.target.value="";}}/>
      <input ref={files} type="file" multiple hidden onChange={e=>{stage(e.target.files);e.target.value="";}}/>
      {(error||status)&&<div className="hub-upload-status" role="status">{error||status}{error&&<button type="button" aria-label="Dismiss attachment error" onClick={()=>setError("")}>×</button>}</div>}
    </div>;
  }
  const offSlot=ctx.slots.register({name:"conversation.input.left",id:"hub-uploads",order:-100},Control);
  return()=>{offSlot();offSource();refs.clear();listeners.clear();removeStyles();};
}
