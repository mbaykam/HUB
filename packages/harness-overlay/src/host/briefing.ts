import type {IncomingMessage,ServerResponse} from "node:http";
import {randomUUID} from "node:crypto";
import {mkdir,readFile,rename,writeFile} from "node:fs/promises";
import {homedir} from "node:os";
import {join} from "node:path";

/**
 * Home's daily briefing: the news on topics the user picked (or the assistant
 * added for them), straight from news feeds. No model call, so it costs no
 * tokens and no usage limit.
 */
export const BRIEFING_TOOLS=["hub_briefing_topics"] as const;
export const BRIEFING_MAX_TOPICS=16,BRIEFING_STALE_MS=3*3600_000,BRIEFING_ITEMS=4;

export interface BriefingTopic {id:string;title:string;by:"user"|"assistant";at:number}
export interface BriefingItem {title:string;source:string;url:string;at:number}
export interface BriefingSection {topicId:string;title:string;items:BriefingItem[];failed?:boolean}
export interface BriefingState {topics:BriefingTopic[];last?:{at:number;sections:BriefingSection[]}}

const decode=(text:string)=>text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,"$1").replace(/<[^>]+>/g,"")
  .replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,"\"").replace(/&#39;|&apos;/g,"'")
  .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&amp;/g,"&").replace(/\s+/g," ").trim();

/** Headlines from a news RSS feed, in the feed's order (most relevant first), without repeats. */
export function parseNewsFeed(xml:string,limit=BRIEFING_ITEMS):BriefingItem[]{
  const items:BriefingItem[]=[],seen=new Set<string>();
  for(const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)){
    const tag=(name:string)=>{const found=new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(match[1]);return found?decode(found[1]):"";};
    const source=tag("source");let title=tag("title");
    if(source&&title.endsWith(" - "+source))title=title.slice(0,-(source.length+3)).trim();
    const url=tag("link"),at=Date.parse(tag("pubDate"));
    if(!title||!/^https:\/\/[^\s]+$/.test(url))continue;
    const key=title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim().slice(0,90);
    if(seen.has(key))continue;seen.add(key);
    items.push({title:title.slice(0,300),source:source.slice(0,80),url:url.slice(0,2000),at:Number.isFinite(at)?at:0});
    if(items.length>=limit)break;
  }
  return items;
}

export function newsFeedUrl(topic:string){
  return `https://news.google.com/rss/search?q=${encodeURIComponent(topic+" when:2d")}&hl=tr&gl=TR&ceid=TR:tr`;
}

const cleanTitle=(value:unknown)=>{
  const title=String(value??"").replace(/\s+/g," ").trim();
  if(!title||title.length>80)throw Object.assign(Error("Write a topic of 1–80 characters."),{status:400});
  return title;
};

export class BriefingService {
  #state?:BriefingState;#queue:Promise<unknown>=Promise.resolve();#refreshing?:Promise<BriefingState>;
  constructor(readonly root=join(homedir(),".dsh","hub-briefing"),readonly fetcher:(url:string,init:RequestInit)=>Promise<Response>=fetch,readonly now=()=>Date.now()){}

  async #load(){
    if(this.#state)return this.#state;
    try{
      const value=JSON.parse(await readFile(join(this.root,"briefing.json"),"utf8"));
      this.#state={topics:Array.isArray(value.topics)?value.topics:[],...(value.last?{last:value.last}:{})};
    }catch(error:any){if(error?.code!=="ENOENT")throw error;this.#state={topics:[]};}
    return this.#state;
  }
  async #save(state:BriefingState){
    await mkdir(this.root,{recursive:true});
    const temp=join(this.root,randomUUID()+".tmp");
    await writeFile(temp,JSON.stringify(state,null,2)+"\n",{mode:0o600});
    await rename(temp,join(this.root,"briefing.json"));
    this.#state=state;
  }
  #change<T>(work:(state:BriefingState)=>Promise<T>|T){
    const next=this.#queue.then(async()=>{const state=structuredClone(await this.#load());const result=await work(state);await this.#save(state);return result;});
    this.#queue=next.catch(()=>{});return next;
  }

  async view(){
    const state=await this.#load();
    return {topics:state.topics,briefing:state.last??null,refreshing:!!this.#refreshing,stale:this.isStale(state)};
  }
  isStale(state:BriefingState){return state.topics.length>0&&(!state.last||this.now()-state.last.at>BRIEFING_STALE_MS||state.topics.some(t=>!state.last!.sections.some(s=>s.topicId===t.id)));}

  async addTopic(title:unknown,by:"user"|"assistant"){
    const name=cleanTitle(title);
    return this.#change(state=>{
      const existing=state.topics.find(t=>t.title.toLowerCase()===name.toLowerCase());
      if(existing)return existing;
      if(state.topics.length>=BRIEFING_MAX_TOPICS)throw Object.assign(Error(`The briefing follows at most ${BRIEFING_MAX_TOPICS} topics. Remove one first.`),{status:400});
      const topic:BriefingTopic={id:randomUUID(),title:name,by,at:this.now()};state.topics.push(topic);return topic;
    });
  }
  removeTopic(idOrTitle:unknown){
    const key=String(idOrTitle??"").trim().toLowerCase();
    return this.#change(state=>{
      const before=state.topics.length;
      state.topics=state.topics.filter(t=>t.id!==String(idOrTitle)&&t.title.toLowerCase()!==key);
      if(state.topics.length===before)throw Object.assign(Error("That topic is not in the briefing."),{status:404});
      if(state.last)state.last.sections=state.last.sections.filter(s=>state.topics.some(t=>t.id===s.topicId));
      return state.topics;
    });
  }
  moveTopic(id:unknown,to:unknown){
    return this.#change(state=>{
      const from=state.topics.findIndex(t=>t.id===String(id)),index=Math.max(0,Math.min(state.topics.length-1,Number(to)));
      if(from<0||!Number.isInteger(index))throw Object.assign(Error("That topic is not in the briefing."),{status:404});
      const [topic]=state.topics.splice(from,1);state.topics.splice(index,0,topic);return state.topics;
    });
  }

  /** Fetches every topic's headlines at once; concurrent callers share one refresh. */
  refresh(){
    this.#refreshing??=(async()=>{
      try{
        const {topics}=await this.#load();
        const sections=await Promise.all(topics.map(async(topic):Promise<BriefingSection>=>{
          try{
            const response=await this.fetcher(newsFeedUrl(topic.title),{signal:AbortSignal.timeout(9000),headers:{accept:"application/rss+xml, application/xml"}});
            if(!response.ok)throw Error(String(response.status));
            return {topicId:topic.id,title:topic.title,items:parseNewsFeed((await response.text()).slice(0,3_000_000))};
          }catch{return {topicId:topic.id,title:topic.title,items:[],failed:true};}
        }));
        return await this.#change(state=>{
          // Topics removed while fetching stay removed; a failed topic keeps its last headlines.
          state.last={at:this.now(),sections:sections.filter(s=>state.topics.some(t=>t.id===s.topicId)).map(s=>{
            const previous=s.failed?state.last?.sections.find(p=>p.topicId===s.topicId):undefined;
            return previous?.items.length?{...s,items:previous.items}:s;
          })};
          return state;
        });
      }finally{this.#refreshing=undefined;}
    })();
    return this.#refreshing;
  }
}

async function body(req:IncomingMessage){
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>20_000)throw Object.assign(Error("This is too large."),{status:413});chunks.push(chunk as Buffer);}
  return JSON.parse(Buffer.concat(chunks).toString("utf8")||"{}");
}

export function installBriefing(ctx:any,service=new BriefingService()){
  const send=(res:ServerResponse,code:number,value:unknown)=>{res.writeHead(code,{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"});res.end(JSON.stringify(value));};
  const off:(()=>void)[]=[];
  off.push(ctx.webServer.register({kind:"exact",path:"/api/hub/briefing",async handler(req:IncomingMessage,res:ServerResponse){
    const reject=ctx.connection.requestRejection(req);
    if(reject||req.headers["sec-fetch-site"]==="cross-site"||req.headers["x-hub-briefing"]!=="1"){send(res,reject??403,{error:"unauthorized"});return;}
    try{
      if(req.method==="GET"){
        const view=await service.view();
        // Old headlines show at once; fresh ones arrive on the next look.
        if(view.stale&&!view.refreshing){service.refresh().catch(()=>{});view.refreshing=true;}
        send(res,200,view);return;
      }
      if(req.method!=="POST"){send(res,405,{error:"method-not-allowed"});return;}
      const input=await body(req);
      switch(input.action){
        case "add":await service.addTopic(input.title,"user");service.refresh().catch(()=>{});break;
        case "remove":await service.removeTopic(input.id);break;
        case "move":await service.moveTopic(input.id,input.to);break;
        case "refresh":await service.refresh();break;
        default:send(res,400,{error:"unknown-action"});return;
      }
      send(res,200,await service.view());
    }catch(error:any){send(res,error?.status??400,{error:String(error?.message??error).slice(0,300)});}
  }}));
  const remove=ctx.tools?.register?.({name:"hub_briefing_topics",
    description:"The topics of the user's daily news briefing on HUB's Home screen. list shows them; add follows a new topic when the user asks, or on your own when they clearly show a lasting interest (a hobby, an investment, a project, a team); remove drops one when asked or when the interest has clearly ended. Topics are short search phrases like \"Yapay zekâ\" or \"Bitcoin\". After adding or removing on your own, tell the user in one short sentence.",
    parameters:{type:"object",properties:{action:{type:"string",enum:["list","add","remove"]},topic:{type:"string",maxLength:80}},required:["action"],additionalProperties:false},
    output:{schema:{type:"string"},render:(_a:any,v:any)=>[{type:"text",text:String(v)}]},
    async execute(args:any){
      if(args.action==="add"){const topic=await service.addTopic(args.topic,"assistant");service.refresh().catch(()=>{});return JSON.stringify({following:topic.title});}
      if(args.action==="remove"){await service.removeTopic(args.topic);return JSON.stringify({removed:args.topic});}
      const {topics}=await service.view();
      return JSON.stringify({topics:topics.map(t=>({title:t.title,addedBy:t.by}))});
    }});
  if(typeof remove==="function")off.push(remove);
  return ()=>off.forEach(f=>f());
}
