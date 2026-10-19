import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {KnowledgeStore,digest} from '../packages/harness-overlay/src/host/knowledge-store.ts';
import {KnowledgeCurator} from '../packages/harness-overlay/src/host/knowledge-curator.ts';
import {nativeConversation,conversationSources} from '../packages/harness-overlay/src/host/knowledge-archive.ts';
import {distillMemories,validateMemories} from '../packages/harness-overlay/src/host/knowledge-distillation.ts';
import {defaultKnowledgeSettings} from '../packages/harness-overlay/src/knowledge-contract.ts';
const quote='I use Telegram for my daily conversations. Türkçe ve İngilizce konuşurum.';
const memory={title:'Daily conversation channels and languages',category:'preferences',evidence:quote};
const plan={version:1,decision:'organize',reason:'A durable user preference',tags:[],relations:[],reflections:[],profileSuggestions:[],memories:[memory]};
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'hub-eval-distill-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new KnowledgeStore(join(root,'vault'),join(root,'private'));await store.initialize();const at=Date.now();const conversation=nativeConversation({id:'personal-sourced-test'},[{seq:0,time:at,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:quote}]}},{seq:1,time:at+1,type:'assistant/message',data:{message:{content:[{type:'text',text:'You probably live in Berlin.'}]}}}],'voice');await store.archive.put(conversation);const source=conversationSources(conversation)[0];return {root,store,conversation,source};}

test('selected facts become standalone source-linked brain notes without changing the archived messages',async t=>{
 const {store,source,conversation}=await fixture(t),path=join(store.root,'conversations',conversation.id+'.json'),before=await readFile(path,'utf8');
 const result=await distillMemories(store,plan,source,defaultKnowledgeSettings);assert.equal(result.count,1);
 const notes=await store.scan(),note=notes.find(n=>n.kind!=='conversation');assert.equal(notes.length,2);assert.equal(note.body.trim(),quote);
 assert.equal((await store.note(note.id)).sources[0].conversationId,conversation.id);assert.ok((await store.graph()).edges.some(e=>e.source===note.id&&e.target===conversation.id));
 assert.equal(await readFile(path,'utf8'),before);assert.equal((await store.organization.domains()).memberships.some(m=>m.nodeId===conversation.id),false);
 assert.deepEqual(await distillMemories(store,plan,source,defaultKnowledgeSettings),result);
 await store.undo(result.revision);assert.equal((await store.scan()).filter(n=>n.kind!=='conversation').length,0);
 assert.equal((await distillMemories(store,plan,source,defaultKnowledgeSettings)).count,0);assert.equal(await readFile(path,'utf8'),before);
});

test('another chat or paraphrased title cannot duplicate an already quoted fact or rewrite a human note',async t=>{
 const {store,source}=await fixture(t);await distillMemories(store,plan,source,defaultKnowledgeSettings);const before=(await store.scan()).find(n=>n.kind!=='conversation');
 const again=await distillMemories(store,{...plan,memories:[{...memory,title:'Another title'}]},{...source,id:'another-episode'},defaultKnowledgeSettings);
 assert.equal(again.count,0);assert.equal((await store.scan()).filter(n=>n.kind!=='conversation').length,1);assert.equal((await store.scan()).find(n=>n.id===before.id).raw,before.raw);
});

test('invented user facts, assistant statements, background context and credentials are rejected',async t=>{
 const {source}=await fixture(t);
 for(const bad of [{...memory,evidence:'You probably live in Berlin.'},{...memory,evidence:'I have a different private fact.'}])assert.throws(()=>validateMemories([bad],source),/genuine user/);
 assert.throws(()=>validateMemories([memory],{...source,channel:'hub-worker-result'}),/genuine user/);
 assert.throws(()=>validateMemories([{...memory,evidence:'password=synthetic-long-private-value'}],{...source,spans:undefined,authorRole:'user',content:'password=synthetic-long-private-value'}),/Credentials/);
 assert.throws(()=>validateMemories([{...memory,body:'An invented summary'}],source),/genuine user/);
});

test('one normal curator pass handles extraction and review; no extra extraction model call',async t=>{
 const {store,source}=await fixture(t);let calls=0;const curator=new KnowledgeCurator(store,async prompt=>{calls++;assert.match(prompt,/SOURCED MEMORY EXTRACTION/);return JSON.stringify(plan);});await curator.initialize();t.after(()=>curator.dispose());
 await curator.configure({...curator.settings,mode:'review'});await curator.enqueue(source);await curator.tick(true);const job=curator.jobs.get(source.id);assert.equal(job.status,'review');assert.equal(calls,1);assert.equal((await store.scan()).length,1);
 const review=await curator.review(job.id);assert.equal(review.plan.memories[0].evidence,quote);await curator.decideReview(job.id,true);assert.equal(calls,1);assert.equal(job.memoryCount,1);assert.ok(job.memoryRevision);assert.equal(job.status,'done');
 assert.equal((await store.scan()).length,2);
 await curator.undoNote(job.memoryRevision);assert.equal((await store.scan()).length,1);assert.equal(job.memoryRevision,undefined);assert.equal(job.memoryCount,0);assert.equal(calls,1);
});

test('disabled extraction and category settings fail closed before original text can change',async t=>{
 const {store,source}=await fixture(t);await assert.rejects(distillMemories(store,plan,source,{...defaultKnowledgeSettings,extractMemories:false}),/disabled/);
 await assert.rejects(distillMemories(store,plan,source,{...defaultKnowledgeSettings,categories:['projects']}),/category/);assert.equal((await store.scan()).length,1);
});

test('withdrawing an imported source also removes its derived memory from recall, without deleting any bytes',async t=>{
 const {store,source,conversation}=await fixture(t);const state=await store.admission.read();state.records[conversation.id]={batchId:randomUUID(),receiptId:randomUUID(),contentHash:digest(quote),state:'admitted',at:Date.now()};state.revision++;await store.admission.save(state);
 await distillMemories(store,plan,source,defaultKnowledgeSettings);assert.equal((await store.scan()).length,2);
 state.records[conversation.id].state='withdrawn';state.revision++;await store.admission.save(state);assert.equal((await store.scan()).length,0);assert.equal((await store.scan(undefined,true)).length,2);assert.equal((await store.recall('Telegram')).length,0);
 await assert.rejects(distillMemories(store,plan,{...source,id:'a-new-source'},defaultKnowledgeSettings),/withdrawn|staged/);
});

test('retry after a note write fails reuses the validated response without another model request',async t=>{
 const {store,source}=await fixture(t);let calls=0;const curator=new KnowledgeCurator(store,async()=>{calls++;return JSON.stringify(plan);});await curator.initialize();t.after(()=>curator.dispose());
 const apply=store.apply.bind(store);let fail=true;store.apply=async(...args)=>{if(fail){fail=false;throw Error('Simulated disk interruption');}return apply(...args);};
 await curator.enqueue(source);await curator.tick(true);const job=curator.jobs.get(source.id);assert.equal(job.status,'failed');assert.equal(job.error.phase,'memory extraction');
 await curator.retryFailed();assert.equal(job.status,'done');assert.equal(job.memoryCount,1);assert.equal(calls,1);assert.equal((await store.scan()).length,2);
});
