/** Only called after the paired sender has been authorized. No token-bearing URLs escape. */
export async function receiveTelegramMedia(token:string,items:readonly {fileId:string;name:string;mediaType:string;size?:number}[],fetcher:typeof fetch,signal:AbortSignal){
  const result:{name:string;mediaType:string;data:string}[]=[];
  try{
    for(const item of items){
      if(item.size&&item.size>20000000)throw Error("File too large");
      const info=await fetcher(`https://api.telegram.org/bot${token}/getFile`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({file_id:item.fileId}),signal,redirect:"error"});
      if(!info.ok)throw Error("File lookup failed");const response=await info.json();const path=response?.result?.file_path;
      if(response.ok!==true||typeof path!=="string"||path.length>300||!/^[-A-Za-z0-9_./]+$/.test(path)||path.split("/").some(p=>p===".."||p==="."))throw Error("Invalid file reference");
      const file=await fetcher(`https://api.telegram.org/file/bot${token}/${path}`,{signal,redirect:"error"});if(!file.ok||!file.body)throw Error("File unavailable");
      const reader=file.body.getReader(),chunks:Uint8Array[]=[];let size=0;
      try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>20000000)throw Error("File too large");chunks.push(next.value);}}finally{reader.releaseLock();}
      result.push({name:item.name,mediaType:item.mediaType,data:Buffer.concat(chunks).toString("base64")});
    }
    return result;
  }catch{throw Error("Telegram attachment could not be received. Use files smaller than 20 MB.");}
}
