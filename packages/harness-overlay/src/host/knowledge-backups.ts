import {mkdir,readdir,readFile,lstat} from "node:fs/promises";
import {join,dirname} from "node:path";
import {homedir} from "node:os";
import {randomUUID} from "node:crypto";
import type {KnowledgeStore} from "./knowledge-store.ts";
import {ensureKnowledgeDataset,exportKnowledgeSnapshot,verifyKnowledgeSnapshot,restoreKnowledgeSnapshot} from "./knowledge-portable.ts";
const backupId=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Operator controls create verified copies; activating another dataset is a
 * separate setup decision and never an incidental effect of a restore test. */
export class KnowledgeBackups {
  constructor(readonly store:KnowledgeStore,readonly base=join(homedir(),".dsh","knowledge-backups")){}
  private async directory(){const {datasetId}=await ensureKnowledgeDataset(this.store),path=join(this.base,datasetId);await mkdir(path,{recursive:true});if((await lstat(this.base)).isSymbolicLink()||(await lstat(path)).isSymbolicLink())throw Error("Backup storage must be a real directory");return path;}
  private async path(id:string){if(!backupId.test(id))throw Error("Invalid backup identity");const path=join(await this.directory(),id);if((await lstat(path)).isSymbolicLink())throw Error("Linked backup directory");return path;}
  async create(){const id=randomUUID(),path=join(await this.directory(),id),snapshot=await exportKnowledgeSnapshot(this.store,path);return {id,path,at:snapshot.at,records:snapshot.records,bytes:snapshot.bytes,verified:true};}
  async list(offset=0){
    if(!Number.isSafeInteger(offset)||offset<0)throw Error("Invalid backup page");
    const directory=await this.directory(),dataset=await ensureKnowledgeDataset(this.store),ids=(await readdir(directory)).filter(id=>backupId.test(id)),items=[];let incompleteCopies=0;
    for(const id of ids)try{
      const value=JSON.parse(await readFile(join(await this.path(id),"snapshot.json"),"utf8"));
      if(value.format!=="hub-knowledge-snapshot"||value.version!==1||value.dataset?.datasetId!==dataset.datasetId||!Array.isArray(value.files)||!Number.isSafeInteger(value.at)||!Number.isSafeInteger(value.records)||value.records<0||!Number.isSafeInteger(value.bytes)||value.bytes<0)throw Error("Uncertified copy");
      items.push({id,at:value.at,records:value.records,bytes:value.bytes,path:join(directory,id)});
    }catch{incompleteCopies++;}
    items.sort((a,b)=>b.at-a.at||a.id.localeCompare(b.id));
    return {items:items.slice(offset,offset+30),total:items.length,nextOffset:offset+30<items.length?offset+30:null,storage:directory,incompleteCopies};
  }
  async verify(id:string){const path=await this.path(id),snapshot=await verifyKnowledgeSnapshot(path);return {id,path,verified:true,files:snapshot.files.length,bytes:snapshot.bytes,at:snapshot.at};}
  async restoreCopy(id:string){const path=await this.path(id),target=join(dirname(this.store.vault),"HUB Brain restored "+randomUUID()),copy=await restoreKnowledgeSnapshot(path,target);return {...copy,activated:false};}
}
