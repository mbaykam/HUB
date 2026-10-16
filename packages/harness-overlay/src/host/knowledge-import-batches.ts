import {mkdir,readFile,writeFile,readdir,lstat} from "node:fs/promises";
import {join,basename} from "node:path";
import {createHash,randomUUID} from "node:crypto";
import type {KnowledgeConversation,KnowledgeSource,KnowledgeAsset} from "../knowledge-contract.ts";
import {atomicJson,digest,type KnowledgeStore} from "./knowledge-store.ts";
import {archiveTexts,archiveMedia,previewKnowledgeImport} from "./knowledge-import.ts";
import {conversationSources} from "./knowledge-archive.ts";

interface ImportOperation {id:string;at:number;state:"prepared"|"committed"|"conflict";recordIds:string[];queued?:boolean;error?:string}
interface ImportManifest {
  version:1;parserVersion:1;id:string;filename:string;sha256:string;bytes:number;at:number;
  state:"previewed"|"archived"|"failed";recordsHash?:string;conversations:number;messages:number;
  warnings:string[];error?:string;operations:ImportOperation[];
}
const validId=(id:unknown):id is string=>typeof id==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
const bytesHash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
/** Comparison excludes an export envelope and resolved local file paths, while
 * retaining every message, branch, date, role and explicit attachment pointer. */
export function importedContentHash(record:KnowledgeConversation){return digest(JSON.stringify({id:record.id,externalId:record.externalId,title:record.title,channel:record.channel,messages:record.messages.map(m=>({id:m.id,role:m.role,text:m.text,at:m.at,parent:m.parent??null,branch:m.branch??null,interrupted:m.interrupted??false,refs:[...(m.importRefs??[])].sort(),media:[...(m.importMediaHashes??[])].sort()}))}));}
/** Bind only explicit pointers on THIS message. Ambiguous basenames/IDs are
 * retained in the exact ZIP, never guessed onto a conversation or all messages. */
export function importedMediaMatches(refs:readonly string[],names:readonly string[]){
  const normalized=names.map(name=>name.replace(/\\/g,"/").normalize("NFC")),indices=new Set<number>(),unresolved:string[]=[];
  for(const raw of refs){
    const ref=raw.replace(/^(?:sediment|file-service):\/\//,"").trim().replace(/\\/g,"/").normalize("NFC");
    let matches=normalized.flatMap((name,i)=>name===ref?[i]:[]);
    if(!matches.length){const file=basename(ref);matches=normalized.flatMap((name,i)=>basename(name)===file?[i]:[]);}
    if(!matches.length&&/^file[-_][a-zA-Z0-9-]+$/.test(ref))matches=normalized.flatMap((name,i)=>{const file=basename(name);return file.startsWith(ref)&&/^[._-]/.test(file.slice(ref.length))?[i]:[];});
    if(matches.length===1)indices.add(matches[0]!);else unresolved.push(raw);
  }
  return {indices:[...indices],unresolved};
}

/** Persistent, private quarantine. Upload bytes and parser output stay outside
 * the vault and all retrieval until the operator admits a selected pilot. */
export class KnowledgeImportBatches {
  constructor(readonly store:KnowledgeStore,readonly enqueue:(source:KnowledgeSource)=>Promise<boolean>,readonly prices?:()=>{inputPrice:number;outputPrice:number}){}
  private directory(id:string){if(!validId(id))throw Error("Invalid import batch");return join(this.store.root,"import-batches",id);}
  private async manifest(id:string):Promise<ImportManifest>{
    const directory=this.directory(id);if((await lstat(directory)).isSymbolicLink())throw Error("Linked import batch");
    const value=JSON.parse(await readFile(join(directory,"manifest.json"),"utf8"));
    if(value?.version!==1||value.parserVersion!==1||value.id!==id||!/^[a-f0-9]{64}$/.test(value.sha256)||!["previewed","archived","failed"].includes(value.state)||!Array.isArray(value.operations)||!Array.isArray(value.warnings))throw Error("Invalid import manifest; preserve the original upload");return value;
  }
  private save(manifest:ImportManifest){return atomicJson(join(this.directory(manifest.id),"manifest.json"),manifest);}
  private async records(manifest:ImportManifest):Promise<KnowledgeConversation[]>{
    if(!manifest.recordsHash)return [];
    const raw=await readFile(join(this.directory(manifest.id),"records.json"),"utf8");if(digest(raw)!==manifest.recordsHash)throw Error("Import preview changed; preserve the upload and review the batch");
    const records=JSON.parse(raw);if(!Array.isArray(records)||records.some(r=>!/^conversation-[a-f0-9]{32}$/.test(r?.id)||!Array.isArray(r.messages))||new Set(records.map(r=>r.id)).size!==records.length)throw Error("Invalid parsed import records");return records;
  }
  private async upload(manifest:ImportManifest){const bytes=await readFile(join(this.directory(manifest.id),"upload.bin"));if(bytes.length!==manifest.bytes||bytesHash(bytes)!==manifest.sha256)throw Error("Original upload integrity check failed");return bytes;}
  stage(bytes:Buffer,filename:string){return this.store.mutations.run(async()=>{
    if(!bytes.length||bytes.length>80000000||! /\.(zip|json|html)$/i.test(filename))throw Error("Choose a JSON, HTML or ZIP history under the current 80 MB upload limit");
    const id=randomUUID(),directory=this.directory(id),manifest:ImportManifest={version:1,parserVersion:1,id,filename:basename(filename.replace(/\\/g,"/")).slice(0,200),sha256:bytesHash(bytes),bytes:bytes.length,at:Date.now(),state:"failed",conversations:0,messages:0,warnings:[],operations:[]};
    await mkdir(join(this.store.root,"import-batches"),{recursive:true});if((await lstat(join(this.store.root,"import-batches"))).isSymbolicLink())throw Error("Import quarantine must be a real directory");
    await mkdir(directory);await writeFile(join(directory,"upload.bin"),bytes,{flag:"wx",mode:0o600});await this.save(manifest);
    try{
      const files=/\.zip$/i.test(filename)?archiveTexts(bytes):[{name:filename,body:bytes.toString("utf8")}],preview=previewKnowledgeImport(files),media=/\.zip$/i.test(filename)?archiveMedia(bytes):[];
      // Validate media containers now; no original asset enters the live vault.
      for(const record of preview.records)for(const message of record.messages){const match=importedMediaMatches(message.importRefs??[],media.map(m=>m.name));if(match.indices.length)message.importMediaHashes=match.indices.map(i=>bytesHash(media[i]!.data));}
      const raw=JSON.stringify(preview.records);
      await writeFile(join(directory,"records.json"),raw,{flag:"wx",mode:0o600});manifest.recordsHash=digest(raw);manifest.conversations=preview.records.length;manifest.messages=preview.records.reduce((n,r)=>n+r.messages.length,0);manifest.warnings=preview.warnings;manifest.state="previewed";
    }catch(e){manifest.error=String((e as Error).message).slice(0,500);}
    await this.save(manifest);return this.preview(id);
  });}
  async list(offset=0){
    if(!Number.isSafeInteger(offset)||offset<0)throw Error("Invalid import page");
    const directory=join(this.store.root,"import-batches"),files=await readdir(directory,{withFileTypes:true}).catch((e:any)=>{if(e.code!=="ENOENT")throw e;return [];});
    const records=await Promise.all(files.filter(f=>f.isDirectory()&&!f.isSymbolicLink()&&validId(f.name)).map(f=>this.manifest(f.name)));
    records.sort((a,b)=>b.at-a.at);return {batches:records.slice(offset,offset+20).map(({recordsHash,operations,...m})=>({...m,unfinished:operations.filter(o=>o.state==="prepared"||o.state==="conflict").length})),total:records.length,nextOffset:offset+20<records.length?offset+20:null};
  }
  private async status(record:KnowledgeConversation,batchId:string,cutoff:number){
    const entry=(await this.store.admission.read()).records[record.id];let old:KnowledgeConversation|undefined;
    try{old=await this.store.archive.read(record.id);}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    if(old&&importedContentHash(old)!==importedContentHash(record))return "conflict" as const;
    if(entry&&entry.batchId!==batchId&&entry.state!=="admitted")return "conflict" as const;
    if(entry?.batchId===batchId&&entry.state!=="admitted")return entry.state==="prepared"?"interrupted" as const:"withdrawn" as const;
    if(old)return entry?.batchId===batchId?"admitted" as const:"duplicate" as const;
    if(entry&&entry.batchId!==batchId)return "conflict" as const;
    if(record.messages.some(m=>m.at<=cutoff))return "held-by-forget-policy" as const;
    return "new" as const;
  }
  async preview(id:string,offset=0){
    if(!Number.isSafeInteger(offset)||offset<0)throw Error("Invalid import record page");const manifest=await this.manifest(id),records=await this.records(manifest),admission=await this.store.admission.read(),cutoff=await this.store.cutoff();
    const page=await Promise.all(records.slice(offset,offset+50).map(async r=>({id:r.id,title:r.title,channel:r.channel,createdAt:r.createdAt,updatedAt:r.updatedAt,messages:r.messages.length,estimatedCalls:r.messages.reduce((n,m)=>n+Math.ceil(m.text.length/14000),0),inputBytes:r.messages.reduce((n,m)=>n+Buffer.byteLength(m.text),0),status:await this.status(r,id,cutoff)})));
    const owned=Object.values(admission.records).filter(e=>e.batchId===id&&e.state==="admitted").length;
    return {...manifest,operations:manifest.operations.map(({recordIds,...o})=>({...o,records:recordIds.length})),admitted:owned,previewHash:digest(JSON.stringify([manifest.sha256,manifest.recordsHash,admission.revision,cutoff])),records:page,offset,nextOffset:offset+50<records.length?offset+50:null,...(this.prices?{prices:{inputPrice:this.prices().inputPrice,outputPrice:this.prices().outputPrice}}:{}),recommendation:"Keep the complete archive private; admit 20–50 selected conversations as a pilot. Staging and archiving make no model calls."};
  }
  async record(id:string,recordId:string,offset=0){
    if(!Number.isSafeInteger(offset)||offset<0)throw Error("Invalid message page");const manifest=await this.manifest(id),record=(await this.records(manifest)).find(r=>r.id===recordId);if(!record)throw Error("Import record missing");return {id:record.id,title:record.title,messages:record.messages.slice(offset,offset+8).map(m=>({...m,text:m.text.slice(0,2000),originalChars:m.text.length,truncated:m.text.length>2000})),total:record.messages.length,nextOffset:offset+8<record.messages.length?offset+8:null,source:"private-quarantine",searchable:false};
  }
  archive(id:string){return this.store.exclusive(async()=>{const manifest=await this.manifest(id);await this.upload(manifest);if(manifest.state==="failed")throw Error("This upload could not be parsed; the original bytes are retained for review");manifest.state="archived";await this.save(manifest);return this.preview(id);});}
  async admit(id:string,ids:string[],previewHash:string){
    if(!Array.isArray(ids)||!ids.length||ids.length>50||ids.some(x=>typeof x!=="string")||new Set(ids).size!==ids.length)throw Error("Select between 1 and 50 conversations for this admission");
    await this.finishWithdrawals(id);
    const result=await this.store.exclusive(async()=>{
      const preview=await this.preview(id);if(previewHash!==preview.previewHash)throw Error("Admission or forget policy changed; refresh this preview before admitting");
      const manifest=await this.manifest(id);if(manifest.state==="failed")throw Error("Resolve the import parse error first");
      const all=await this.records(manifest),selected=ids.map(recordId=>{const r=all.find(r=>r.id===recordId);if(!r)throw Error("Select original records from this batch");return r;}),cutoff=await this.store.cutoff(),ledger=await this.store.admission.read(),notes=await this.store.scan(undefined,true);
      let duplicates=0;const chosen:KnowledgeConversation[]=[];
      for(const record of selected){const status=await this.status(record,id,cutoff);if(status==="duplicate"||status==="admitted"){duplicates++;continue;}if(status==="conflict")throw Error("An original with this identity has different content or ownership; preserve both versions and review the conflict");if(status==="held-by-forget-policy"||record.messages.some(m=>m.at<=cutoff))throw Error("This history contains messages excluded by the current forget policy; the private archive remains available for review");
        if(notes.some(n=>n.id===record.id)&&!ledger.records[record.id])throw Error("An existing vault source owns this identity; preserve it and review the conflict");chosen.push(structuredClone(record));}
      if(!chosen.length)return {admitted:0,duplicates,queued:0,warnings:[] as string[]};
      const receipt:ImportOperation={id:randomUUID(),at:Date.now(),state:"prepared",recordIds:chosen.map(r=>r.id)};
      manifest.operations.push(receipt);await this.save(manifest);
      for(const record of chosen)ledger.records[record.id]={batchId:id,receiptId:receipt.id,contentHash:importedContentHash(record),state:"prepared",at:receipt.at};ledger.revision++;await this.store.admission.save(ledger);
      const warnings:string[]=[];
      try{
        const bytes=await this.upload(manifest),media=/\.zip$/i.test(manifest.filename)?archiveMedia(bytes):[],saved=new Map<number,KnowledgeAsset>();
        for(const record of chosen){
          for(const message of record.messages){const match=importedMediaMatches(message.importRefs??[],media.map(m=>m.name));if(match.unresolved.length)warnings.push(`${record.title}: ${match.unresolved.length} missing or ambiguous attachment references retained in the upload`);const assets:KnowledgeAsset[]=[];
            for(const index of match.indices){let asset=saved.get(index);if(!asset){asset=await this.store.assets.save(media[index]!.data,media[index]!.name);saved.set(index,asset);}if(!assets.some(a=>a.id===asset!.id))assets.push(asset);}if(assets.length)message.assets=assets;
          }
          await this.store.archive.put(record);
          if(importedContentHash(await this.store.archive.read(record.id))!==importedContentHash(record))throw Error("Original source changed during admission; preserve and review it");
        }
        for(const record of chosen)ledger.records[record.id]!.state="admitted";ledger.revision++;await this.store.admission.save(ledger);
        receipt.state="committed";manifest.state="archived";manifest.warnings=[...new Set([...manifest.warnings,...warnings])].slice(0,200);await this.save(manifest);
        return {admitted:chosen.length,duplicates,queued:0,warnings};
      }catch(e){receipt.state="conflict";receipt.error=String((e as Error).message).slice(0,500);await this.save(manifest);throw e;}
    });
    result.queued=await this.resumePendingQueue(id);return result;
  }
  resumePendingQueue(onlyId?:string){return this.store.exclusive(async()=>{
    const ids=onlyId?[onlyId]:(await readdir(join(this.store.root,"import-batches"),{withFileTypes:true}).catch((e:any)=>{if(e.code!=="ENOENT")throw e;return [];})).filter(f=>f.isDirectory()&&!f.isSymbolicLink()&&validId(f.name)).map(f=>f.name);let queued=0;
    for(const id of ids){const manifest=await this.manifest(id),ledger=await this.store.admission.read();
      // The ledger commits only after every original projection is complete;
      // a power loss before the manifest save must not lose authorized jobs.
      for(const operation of manifest.operations.filter(o=>!o.queued)){
        if(!operation.recordIds.every(recordId=>{const e=ledger.records[recordId];return e?.batchId===id&&e.receiptId===operation.id&&e.state==="admitted";}))continue;
        operation.state="committed";
        for(const recordId of operation.recordIds)for(const source of conversationSources(await this.store.archive.read(recordId)))if(await this.enqueue({...source,id:source.id+"-admission-"+operation.id,importBatchId:id,importAdmissionId:operation.id}))queued++;
        operation.queued=true;await this.save(manifest);
      }
    }return queued;
  });}
  async finishWithdrawals(id:string){const ids=Object.entries((await this.store.admission.read()).records).filter(([,entry])=>entry.batchId===id&&entry.state==="withdrawn").map(([recordId])=>recordId);return ids.length?this.store.organization.withdrawImported(ids):{domainReviewRequired:[] as string[]};}
  async recover(){for(const id of new Set(Object.values((await this.store.admission.read()).records).filter(e=>e.state==="withdrawn").map(e=>e.batchId)))await this.finishWithdrawals(id);return this.resumePendingQueue();}
  async withdraw(id:string){
    const records=await this.store.exclusive(async()=>{
      await this.manifest(id);const ledger=await this.store.admission.read(),ids=Object.entries(ledger.records).filter(([,e])=>e.batchId===id&&e.state!=="withdrawn").map(([recordId])=>recordId),state=await this.store.organization.state();
      if(state.suggestions.some(s=>ids.includes(s.conversationId??"")&&s.status==="applied"))throw Error("Undo this batch's applied profile changes before withdrawing its sources");
      for(const recordId of ids){ledger.records[recordId]!.state="withdrawn";ledger.records[recordId]!.at=Date.now();}if(ids.length){ledger.revision++;await this.store.admission.save(ledger);}return ids;
    });
    const cleanup=await this.finishWithdrawals(id);return {withdrawn:records.length,originals:"retained",sharedAssets:"retained",...cleanup};
  }
}
