import {readFile,writeFile,mkdir,rename,lstat,readdir,unlink} from "node:fs/promises";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {atomicJson,digest,type KnowledgeStore} from "./knowledge-store.ts";
import {changeKnowledgeDomains} from "./knowledge-domains.ts";
import type {DomainOperation} from "../knowledge-domain-contract.ts";

export interface SkillOrigin {kind:"user"|"character";sessionId?:string;characterId?:string}
export interface KnowledgeSkill {id:string;name:string;title:string;description:string;requiredTools:string[];content:string;hash:string;path:string;updatedAt:number;domainId?:string;source?:SkillOrigin;updatedBy?:SkillOrigin}
const validName=(name:unknown):name is string=>typeof name==="string"&&name.length<=80&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);

/** Portable SKILL.md bundles live in the same vault and ordinary domain graph.
 * Their contents are loaded explicitly, never granted executable authority. */
export class KnowledgeSkills {
  constructor(readonly store:KnowledgeStore){}
  /** Finish a two-file save after power loss, only if neither file was
   * independently edited. A conflict preserves both originals for review. */
  async recover(){return this.store.exclusive(()=>this.recoverPending());}
  private async recoverPending(){
    const receipt=join(this.store.root,"skills-pending.json");
    const raw=await readFile(receipt,"utf8").catch(e=>{if(e.code!=="ENOENT")throw e;return null;});if(raw===null)return;
    const pending=JSON.parse(raw);
    if(pending.version!==1||!validName(pending.name)||typeof pending.after!=="string"||pending.before!==null&&typeof pending.before!=="string"||!pending.registryBefore||!pending.registryAfter)throw Error("Invalid interrupted skill receipt; preserve it for review");
    const path=await this.store.skillPath(pending.name),current=await readFile(path,"utf8").catch(e=>{if(e.code!=="ENOENT")throw e;return null;}),state=await this.store.organization.state();
    const stateHash=digest(JSON.stringify(state));
    if(current!==pending.before&&current!==pending.after||![digest(JSON.stringify(pending.registryBefore)),digest(JSON.stringify(pending.registryAfter))].includes(stateHash))throw Error("Interrupted skill save conflicts with a newer edit; preserve both files and review skills-pending.json");
    await mkdir(join(this.store.vault,"Skills",pending.name),{recursive:true});await this.store.skillPath(pending.name);
    if(current!==pending.after){const temp=path+`.${randomUUID()}.tmp`;await writeFile(temp,pending.after,{flag:"wx",mode:0o600});await rename(temp,path);}
    if(stateHash!==digest(JSON.stringify(pending.registryAfter)))await atomicJson(join(this.store.root,"organization.json"),pending.registryAfter);
    await unlink(receipt);
  }
  async list():Promise<KnowledgeSkill[]>{return (await this.catalog()).skills;}
  async catalog():Promise<{skills:KnowledgeSkill[];issues:{name:string;reason:string}[]}>{
    const directory=await this.store.skillPath();
    const entries=await readdir(directory,{withFileTypes:true}).catch(e=>{if(e.code!=="ENOENT")throw e;return [];});
    const skills:KnowledgeSkill[]=[],issues:{name:string;reason:string}[]=[];
    for(const entry of entries){
      if(!entry.isDirectory()||entry.isSymbolicLink()||!validName(entry.name))continue;
      try{const skill=await this.read(entry.name);if(skill)skills.push(skill);}catch{issues.push({name:entry.name,reason:"Skill metadata or file needs repair; original file was left untouched."});}
    }
    return {skills:skills.sort((a,b)=>a.name.localeCompare(b.name)),issues};
  }
  async read(name:string):Promise<KnowledgeSkill|undefined>{
    if(!validName(name))throw Error("Use a lowercase hyphen-separated skill name");
    const path=await this.store.skillPath(name),info=await lstat(path).catch(e=>{if(e.code!=="ENOENT")throw e;return undefined;});
    if(!info)return undefined;if(info.isSymbolicLink()||!info.isFile()||info.size>40000)throw Error("Skill must be a regular Markdown file under 40 KB");
    const raw=await readFile(path,"utf8"),front=raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)?.[0];if(!front)throw Error("Skill metadata is missing");
    const field=(key:string)=>{const value=front.match(new RegExp(`^${key}: (.+)$`,"m"))?.[1];return value?JSON.parse(value):undefined;};
    const id=field("hub_id"),title=field("title"),description=field("description"),requiredTools=field("required_tools")??[];
    if(typeof id!=="string"||typeof title!=="string"||typeof description!=="string"||!Array.isArray(requiredTools)||!requiredTools.every(t=>typeof t==="string"))throw Error("Skill metadata is invalid");
    if((await this.store.admission.blocked()).has(id))return undefined;
    return {id,name,title,description,requiredTools,content:raw.slice(front.length),hash:digest(raw),path,updatedAt:info.mtimeMs,domainId:field("hub_skill_domain"),source:field("hub_skill_source"),updatedBy:field("hub_skill_updated_by")};
  }
  async save(input:{name:string;title:string;description:string;content:string;requiredTools?:string[];expectedHash:string|null},origin:SkillOrigin={kind:"user"}){
    if(!validName(input.name)||typeof input.title!=="string"||!input.title.trim()||input.title.length>100||/[\u0000-\u001f]/.test(input.title)||typeof input.description!=="string"||!input.description.trim()||input.description.length>500||typeof input.content!=="string"||!input.content.trim()||Buffer.byteLength(input.content)>30000||!Array.isArray(input.requiredTools??[])||(input.requiredTools??[]).length>32||(input.requiredTools??[]).some(t=>typeof t!=="string"||!/^[-\w.]+$/.test(t)))throw Error("Provide a title, short description, reusable instructions and valid required tool names");
    return this.store.exclusive(async()=>{
      await this.recoverPending();
      const before=await this.read(input.name);if((before?.hash??null)!==input.expectedHash)throw Error("Skill changed; read its current version before saving");
      const path=await this.store.skillPath(input.name),id=before?.id??randomUUID(),state=await this.store.organization.state();
      if(!before&&await lstat(path).then(()=>true,e=>{if(e.code!=="ENOENT")throw e;return false;}))throw Error("An unavailable skill already occupies this name; choose another name");
      let domain=before?.domainId?state.domainState.domains.find(d=>d.id===before.domainId):undefined;
      if(domain?.status==="merged")domain=state.domainState.domains.find(d=>d.id===domain!.mergedInto);
      domain??=state.domainState.domains.find(d=>!d.parentId&&d.status!=="merged"&&(d.title.toLowerCase()==="skills"||d.aliases.some(a=>a.toLowerCase()==="skills")));
      if(domain&&domain.status!=="active")throw Error("Activate the Skills domain in Knowledge before adding skills");
      const operations:DomainOperation[]=[];
      if(!domain)operations.push({type:"create",ref:"new-skills",title:"Skills",aliases:["Reusable workflows"]});
      operations.push({type:"assign",nodeId:id,domainId:domain?.id??"new-skills"});
      const registry=changeKnowledgeDomains(state.domainState,operations,{expectedRevision:state.domainState.revision,actor:"user",knownNodeIds:[...(await this.store.scan()).filter(n=>n.kind!=="conversation").map(n=>n.id),id],revisionId:randomUUID()});
      const domainId=domain?.id??registry.memberships.find(m=>m.nodeId===id)!.domainId;
      const raw=`---\nhub_id: ${JSON.stringify(id)}\ntitle: ${JSON.stringify(input.title.trim())}\nname: ${JSON.stringify(input.name)}\ndescription: ${JSON.stringify(input.description.trim())}\nrequired_tools: ${JSON.stringify([...new Set(input.requiredTools??[])])}\nhub_skill_domain: ${JSON.stringify(domainId)}\nhub_skill_source: ${JSON.stringify(before?.source??origin)}\nhub_skill_updated_by: ${JSON.stringify(origin)}\ntype: hub_skill\n---\n${input.content.trim()}\n`;
      await mkdir(join(this.store.vault,"Skills",input.name),{recursive:true});await this.store.skillPath(input.name);
      const previous=before?await readFile(path,"utf8"):null;
      if(before){const history=join(this.store.root,"skills-history",id);await mkdir(history,{recursive:true});await writeFile(join(history,before.hash+".md"),previous!,{mode:0o600});}
      await atomicJson(join(this.store.root,"skills-pending.json"),{version:1,name:input.name,before:previous,after:raw,registryBefore:state,registryAfter:{...state,domainState:registry}});
      await this.recoverPending();
      return (await this.read(input.name))!;
    });
  }
}
