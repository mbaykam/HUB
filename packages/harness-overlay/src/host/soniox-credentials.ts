import type {IncomingMessage,ServerResponse} from "node:http";

export interface SpeechCredentials {
  resolve(ref:string):Promise<{readonly value:string}|undefined>;
  set(ref:string,value:string):Promise<unknown>;
}
export function createSonioxCredentialsHandler(ports:{
  credentials?:SpeechCredentials;
  reject(request:IncomingMessage):401|403|undefined;
  changed():void;
}) {
  return async(req:IncomingMessage,res:ServerResponse)=>{
    const send=(code:number,body:unknown)=>{res.writeHead(code,{"content-type":"application/json","cache-control":"no-store, private","x-content-type-options":"nosniff"});res.end(JSON.stringify(body));};
    const rejection=ports.reject(req);
    if(rejection||req.headers["sec-fetch-site"]==="cross-site"||req.headers["x-hub-speech-settings"]!=="1"){send(rejection??403,{error:"unauthorized"});return;}
    try {
      if(!ports.credentials){send(503,{error:"credential-store-unavailable"});return;}
      if(req.method==="GET"){send(200,{configured:!!(await ports.credentials.resolve("SONIOX_API_KEY"))?.value});return;}
      if(req.method!=="POST"){send(405,{error:"method-not-allowed"});return;}
      if(!/^application\/json(?:;|$)/i.test(String(req.headers["content-type"]??""))){send(415,{error:"json-required"});return;}
      let size=0;const chunks:Buffer[]=[];
      for await(const chunk of req){size+=chunk.length;if(size>2048){send(413,{error:"body-too-large"});return;}chunks.push(chunk);}
      const value:unknown=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).join()!=="apiKey"){send(400,{error:"invalid-key"});return;}
      const key=(value as {apiKey:unknown}).apiKey;
      if(typeof key!=="string"||key.length<16||key.length>512||/\s/.test(key)){send(400,{error:"invalid-key"});return;}
      await ports.credentials.set("SONIOX_API_KEY",key);
      ports.changed();send(200,{configured:true});
    } catch {send(400,{error:"could-not-save-key"});}
  };
}
