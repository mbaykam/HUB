import {randomUUID} from "node:crypto";
import {emptyKnowledgeDomains,type DomainOperation,type KnowledgeDomainState,type KnowledgeDomain} from "../knowledge-domain-contract.ts";
import type {KnowledgeSource} from "../knowledge-contract.ts";
import {sourceContains,sourceReference} from "./knowledge-provenance.ts";

const key=(m:{nodeId:string;domainId:string})=>m.nodeId+"\0"+m.domainId;
const title=(v:unknown)=>typeof v==="string"&&v.trim().length>0&&v.length<=100&&!/[\u0000-\u001f]/.test(v);
const aliases=(v:unknown)=>v===undefined||Array.isArray(v)&&v.length<=12&&v.every(title)&&new Set(v.map(s=>s.normalize("NFKC").toLocaleLowerCase())).size===v.length;
const fields=(v:any,keys:string[])=>v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
export function validateDomainOperation(op:any){
  if(!op||typeof op.type!=="string")throw Error("Invalid domain operation");
  const id=(s:any)=>typeof s==="string"&&s.length>0&&s.length<=100&&!/[\u0000-\u0020]/.test(s);
  let valid=false;
  switch(op.type){
    case "create":valid=fields(op,["type","ref","title","aliases","parentId","evidence"])&&/^new-[a-zA-Z0-9_-]{1,60}$/.test(op.ref)&&title(op.title)&&aliases(op.aliases)&&(op.parentId===undefined||id(op.parentId));break;
    case "assign":valid=fields(op,["type","nodeId","domainId","evidence"])&&id(op.domainId)&&(op.nodeId===undefined||id(op.nodeId));break;
    case "unassign":valid=fields(op,["type","nodeId","domainId"])&&id(op.nodeId)&&id(op.domainId);break;
    case "rename":valid=fields(op,["type","id","title","aliases"])&&id(op.id)&&title(op.title)&&aliases(op.aliases);break;
    case "reparent":valid=fields(op,["type","id","parentId"])&&id(op.id)&&(op.parentId===undefined||id(op.parentId));break;
    case "status":valid=fields(op,["type","id","status"])&&id(op.id)&&["active","inactive"].includes(op.status);break;
    case "merge":valid=fields(op,["type","id","targetId"])&&id(op.id)&&id(op.targetId);break;
    case "split":valid=fields(op,["type","id","groups","deactivateSource"])&&id(op.id)&&Array.isArray(op.groups)&&op.groups.length>=2&&op.groups.length<=8&&op.groups.every((g:any)=>fields(g,["ref","title","aliases","nodeIds"])&&/^new-[a-zA-Z0-9_-]{1,60}$/.test(g.ref)&&title(g.title)&&aliases(g.aliases)&&Array.isArray(g.nodeIds)&&g.nodeIds.length>0&&g.nodeIds.length<=1000&&g.nodeIds.every(id)&&new Set(g.nodeIds).size===g.nodeIds.length)&&(op.deactivateSource===undefined||typeof op.deactivateSource==="boolean");break;
    case "propose":valid=fields(op,["type","operation","evidence"])&&["rename","reparent","status","merge","split","unassign"].includes(op.operation?.type);if(valid)validateDomainOperation(op.operation);break;
  }
  if(!valid||op.evidence!==undefined&&(typeof op.evidence!=="string"||op.evidence.length>1200))throw Error("Invalid domain operation fields");
}
export function validateDomainState(state:KnowledgeDomainState){
  if(state.version!==1||!Number.isInteger(state.revision)||state.revision<0||!Number.isInteger(state.maxActiveDomains)||state.maxActiveDomains<1||state.maxActiveDomains>20||!Array.isArray(state.domains)||!Array.isArray(state.memberships)||!Array.isArray(state.history)||!Array.isArray(state.proposals)||state.domains.length>10000)throw Error("Invalid domain registry");
  const byId=new Map(state.domains.map(d=>[d.id,d]));if(byId.size!==state.domains.length)throw Error("Duplicate domain identity");
  for(const d of state.domains){
    if(!title(d.title)||!aliases(d.aliases)||!Array.isArray(d.aliases)||!["active","inactive","merged"].includes(d.status)||typeof d.id!=="string"||!/^[0-9a-f-]{36}$/i.test(d.id)||!Number.isFinite(d.createdAt)||d.createdAt<0||!Number.isFinite(d.updatedAt)||d.updatedAt<d.createdAt)throw Error("Invalid domain record");
    if(d.status==="merged"){if(d.parentId||!d.mergedInto||!byId.has(d.mergedInto)||byId.get(d.mergedInto)!.status==="merged"||d.mergedInto===d.id)throw Error("Invalid domain redirect");continue;}
    const seen=new Set([d.id]);let node=d,depth=1;while(node.parentId){const p=byId.get(node.parentId);if(!p||p.status==="merged"||seen.has(p.id))throw Error("Domain parent missing or cyclic");if(d.status==="active"&&p.status!=="active")throw Error("Activate parent domains before their subdomains");seen.add(p.id);node=p;if(++depth>4)throw Error("Domain nesting is limited to four levels");}
  }
  if(state.domains.filter(d=>d.status==="active"&&!d.parentId).length>state.maxActiveDomains)throw Error("Active main-domain limit reached; deactivate or merge a main domain first");
  const unique=new Set<string>();for(const m of state.memberships){if(!byId.has(m.domainId)||byId.get(m.domainId)!.status==="merged"||typeof m.nodeId!=="string"||!m.nodeId||m.nodeId.length>200||!Array.isArray(m.evidence)||!m.evidence.every(e=>typeof e.sourceId==="string"&&!!e.sourceId&&typeof e.quote==="string"&&e.quote.length<=1200&&(e.contentHash===undefined||/^[0-9a-f]{64}$/.test(e.contentHash)))||!["user","curator"].includes(m.origin)||typeof m.revisionId!=="string"||unique.has(key(m)))throw Error("Invalid domain membership");unique.add(key(m));}
  for(const p of state.proposals){if(typeof p.id!=="string"||typeof p.sourceId!=="string"||!Number.isFinite(p.at)||!Number.isInteger(p.basedOnRevision)||!["pending","applied","rejected"].includes(p.status)||typeof p.evidence!=="string")throw Error("Invalid domain proposal");validateDomainOperation(p.operation);}
  for(const h of state.history)if(typeof h.id!=="string"||!Array.isArray(h.beforeDomains)||!Array.isArray(h.beforeMemberships)||!Array.isArray(h.beforeProposals)||!Number.isInteger(h.afterRevision))throw Error("Invalid domain audit receipt");
}
export function domainAncestors(state:Pick<KnowledgeDomainState,"domains">,id:string){const byId=new Map(state.domains.map(d=>[d.id,d])),out:KnowledgeDomain[]=[];let d=byId.get(id);while(d&&!out.some(v=>v.id===d!.id)){out.push(d);d=byId.get(d.mergedInto??d.parentId??"");}return out;}

/** Work on a copy. The caller commits this together with the organization plan
 * once; validation errors cannot leave half a hierarchy or relation behind. */
export function changeKnowledgeDomains(current:KnowledgeDomainState|undefined,operations:DomainOperation[],context:{expectedRevision:number;actor:"user"|"curator";source?:KnowledgeSource;knownNodeIds:string[];revisionId:string;maxActiveDomains?:number;now?:number}){
  const state=structuredClone(current??emptyKnowledgeDomains());validateDomainState(state);
  if(context.expectedRevision!==state.revision)throw Object.assign(Error("Domains changed; refresh and replan before saving"),{code:"DOMAIN_REVISION_CONFLICT"});
  if(!Array.isArray(operations)||operations.length>(context.actor==="curator"?8:100))throw Error("Too many domain operations");
  if(context.actor==="curator"&&(operations.filter(o=>o.type==="create").length>2||operations.filter(o=>o.type==="assign").length>4||operations.filter(o=>o.type==="propose").length>2||context.maxActiveDomains!==undefined))throw Error("Curator domain allowance exceeded");
  const before=structuredClone(state),refs=new Map<string,string>(),now=context.now??Date.now(),known=new Set(context.knownNodeIds);
  const domain=(id:string)=>{const d=state.domains.find(d=>d.id===(refs.get(id)??id));if(!d||d.status==="merged")throw Error("Domain target missing or merged");return d;};
  for(const op of operations){validateDomainOperation(op);
    if(context.actor==="curator"&&!['create','assign','propose'].includes(op.type))throw Error("Domain lifecycle changes require human review");
    if(context.actor==="curator"){
      const quote=(op as any).evidence,source=context.source;if(!source||typeof quote!=="string"||quote.trim().length<4||!sourceContains(source,quote))throw Error("Domain changes require exact source evidence");
    }
    if(op.type==="create"){
      if(refs.has(op.ref))throw Error("Duplicate new domain reference");const parent=op.parentId?domain(op.parentId):undefined;
      if(state.domains.some(d=>d.status!=="merged"&&d.parentId===parent?.id&&[d.title,...d.aliases].some(t=>t.normalize('NFKC').toLocaleLowerCase()===op.title.trim().normalize('NFKC').toLocaleLowerCase())))throw Error("An equivalent domain already exists; reuse its identity");
      const id=randomUUID();refs.set(op.ref,id);state.domains.push({id,title:op.title.trim(),aliases:op.aliases??[],...(parent?{parentId:parent.id}:{}),status:parent?.status==="inactive"?"inactive":"active",createdAt:now,updatedAt:now});
    }else if(op.type==="assign"){
      const d=domain(op.domainId),nodeId=op.nodeId??context.source?.conversationId;if(!nodeId||!known.has(nodeId)||context.actor==="curator"&&nodeId!==context.source?.conversationId)throw Error("Assignment must reference an admitted current source record");
      const evidence=context.source&&op.evidence?[sourceReference(context.source,op.evidence)]:[];
      const existing=state.memberships.find(m=>m.nodeId===nodeId&&m.domainId===d.id);if(existing){if(context.actor==="curator"&&existing.origin==="user")continue;if(context.actor==="user"&&existing.origin!=="user"){existing.origin="user";existing.revisionId=context.revisionId;}for(const e of evidence)if(!existing.evidence.some(v=>v.sourceId===e.sourceId&&v.quote===e.quote))existing.evidence.push(e);}
      else state.memberships.push({nodeId,domainId:d.id,evidence,origin:context.actor,revisionId:context.revisionId});
    }else if(op.type==="propose"){
      if(context.actor!=="curator")throw Error("Only the Curator submits review proposals");
      const proposed=structuredClone(op.operation);if('id'in proposed)proposed.id=domain(proposed.id).id;else {proposed.domainId=domain(proposed.domainId).id;if(!known.has(proposed.nodeId))throw Error("Proposal record is not admitted");}if(proposed.type==="merge")proposed.targetId=domain(proposed.targetId).id;if(proposed.type==="reparent"&&proposed.parentId)proposed.parentId=domain(proposed.parentId).id;
      state.proposals.push({id:randomUUID(),sourceId:context.source!.id,at:now,evidence:op.evidence,operation:proposed,basedOnRevision:state.revision+1,status:"pending"});
    }else if(op.type==="unassign"){
      domain(op.domainId);state.memberships=state.memberships.filter(m=>!(m.nodeId===op.nodeId&&m.domainId===op.domainId));
    }else{
      const d=domain(op.id);
      if(op.type==="rename"&&d.title===op.title.trim()&&JSON.stringify(d.aliases)===JSON.stringify(op.aliases??d.aliases)||op.type==="reparent"&&d.parentId===op.parentId||op.type==="status"&&d.status===op.status)continue;
      d.updatedAt=now;
      if(op.type==="rename"){d.title=op.title.trim();d.aliases=op.aliases??d.aliases;}
      if(op.type==="reparent"){d.parentId=op.parentId?domain(op.parentId).id:undefined;}
      if(op.type==="status"){
        d.status=op.status;
        if(op.status==="inactive")for(const child of state.domains)if(domainAncestors(state,child.id).some(a=>a.id===d.id)&&child.status!=="merged"){child.status="inactive";child.updatedAt=now;}
      }
      if(op.type==="merge"){
        const target=domain(op.targetId);if(target.id===d.id||domainAncestors(state,target.id).some(a=>a.id===d.id))throw Error("Cannot merge into self or a descendant");
        for(const child of state.domains)if(child.parentId===d.id)child.parentId=target.id;
        for(const redirect of state.domains)if(redirect.mergedInto===d.id)redirect.mergedInto=target.id;
        for(const m of state.memberships.filter(m=>m.domainId===d.id)){const existing=state.memberships.find(v=>v.nodeId===m.nodeId&&v.domainId===target.id);if(existing){existing.evidence.push(...m.evidence.filter(e=>!existing.evidence.some(v=>v.sourceId===e.sourceId&&v.quote===e.quote)));if(m.origin==="user")existing.origin="user";state.memberships=state.memberships.filter(v=>v!==m);}else m.domainId=target.id;}
        d.status="merged";d.mergedInto=target.id;delete d.parentId;
      }
      if(op.type==="split"){
        const originals=state.memberships.filter(m=>m.domainId===d.id),moved=new Set<string>();
        for(const group of op.groups){if(refs.has(group.ref))throw Error("Duplicate split reference");if(state.domains.some(v=>v.status!=="merged"&&v.parentId===d.parentId&&v.title.toLocaleLowerCase()===group.title.trim().toLocaleLowerCase()))throw Error("Split domain already exists");const id=randomUUID();refs.set(group.ref,id);state.domains.push({id,title:group.title.trim(),aliases:group.aliases??[],...(d.parentId?{parentId:d.parentId}:{}),status:d.status,createdAt:now,updatedAt:now});
          for(const nodeId of group.nodeIds){const prior=originals.find(m=>m.nodeId===nodeId);if(!known.has(nodeId)||!prior)throw Error("Split selections must belong to the source domain");state.memberships.push({...structuredClone(prior),domainId:id,origin:"user",revisionId:context.revisionId});moved.add(nodeId);}
        }
        state.memberships=state.memberships.filter(m=>m.domainId!==d.id||!moved.has(m.nodeId));
        if(op.deactivateSource)for(const child of state.domains)if(domainAncestors(state,child.id).some(a=>a.id===d.id)&&child.status!=="merged"){child.status="inactive";child.updatedAt=now;}
      }
    }
  }
  if(context.maxActiveDomains!==undefined)state.maxActiveDomains=context.maxActiveDomains;
  validateDomainState(state);if(JSON.stringify([state.domains,state.memberships,state.proposals,state.maxActiveDomains])===JSON.stringify([before.domains,before.memberships,before.proposals,before.maxActiveDomains]))return state;state.revision++;
  const changed=<T>(before:T[],after:T[],identify:(v:T)=>string)=>{const b=new Map(before.map(v=>[identify(v),v])),a=new Map(after.map(v=>[identify(v),v]));return [...new Set([...b.keys(),...a.keys()])].filter(id=>JSON.stringify(b.get(id))!==JSON.stringify(a.get(id))).map(id=>({id,value:b.get(id)??null}));};
  const beforeDomains=changed(before.domains,state.domains,d=>d.id);
  state.history.push({id:context.revisionId,at:now,actor:context.actor,...(context.source?{sourceId:context.source.id}:{}),operations:structuredClone(operations),...(refs.size?{resolvedReferences:Object.fromEntries(refs)}:{}),beforeDomains,afterDomains:beforeDomains.map(({id})=>({id,value:state.domains.find(d=>d.id===id)??null})),beforeMemberships:changed(before.memberships,state.memberships,key).map(({id,value})=>({key:id,value})),beforeProposals:changed(before.proposals,state.proposals,p=>p.id),beforeCap:before.maxActiveDomains,afterRevision:state.revision});
  return state;
}
export function undoKnowledgeDomains(current:KnowledgeDomainState,id:string){
  const state=structuredClone(current),entry=state.history.find(h=>h.id===id);if(!entry||entry.undone)throw Error("Domain revision unavailable");if(state.history.filter(h=>!h.undone).at(-1)?.id!==id)throw Error("Newer domain changes must be preserved; undo the latest domain revision first");
  for(const {id,value}of entry.beforeDomains){state.domains=state.domains.filter(d=>d.id!==id);if(value)state.domains.push(value);}
  for(const {key:k,value}of entry.beforeMemberships){state.memberships=state.memberships.filter(m=>key(m)!==k);if(value)state.memberships.push(value);}
  state.maxActiveDomains=entry.beforeCap;for(const {id,value}of entry.beforeProposals){const i=state.proposals.findIndex(p=>p.id===id);if(value){if(i<0)state.proposals.push(value);else state.proposals[i]=value;}else if(i>=0)state.proposals[i]!.status="rejected";}
  entry.undone=true;state.revision++;validateDomainState(state);return state;
}
