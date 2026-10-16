import { inflateRawSync } from "node:zlib";
import { digest } from "./knowledge-store.ts";
import type { KnowledgeSource,KnowledgeConversation,ConversationMessage } from "../knowledge-contract.ts";
import {conversationSources} from "./knowledge-archive.ts";
export interface KnowledgeImportPreview { sources: KnowledgeSource[]; records:KnowledgeConversation[]; conversations: number; messages: number; skipped: number; warnings: string[]; estimatedInputTokens: number }
const text=(value:unknown):string=>typeof value==="string"?value:"";
function assetPointers(value:any):string[]{return Array.isArray(value?.parts)?value.parts.filter((p:any)=>p&&typeof p==="object").flatMap((p:any)=>[p.asset_pointer,p.image_asset_pointer,p.file_id,p.file_name].filter((x:any)=>typeof x==="string")):[];}
function messageAssetPointers(message:any):string[]{return [...new Set([...assetPointers(message?.content),...(Array.isArray(message?.metadata?.attachments)?message.metadata.attachments.flatMap((a:any)=>[a?.id,a?.file_id,a?.name,a?.file_name].filter((x:any)=>typeof x==="string")):[])])];}
function content(value:any) { return Array.isArray(value?.parts) ? value.parts.flatMap((x:any)=>typeof x==="string"?[x]:x&&typeof x==="object"&&(x.asset_pointer||x.image_asset_pointer||x.file_id)?["Attached media: "+(x.file_name??"image or file")]:[]).join("\n") : text(value?.text); }
/** Return bounded archive bytes, never extract archive paths into the host filesystem. */
export function archiveMedia(buffer:Buffer):{name:string;data:Buffer}[]{
  const end=buffer.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));if(buffer.length>80000000||end<0||end+22>buffer.length)throw Error("Invalid media archive");
  const count=buffer.readUInt16LE(end+10);let cursor=buffer.readUInt32LE(end+16),total=0;const result:{name:string;data:Buffer}[]=[];
  if(count>20000)throw Error("Archive has too many entries");
  for(let i=0;i<count;i++){
    if(cursor+46>buffer.length||buffer.readUInt32LE(cursor)!==0x02014b50)throw Error("Invalid archive directory");
    const flags=buffer.readUInt16LE(cursor+8),method=buffer.readUInt16LE(cursor+10),compressed=buffer.readUInt32LE(cursor+20),size=buffer.readUInt32LE(cursor+24),nameLength=buffer.readUInt16LE(cursor+28),extra=buffer.readUInt16LE(cursor+30),comment=buffer.readUInt16LE(cursor+32),offset=buffer.readUInt32LE(cursor+42),name=buffer.subarray(cursor+46,cursor+46+nameLength).toString("utf8");cursor+=46+nameLength+extra+comment;
    if(!/\.(png|jpe?g|webp|gif|pdf|docx|xlsx|csv|txt|mp3|wav|ogg|mp4)$/i.test(name))continue;
    if(flags&1||![0,8].includes(method)||size>25000000||(total+=size)>80000000||result.length>=1000)throw Error("Archive media exceeds limits");
    if(offset+30>buffer.length||buffer.readUInt32LE(offset)!==0x04034b50)throw Error("Invalid media member");
    const start=offset+30+buffer.readUInt16LE(offset+26)+buffer.readUInt16LE(offset+28);if(start+compressed>buffer.length)throw Error("Truncated media member");
    const raw=buffer.subarray(start,start+compressed),data=method===8?inflateRawSync(raw,{maxOutputLength:25000000}):Buffer.from(raw);if(data.length!==size)throw Error("Invalid media size");result.push({name,data});
  }return result;
}
const time=(value:unknown)=>typeof value==="number" && Number.isFinite(value) && value>0 ? value<1e12?Math.round(value*1000):Math.round(value) : typeof value==="string" ? Date.parse(value) : NaN;
const htmlText=(value:string)=>value.replace(/<script\b[\s\S]*?<\/script>/gi,"").replace(/<style\b[\s\S]*?<\/style>/gi,"").replace(/<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,(_m,url,label)=>`${label} (${url})`).replace(/<br\s*\/?>|<\/p>|<\/div>/gi,"\n").replace(/<[^>]+>/g,"").replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g,e=>({"&amp;":"&","&lt;":"<","&gt;":">","&quot;":'"',"&#39;":"'","&nbsp;":" "}[e]??e)).trim();
/** Read only text history members; never extract or execute archive entries. */
export function archiveTexts(buffer:Buffer): { name:string; body:string }[] {
  if(buffer.length>80_000_000)throw new Error("Archive exceeds 80 MB; split the export");
  const end=buffer.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));
  if(end<0 || end+22>buffer.length)throw new Error("Invalid ZIP archive");
  const count=buffer.readUInt16LE(end+10),offset=buffer.readUInt32LE(end+16);let cursor=offset,total=0;
  if(count>20000)throw new Error("Archive has too many entries");
  const results:{name:string;body:string}[]=[];
  for(let n=0;n<count;n++) {
    if(cursor+46>buffer.length || buffer.readUInt32LE(cursor)!==0x02014b50)throw new Error("Invalid ZIP directory");
    const method=buffer.readUInt16LE(cursor+10),flags=buffer.readUInt16LE(cursor+8),compressed=buffer.readUInt32LE(cursor+20),size=buffer.readUInt32LE(cursor+24),nameSize=buffer.readUInt16LE(cursor+28),extra=buffer.readUInt16LE(cursor+30),comment=buffer.readUInt16LE(cursor+32),local=buffer.readUInt32LE(cursor+42);
    const name=buffer.subarray(cursor+46,cursor+46+nameSize).toString("utf8");cursor+=46+nameSize+extra+comment;
    if(!/(?:conversations\.json|MyActivity\.json|MyActivity\.html|Gemini[^/]*\.(?:json|html))$/i.test(name))continue;
    if(flags&1 || ![0,8].includes(method) || size>40_000_000 || (total+=size)>80_000_000)throw new Error("Unsupported or oversized history member");
    if(local+30>buffer.length || buffer.readUInt32LE(local)!==0x04034b50)throw new Error("Invalid ZIP member");
    const start=local+30+buffer.readUInt16LE(local+26)+buffer.readUInt16LE(local+28);
    if(start+compressed>buffer.length)throw new Error("Truncated ZIP member");
    const data=method===0?buffer.subarray(start,start+compressed):inflateRawSync(buffer.subarray(start,start+compressed),{maxOutputLength:Math.max(size,1)});
    if(data.length!==size)throw new Error("ZIP size mismatch");
    results.push({name,body:data.toString("utf8")});
  }
  if(!results.length)throw new Error("No supported ChatGPT or Gemini conversation history in archive");return results;
}
export function previewKnowledgeImport(files:{name:string;body:string}[]):KnowledgeImportPreview {
  const sources:KnowledgeSource[]=[];let conversations=0,messages=0,skipped=0;const warnings=new Set<string>();
  const add=(channel:string,id:string,date:number,body:string,authorRole:"user"|"assistant"|"mixed"="mixed")=>{
    if(!body.trim()||!Number.isFinite(date)||date<=0){skipped++;warnings.add("Some entries lack a trustworthy date or readable text; they were skipped.");return;}
    // Bound each model call while preserving the chronological source identity.
    for(let position=0,part=0;position<body.length;part++) {
      let end=Math.min(body.length,position+16000);if(end<body.length){const boundary=body.lastIndexOf("\n",end);if(boundary>position+8000)end=boundary;}
      sources.push({id:`${channel}-${digest(id).slice(0,32)}-${part}`,channel,completedAt:date,content:body.slice(position,end),authorRole});position=end;
    }
  };
  for(const file of files) {
    if(/\.html$/i.test(file.name)) {
      // Google Takeout activity HTML may contain prompt-only records. We do
      // not manufacture answers or pretend it is a complete conversation.
      const blocks=file.body.split(/(?=<div[^>]+class="[^\"]*outer-cell)/i).slice(1);
      for(const block of blocks) {
        if(!/Gemini|Bard/i.test(block)){skipped++;continue;}
        const cell=block.match(/<div[^>]+class="[^"]*content-cell[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1];
        if(!cell){skipped++;continue;}
        const lines=htmlText(cell).split("\n").map(s=>s.trim()).filter(Boolean);
        const date=block.match(/<time[^>]+datetime="([^"]+)"/i)?.[1] ?? lines.find(line=>/\bGMT[+-]\d{2}:?\d{2}\b|\b\d{4}-\d{2}-\d{2}T[\d:.+Z-]+/.test(line));
        const prompt=lines.filter(line=>line!==date).join("\n").replace(/^Gemini Apps\s*/i,"").replace(/^(?:Prompted|Asked)\s+/i,"").trim();
        add("gemini",digest(block),time(date),`## User (Takeout activity; response may be absent)\n\n${prompt}`,"user");conversations++;messages++;
      }
      warnings.add("Gemini HTML is activity data and may omit replies; prefer Takeout JSON when available.");continue;
    }
    let data:any;try{data=JSON.parse(file.body);}catch{throw new Error("Invalid history JSON");}
    if(!Array.isArray(data))throw new Error("History JSON must contain a conversation/activity list");
    for(const entry of data) {
      if(entry?.mapping && typeof entry.mapping==="object") {
        conversations++;
        // Export regenerations are branches. Follow the selected leaf; include
        // other branches separately without duplicating shared ancestors.
        const nodes=entry.mapping as Record<string,any>,seen=new Set<string>();
        const leaves=[entry.current_node,...Object.keys(nodes).filter(k=>!nodes[k]?.children?.length)].filter((x):x is string=>typeof x==="string");
        for(const leaf of [...new Set(leaves)]) {
          const chain:string[]=[];let cursor:string|undefined=leaf;const cycle=new Set<string>();
          while(cursor && nodes[cursor] && !cycle.has(cursor)) {cycle.add(cursor);chain.unshift(cursor);cursor=nodes[cursor].parent;}
          for(const id of chain) {
            if(seen.has(id))continue;seen.add(id);const m=nodes[id]?.message,role=m?.author?.role;
            if(!["user","assistant"].includes(role)){continue;}
            const body=content(m.content);if(!body){skipped++;continue;}messages++;
            const previous=chain.slice(Math.max(0,chain.indexOf(id)-5),chain.indexOf(id)).map(key=>nodes[key]?.message).filter(x=>["user","assistant"].includes(x?.author?.role)).map(x=>({role:x.author.role,time:x.create_time,text:content(x.content).slice(0,2000)}));
            const before=sources.length;add("chatgpt",`${entry.id??entry.conversation_id}:${m.id??id}`,time(m.create_time??entry.create_time),`Conversation: ${text(entry.title)}\nBranch: ${leaf}\nEarlier context (already historical, not new facts): ${JSON.stringify(previous)}\n\nCURRENT SOURCE MESSAGE:\n## ${role==="user"?"User":"Assistant (proposal, not a user fact)"}\n\n${body}`,role);for(const source of sources.slice(before))source.importRefs=assetPointers(m.content);
          }
        }
      } else if(entry?.title && (entry.time||entry.timestamp) && (!entry.products || entry.products.some((p:unknown)=>/Gemini|Bard/i.test(text(p))))) {
        conversations++;messages++;
        const prompt=text(entry.title).replace(/^(?:Prompted|Asked|Sordunuz)\s+/i,"");
        const answer=typeof entry.response==="string"?entry.response:typeof entry.answer==="string"?entry.answer:"";
        const id=text(entry.id)||digest(JSON.stringify(entry));add("gemini",`${id}:user`,time(entry.time??entry.timestamp),`## User\n\n${prompt}`,"user");
        if(answer)add("gemini",`${id}:assistant`,time(entry.time??entry.timestamp),`Earlier user prompt (context): ${prompt.slice(0,2000)}\n\n## Assistant (proposal, not a user fact)\n\n${htmlText(answer)}`,"assistant");
        if(!answer)warnings.add("Some Gemini activity entries contain only the prompt; missing replies were not fabricated.");
      } else {skipped++;}
    }
  }
  const unique=[...new Map(sources.map(s=>[s.id,s])).values()].sort((a,b)=>a.completedAt-b.completedAt);
  const records=originalImportRecords(files);
  // Preserve the compatibility preview episodes; the live queue uses bounded
  // typed chunks attached to the single canonical conversation identity.
  return {sources:unique,records,conversations,messages,skipped,warnings:[...warnings],estimatedInputTokens:unique.reduce((n,s)=>n+Buffer.byteLength(s.content),0)};
}
export function originalImportRecords(files:{name:string;body:string}[]):KnowledgeConversation[]{
  const records:KnowledgeConversation[]=[];
  const add=(channel:string,id:string,title:string,messages:ConversationMessage[],raw:unknown)=>{const valid=messages.filter(m=>m.text.trim()&&Number.isSafeInteger(m.at)&&m.at>0);if(!valid.length)return;records.push({id:"conversation-"+digest(channel+":"+id).slice(0,32),externalId:id,title:title.slice(0,200),channel,messages:valid,createdAt:Math.min(...valid.map(m=>m.at)),updatedAt:Math.max(...valid.map(m=>m.at)),raw});};
  for(const file of files){
    if(/\.html$/i.test(file.name)){
      for(const block of file.body.split(/(?=<div[^>]+class="[^\"]*outer-cell)/i).slice(1)){
        if(!/Gemini|Bard/i.test(block))continue;const cell=block.match(/<div[^>]+class="[^"]*content-cell[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1];if(!cell)continue;
        const lines=htmlText(cell).split("\n").map(s=>s.trim()).filter(Boolean),date=block.match(/<time[^>]+datetime="([^"]+)"/i)?.[1]??lines.find(l=>/\bGMT[+-]\d{2}:?\d{2}\b|\b\d{4}-\d{2}-\d{2}T[\d:.+Z-]+/.test(l));
        const prompt=lines.filter(l=>l!==date).join("\n").replace(/^Gemini Apps\s*/i,"").replace(/^(?:Prompted|Asked)\s+/i,"").trim();add("gemini",digest(block),prompt,[{id:"user",role:"user",text:prompt,at:time(date)}],block);
      }continue;
    }
    const data=JSON.parse(file.body);for(const entry of data){
      if(entry?.mapping){const messages:ConversationMessage[]=[];for(const [key,node]of Object.entries(entry.mapping) as [string,any][]){const m=node.message,role=m?.author?.role;if(!["user","assistant"].includes(role))continue;const refs=messageAssetPointers(m);messages.push({id:String(m.id??key),role,text:content(m.content),at:time(m.create_time??entry.create_time),parent:node.parent??undefined,branch:key,...(refs.length?{importRefs:refs}:{})});}
        const id=String(entry.id??entry.conversation_id??digest(JSON.stringify(entry)));add("chatgpt",id,text(entry.title)||"ChatGPT conversation",messages,entry);
      }else if(entry?.title&&(entry.time||entry.timestamp)&&(!entry.products||entry.products.some((p:unknown)=>/Gemini|Bard/i.test(text(p))))){const prompt=text(entry.title).replace(/^(?:Prompted|Asked|Sordunuz)\s+/i,""),answer=typeof entry.response==="string"?entry.response:typeof entry.answer==="string"?entry.answer:"",at=time(entry.time??entry.timestamp),id=text(entry.id)||digest(JSON.stringify(entry));
        add("gemini",id,prompt,[{id:"user",role:"user",text:prompt,at},...(answer?[{id:"assistant",role:"assistant" as const,text:htmlText(answer),at}]:[])],entry);
      }
    }
  }const unique=new Map<string,KnowledgeConversation>();for(const record of records){const old=unique.get(record.id);if(old&&JSON.stringify({...old,raw:undefined})!==JSON.stringify({...record,raw:undefined}))throw Error("This archive contains conflicting versions of the same conversation; exact upload retained for review");unique.set(record.id,record);}return [...unique.values()];
}
export {conversationSources as importedConversationSources};
