import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KnowledgeStore, atomicJson, digest } from "../packages/harness-overlay/src/host/knowledge-store.ts";
import { KnowledgeCurator } from "../packages/harness-overlay/src/host/knowledge-curator.ts";
import { knowledgeActivity } from "../packages/harness-overlay/src/host/knowledge-activity.ts";
import { nativeConversation, conversationSources } from "../packages/harness-overlay/src/host/knowledge-archive.ts";

const quote="I use Telegram for my daily conversations and prefer a concise explanation.";
async function fixture(t,generate){
  const root=await mkdtemp(join(tmpdir(),"hub-activity-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new KnowledgeStore(join(root,"vault"),join(root,"private"));await store.initialize();
  const conversation=nativeConversation({id:"activity-fixture"},[{seq:0,time:Date.now(),type:"user/message",data:{source:{kind:"user"},content:[{type:"text",text:quote}]}}],"pwa");await store.archive.put(conversation);
  const source=conversationSources(conversation)[0],curator=new KnowledgeCurator(store,generate);await curator.initialize();t.after(()=>curator.dispose());return {store,source,curator,conversation};
}
const skip=JSON.stringify({decision:"skip",reason:"No durable new information",changes:[]});

test("real isolated success records model timing, committed note/tag receipts and original conversation links",async t=>{
  let c,working,calls=0;
  const f=await fixture(t,async()=>{calls++;working=await knowledgeActivity(c);return JSON.stringify({version:1,decision:"organize",reason:"Save a sourced preference",tags:["communication"],relations:[],reflections:[],profileSuggestions:[],memories:[{title:"Daily communication preference",category:"preferences",evidence:quote}]});});c=f.curator;
  const path=join(f.store.root,"conversations",f.conversation.id+".json"),before=await readFile(path,"utf8");
  await c.enqueue(f.source);await c.tick(true);
  assert.equal(working.state,"working");assert.equal(working.entries[0].finishedAt,undefined);
  const result=await knowledgeActivity(c),entry=result.entries[0];assert.equal(entry.status,"done");assert.ok(entry.startedAt<=entry.finishedAt);assert.ok(entry.changes.some(change=>change.kind==="note"&&change.action==="created"));assert.ok(entry.changes.some(change=>change.kind==="tag"&&change.title==="communication"));assert.equal(entry.source.sessionId,"activity-fixture");
  await knowledgeActivity(c);assert.equal(calls,1,"reading activity never runs curation");assert.equal(await readFile(path,"utf8"),before);
});

test("no-change, failure and retry explanations survive restart without fabricating historical timing",async t=>{
  let fail=true,calls=0;const {curator:c,store,source}=await fixture(t,async()=>{calls++;if(fail)throw Error("Synthetic transient failure");return skip;});
  await c.enqueue(source);await c.tick(true);let page=await knowledgeActivity(c);assert.equal(page.entries[0].status,"failed");assert.match(page.entries[0].error.message,/Synthetic transient/);assert.ok(page.lastFinishedAt);
  await c.retry(source.id);fail=false;await c.tick(true);page=await knowledgeActivity(c);assert.equal(page.entries[0].outcome,"skipped");assert.deepEqual(page.entries[0].changes,[]);assert.equal(page.entries[0].previousAttempts[0].status,"failed");assert.match(page.entries[0].previousAttempts[0].reason,/Synthetic transient/);assert.ok(page.entries[0].retryAt);assert.equal(calls,2);
  const restored=new KnowledgeCurator(store,async()=>{throw Error("must not call model");});await restored.initialize();t.after(()=>restored.dispose());assert.equal((await knowledgeActivity(restored)).entries[0].previousAttempts.length,1);
  const old={id:"older-job",source:{...source,id:"older-source"},status:"done",attempts:2,updatedAt:Date.now()+1,queuedAt:1,outcome:"skipped"};await atomicJson(join(store.root,"jobs",digest(old.id)+".json"),old);restored.jobs.set(old.id,old);
  const historical=(await knowledgeActivity(restored)).entries.find(entry=>entry.id===old.id);assert.equal(historical.startedAt,undefined);assert.equal(historical.finishedAt,undefined);assert.equal(historical.changes.length,0);assert.match(historical.warnings.join(" "),/no recorded model start/);
});

test("empty activity stays empty and malformed page or receipt errors remain explicit",async t=>{
  const {curator:c,source,store}=await fixture(t,async()=>skip);const page=await knowledgeActivity(c);assert.equal(page.total,0);assert.deepEqual(page.entries,[]);assert.match(page.historyNotice,/not reconstructed/);await assert.rejects(knowledgeActivity(c,-1),/Invalid activity/);
  const revision="11111111-1111-4111-8111-111111111111";c.jobs.set("damaged",{id:"damaged",source,status:"done",attempts:1,queuedAt:1,updatedAt:Date.now(),memoryRevision:revision,previousAttempts:[{attempt:1,status:"failed",reason:"Bearer do-not-display",error:{code:"TEST",phase:"model response",message:"api_key=private-value"}}]});await atomicJson(join(store.root,"journal",revision+".json"),{id:revision,state:"prepared",changes:[]});const damaged=(await knowledgeActivity(c)).entries[0];assert.equal(damaged.changes.length,0);assert.match(damaged.warnings.join(" "),/could not be verified/);assert.doesNotMatch(JSON.stringify(damaged.previousAttempts),/do-not-display|private-value/);
});

test("domain assignments and links are listed from committed audits, not proposed operations or graph totals",async t=>{
  let calls=0;const {curator:c,store}=await fixture(t,async()=>{calls++;return JSON.stringify({version:2,expectedRegistryRevision:0,decision:"organize",reason:"Organize the project record",tags:["project"],domainOps:[{type:"create",ref:"new-projects",title:"Projects",evidence:"I am building HUB."},{type:"assign",domainId:"new-projects",evidence:"I am building HUB."}],relations:[{targetId:"related-project",label:"project context",predicate:"project context",direction:"directed",evidence:"I am building HUB.",targetEvidence:"HUB is a software project."}],reflections:[],profileSuggestions:[]});});
  await mkdir(join(store.vault,"Notes"),{recursive:true});await writeFile(join(store.vault,"Notes/brain-one.md"),"---\nhub_id: brain-one\n---\nI am building HUB.");await writeFile(join(store.vault,"Notes/related-project.md"),"---\nhub_id: related-project\n---\nHUB is a software project.");await c.configure({...c.settings,mode:"manual"});await c.reorganize(["brain-one"]);await c.tick(true);
  const entry=(await knowledgeActivity(c)).entries[0];assert.equal(entry.status,"done",entry.reason);assert.ok(entry.changes.some(change=>change.kind==="domain"&&change.action==="created"&&change.title==="Projects"));assert.ok(entry.changes.some(change=>change.kind==="assignment"&&change.title.endsWith("→ Projects")));assert.ok(entry.changes.some(change=>change.kind==="link"&&change.targetId==="related-project"));assert.equal(calls,1);
});
