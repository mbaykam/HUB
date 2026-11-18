import {connect} from "node:http2";
import {createHash,createPrivateKey,randomUUID,sign} from "node:crypto";
import {mkdir,readFile,rename,writeFile,lstat,rm} from "node:fs/promises";
import {join} from "node:path";
import type {IncomingMessage,ServerResponse} from "node:http";

export interface ApplePushConfig {teamId:string;keyId:string;topic:string;privateKey:string}
export type PushOutcome="sent"|"invalid-device"|"retry"|"credentials";
export const PUSH_KINDS=["task","goal","automation","reply","approval","reminder","brief","assistant"] as const;
export type PushKind=typeof PUSH_KINDS[number];
/** What a notification carries. Title/body are the readable text; category picks
 * the iPhone's action buttons; data holds the ids an action needs. */
export interface NativePushEvent {id:string;sessionId:string;kind:PushKind;status:"completed"|"failed"|"attention"|"info";
  title?:string;body?:string;level?:"passive"|"active"|"time-sensitive";category?:"reply"|"approval"|"reminder"|"open";data?:Record<string,string|number>}
/** The user's choices: which kinds reach the phone, and quiet hours during which
 * only time-sensitive alerts (approvals, imminent reminders) are delivered. */
export interface PushPreferences {kinds:Record<PushKind,boolean>;quiet:{enabled:boolean;start:string;end:string};timeZone:string;briefTime:string;reminderMinutes:number}
export const DEFAULT_PUSH_PREFERENCES:PushPreferences={kinds:{task:true,goal:true,automation:true,reply:true,approval:true,reminder:true,brief:true,assistant:true},quiet:{enabled:false,start:"22:30",end:"07:30"},timeZone:"UTC",briefTime:"08:00",reminderMinutes:15};
interface Device {id:string;token:string;origin:string;generation:number;environment:"development"|"production";registeredAt:number;enabled:boolean}
interface Delivery {id:string;event:NativePushEvent;deviceId:string;attempts:number;nextAt:number;createdAt:number;state:"pending"|"sent"|"failed"}
interface PushState {devices:Device[];deliveries:Delivery[];preferences?:PushPreferences;memory?:Record<string,number>}
const id=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9-]{36}$/i.test(v)&&!!v.match(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i);
const session=(v:unknown):v is string=>typeof v==="string"&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(v);
const words=(v:unknown,max:number)=>v===undefined||typeof v==="string"&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
const clock=(v:unknown):v is string=>typeof v==="string"&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v);
function validData(d:unknown){if(d===undefined)return true;if(!d||typeof d!=="object"||Array.isArray(d))return false;const entries=Object.entries(d);return entries.length<=8&&entries.every(([k,v])=>/^[a-zA-Z]{1,24}$/.test(k)&&(typeof v==="number"&&Number.isFinite(v)||typeof v==="string"&&v.length<=200));}
function validEvent(e:NativePushEvent){return e&&typeof e.id==="string"&&e.id.length>0&&e.id.length<=260&&!/[\u0000-\u001f]/.test(e.id)&&session(e.sessionId)&&(PUSH_KINDS as readonly string[]).includes(e.kind)&&["completed","failed","attention","info"].includes(e.status)
  &&words(e.title,120)&&words(e.body,600)&&(e.level===undefined||["passive","active","time-sensitive"].includes(e.level))&&(e.category===undefined||["reply","approval","reminder","open"].includes(e.category))&&validData(e.data);}
export function parsePushPreferences(value:any):PushPreferences{
  const base=DEFAULT_PUSH_PREFERENCES;if(!value||typeof value!=="object")throw Error("Invalid notification preferences");
  const kinds={...base.kinds};for(const [k,v] of Object.entries(value.kinds??{})){if(!(PUSH_KINDS as readonly string[]).includes(k)||typeof v!=="boolean")throw Error("Invalid notification kind");(kinds as any)[k]=v;}
  const quiet={...base.quiet,...(value.quiet??{})};if(typeof quiet.enabled!=="boolean"||!clock(quiet.start)||!clock(quiet.end))throw Error("Quiet hours need a start and end like 22:30");
  const timeZone=value.timeZone??base.timeZone;try{new Intl.DateTimeFormat("en",{timeZone});}catch{throw Error("Unknown timezone");}
  const briefTime=value.briefTime??base.briefTime;if(!clock(briefTime))throw Error("Brief time looks like 08:00");
  const reminderMinutes=value.reminderMinutes??base.reminderMinutes;if(![0,5,10,15,30,60].includes(reminderMinutes))throw Error("Reminders go 0, 5, 10, 15, 30 or 60 minutes before");
  return {kinds,quiet:{enabled:quiet.enabled,start:quiet.start,end:quiet.end},timeZone,briefTime,reminderMinutes};
}
/** Minutes since midnight in a timezone. */
export function localMinutes(at:number,timeZone:string){const parts=new Intl.DateTimeFormat("en-GB",{timeZone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(at));const hour=Number(parts.find(p=>p.type==="hour")?.value),minute=Number(parts.find(p=>p.type==="minute")?.value);return hour*60+minute;}
const toMinutes=(value:string)=>Number(value.slice(0,2))*60+Number(value.slice(3));
/** When a notification may go out: now, or the end of quiet hours. */
export function quietRelease(at:number,prefs:PushPreferences,level:NativePushEvent["level"]){
  if(!prefs.quiet.enabled||level==="time-sensitive")return at;
  const now=localMinutes(at,prefs.timeZone),start=toMinutes(prefs.quiet.start),end=toMinutes(prefs.quiet.end);
  const inside=start===end?false:start<end?now>=start&&now<end:now>=start||now<end;
  if(!inside)return at;
  const wait=(end-now+1440)%1440;return at+wait*60000;
}
/** The text and buttons an event shows on the phone. */
export function pushAlert(event:NativePushEvent){
  const title=event.title?.trim()||({task:"Task",goal:"Goal",automation:"Automation",reply:"HUB replied",approval:"Approval needed",reminder:"Reminder",brief:"Your day",assistant:"HUB"} as Record<string,string>)[event.kind]||"HUB";
  const body=event.body?.trim()||(event.status==="completed"?"Your task is ready in HUB.":event.status==="failed"?"A task needs checking in HUB.":"Something is waiting for you in HUB.");
  const category=event.category??(event.kind==="approval"?"approval":event.kind==="reminder"?"reminder":event.kind==="brief"?"open":"reply");
  const level=event.level??(event.kind==="approval"||event.kind==="reminder"?"time-sensitive":event.kind==="brief"?"passive":"active");
  return {title,body,category,level};
}
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
    const alert=pushAlert(delivery.event),passive=alert.level==="passive";
    return new Promise<PushOutcome>(resolve=>{
      let done=false;const client=open(host),timer=setTimeout(()=>finish("retry"),10000);
      function finish(outcome:PushOutcome){if(done)return;done=true;clearTimeout(timer);client.destroy();resolve(outcome);}
      client.on("error",()=>finish("retry"));
      const req=client.request({":method":"POST",":path":"/3/device/"+device.token,"authorization":"bearer "+jwt,"apns-topic":settings.topic,"apns-push-type":"alert","apns-priority":passive?"5":"10","apns-id":delivery.id,"apns-collapse-id":createHash("sha256").update(delivery.event.id).digest("hex"),"apns-expiration":String(now+21600)});
      let status=0,body="";
      req.on("response",headers=>{status=Number(headers[":status"]);});req.on("data",data=>{if(body.length<4096)body+=String(data);});req.on("error",()=>finish("retry"));
      req.on("end",()=>{let reason="";try{reason=JSON.parse(body).reason;}catch{}
        finish(status===200?"sent":status===410||reason==="BadDeviceToken"?"invalid-device":status===403||reason==="DeviceTokenNotForTopic"?"credentials":"retry");});
      // Grouped per conversation; the category gives the iPhone its buttons.
      req.end(JSON.stringify({aps:{alert:{title:alert.title,body:alert.body},...(passive?{}:{sound:"default"}),"thread-id":delivery.event.sessionId,
        category:"HUB_"+alert.category.toUpperCase(),"interruption-level":alert.level,"relevance-score":alert.level==="time-sensitive"?1:alert.level==="active"?0.6:0.2},
        // "hub" keeps its exact older shape so installed apps still open the chat;
        // newer apps read the kind and ids for their buttons from "hubNote".
        hub:{version:1,kind:"session",sessionId:delivery.event.sessionId,origin:device.origin},
        hubNote:{kind:delivery.event.kind,status:delivery.event.status,...(delivery.event.data??{})}}));
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
      // Preferences saved by an older or damaged write fall back to defaults.
      try{value.preferences=value.preferences?parsePushPreferences(value.preferences):undefined;}catch{value.preferences=undefined;}
      if(value.memory&&(typeof value.memory!=="object"||Array.isArray(value.memory)))value.memory=undefined;
      this.#state=value;
    }catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  }
  preferences():PushPreferences{return structuredClone(this.#state.preferences??DEFAULT_PUSH_PREFERENCES);}
  async setPreferences(value:unknown){const next=parsePushPreferences(value);await this.#change(state=>{state.preferences=next;});return next;}
  /** Small durable markers, like "today's brief was sent", kept for 3 days. */
  remembered(key:string){return this.#state.memory?.[key];}
  async remember(key:string){await this.#change(state=>{const now=this.now(),memory=state.memory??{};for(const [k,at] of Object.entries(memory))if(now-at>259200000)delete memory[k];memory[key]=now;state.memory=memory;});}
  async #change<T>(mutate:(state:PushState)=>T){const work=this.#writes.then(async()=>{const next=structuredClone(this.#state),value=mutate(next),file=join(this.root,"native-push.json"),temp=file+"."+randomUUID()+".tmp";try{await writeFile(temp,JSON.stringify(next),{mode:0o600,flag:"wx"});await rename(temp,file);}finally{await rm(temp,{force:true});}this.#state=next;return value;});this.#writes=work.catch(()=>{});return work;}
  snapshot(){return {devices:this.#state.devices.filter(d=>d.enabled).length,pending:this.#state.deliveries.filter(d=>d.state==="pending").length,preferences:this.preferences()};}
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
  /** Queues an event for every enabled device, unless the user turned its kind
   * off. Quiet hours delay it (nothing is dropped); the expiry clock starts
   * when it is released. Returns whether it was queued. */
  async publish(event:NativePushEvent){if(!validEvent(event))throw Error("Invalid notification");const prefs=this.preferences();if(!prefs.kinds[event.kind])return false;
    const queued=await this.#change(state=>{
    const now=this.now(),release=quietRelease(now,prefs,pushAlert(event).level);state.deliveries=state.deliveries.filter(d=>now-d.createdAt<21600000);let added=false;
    for(const device of state.devices.filter(d=>d.enabled)){if(state.deliveries.some(d=>d.deviceId===device.id&&d.event.id===event.id))continue;if(state.deliveries.length>=512)break;state.deliveries.push({id:randomUUID(),event:structuredClone(event),deviceId:device.id,attempts:0,nextAt:release,createdAt:release,state:"pending"});added=true;}
    return added;
  });await this.tick();return queued;}
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
      else if(value?.action==="preferences"&&Object.keys(value).sort().join()==="action,preferences"){
        try{await ports.store.setPreferences(value.preferences);}catch(e){json(400,{error:"invalid-preferences",detail:String((e as Error).message).slice(0,200)});return;}
      }
      else if(value?.action==="test"&&Object.keys(value).join()==="action")await ports.store.publish({id:"test:"+randomUUID(),sessionId:"hub-notification-test",kind:"assistant",status:"info",title:"HUB",body:"Notifications work. This is how HUB will reach you.",category:"open",level:"active"});
      else{json(400,{error:"invalid-command"});return;}
      json(200,{version:1,configured:await ports.configured(),...ports.store.snapshot()});
    }catch{json(503,{error:"notification-service-unavailable"});}
  };
}
