import type {IncomingMessage,ServerResponse} from "node:http";

export interface SpeechCredentials {
  resolve(ref:string):Promise<{readonly value:string}|undefined>;
  set(ref:string,value:string):Promise<unknown>;
}
export const SONIOX_DICTATION_URL="wss://stt-rt.soniox.com/transcribe-websocket";
/** Voice typing: the phone streams its microphone straight to Soniox with a
 * key that expires in minutes. The stored key never leaves this host, and no
 * voice call, chat turn or speech process is started. */
export function createSonioxDictationHandler(ports:{
  credentials?:SpeechCredentials;
  reject(request:IncomingMessage):401|403|undefined;
  fetch?:typeof fetch;
}) {
  return async(req:IncomingMessage,res:ServerResponse)=>{
    const send=(code:number,body:unknown)=>{res.writeHead(code,{"content-type":"application/json","cache-control":"no-store, private","x-content-type-options":"nosniff"});res.end(JSON.stringify(body));};
    const rejection=ports.reject(req);
    if(rejection||req.headers["sec-fetch-site"]==="cross-site"||req.headers["x-hub-dictation"]!=="1"){send(rejection??403,{error:"unauthorized"});return;}
    if(req.method!=="POST"){send(405,{error:"method-not-allowed"});return;}
    req.resume();
    try {
      const key=(await ports.credentials?.resolve("SONIOX_API_KEY"))?.value;
      if(!key){send(409,{error:"soniox-not-connected"});return;}
      const reply=await (ports.fetch??fetch)("https://api.soniox.com/v1/auth/temporary-api-key",{method:"POST",redirect:"error",
        headers:{authorization:"Bearer "+key,"content-type":"application/json"},
        body:JSON.stringify({usage_type:"transcribe_websocket",expires_in_seconds:120}),signal:AbortSignal.timeout(10000)});
      // Never forward the provider's body: it can echo account details.
      if(!reply.ok){send(reply.status===402?409:502,{error:reply.status===402?"soniox-balance":reply.status===401||reply.status===403?"soniox-access":"soniox-unavailable"});return;}
      const body=await reply.json() as {api_key?:unknown;expires_at?:unknown};
      if(typeof body.api_key!=="string"||body.api_key.length<8||body.api_key.length>512||body.api_key===key){send(502,{error:"soniox-unavailable"});return;}
      send(200,{url:SONIOX_DICTATION_URL,expiresAt:typeof body.expires_at==="string"?body.expires_at:null,config:{
        api_key:body.api_key,model:"stt-rt-v5",audio_format:"pcm_s16le",sample_rate:16000,num_channels:1,
        enable_language_identification:true,language_hints:["en","tr"],language_hints_strict:true}});
    } catch {send(502,{error:"soniox-unavailable"});}
  };
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
