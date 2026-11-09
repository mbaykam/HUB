import {connect} from "node:http2";
import {createHash,createPrivateKey,randomUUID,sign} from "node:crypto";
import {mkdir,readFile,rename,writeFile,lstat,rm} from "node:fs/promises";
import {join} from "node:path";
import type {IncomingMessage,ServerResponse} from "node:http";

export interface ApplePushConfig {teamId:string;keyId:string;topic:string;privateKey:string}
export type PushOutcome="sent"|"invalid-device"|"retry"|"credentials";
export interface NativePushEvent {id:string;sessionId:string;kind:"task"|"goal"|"automation";status:"completed"|"failed"|"attention"}
interface Device {id:string;token:string;origin:string;generation:number;environment:"development"|"production";registeredAt:number;enabled:boolean}
interface Delivery {id:string;event:NativePushEvent;deviceId:string;attempts:number;nextAt:number;createdAt:number;state:"pending"|"sent"|"failed"}
interface PushState {devices:Device[];deliveries:Delivery[]}
const id=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9-]{36}$/i.test(v)&&!!v.match(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i);
const session=(v:unknown):v is string=>typeof v==="string"&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(v);
function validEvent(e:NativePushEvent){return e&&typeof e.id==="string"&&e.id.length>0&&e.id.length<=260&&!/[\u0000-\u001f]/.test(e.id)&&session(e.sessionId)&&["task","goal","automation"].includes(e.kind)&&["completed","failed","attention"].includes(e.status);}
function origin(v:unknown):v is string{try{const u=new URL(String(v));return u.protocol==="https:"&&!u.username&&!u.password&&u.origin===v;}catch{return false;}}
const generation=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
function validDevice(d:Device){return d&&id(d.id)&&origin(d.origin)&&generation(d.generation)&&typeof d.token==="string"&&(!d.enabled&&d.token===""||/^[a-f0-9]{32,512}$/i.test(d.token)&&d.token.length%2===0)&&["development","production"].includes(d.environment)&&typeof d.enabled==="boolean"&&Number.isFinite(d.registeredAt);}

/** Apple endpoint and topic are server-owned, never arbitrary client proxy inputs.
 * Token keys stay in the host credential store; payloads contain no result text. */
export function createApplePushSender(config:()=>Promise<ApplePushConfig|undefined>,open:typeof connect=connect){
  let cached:{key:string;at:number;token:string}|undefined;
  return async(device:Device,delivery:Delivery):Promise<PushOutcome>=>{
    const settings=await config();if(!settings)return "credentials";
    if(!/^[A-Z0-9]{10}$/.test(settings.teamId)||!/^[A-Z0-9]{10}$/.test(settings.keyId)||!/^[-A-Za-z0-9]+(?:\.[-A-Za-z0-9]+){2,}$/.test(settings.topic))return "credentials";
    const keyHash=createHash("sha256").update(JSON.stringify(settings)).digest("hex"),now=Math.floor(Date.now()/1000);
    let jwt:string;
    try{
      if(cached?.key===keyHash&&now-cached.at<3000)jwt=cached.token;
      else{
        const key=createPrivateKey(settings.privateKey);if(key.asymmetricKeyType!=="ec"||key.asymmetricKeyDetails?.namedCurve!=="prime256v1")return "credentials";
        const header=Buffer.from(JSON.stringify({alg:"ES256",kid:settings.keyId})).toString("base64url"),payload=Buffer.from(JSON.stringify({iss:settings.teamId,iat:now})).toString("base64url");
        const message=header+"."+payload,signature=sign("sha256",Buffer.from(message),{key,dsaEncoding:"ieee-p1363"}).toString("base64url");
        jwt=message+"."+signature;cached={key:keyHash,at:now,token:jwt};
      }
    }catch{return "credentials";}
    const host=device.environment==="production"?"https://api.push.apple.com":"https://api.sandbox.push.apple.com";
    const text=delivery.event.status==="completed"?"Your task is ready in HUB.":delivery.event.status==="failed"?"A task needs checking in HUB.":"A task is waiting for you in HUB.";
    return new Promise<PushOutcome>(resolve=>{
      let done=false;const client=open(host),timer=setTimeout(()=>finish("retry"),10000);
      function finish(outcome:PushOutcome){if(done)return;done=true;clearTimeout(timer);client.destroy();resolve(outcome);}
      client.on("error",()=>finish("retry"));
      const req=client.request({":method":"POST",":path":"/3/device/"+device.token,"authorization":"bearer "+jwt,"apns-topic":settings.topic,"apns-push-type":"alert","apns-priority":"10","apns-id":delivery.id,"apns-collapse-id":createHash("sha256").update(delivery.event.id).digest("hex"),"apns-expiration":String(now+21600)});
      let status=0,body="";
      req.on("response",headers=>{status=Number(headers[":status"]);});req.on("data",data=>{if(body.length<4096)body+=String(data);});req.on("error",()=>finish("retry"));
      req.on("end",()=>{let reason="";try{reason=JSON.parse(body).reason;}catch{}
        finish(status===200?"sent":status===410||reason==="BadDeviceToken"?"invalid-device":status===403||reason==="DeviceTokenNotForTopic"?"credentials":"retry");});
      req.end(JSON.stringify({aps:{alert:{title:"HUB",body:text},sound:"default"},hub:{version:1,kind:"session",sessionId:delivery.event.sessionId,origin:device.origin}}));
    });
  };
}

/** Private bounded durable queue. Reserve attempts before network I/O; retries
 * keep the same APNs ID/collapse key across a lost response or host restart. */
export class NativePushStore {
  #state:PushState={devices:[],deliveries:[]};#writes:Promise<unknown>=Promise.resolve();#active=new Set<string>();
  constructor(readonly root:string,readonly send:(device:Device,delivery:Delivery)=>Promise<PushOutcome>,readonly now=()=>Date.now()){}
  async initialize(){await mkdir(this.root,{recursive:true,mode:0o700});if((await lstat(this.root)).isSymbolicLink())throw Error("Invalid notification storage");
    try{const file=join(this.root,"native-push.json");if((await lstat(file)).isSymbolicLink())throw Error("Invalid notification file");const value=JSON.parse(await readFile(file,"utf8"));
      if(!Array.isArray(value.devices)||value.devices.length>64||value.devices.some((d:Device)=>!validDevice(d))||!Array.isArray(value.deliveries)||value.deliveries.length>512||value.deliveries.some((d:Delivery)=>!id(d.id)||!validEvent(d.event)||!id(d.deviceId)||!Number.isSafeInteger(d.attempts)||d.attempts<0||!Number.isFinite(d.nextAt)||!Number.isFinite(d.createdAt)||!["pending","sent","failed"].includes(d.state)))throw Error("Saved notifications need repair; data preserved");
      this.#state=value;
    }catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  }
  async #change<T>(mutate:(state:PushState)=>T){const work=this.#writes.then(async()=>{const next=structuredClone(this.#state),value=mutate(next),file=join(this.root,"native-push.json"),temp=file+"."+randomUUID()+".tmp";try{await writeFile(temp,JSON.stringify(next),{mode:0o600,flag:"wx"});await rename(temp,file);}finally{await rm(temp,{force:true});}this.#state=next;return value;});this.#writes=work.catch(()=>{});return work;}
  snapshot(){return {devices:this.#state.devices.filter(d=>d.enabled).length,pending:this.#state.deliveries.filter(d=>d.state==="pending").length};}
  async register(input:unknown){const value=input as Device;if(!value||Object.keys(value).sort().join()!=="environment,generation,id,origin,token"||!validDevice({...value,registeredAt:0,enabled:true}))throw Error("Invalid device registration");
    await this.#change(state=>{const old=state.devices.find(d=>d.id===value.id);if(old&&(old.generation>value.generation||old.generation===value.generation&&(!old.enabled||old.token!==value.token.toLowerCase()||old.environment!==value.environment||old.origin!==value.origin)))return;
      for(const previous of state.devices)if(previous.id!==value.id&&previous.token===value.token.toLowerCase()&&previous.environment===value.environment){previous.enabled=false;previous.token="";}
      state.devices=state.devices.filter(d=>d.id!==value.id);if(state.devices.filter(d=>d.enabled).length>=10)throw Error("Too many registered devices");
      if(state.devices.length>=64){const remove=state.devices.findIndex(d=>!d.enabled);if(remove<0)throw Error("Too many devices");state.devices.splice(remove,1);}
      state.devices.push({...value,token:value.token.toLowerCase(),registeredAt:this.now(),enabled:true});});
  }
  async revoke(deviceId:string,revision:number,sourceOrigin:string){if(!id(deviceId)||!generation(revision)||!origin(sourceOrigin))throw Error("Invalid device");await this.#change(state=>{const current=state.devices.find(d=>d.id===deviceId);if(current&&current.generation>revision)return;
    if(current){current.enabled=false;current.token="";current.generation=revision;}
    else{if(state.devices.length>=64){const remove=state.devices.findIndex(d=>!d.enabled);if(remove>=0)state.devices.splice(remove,1);}if(state.devices.length<64)state.devices.push({id:deviceId,token:"",origin:sourceOrigin,generation:revision,environment:"development",registeredAt:this.now(),enabled:false});}
    state.deliveries=state.deliveries.filter(d=>d.deviceId!==deviceId);});}
  async publish(event:NativePushEvent){if(!validEvent(event))throw Error("Invalid notification");await this.#change(state=>{
    const now=this.now();state.deliveries=state.deliveries.filter(d=>now-d.createdAt<21600000);
    for(const device of state.devices.filter(d=>d.enabled)){if(state.deliveries.some(d=>d.deviceId===device.id&&d.event.id===event.id))continue;if(state.deliveries.length>=512)break;state.deliveries.push({id:randomUUID(),event:structuredClone(event),deviceId:device.id,attempts:0,nextAt:now,createdAt:now,state:"pending"});}
  });await this.tick();}
  async tick(){const ready=this.#state.deliveries.filter(d=>d.state==="pending"&&d.nextAt<=this.now()&&!this.#active.has(d.id));
    for(const delivery of ready){if(this.#active.has(delivery.id))continue;this.#active.add(delivery.id);try{
      const device=this.#state.devices.find(d=>d.id===delivery.deviceId&&d.enabled);if(!device)continue;
      const reserved=await this.#change(state=>{const current=state.deliveries.find(d=>d.id===delivery.id);if(!current||current.state!=="pending"||current.nextAt>this.now()||!state.devices.some(d=>d.id===device.id&&d.enabled))return false;current.attempts++;current.nextAt=this.now()+Math.min(600000,30000*2**Math.min(current.attempts,5));if(this.now()-current.createdAt>21600000)current.state="failed";return true;});
      if(!reserved)continue;
      if(this.now()-delivery.createdAt>21600000)continue;
      let outcome:PushOutcome;try{outcome=await this.send(device,delivery);}catch{outcome="retry";}
      await this.#change(state=>{const current=state.deliveries.find(d=>d.id===delivery.id);if(!current)return;if(outcome==="sent")current.state="sent";else if(outcome==="invalid-device"){current.state="failed";const saved=state.devices.find(d=>d.id===device.id);if(saved){saved.enabled=false;saved.token="";}}else if(outcome==="credentials")current.nextAt=this.now()+600000;else if(current.attempts>=5)current.state="failed";});
    }finally{this.#active.delete(delivery.id);}}
  }
}

export function createNativePushHandler(ports:{store:NativePushStore;ready:Promise<unknown>;configured():Promise<boolean>;reject(req:IncomingMessage):401|403|undefined}){
  return async(req:IncomingMessage,res:ServerResponse)=>{
    const json=(status:number,value:unknown)=>{res.writeHead(status,{"content-type":"application/json","cache-control":"no-store, private","x-content-type-options":"nosniff"});res.end(JSON.stringify(value));};
    const rejected=ports.reject(req);if(rejected||req.headers["sec-fetch-site"]==="cross-site"||req.headers["x-hub-native-push"]!=="1"){json(rejected??403,{error:"unauthorized"});return;}
    try{await ports.ready;if(req.method==="GET"){json(200,{version:1,configured:await ports.configured(),...ports.store.snapshot()});return;}
      if(req.method!=="POST"){json(405,{error:"method-not-allowed"});return;}
      if(!/^application\/json(?:;|$)/i.test(String(req.headers["content-type"]??""))){json(415,{error:"json-required"});return;}
      let bytes=0;const chunks:Buffer[]=[];for await(const part of req){bytes+=part.length;if(bytes>4096){json(413,{error:"request-too-large"});return;}chunks.push(part);}
      const value=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if(!origin(req.headers.origin)){json(400,{error:"secure-origin-required"});return;}
      if(value?.action==="register"&&Object.keys(value).sort().join()==="action,device")await ports.store.register({...value.device,origin:req.headers.origin});
      else if(value?.action==="revoke"&&Object.keys(value).sort().join()==="action,deviceId,generation")await ports.store.revoke(value.deviceId,value.generation,req.headers.origin);
      else{json(400,{error:"invalid-command"});return;}
      json(200,{version:1,configured:await ports.configured(),...ports.store.snapshot()});
    }catch{json(503,{error:"notification-service-unavailable"});}
  };
}
