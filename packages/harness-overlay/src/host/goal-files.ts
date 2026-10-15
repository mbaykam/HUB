import {mkdir,readFile,writeFile,readdir,realpath,lstat,rename} from "node:fs/promises";
import {resolve,relative,isAbsolute,dirname,join} from "node:path";
import {randomUUID,createHash} from "node:crypto";
import type {HubGoal,GoalEvidence} from "../goal-contract.ts";

const inside=(root:string,path:string)=>{const r=relative(root,path);return r===""||!r.startsWith("..")&&!isAbsolute(r);};
/** Resolve symlinks before checking the scope. Even an approved project write
 * cannot change HUB's private settings or original Knowledge files. */
export async function goalPath(g:HubGoal,raw:string,write:boolean,privateRoot:string|string[]){
  const workspace=resolve(g.workspace!);await mkdir(workspace,{recursive:true});
  const path=resolve(workspace,raw),roots=[workspace,...g.resources.writeFolders,...(write?[]:g.resources.folders)];
  let cursor=path;while(true){try{await lstat(cursor);break;}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;const parent=dirname(cursor);if(parent===cursor)throw e;cursor=parent;}}
  const actual=resolve(await realpath(cursor),relative(cursor,path));
  const approved=await Promise.all(roots.map(async r=>{try{return await realpath(r);}catch{return resolve(r);}}));
  const fileRead=!write&&await Promise.all(g.resources.files.map(async p=>{try{return await realpath(p);}catch{return resolve(p);}}));
  if(!approved.some(r=>inside(r,actual))&&!(fileRead&&fileRead.includes(actual)))throw Error("This file is outside the goal's saved resource scope.");
  const privatePaths=await Promise.all((Array.isArray(privateRoot)?privateRoot:[privateRoot]).map(async p=>{try{return await realpath(p);}catch{return resolve(p);}}));if(!inside(workspace,actual)&&privatePaths.some(p=>inside(p,actual)))throw Error("Use the Knowledge tools for original conversations; HUB's private settings are outside project-file access.");
  if(write&&approved.some(r=>inside(r,actual))&&/^(?:[a-z]:[\\/]|[\\/])$/i.test(actual))throw Error("Writing a filesystem root is not allowed.");
  return actual;
}
export async function goalFile(g:HubGoal,args:{action:string;path:string;content?:string},privateRoot:string|string[],roundId:string):Promise<{value:string;evidence?:GoalEvidence}>{
  const writing=args.action==="write",path=await goalPath(g,args.path,writing,privateRoot);
  if(args.action==="list"){const files=await readdir(path,{withFileTypes:true});return {value:JSON.stringify(files.slice(0,500).map(f=>({name:f.name,directory:f.isDirectory(),symbolicLink:f.isSymbolicLink()})))};}
  if(args.action==="read"){const info=await lstat(path);if(info.size>1048576||!info.isFile())throw Error("Select a text file under 1 MB; use a bounded import for archives.");return {value:await readFile(path,"utf8")};}
  if(args.action==="verify"){const info=await lstat(path);if(!info.isFile()||info.size>25000000)throw Error("Verify a file under 25 MB.");const sha256=createHash("sha256").update(await readFile(path)).digest("hex"),id="file:"+sha256+":"+roundId;return {value:JSON.stringify({path,sha256,bytes:info.size,evidenceId:id}),evidence:{id,roundId,kind:"file",label:"Checked "+args.path,detail:"Existing file was read and SHA-256 checked; this receipt does not claim it was newly created.",path,sha256,at:Date.now()}};}
  if(writing){
    if(typeof args.content!=="string"||Buffer.byteLength(args.content)>1048576)throw Error("Output must be text under 1 MB.");
    await mkdir(dirname(path),{recursive:true});await goalPath(g,path,true,privateRoot); // Recheck after creating parents.
    const temp=join(dirname(path),`.hub-goal-${randomUUID()}.tmp`);await writeFile(temp,args.content,{flag:"wx",mode:0o600});await rename(temp,path);
    const sha256=createHash("sha256").update(await readFile(path)).digest("hex"),id="file:"+sha256+":"+roundId;
    return {value:JSON.stringify({path,sha256,evidenceId:id}),evidence:{id,roundId,kind:"file",label:"Saved "+args.path,detail:"Saved output was read back and SHA-256 checked.",path,sha256,at:Date.now()}};
  }
  throw Error("Choose list, read, write or verify.");
}
