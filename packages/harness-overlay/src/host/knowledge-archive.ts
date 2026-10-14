import {readFile,writeFile,mkdir,rename,lstat,readdir,open} from "node:fs/promises";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {atomicJson,digest} from "./knowledge-store.ts";
import type {KnowledgeConversation,ConversationMessage,KnowledgeSource} from "../knowledge-contract.ts";
import {isKnowledgeEvaluation} from "./knowledge-evidence.ts";
import {operationFailure} from "./operation-failure.ts";

/** Original messages are canonical private JSON; readable Markdown is a
 * lossless projection. Curator never owns either write path. */
export class KnowledgeArchive {
  private writes:Promise<unknown>=Promise.resolve();
  constructor(readonly vault:string,readonly root:string){}
  private file(id:string){if(!/^conversation-[a-f0-9]{32}$/.test(id))throw Error("Invalid conversation identity");return join(this.root,"conversations",id+".json");}
  private async projectionPath(id:string,discoverRename=true){
    const expected=join(this.vault,"Conversations",id+".md");try{if((await lstat(expected)).isSymbolicLink())throw Error("Linked archive file");return expected;}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    if(!discoverRename)return expected;
    const found:string[]=[];
    const visit=async(dir:string)=>{for(const entry of await readdir(dir,{withFileTypes:true})){
      if(entry.isSymbolicLink()||entry.name.startsWith("."))continue;const path=join(dir,entry.name);
      if(entry.isDirectory()){if(!/^(Attachments|control|sessions|sources)$/i.test(entry.name))await visit(path);continue;}
      if(!entry.isFile()||!entry.name.endsWith(".md"))continue;const handle=await open(path,"r");try{const head=Buffer.alloc(5000),{bytesRead}=await handle.read(head,0,head.length,0);if(head.subarray(0,bytesRead).toString("utf8").match(/^hub_id:\s*["']?([^"'\r\n]+)/m)?.[1]?.trim()===id)found.push(path);}finally{await handle.close();}
    }};await visit(this.vault);if(found.length>1)throw Error("Duplicate original conversation identity; preserve and review the vault");return found[0]??expected;
  }
  async read(id:string):Promise<KnowledgeConversation>{return JSON.parse(await readFile(this.file(id),"utf8"));}
  put(record:KnowledgeConversation){
    const task=this.writes.then(async()=>{
      if(!/^conversation-[a-f0-9]{32}$/.test(record.id)||!record.messages.length||!record.messages.every(m=>typeof m.text==="string"&&Number.isSafeInteger(m.at)&&m.at>0))throw Error("Invalid original conversation");
      const path=this.file(record.id),dir=join(this.vault,"Conversations");await mkdir(dir,{recursive:true});
      if((await lstat(dir)).isSymbolicLink())throw Error("Archive must be a real directory");
      let old:KnowledgeConversation|undefined;try{old=await this.read(record.id);}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
      // A partial old snapshot must not erase a continuation already stored.
      const messages=new Map((old?.messages??[]).filter(m=>!record.forgetBefore||m.at>record.forgetBefore).map(m=>[m.id,m]));for(const m of record.messages)if(!messages.has(m.id)||!old||record.updatedAt>=old.updatedAt)messages.set(m.id,m);
      const next={...record,createdAt:old?.createdAt??record.createdAt,updatedAt:Math.max(old?.updatedAt??0,record.updatedAt),messages:[...messages.values()]};
      if(old&&JSON.stringify(old)===JSON.stringify(next))return false;
      const md=await this.projectionPath(record.id,!!old);let existing:string|undefined;try{if((await lstat(md)).isSymbolicLink())throw Error("Linked archive file");existing=await readFile(md,"utf8");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
      if(!old&&existing!==undefined)throw Error("Original source ledger is missing; preserve the existing Markdown before reimporting");
      if(old&&existing!==undefined&&existing.slice(existing.indexOf("\n---\n")+5)!==conversationMarkdown(old).slice(conversationMarkdown(old).indexOf("\n---\n")+5))throw Error("Original conversation was edited externally; preserve that edit and review the archive");
      // Appending a message does not duplicate the full day-long chat. Only
      // genuine source edits/import revisions need exact old-value history.
      if(old){const edits=old.messages.filter(m=>JSON.stringify(messages.get(m.id))!==JSON.stringify(m)),rawChanged=JSON.stringify(old.raw)!==JSON.stringify(record.raw);if(edits.length||rawChanged)await atomicJson(join(this.root,"archive-history",record.id,digest(JSON.stringify(old))+".json"),{id:old.id,at:old.updatedAt,messages:edits,...(rawChanged?{raw:old.raw}:{})});}
      await atomicJson(path,next);
      const links=existing?.match(/^hub_related: .+$/m)?.[0],projection=conversationMarkdown(next);
      const temp=md+"."+randomUUID()+".tmp";await writeFile(temp,links?projection.replace("\n---\n","\n"+links+"\n---\n"):projection,{mode:0o600});await rename(temp,md);
      return true;
    });this.writes=task.catch(()=>{});return task;
  }
  async drain(){await this.writes;}
  projectRelations(id:string,links:string[]){const task=this.writes.then(async()=>{
    const original=await this.read(id),path=await this.projectionPath(id);if((await lstat(path)).isSymbolicLink())throw Error("Linked archive file");const current=await readFile(path,"utf8"),boundary=current.indexOf("\n---\n")+5;
    if(current.slice(boundary)!==conversationMarkdown(original).slice(conversationMarkdown(original).indexOf("\n---\n")+5))throw Error("Original body edited externally; relation projection deferred");
    if(links.some(l=>/[\[\]|\r\n]/.test(l)))throw Error("Invalid Obsidian target");
    const front=current.slice(0,boundary).replace(/^hub_related: .+\n/gm,""),next=front.replace("\n---\n","\nhub_related: "+JSON.stringify(links.map(l=>"[["+l+"]]"))+"\n---\n")+current.slice(boundary);if(next===current)return;
    const temp=path+"."+randomUUID()+".tmp";await writeFile(temp,next,{mode:0o600});if(await readFile(path,"utf8")!==current)throw Error("Conversation metadata changed during projection");await rename(temp,path);
  });this.writes=task.catch(()=>{});return task;}
}
export function conversationMarkdown(c:KnowledgeConversation){
  const front=`---\nhub_id: ${JSON.stringify(c.id)}\ntitle: ${JSON.stringify(c.title)}\nhub_kind: conversation\nchannel: ${JSON.stringify(c.channel)}\nsource_updated_at: ${c.updatedAt}\n---\n`;
  return front+c.messages.map(m=>`## ${m.role} · ${new Date(m.at).toISOString()}${m.branch?" · branch "+m.branch:""}${m.interrupted?" · interrupted":""}\n\n${m.text}${m.assets?.length?"\n\n"+m.assets.map(a=>`[${a.name.replace(/[\[\]]/g,"")}](${a.path.startsWith("Attachments/")?"../":""}${a.path})`).join("\n"):""}`).join("\n\n")+"\n";
}
export function nativeConversation(header:any,events:readonly any[],channel:string,inherited=0,cutoff=0):KnowledgeConversation|undefined {
  if(isKnowledgeEvaluation(header.id)||header.parentSession&&isKnowledgeEvaluation(header.parentSession))return;
  const messages:ConversationMessage[]=[];
  for(const [i,e] of events.slice(inherited).entries()){
    if(!Number.isSafeInteger(e.time)||e.time<=cutoff)continue;
    let role:ConversationMessage["role"]|undefined,text="",interrupted=false;
    if(e.type==="user/message"&&(e.data?.source?.kind==="user"||e.data?.source?.plugin==="hub-automation")){role=e.data?.source?.kind!=="user"||header.origin==="subagent"?"task":"user";text=(e.data.content??[]).flatMap((b:any)=>b.type==="text"?[String(b.text??"")]:b.type==="image"?["Attached image: "+(b.attachment?.name??"Image")]:[]).join("\n");if(role==="task")text=text.split("\nYour parent agent id is ")[0]!;}
    if(e.type==="assistant/message"){role="assistant";text=(e.data?.message?.content??[]).filter((b:any)=>b.type==="text").map((b:any)=>b.text??"").join("\n");interrupted=e.data?.interrupted===true;}
    if(e.type==="turn/end"){const f=operationFailure(e.data?.reason);if(f){role="status";text=f.kind+" · "+f.code+" · "+f.message;}}
    if(role&&text.trim())messages.push({id:String(e.seq??i),role,text,at:e.time,...(interrupted?{interrupted:true}:{})});
  }
  if(!messages.some(m=>m.role==="user"||m.role==="task"))return;
  const title=events.filter(e=>e.type==="session/title").at(-1)?.data?.title??header.title??messages[0]!.text.slice(0,100);
  return {id:"conversation-"+digest("hub:"+header.id).slice(0,32),externalId:header.id,sessionId:header.id,parentSession:header.parentSession,...(cutoff?{forgetBefore:cutoff}:{}),title:String(title).slice(0,200),channel,messages,createdAt:messages[0]!.at,updatedAt:Math.max(...messages.map(m=>m.at))};
}
/** Chunks are processing units only; one conversation remains one graph node. */
export function conversationSources(c:KnowledgeConversation):KnowledgeSource[]{
  const sources:KnowledgeSource[]=[];
  for(const m of c.messages.filter(m=>m.role!=="status"))for(let at=0,part=0;at<m.text.length;at+=14000,part++)sources.push({id:`archive-${digest(c.id+":"+m.id+":"+part).slice(0,40)}`,conversationId:c.id,sessionId:c.sessionId,channel:c.channel,completedAt:m.at,authorRole:m.role==="user"?"user":"assistant",evidenceVersion:2,content:`Original conversation: ${c.title}\nRole: ${m.role}\nMessage ID: ${m.id}\n${m.text.slice(at,at+14000)}`,assets:m.assets});
  return sources;
}
