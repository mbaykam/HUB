import {mkdir,readFile,writeFile,readdir,lstat,copyFile,rename} from "node:fs/promises";
import {createReadStream,constants} from "node:fs";
import {createHash,randomUUID} from "node:crypto";
import {join,resolve,relative,isAbsolute,dirname} from "node:path";
import type {KnowledgeStore} from "./knowledge-store.ts";

export interface KnowledgeDatasetManifest {version:1;datasetId:string;createdAt:number;schemas:{organization:2;evidence:1};components:{vault:".";canonical:".hub/canonical"};companionRequired:true}
export interface SnapshotFile {path:string;sha256:string;bytes:number;component:"vault"|"canonical"|"continuity"}
export interface KnowledgeSnapshot {format:"hub-knowledge-snapshot";version:1;dataset:KnowledgeDatasetManifest;at:number;files:SnapshotFile[];records:number;bytes:number;runtimeCachesIncluded:false;credentialTransferIncluded:false}
export interface KnowledgeRestoreHold {version:1;datasetId:string;restoredAt:number;snapshotAt:number;state:"needs-review"|"resumed";resumedAt?:number}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json=async(path:string)=>{try{return JSON.parse(await readFile(path,"utf8"));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;return undefined;}};
const atomic=async(path:string,value:unknown)=>{await mkdir(dirname(path),{recursive:true});const temp=path+"."+randomUUID()+".tmp";await writeFile(temp,JSON.stringify(value,null,2),{flag:"wx",mode:0o600});await rename(temp,path);};
const within=(parent:string,child:string)=>{const part=relative(parent,child);return part===""||!part.startsWith("..")&&!isAbsolute(part);};
function validateManifest(value:any):asserts value is KnowledgeDatasetManifest {if(value?.version!==1||!uuid.test(value.datasetId)||!Number.isFinite(value.createdAt)||value.schemas?.organization!==2||value.schemas?.evidence!==1||value.components?.vault!=="."||value.components?.canonical!==".hub/canonical"||value.companionRequired!==true)throw Error("Unsupported or corrupt Knowledge dataset manifest");}
export async function ensureKnowledgeDataset(store:Pick<KnowledgeStore,"vault"|"root">){
  const path=join(store.vault,".hub","knowledge-manifest.json"),bindingPath=join(store.root,"dataset-binding.json");
  await mkdir(dirname(path),{recursive:true});if((await lstat(dirname(path))).isSymbolicLink())throw Error("Knowledge metadata must be a real directory");
  let manifest=await json(path),binding=await json(bindingPath);
  const vaultToken=createHash("sha256").update(resolve(store.vault).normalize("NFC").toLocaleLowerCase()).digest("hex");
  if(!manifest&&!binding){const datasetId=randomUUID();binding={version:1,datasetId,state:"prepared",vaultToken};await atomic(bindingPath,binding);}
  if(binding?.state==="prepared"){
    if(binding.version!==1||!uuid.test(binding.datasetId)||binding.vaultToken!==vaultToken||manifest&&manifest.datasetId!==binding.datasetId)throw Error("Incomplete Knowledge dataset binding requires review");
    if(!manifest){manifest={version:1,datasetId:binding.datasetId,createdAt:Date.now(),schemas:{organization:2,evidence:1},components:{vault:".",canonical:".hub/canonical"},companionRequired:true};await atomic(path,manifest);}
    binding={version:1,datasetId:binding.datasetId,state:"committed"};await atomic(bindingPath,binding);
  }
  validateManifest(manifest);
  if(binding?.version!==1||binding.state!=="committed"||binding.datasetId!==manifest.datasetId)throw Error("This Knowledge vault and its canonical companion belong to different datasets; restore the matching companion");
  return manifest;
}
async function hashFile(path:string){const hash=createHash("sha256");let bytes=0;for await(const chunk of createReadStream(path)){hash.update(chunk);bytes+=chunk.length;}return {sha256:hash.digest("hex"),bytes};}
async function filesAt(base:string,skip:(path:string)=>boolean=()=>false){
  const result:string[]=[];async function visit(dir:string){for(const entry of await readdir(join(base,dir),{withFileTypes:true})){const path=dir?dir+"/"+entry.name:entry.name;if(skip(path))continue;if(entry.isSymbolicLink())throw Error("Linked files cannot be exported as canonical Knowledge: "+path);if(entry.isDirectory())await visit(path);else if(entry.isFile())result.push(path);else throw Error("Non-file Knowledge component: "+path);}}
  await visit("");return result.sort();
}
function safeSnapshotPath(path:unknown):path is string{return typeof path==="string"&&path.length<=1024&&path.startsWith("vault/")&&!/[\\:\u0000-\u001f]/.test(path)&&path.split("/").every(p=>!!p&&p!=="."&&p!=="..");}
const runtime=(path:string)=>/^(runtime|models|cache|indexes)(\/|$)/.test(path)||/(^|\/)(embeddings\.db|.*\.sqlite)(-wal|-shm)?$/.test(path)||/\.[0-9a-f-]{36}\.tmp$/.test(path);
const continuity=(path:string)=>/^(jobs|reviews|config-backups|pilot)(\/|$)/.test(path)||/^(settings|costs|model-health)\.json$/.test(path);
function assertPortablePaths(paths:readonly unknown[]){const seen=new Set<string>();for(const path of paths){if(!safeSnapshotPath(path))throw Error("Invalid Knowledge snapshot inventory");const key=path.normalize("NFC").toLowerCase();if(seen.has(key))throw Error("Knowledge snapshot paths collide across case or Unicode normalization; review filenames before exporting or restoring");seen.add(key);}}
export async function knowledgeRestoreHold(store:Pick<KnowledgeStore,"root"|"vault">){const value=await json(join(store.root,"restored-work-hold.json"));if(value===undefined)return undefined;const dataset=await ensureKnowledgeDataset(store);if(value.version!==1||value.datasetId!==dataset.datasetId||!["needs-review","resumed"].includes(value.state)||!Number.isSafeInteger(value.restoredAt)||!Number.isSafeInteger(value.snapshotAt))throw Error("Invalid restored-work review receipt");return value as KnowledgeRestoreHold;}
export async function resumeRestoredKnowledgeWork(store:KnowledgeStore){return store.mutations.run(async()=>{const hold=await knowledgeRestoreHold(store);if(hold?.state==="needs-review")await atomic(join(store.root,"restored-work-hold.json"),{...hold,state:"resumed",resumedAt:Date.now()});});}

/** Destination is a new directory, never the current vault. The shared gate
 * pauses canonical admission, drains existing writers, then verifies a full
 * before/after inventory, detecting external Obsidian edits too. */
export async function exportKnowledgeSnapshot(store:KnowledgeStore,destination:string){
  destination=resolve(destination);if(within(store.vault,destination)||within(store.root,destination)||within(destination,store.vault)||within(destination,store.root))throw Error("Choose a snapshot directory outside the live Knowledge dataset");
  return store.mutations.snapshot(async()=>{
    const dataset=await ensureKnowledgeDataset(store);await store.archive.drain();
    const inventory=async()=>{
      const vaultPaths=await filesAt(store.vault,p=>p===".git"||p.startsWith(".git/")||p===".hub"||runtime(p));
      const rootPaths=await filesAt(store.root,runtime);
      if(rootPaths.some(p=>/(^|\/)(\.credentials\.ya?ml|credentials\.json|auth\.json)$/.test(p)))throw Error("Credentials do not belong in a portable Knowledge companion");
      const entries:{source:string;file:SnapshotFile}[]=[];
      for(const path of [...vaultPaths,".hub/knowledge-manifest.json"]){const source=join(store.vault,path);entries.push({source,file:{path:"vault/"+path,...await hashFile(source),component:"vault"}});}
      for(const path of rootPaths){const source=join(store.root,path);entries.push({source,file:{path:"vault/.hub/canonical/"+path,...await hashFile(source),component:continuity(path)?"continuity":"canonical"}});}
      return entries.sort((a,b)=>a.file.path.localeCompare(b.file.path));
    };
    const before=await inventory();assertPortablePaths(before.map(entry=>entry.file.path));await mkdir(destination,{recursive:false});
    for(const entry of before){const path=join(destination,entry.file.path);await mkdir(dirname(path),{recursive:true});await copyFile(entry.source,path,constants.COPYFILE_EXCL);const copied=await hashFile(path);if(copied.sha256!==entry.file.sha256||copied.bytes!==entry.file.bytes)throw Error("Knowledge changed while copying; incomplete snapshot was not certified");}
    const after=await inventory();if(JSON.stringify(before.map(v=>v.file))!==JSON.stringify(after.map(v=>v.file)))throw Error("Knowledge changed during export; close external vault editors and retry");
    const snapshot:KnowledgeSnapshot={format:"hub-knowledge-snapshot",version:1,dataset,at:Date.now(),files:before.map(v=>v.file),records:(await store.scan()).length,bytes:before.reduce((sum,v)=>sum+v.file.bytes,0),runtimeCachesIncluded:false,credentialTransferIncluded:false};
    await atomic(join(destination,"snapshot.json"),snapshot);
    await writeFile(join(destination,"README.txt"),"HUB portable Knowledge snapshot\nKeep snapshot.json and vault/ together. Original notes, conversations, media and canonical sidecars are included. Index/model caches and credentials are excluded. Restore into a NEW directory using HUB's verified restore command; configure canonical root as <restored vault>/.hub/canonical. Rebuild local indexes after restore. Runtime continuity files are kept but background work must be reviewed before resuming.\n",{flag:"wx",mode:0o600});
    await verifyKnowledgeSnapshot(destination);return snapshot;
  });
}
export async function verifyKnowledgeSnapshot(directory:string){
  directory=resolve(directory);const snapshot=await json(join(directory,"snapshot.json"));
  if(snapshot?.format!=="hub-knowledge-snapshot"||snapshot.version!==1||!Array.isArray(snapshot.files)||snapshot.files.length>100000||snapshot.files.some((file:any)=>!file||typeof file!=="object")||!Number.isSafeInteger(snapshot.at)||!Number.isSafeInteger(snapshot.records)||snapshot.records<0||!Number.isSafeInteger(snapshot.bytes)||snapshot.bytes<0||snapshot.runtimeCachesIncluded!==false||snapshot.credentialTransferIncluded!==false)throw Error("Unsupported or incomplete Knowledge snapshot");validateManifest(snapshot.dataset);
  assertPortablePaths(snapshot.files.map((file:any)=>file.path));
  const seen=new Set<string>();let bytes=0;
  for(const file of snapshot.files){if(!safeSnapshotPath(file.path)||seen.has(file.path)||!/^[0-9a-f]{64}$/.test(file.sha256)||!Number.isSafeInteger(file.bytes)||file.bytes<0||!["vault","canonical","continuity"].includes(file.component))throw Error("Invalid Knowledge snapshot inventory");seen.add(file.path);
    let parent=directory;for(const part of file.path.split("/")){parent=join(parent,part);if((await lstat(parent)).isSymbolicLink())throw Error("Linked snapshot component");}
    const actual=await hashFile(parent);if(actual.sha256!==file.sha256||actual.bytes!==file.bytes)throw Error("Knowledge snapshot integrity check failed: "+file.path);bytes+=file.bytes;
  }
  if(bytes!==snapshot.bytes||!seen.has("vault/.hub/knowledge-manifest.json")||!seen.has("vault/.hub/canonical/dataset-binding.json"))throw Error("Incomplete Knowledge snapshot inventory");
  const manifest=await json(join(directory,"vault/.hub/knowledge-manifest.json")),binding=await json(join(directory,"vault/.hub/canonical/dataset-binding.json"));validateManifest(manifest);if(manifest.datasetId!==snapshot.dataset.datasetId||binding?.datasetId!==manifest.datasetId||binding.state!=="committed")throw Error("Snapshot dataset binding mismatch");
  return snapshot as KnowledgeSnapshot;
}
/** Never overwrites a live or existing directory. No models, replay or deletion. */
export async function restoreKnowledgeSnapshot(directory:string,targetVault:string){
  directory=resolve(directory);targetVault=resolve(targetVault);if(within(directory,targetVault)||within(targetVault,directory))throw Error("Restore into a separate new directory");const snapshot=await verifyKnowledgeSnapshot(directory);
  await mkdir(targetVault,{recursive:false});
  for(const file of snapshot.files){const path=join(targetVault,file.path.slice("vault/".length));if(!within(targetVault,path))throw Error("Invalid restore destination");await mkdir(dirname(path),{recursive:true});await copyFile(join(directory,file.path),path,constants.COPYFILE_EXCL);const actual=await hashFile(path);if(actual.sha256!==file.sha256||actual.bytes!==file.bytes)throw Error("Restored Knowledge integrity check failed");}
  const root=join(targetVault,".hub/canonical");await ensureKnowledgeDataset({vault:targetVault,root});
  const oldHold=await json(join(root,"restored-work-hold.json"));if(oldHold)await atomic(join(root,"restore-history",randomUUID()+".json"),oldHold);
  await atomic(join(root,"restored-work-hold.json"),{version:1,datasetId:snapshot.dataset.datasetId,restoredAt:Date.now(),snapshotAt:snapshot.at,state:"needs-review"} satisfies KnowledgeRestoreHold);
  return {datasetId:snapshot.dataset.datasetId,vault:targetVault,root,files:snapshot.files.length,bytes:snapshot.bytes,backgroundWork:"paused-for-review" as const};
}
