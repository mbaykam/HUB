import {readFile,mkdir,writeFile,rename,lstat} from "node:fs/promises";
import {join,dirname} from "node:path";
import {randomUUID} from "node:crypto";
import type {IncomingMessage,ServerResponse} from "node:http";
import type {HubCharacters} from "../characters.ts";
import {digest} from "./knowledge-store.ts";
import {redactKnowledgeSecrets} from "./knowledge-curator.ts";

/** Operator-owned Markdown files are shared by conversational characters.
 * Existing character instructions retain their one authoritative JSON store. */
export class InstructionFiles {
  readonly root:string;
  private texts:Record<string,string>={};
  private managed=new Map<string,{generate:()=>Promise<string>;visible?:(context:any)=>boolean}>();
  private writes:Promise<unknown>=Promise.resolve();
  private refreshes:Promise<unknown>=Promise.resolve();
  constructor(root:string){this.root=root;}
  async load(){
    await mkdir(this.root,{recursive:true});
    if((await lstat(this.root)).isSymbolicLink())throw new Error("Instruction directory must be a real directory");
    for(const name of ["SOUL.md","USER.md"]){
      const path=join(this.root,name);
      try{await writeFile(path,"",{flag:"wx",mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;}
    }
    await this.refresh();
  }
  registerManaged(name:"memory.md",generate:()=>Promise<string>,visible?:(context:any)=>boolean){
    const registration={generate,visible};this.managed.set(name,registration);
    return ()=>{if(this.managed.get(name)===registration){this.managed.delete(name);delete this.texts[name];}};
  }
  async refresh(){const next=this.refreshes.then(()=>this.refreshNow());this.refreshes=next.catch(()=>{});await next;}
  private async refreshNow(){
    for(const name of ["SOUL.md","USER.md"]){const path=join(this.root,name),info=await lstat(path);if(info.isSymbolicLink()||info.size>32000)throw new Error("Instruction file must be plain text under 32 KB");this.texts[name]=await readFile(path,"utf8");}
    for(const [name,source]of this.managed){
      // Never continue with yesterday's routing index if its authoritative
      // registry is unavailable. A failed refresh must not block normal chat.
      try{
        const content=await source.generate();if(Buffer.byteLength(content)>16000)throw Error("Managed index exceeds its context budget");
        const path=join(this.root,name),info=await lstat(path).catch(e=>{if(e.code!=="ENOENT")throw e;return undefined;});
        if(info&&(info.isSymbolicLink()||!info.isFile()))throw Error("Managed index must be a regular file");
        if(!info||await readFile(path,"utf8")!==content){const temp=path+`.${randomUUID()}.tmp`;await writeFile(temp,content,{flag:"wx",mode:0o600});await rename(temp,path);}
        this.texts[name]=content;
      }catch{this.texts[name]="Memory navigation is temporarily unavailable. Do not assume saved information is absent; retry the permitted Knowledge tools.";}
    }
  }
  visible(name:string,context:any){return this.managed.get(name)?.visible?.(context)??true;}
  text(name:string){return this.texts[name]??"";}
  files(){return [...["SOUL.md","USER.md"],...this.managed.keys()].map(name=>({id:name,name,path:join(this.root,name),content:this.text(name),hash:digest(this.text(name)),editable:!this.managed.has(name),generated:this.managed.has(name),scope:"Conversation characters and their delegated workers"}));}
  async save(name:string,hash:string,content:string){
    if(!["SOUL.md","USER.md"].includes(name)||typeof hash!=="string"||typeof content!=="string"||Buffer.byteLength(content)>32000)throw new Error("Invalid instruction edit");
    const task=this.writes.then(async()=>{await this.refresh();const before=this.text(name);if(digest(before)!==hash)throw new Error("Instructions changed; reload before saving");
      await mkdir(join(this.root,"history"),{recursive:true});await writeFile(join(this.root,"history",`${name}.${digest(before)}.md`),before,{mode:0o600});
      const path=join(this.root,name),temp=path+`.${randomUUID()}.tmp`;await writeFile(temp,content,{flag:"wx",mode:0o600});
      if(await readFile(path,"utf8")!==before)throw new Error("Instructions changed during the edit");await rename(temp,path);this.texts[name]=content;
    });this.writes=task.catch(()=>{});await task;
  }
}

/** Exposes only known instruction sources; never arbitrary paths or credentials. */
export function installInstructionFiles(ctx:any,characters:HubCharacters,files=new InstructionFiles(join(characters.store.root,"instructions"))){
  const ready=files.load();void ready.catch(()=>{});
  const sharedText=(name:string,context:any)=>context.scope?.id?.startsWith("hub-memory-")||!files.visible(name,context)?"":files.text(name)?`${name==="memory.md"?"Generated Knowledge navigation":"Operator "+name+" instructions"} (current version):\n${files.text(name)}`:"";
  const offRefresh=ctx.on("system-prompt/assemble",async(_assembly:any,context:any,next:()=>Promise<any>)=>{await ready;await files.refresh();const assembled=await next();return {...assembled,sections:assembled.sections.map((section:any)=>section.name.startsWith("hub:instructions:")?{...section,text:sharedText(section.name.slice("hub:instructions:".length),context)}:section)};},{global:true,prepend:true});
  const offs=["SOUL.md","USER.md","memory.md"].map((name,i)=>ctx.systemPrompt.section({name:"hub:instructions:"+name,order:993+i,text:(context:any)=>sharedText(name,context)}));
  const send=(res:ServerResponse,code:number,value:unknown)=>{res.writeHead(code,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});res.end(JSON.stringify(value));};
  const offRoute=ctx.webServer.register({kind:"exact",path:"/api/hub/instructions",async handler(req:IncomingMessage,res:ServerResponse){
    const rejection=ctx.connection.requestRejection(req);if(rejection||req.headers["sec-fetch-site"]==="cross-site"){send(res,rejection??403,{error:"unauthorized"});return;}
    if(req.headers["x-hub-instructions"]!=="1"){send(res,403,{error:"header-required"});return;}
    try{await Promise.all([ready,characters.ready]);await files.refresh();
      if(req.method==="POST"){
        if(!req.headers["content-type"]?.startsWith("application/json"))throw new Error("JSON required");
        let size=0;const chunks:Buffer[]=[];for await(const chunk of req){size+=chunk.length;if(size>80000)throw new Error("Instruction edit too large");chunks.push(chunk);}
        const command=JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if(command.id==="SOUL.md"||command.id==="USER.md")await files.save(command.id,command.hash,command.content);
        else if(typeof command.id==="string"&&command.id.startsWith("character:")){
          const state=characters.store.snapshot(),c=state.characters.find(c=>c.id===command.id.slice(10));
          if(!c||typeof command.content!=="string"||command.content.length>12000||digest(c.instructions)!==command.hash)throw new Error("Character instructions changed; reload before saving");
          await characters.store.change({action:"save",revision:state.revision,character:{...c,instructions:command.content}},c=>characters.validate(c));
        }else throw new Error("Unknown instruction source");
      }else if(req.method!=="GET"){send(res,405,{error:"method-not-allowed"});return;}
      const state=characters.store.snapshot(),nativePath=join(dirname(characters.store.root),"AGENTS.md");
      let nativeText="";try{const info=await lstat(nativePath);if(!info.isSymbolicLink()&&info.size<=32000)nativeText=await readFile(nativePath,"utf8");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
      const sessionId=new URL(req.url??"/", "http://hub.invalid").searchParams.get("sessionId");
      let lastRequest:any;
      if(sessionId&&sessionId.length<=200){const found=await ctx.sessionController.resolveAgent(sessionId);if(found.agent){const agent=found.agent,header=agent.session.requestHeader?.();const workspace=agent.session.snapshotEvents().filter((e:any)=>e.type==="user/message"&&e.data?.source?.kind==="agent-instructions").slice(-8).map((e:any)=>e.data.content.filter((b:any)=>b.type==="text").map((b:any)=>b.text).join("\n"));lastRequest={sessionId,model:header?.config?.model,provider:header?.config?.provider,system:redactKnowledgeSecrets(header?.system??"").slice(0,100000),workspace:workspace.map((s:string)=>redactKnowledgeSecrets(s).slice(0,32000))};}}
      send(res,200,{shared:[...files.files(),{id:"native-agents",name:"AGENTS.md",path:nativePath,content:nativeText,editable:false,scope:"Native global workspace instructions; project files may add further rules"}],characters:state.characters.map(c=>({id:c.id,name:c.name,role:c.id===state.mainId?"Main":c.id===state.voiceId?"Voice":"Specialist",route:c.route,instructions:{id:"character:"+c.id,name:c.name+" instructions",path:join(characters.store.root,"characters.json")+" → instructions",content:c.instructions,hash:digest(c.instructions),editable:true,scope:c.name+" only; follows this character across model changes"}})),lastRequest});
    }catch(error){send(res,409,{error:"instructions-operation-failed",detail:redactKnowledgeSecrets((error as Error).message).slice(0,600)});}
  }});
  return ()=>{offRoute();offRefresh();for(const off of offs)off();};
}
