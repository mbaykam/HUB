import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {atomicJson} from "./knowledge-store.ts";
import type {KnowledgeSource} from "../knowledge-contract.ts";

export interface KnowledgeAdmissionEntry {
  batchId:string;
  receiptId:string;
  contentHash:string;
  state:"prepared"|"admitted"|"withdrawn";
  at:number;
}
export interface KnowledgeAdmissionState {version:1;revision:number;records:Record<string,KnowledgeAdmissionEntry>}
export function knowledgeSourceAdmitted(state:KnowledgeAdmissionState,source:Pick<KnowledgeSource,"conversationId"|"importBatchId"|"importAdmissionId">){
  if(!source.conversationId)return !source.importBatchId&&!source.importAdmissionId;
  const entry=state.records[source.conversationId];if(!entry)return !source.importBatchId&&!source.importAdmissionId;
  return entry.state==="admitted"&&(!source.importBatchId||entry.batchId===source.importBatchId)&&(!source.importAdmissionId||entry.receiptId===source.importAdmissionId);
}
const uuid=/^[0-9a-f-]{36}$/;
/** Missing entries are existing, admitted user data. Only explicit import
 * transactions opt into this ledger; staging never creates vault sources. */
export class KnowledgeAdmission {
  constructor(readonly root:string){}
  async read():Promise<KnowledgeAdmissionState>{
    try{
      const value=JSON.parse(await readFile(join(this.root,"admission.json"),"utf8"));
      if(value?.version!==1||!Number.isSafeInteger(value.revision)||value.revision<0||!value.records||Array.isArray(value.records))throw Error("Invalid Knowledge admission ledger; preserve and review it");
      for(const [id,entry] of Object.entries(value.records) as [string,KnowledgeAdmissionEntry][])
        if(!/^conversation-[a-f0-9]{32}$/.test(id)||!uuid.test(entry?.batchId)||!uuid.test(entry?.receiptId)||!/^[a-f0-9]{64}$/.test(entry?.contentHash)||!["prepared","admitted","withdrawn"].includes(entry?.state)||!Number.isSafeInteger(entry?.at))throw Error("Invalid Knowledge admission receipt");
      return value;
    }catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;return {version:1,revision:0,records:{}};}
  }
  save(state:KnowledgeAdmissionState){return atomicJson(join(this.root,"admission.json"),state);}
  async blocked(){return new Set(Object.entries((await this.read()).records).filter(([,e])=>e.state!=="admitted").map(([id])=>id));}
  async allows(source:Pick<KnowledgeSource,"conversationId"|"importBatchId"|"importAdmissionId">){
    return knowledgeSourceAdmitted(await this.read(),source);
  }
  async assert(source:Pick<KnowledgeSource,"conversationId"|"importBatchId"|"importAdmissionId">){
    if(!await this.allows(source))throw Object.assign(Error("This original is staged, withdrawn, or belongs to an older admission; it cannot update memory"),{code:"KNOWLEDGE_SOURCE_NOT_ADMITTED"});
  }
}
