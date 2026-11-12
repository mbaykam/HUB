import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import type { KnowledgeActivityPage, KnowledgeActivityChange } from "../knowledge-activity-contract.ts";
import type { KnowledgeCurator } from "./knowledge-curator.ts";
import { knowledgeSourceAdmitted } from "./knowledge-admission.ts";
import { redactKnowledgeSecrets } from "./knowledge-secrets.ts";

/** Read-only projection of existing durable jobs and committed mutation receipts. */
export async function knowledgeActivity(curator:KnowledgeCurator,offset=0):Promise<KnowledgeActivityPage>{
  if(!Number.isSafeInteger(offset)||offset<0||offset>100000)throw Error("Invalid activity page");
  const store=curator.store,admission=await store.admission.read(),cutoff=await store.cutoff(),retired=await store.retiredEvidence(),organization=await store.organization.state();
  const titles=new Map((await store.scan()).map(note=>[note.id,note.title])),domainTitles=new Map(organization.domainState.domains.map(domain=>[domain.id,domain.title]));
  const jobs=[...curator.jobs.values()].filter(j=>j.source.completedAt>cutoff&&knowledgeSourceAdmitted(admission,j.source)&&!retired.some(t=>t.recordId===j.source.conversationId&&j.source.completedAt<=t.at)).sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id));
  const entries:KnowledgeActivityPage["entries"]=[];
  for(const job of jobs.slice(offset,offset+30)){
    const changes:KnowledgeActivityChange[]=[],warnings:string[]=[];
    const revision=organization.revisions.find(r=>r.id===job.revision||!job.revision&&(r.passId??r.sourceId)===(job.pass?.id??job.source.id));
    if(revision){
      if(revision.undone)warnings.push("Organization changes were undone.");
      if(revision.projection==="pending")warnings.push("Saved organization is awaiting its Obsidian projection; repair needs no new model request.");
      for(const tag of revision.plan.tags)changes.push({kind:"tag",action:"saved",title:tag});
      const audit=organization.domainState.history.find(h=>h.id===revision.id);
      for(const after of audit?.afterDomains??[]){if(!after.value)continue;const before=audit?.beforeDomains.find(d=>d.id===after.id)?.value;changes.push({kind:"domain",action:before?"updated":"created",title:after.value.title,id:after.id});}
      for(const membership of audit?.beforeMemberships??[]){const [nodeId,domainId]=membership.key.split("\0");changes.push({kind:"assignment",action:"changed",title:`${titles.get(nodeId)??"Source record"} → ${domainTitles.get(domainId)??"Domain"}`,id:nodeId});}
      for(const proposal of audit?.beforeProposals??[])changes.push({kind:"proposal",action:"recorded for review",title:organization.domainState.proposals.find(p=>p.id===proposal.id)?.operation.type??"Domain proposal"});
      for(const record of organization.relationRecords??[])if(titles.has(record.relation.sourceId)&&titles.has(record.relation.targetId)&&record.supports.some(s=>s.revisionId===revision.id))changes.push({kind:"link",action:"saved evidence",title:`${titles.get(record.relation.sourceId)} → ${titles.get(record.relation.targetId)} · ${record.relation.predicate}`,id:record.relation.sourceId,targetId:record.relation.targetId});
      for(const reflection of revision.plan.reflections)changes.push({kind:"reflection",action:"saved",title:reflection.observation});
      for(const suggestion of organization.suggestions.filter(s=>s.revisionId===revision.id))changes.push({kind:"suggestion",action:suggestion.status,title:`${suggestion.target}: ${suggestion.text}`});
      if(!organization.relationRecords&&revision.plan.relations.length)warnings.push("Older relation receipts do not record individual committed links; proposed links are not listed as completed.");
    }else if(job.revision)warnings.push("The organization receipt is unavailable; its changes cannot be listed.");
    if(job.memoryRevision&&/^[a-f0-9-]{36}$/i.test(job.memoryRevision)){
      try{
        const path=join(store.root,"journal",`${job.memoryRevision}.json`),info=await lstat(path);
        if(!info.isFile()||info.isSymbolicLink()||info.size>16*1024*1024)throw Error("Invalid note receipt");
        const journal=JSON.parse(await readFile(path,"utf8"));
        if(journal.id!==job.memoryRevision||!["committed","undone"].includes(journal.state)||!Array.isArray(journal.changes))throw Error("Note receipt is incomplete");
        if(journal.state==="undone")warnings.push("These note changes were undone.");
        for(const change of journal.changes)changes.push({kind:"note",action:change.before===null?"created":"updated",...(titles.has(change.id)?{id:change.id}:{}),title:titles.get(change.id)??"Note is no longer available"});
      }catch(error){warnings.push((error as NodeJS.ErrnoException).code==="ENOENT"?"The saved note receipt is unavailable; no note changes are inferred.":"The saved note receipt could not be verified; no note changes are inferred.");}
    }
    let sessionId=job.source.sessionId;
    if(!sessionId&&job.source.conversationId?.startsWith("conversation-")){try{sessionId=(await store.archive.read(job.source.conversationId)).sessionId;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
    if(!job.startedAt)warnings.push("This older or unstarted job has no recorded model start/end; only its saved job state is available.");
    entries.push({id:job.id,status:job.status,outcome:job.outcome,queuedAt:job.queuedAt,updatedAt:job.updatedAt,startedAt:job.startedAt,finishedAt:job.finishedAt,retryAt:job.retryAt,attempts:job.attempts,reason:job.reason?redactKnowledgeSecrets(job.reason):undefined,error:job.error?{...job.error,message:redactKnowledgeSecrets(job.error.message)}:undefined,previousAttempts:(job.previousAttempts??[]).map(attempt=>({...attempt,reason:attempt.reason?redactKnowledgeSecrets(attempt.reason):undefined,error:attempt.error?{...attempt.error,message:redactKnowledgeSecrets(attempt.error.message)}:undefined})),changes,warnings,source:{id:job.source.id,channel:job.source.channel,recordId:job.source.conversationId,sessionId,assets:(job.source.assets??[]).map(a=>({id:a.id,name:a.name}))}});
  }
  const starts=jobs.flatMap(j=>[j.startedAt,...(j.previousAttempts??[]).map(a=>a.startedAt)].filter((n):n is number=>n!==undefined)),ends=jobs.flatMap(j=>[j.finishedAt,...(j.previousAttempts??[]).map(a=>a.finishedAt)].filter((n):n is number=>n!==undefined));
  return {version:1,state:jobs.some(j=>j.status==="working")?"working":curator.status==="ready"&&jobs.some(j=>j.status==="failed")?"needs-attention":curator.status,enabled:curator.settings.enabled,lastStartedAt:starts.length?Math.max(...starts):undefined,lastFinishedAt:ends.length?Math.max(...ends):undefined,entries,offset,...(offset+30<jobs.length?{nextOffset:offset+30}:{}),total:jobs.length,historyNotice:"Activity comes from saved job and mutation receipts. Older runs may lack timing or retry history; missing history is not reconstructed from graph counts."};
}
