import {readFile,mkdir,writeFile,rename,rm,lstat} from "node:fs/promises";
import {join} from "node:path";
import {randomUUID,createHash} from "node:crypto";
import type {IncomingMessage,ServerResponse} from "node:http";
import {APPS_PAGE} from "./apps-page.ts";

/** A link made on an outside host so someone else can open an app. */
export interface AppShare {slug:string;url:string;createdAt:number;expiresAt:number|null;anonymous:boolean}
/** One web app on the user's Apps page. The HTML is stored beside the index. */
export interface HubApp {id:string;title:string;description:string;icon:string;color:string;createdAt:number;updatedAt:number;bytes:number;sourceSessionId?:string;shares:AppShare[]}

const MAX_APP=4_000_000;
const uuid=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const clean=(v:unknown,max:number)=>typeof v==="string"?v.replace(/[\u0000-\u001f]+/g," ").replace(/\s+/g," ").trim().slice(0,max):"";
const COLORS=["#54DEFF","#A380FF","#FF75BD","#FFC752","#66EBAD","#FF8A5C","#7FA6FF"];

export class AppsStore {
  #apps:HubApp[]=[];#writes:Promise<unknown>=Promise.resolve();
  constructor(readonly root:string,readonly now=()=>Date.now()){}
  async load(){
    await mkdir(join(this.root,"files"),{recursive:true,mode:0o700});if((await lstat(this.root)).isSymbolicLink())throw Error("Apps storage must be a regular directory");
    try{const value=JSON.parse(await readFile(join(this.root,"apps.json"),"utf8"));if(!Array.isArray(value.apps)||value.apps.some((a:HubApp)=>!uuid(a.id)||typeof a.title!=="string"||!Array.isArray(a.shares)))throw Error("Apps index needs repair; the saved file was preserved");this.#apps=value.apps;}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  }
  list(){return structuredClone(this.#apps).sort((a,b)=>b.updatedAt-a.updatedAt);}
  get(id:string){const app=this.#apps.find(a=>a.id===id);return app?structuredClone(app):undefined;}
  async html(id:string){if(!uuid(id)||!this.#apps.some(a=>a.id===id))throw Error("No such app");return readFile(join(this.root,"files",id+".html"),"utf8");}
  #change<T>(run:(apps:HubApp[])=>Promise<T>|T){const work=this.#writes.then(async()=>{const next=structuredClone(this.#apps),value=await run(next),file=join(this.root,"apps.json"),temp=file+"."+randomUUID()+".tmp";
    try{await writeFile(temp,JSON.stringify({apps:next}),{mode:0o600,flag:"wx"});await rename(temp,file);}finally{await rm(temp,{force:true});}this.#apps=next;return value;});this.#writes=work.catch(()=>{});return work;}
  async save(input:{id?:string;title:unknown;description?:unknown;icon?:unknown;color?:unknown;html:unknown;sourceSessionId?:string}){
    const title=clean(input.title,60),html=typeof input.html==="string"?input.html:"";
    if(!title)throw Error("Give the app a short title.");
    if(!html.trim()||!/<[a-z!]/i.test(html))throw Error("An app is one HTML document.");
    const bytes=Buffer.byteLength(html);if(bytes>MAX_APP)throw Error("Keep an app under 4 MB.");
    if(input.id!==undefined&&!uuid(input.id))throw Error("Unknown app id.");
    return this.#change(async apps=>{
      const old=input.id?apps.find(a=>a.id===input.id):undefined;if(input.id&&!old)throw Error("Unknown app id.");
      if(!old&&apps.length>=500)throw Error("The Apps page is full. Remove an app first.");
      const id=old?.id??randomUUID(),now=this.now(),icon=clean(input.icon,4)||old?.icon||title.slice(0,1).toUpperCase();
      const color=typeof input.color==="string"&&/^#[0-9a-f]{6}$/i.test(input.color)?input.color:old?.color??COLORS[parseInt(createHash("sha256").update(id).digest("hex").slice(0,2),16)%COLORS.length];
      const file=join(this.root,"files",id+".html"),temp=file+"."+randomUUID()+".tmp";
      try{await writeFile(temp,html,{mode:0o600,flag:"wx"});await rename(temp,file);}finally{await rm(temp,{force:true});}
      const app:HubApp={id,title,description:clean(input.description,200)||old?.description||"",icon,color,createdAt:old?.createdAt??now,updatedAt:now,bytes,shares:old?.shares??[],...(old?.sourceSessionId??input.sourceSessionId?{sourceSessionId:old?.sourceSessionId??input.sourceSessionId}:{})};
      if(old)apps[apps.indexOf(old)]=app;else apps.push(app);return structuredClone(app);
    });
  }
  remove(id:string){return this.#change(async apps=>{const index=apps.findIndex(a=>a.id===id);if(index<0)throw Error("No such app");const [app]=apps.splice(index,1);await rm(join(this.root,"files",id+".html"),{force:true});return app;});}
  async rename(id:string,title:unknown){const name=clean(title,60);if(!name)throw Error("Give the app a title.");return this.#change(apps=>{const app=apps.find(a=>a.id===id);if(!app)throw Error("No such app");app.title=name;app.updatedAt=this.now();return structuredClone(app);});}
  setShares(id:string,update:(shares:AppShare[])=>AppShare[]){return this.#change(apps=>{const app=apps.find(a=>a.id===id);if(!app)throw Error("No such app");app.shares=update(app.shares).slice(-20);return structuredClone(app);});}
  async drain(){await this.#writes;}
}

const HERE_NOW="https://here.now";
type Fetch=typeof fetch;
/** Publishes one HTML file to here.now. With an account key the link lasts as
 * long as asked; without one, here.now keeps it for 24 hours. */
export async function publishToHereNow(html:string,options:{title:string;ttlSeconds:number;apiKey?:string},fetchImpl:Fetch=fetch):Promise<AppShare>{
  const headers:Record<string,string>={"content-type":"application/json","x-herenow-client":"hub/apps",...(options.apiKey?{authorization:"Bearer "+options.apiKey}:{})};
  const bytes=Buffer.from(html,"utf8"),signal=()=>AbortSignal.timeout(30000);
  const created=await fetchImpl(HERE_NOW+"/api/v1/publish",{method:"POST",headers,signal:signal(),body:JSON.stringify({
    files:[{path:"index.html",size:bytes.length,contentType:"text/html; charset=utf-8",hash:createHash("sha256").update(bytes).digest("hex")}],
    ...(options.apiKey?{ttlSeconds:options.ttlSeconds}:{}),viewer:{title:options.title.slice(0,200)}})});
  if(!created.ok)throw Error(created.status===401||created.status===403?"here.now refused the account key.":created.status===429?"here.now is rate limiting; try again shortly.":"here.now could not publish ("+created.status+").");
  const value:any=await created.json();
  if(typeof value?.slug!=="string"||typeof value?.siteUrl!=="string")throw Error("here.now answered unexpectedly.");
  for(const target of value.upload?.uploads??[]){
    const put=await fetchImpl(target.url,{method:"PUT",headers:target.headers??{"content-type":"text/html; charset=utf-8"},body:bytes,signal:signal()});
    if(!put.ok)throw Error("Uploading to here.now failed ("+put.status+").");
  }
  if(value.requiresFinalize!==false&&value.upload?.finalizeUrl){
    const done=await fetchImpl(value.upload.finalizeUrl,{method:"POST",headers,body:JSON.stringify({versionId:value.upload.versionId}),signal:signal()});
    if(!done.ok)throw Error("here.now did not finish publishing ("+done.status+").");
  }
  const now=Date.now(),ttl=options.apiKey?options.ttlSeconds:Math.min(options.ttlSeconds,86400);
  return {slug:value.slug,url:value.siteUrl,createdAt:now,expiresAt:now+ttl*1000,anonymous:!options.apiKey};
}
export async function deleteFromHereNow(slug:string,apiKey:string,fetchImpl:Fetch=fetch){
  const response=await fetchImpl(HERE_NOW+"/api/v1/publish/"+encodeURIComponent(slug),{method:"DELETE",headers:{"x-herenow-client":"hub/apps",authorization:"Bearer "+apiKey},signal:AbortSignal.timeout(20000)});
  if(!response.ok&&response.status!==404)throw Error("here.now could not remove the link ("+response.status+").");
}

export const APPS_GUIDE="The user has an Apps page: a home for small web apps HUB makes for them (tools, games, calculators, trackers, visualizations). When you build one they will reuse, save it with hub_app_save: one self-contained HTML file with inline CSS and JavaScript, mobile-first, readable in dark and light, no lorem ipsum or fake data presented as real, working offline where it can. Update an existing app by its id instead of saving a copy. Share with hub_app_share only when the user asks to send an app to someone; links expire (24 hours unless their here.now account key is set) and stop working when unshared. Never share personal data in a shared app without saying so.";

function userAsked(agent:any){
  const events=agent?.session?.snapshotEvents?.()??[];
  for(let i=events.length-1;i>=0;i--){const event=events[i];if(event.type==="turn/end")return false;if(event.type==="user/message")return event.data?.source?.kind==="user";}
  return false;
}

export function installApps(ctx:any,characters:any,effectiveCharacter:(ctx:any,agent:any)=>any){
  const store=new AppsStore(join(characters.store.root,"..","hub-apps")),ready=store.load();void ready.catch(()=>{});
  characters.apps=store;
  let credentials:any;
  const credentialScope=ctx.inject(["credentials"],(child:any)=>{const binding=child.credentials;credentials=binding;child.effect(()=>()=>{if(credentials===binding)credentials=undefined;},"apps sharing credentials");});
  const apiKey=async()=>{const value=(await credentials?.resolve?.("HERENOW_API_KEY"))?.value;return typeof value==="string"&&value.trim()?value.trim():undefined;};
  const view=(app:HubApp)=>({...app,url:"/apps/run/"+app.id,shares:app.shares.filter(s=>s.expiresAt===null||s.expiresAt>Date.now())});
  const share=async(id:string,hours:number)=>{
    const app=store.get(id);if(!app)throw Error("No such app");
    const html=await store.html(id),key=await apiKey(),ttl=Math.round(Math.min(720,Math.max(1,hours))*3600);
    const link=await publishToHereNow(html,{title:app.title,ttlSeconds:ttl,apiKey:key});
    await store.setShares(id,shares=>[...shares.filter(s=>s.expiresAt===null||s.expiresAt>Date.now()),link]);
    return {...link,note:link.anonymous&&hours>24?"Without a here.now account key this link lasts 24 hours.":undefined};
  };
  const unshare=async(id:string)=>{
    const app=store.get(id);if(!app)throw Error("No such app");const key=await apiKey();let kept=0;
    for(const link of app.shares){if(link.anonymous||!key){kept++;continue;}await deleteFromHereNow(link.slug,key);}
    await store.setShares(id,shares=>shares.filter(s=>s.anonymous||!key));
    return {removed:app.shares.length-kept,stillLive:kept,note:kept?"Links made without an account key cannot be taken down early; they expire within 24 hours.":undefined};
  };
  const output={schema:{type:"object"},render:(_a:any,v:any)=>[{type:"text",text:JSON.stringify(v)}]};
  const allowed=(exec:any,name:string)=>{if(!exec.agent)throw Error("This tool needs an active conversation.");const character=effectiveCharacter(ctx,exec.agent);if(character?.tools.mode==="allow"&&!character.tools.names.includes(name)&&!character.tools.names.includes("hub_app_save"))throw Error("Apps are disabled for this character.");};
  const offTools=[
    ctx.tools.register({name:"hub_app_save",description:"Save or update a web app on the user's Apps page. html is one complete self-contained HTML document. icon is one emoji or letter. Pass id to update an app you saved before.",parameters:{type:"object",properties:{id:{type:"string"},title:{type:"string"},description:{type:"string"},icon:{type:"string"},color:{type:"string",description:"#RRGGBB"},html:{type:"string"}},required:["title","html"],additionalProperties:false},output,
      async execute(args:any,exec:any){allowed(exec,"hub_app_save");await ready;const header=exec.agent.session.header,root=header.origin==="subagent"&&header.parentSession?header.parentSession:header.id;
        const app=await store.save({...args,sourceSessionId:root});return {saved:true,id:app.id,title:app.title,openAt:"/apps/run/"+app.id,page:"/apps"};}}),
    ctx.tools.register({name:"hub_app_list",description:"List the apps on the user's Apps page with their ids and any live share links.",parameters:{type:"object",properties:{},additionalProperties:false},output,
      async execute(_args:any,exec:any){allowed(exec,"hub_app_list");await ready;return {apps:store.list().map(view).map(({id,title,description,updatedAt,shares})=>({id,title,description,updatedAt,shares}))};}}),
    ctx.tools.register({name:"hub_app_share",description:"Publish an app as a link someone else can open (via here.now), only when the user asks to share it. expires_in_hours 1-720; without the user's here.now account key links last at most 24 hours.",parameters:{type:"object",properties:{id:{type:"string"},expires_in_hours:{type:"number"}},required:["id"],additionalProperties:false},output,
      async execute(args:any,exec:any){allowed(exec,"hub_app_share");if(!userAsked(exec.agent))throw Error("Share only when the user asks in this conversation.");await ready;return share(String(args.id),Number(args.expires_in_hours??24));}}),
    ctx.tools.register({name:"hub_app_unshare",description:"Take down an app's share links.",parameters:{type:"object",properties:{id:{type:"string"}},required:["id"],additionalProperties:false},output,
      async execute(args:any,exec:any){allowed(exec,"hub_app_unshare");await ready;return unshare(String(args.id));}}),
    ctx.tools.register({name:"hub_app_remove",description:"Remove an app from the Apps page, only when the user asks.",parameters:{type:"object",properties:{id:{type:"string"}},required:["id"],additionalProperties:false},output,
      async execute(args:any,exec:any){allowed(exec,"hub_app_remove");if(!userAsked(exec.agent))throw Error("Remove apps only when the user asks.");await ready;const app=await store.remove(String(args.id));return {removed:true,title:app.title};}}),
  ];
  const offPrompt=ctx.systemPrompt.section({name:"hub:apps",order:94,text:(context:any)=>context.scope?.id?.startsWith?.("hub-memory-")?"":APPS_GUIDE});
  const send=(res:ServerResponse,code:number,value:unknown)=>{res.writeHead(code,{"content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff"});res.end(JSON.stringify(value));};
  const guard=(req:IncomingMessage,res:ServerResponse)=>{const rejected=ctx.connection.requestRejection(req);if(rejected){res.writeHead(rejected,{"content-type":"text/plain"});res.end("Sign in to HUB first.");return false;}return true;};
  const offApi=ctx.webServer.register({kind:"exact",path:"/api/hub/apps",async handler(req:IncomingMessage,res:ServerResponse){
    const rejected=ctx.connection.requestRejection(req);if(rejected||req.headers["sec-fetch-site"]==="cross-site"||req.headers["x-hub-apps"]!=="1"){send(res,rejected??403,{error:"unauthorized"});return;}
    try{await ready;
      if(req.method==="GET"){send(res,200,{apps:store.list().map(view),sharing:{accountKey:!!await apiKey()}});return;}
      if(req.method!=="POST"){send(res,405,{error:"method-not-allowed"});return;}
      if(!String(req.headers["content-type"]??"").startsWith("application/json")){send(res,415,{error:"json-required"});return;}
      const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>8192){send(res,413,{error:"too-large"});return;}chunks.push(chunk);}
      const input=JSON.parse(Buffer.concat(chunks).toString("utf8"));let result:unknown;
      if(input?.action==="remove")result=await store.remove(String(input.id));
      else if(input?.action==="rename")result=await store.rename(String(input.id),input.title);
      else if(input?.action==="share")result=await share(String(input.id),Number(input.hours??24));
      else if(input?.action==="unshare")result=await unshare(String(input.id));
      else if(input?.action==="key"){const key=typeof input.apiKey==="string"?input.apiKey.trim():"";if(!credentials?.set)throw Error("The credential store is unavailable.");if(key&&!/^[\x21-\x7e]{16,256}$/.test(key))throw Error("That does not look like a here.now API key.");await credentials.set("HERENOW_API_KEY",key);result={accountKey:!!key};}
      else throw Error("Unknown action");
      send(res,200,{result,apps:store.list().map(view),sharing:{accountKey:!!await apiKey()}});
    }catch(error){send(res,409,{error:"apps-operation-failed",detail:String((error as Error).message).slice(0,300)});}
  }});
  const page=(res:ServerResponse)=>{res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer"});res.end(APPS_PAGE);};
  const offPage=ctx.webServer.register({kind:"exact",path:"/apps",handler(req:IncomingMessage,res:ServerResponse){if(guard(req,res))page(res);}});
  const offFiles=ctx.webServer.register({kind:"prefix",path:"/apps/",async handler(req:IncomingMessage,res:ServerResponse){
    if(!guard(req,res))return;
    const path=new URL(req.url??"/","http://hub.invalid").pathname;
    if(path==="/apps/"){page(res);return;}
    if(path==="/apps/manifest.webmanifest"){res.writeHead(200,{"content-type":"application/manifest+json","cache-control":"no-store"});res.end(JSON.stringify({name:"HUB Apps",short_name:"Apps",start_url:"/apps",scope:"/apps",display:"standalone",background_color:"#05060a",theme_color:"#05060a",icons:[]}));return;}
    const match=/^\/apps\/run\/([a-f0-9-]{36})\/?$/i.exec(path);
    if(!match){res.writeHead(404,{"content-type":"text/plain"});res.end("Not found");return;}
    try{await ready;const html=await store.html(match[1]!);
      // Each app runs in its own sandbox: scripts work, but it gets no access to
      // HUB's cookies, storage or API.
      res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer",
        "content-security-policy":"sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock"});
      res.end(html);
    }catch{res.writeHead(404,{"content-type":"text/plain"});res.end("This app was removed.");}
  }});
  return async()=>{offTools.forEach(off=>off());offPrompt();offApi();offPage();offFiles();void credentialScope.dispose();if(characters.apps===store)characters.apps=undefined;await ready.catch(()=>{});await store.drain();};
}
