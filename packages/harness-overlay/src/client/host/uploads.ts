import {UPLOAD_MAX_BYTES} from "../../upload-contract.ts";
export interface UploadedFile { id:string; name:string; bytes:number; mediaType:string; image:boolean; text:string }
export async function uploadFile(fetcher:typeof fetch,sessionId:string,id:string,file:File,signal:AbortSignal):Promise<UploadedFile>{
  if(!file.size||file.size>UPLOAD_MAX_BYTES)throw Error("Choose a nonempty file of 25 MB or less.");
  const response=await fetcher("/api/hub/uploads",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/octet-stream","x-hub-upload":"1","x-hub-upload-id":id,"x-hub-session":sessionId,"x-hub-file-name":encodeURIComponent(file.name)},body:file,signal});
  const value=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(typeof value.error==="string"?value.error:"Upload failed. Your attachment is still here; try sending again.");
  if(value.id!==id||typeof value.text!=="string"||value.text.length>40000)throw Error("The upload receipt could not be read. Try sending again.");
  return value;
}
