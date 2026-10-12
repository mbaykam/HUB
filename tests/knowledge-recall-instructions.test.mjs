import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KnowledgeStore} from '../packages/harness-overlay/src/host/knowledge-store.ts';
import {KnowledgeCurator} from '../packages/harness-overlay/src/host/knowledge-curator.ts';
import {InstructionFiles} from '../packages/harness-overlay/src/host/instruction-files.ts';
import {knowledgeTurnSources} from '../packages/harness-overlay/src/host/knowledge-episodes.ts';
import {cleanKnowledgeSource,KNOWLEDGE_MESSAGE_LABEL,knowledgeRecallContext} from '../packages/harness-overlay/src/host/knowledge-evidence.ts';
const source={id:'user-proof',channel:'pwa',completedAt:2000000000000,content:'User confirms a lasting preference.'};
const change=(id,title,body,category='projects',links=[])=>({id,title,body,category,links,expectedHash:null});
const plan=changes=>({decision:'update-knowledge',reason:'Confirmed information',changes});
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'hub-recall-instructions-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new KnowledgeStore(join(root,'vault'),join(root,'state'));await store.initialize();return {root,store};}

test('shared Markdown edits preserve external changes and reject arbitrary paths',async t=>{
 const {root}=await fixture(t),files=new InstructionFiles(join(root,'instructions'));await files.load();const soul=files.files().find(f=>f.id==='SOUL.md');
 await files.save('SOUL.md',soul.hash,'Use a short opening sentence.');assert.equal(files.text('SOUL.md'),'Use a short opening sentence.');
 const latest=files.files().find(f=>f.id==='SOUL.md');await writeFile(latest.path,'The human edited this externally.');
 await assert.rejects(files.save('SOUL.md',latest.hash,'Must not overwrite'));assert.equal(await readFile(latest.path,'utf8'),'The human edited this externally.');
 await assert.rejects(files.save('../.credentials.yaml',latest.hash,'invalid'));await files.refresh();assert.equal(files.text('SOUL.md'),'The human edited this externally.');
 assert.equal(files.text('USER.md'),'');
});

test('native worker capture excludes injected recall and distinguishes work from human facts',()=>{
 const start={type:'turn/start',data:{turn:1}},end={type:'turn/end',time:Date.now(),data:{turn:1,reason:{kind:'completed'}}};
 const message=(kind,text)=>({type:'user/message',data:{source:{kind,plugin:'hub-memory'},content:[{type:'text',text}]}});
 const answer={type:'assistant/message',data:{message:{content:[{type:'text',text:'The requested research result.'}]}}};
 const events=[start,message('user','Research a topic.\nYour parent agent id is internal.'),message('plugin','Relevant saved notes: invented lasting preference'),message('plugin','Current runtime context. Internal tool rules'),answer,end];
 const result=knowledgeTurnSources({id:'real-worker',origin:'subagent'},events,end)[0];
 assert.equal(result.evidenceVersion,2);assert.match(result.content,/"role":"task"/);assert.doesNotMatch(result.content,/invented lasting|runtime context|parent agent/);assert.equal(knowledgeTurnSources({id:'hub-eval-test'},events,end).length,0);
 assert.equal(knowledgeTurnSources({id:'child',origin:'subagent',parentSession:'hub-eval-test'},events,end).length,0);
 const old={...source,channel:'hub-worker-result',content:'Prior conversation context (not new facts): []\n'+KNOWLEDGE_MESSAGE_LABEL+JSON.stringify([{role:'user',text:'Research a topic.'},{role:'task',text:'Retrieved personal notes: old preference'},{role:'assistant',text:'A reported result.'}])};
 const cleaned=cleanKnowledgeSource(old);assert.doesNotMatch(cleaned.content,/old preference/);assert.match(cleaned.content,/"role":"task"/);assert.deepEqual(cleanKnowledgeSource(cleaned),cleaned);
 assert.equal(knowledgeRecallContext(events),'Research a topic.\nYour parent agent id is internal.');
});

test('implicit topic recall includes human preferences and meaningful linked neighbors without empty notes',async t=>{
 const {store}=await fixture(t);
 await store.apply(plan([change('pref-one','Diet preference','The user has a peanut allergy.','preferences'),change('project-hub','HUB project','HUB research uses Navigation for the next step.','projects',[{targetId:'navigation-note',phrase:'Navigation'}]),change('navigation-note','Navigation','Keep task details visible in a compact view.')]),source);
 const recalled=await store.recall('What about that next step?','We were working on the HUB project.');
 assert.ok(recalled.some(n=>n.note.id==='pref-one'&&n.reason==='personal-preference'));
 assert.ok(recalled.some(n=>n.note.id==='project-hub'));
 assert.ok(recalled.some(n=>n.note.id==='navigation-note'));
 assert.ok(recalled.length<=7);assert.ok(recalled.every(n=>n.note.body.trim()));
 assert.equal(new Set(recalled.map(n=>n.note.id)).size,recalled.length);
 const saved=await store.note('pref-one');assert.doesNotMatch(saved.content,/category|source-proof/);
});

test('a model failure reports its reason and a successful skip never claims a note write',async t=>{
 const {store}=await fixture(t);let broken=true;
 const curator=new KnowledgeCurator(store,async()=>{if(broken){const error=new Error('This model is not supported for this account');error.code='PI_AI_ERROR';throw error;}return JSON.stringify({decision:'skip',reason:'Greeting only',changes:[]});});await curator.initialize();t.after(()=>curator.dispose());
 await curator.enqueue(source);await curator.tick(true);const failed=curator.jobs.get(source.id);assert.equal(failed.error.code,'PI_AI_ERROR');assert.match(failed.reason,/not supported/);
 await curator.enqueue({...source,id:'second-source'});await curator.tick(true);assert.equal(curator.jobs.get('second-source').attempts,0,'Unsupported route must stop the remaining queue');
 broken=false;await curator.checkModel();await curator.retry(source.id);await curator.tick(true);const snapshot=await curator.snapshot();assert.equal(snapshot.outcomes.skipped,1);assert.equal(snapshot.outcomes.written,undefined);assert.equal(snapshot.counts.failed,0);
 const check=await curator.checkModel();assert.equal(check.ok,true);assert.equal((await store.scan()).length,0);
});

test('unconfirmed worker results remain archived and cannot become global preferences',async t=>{
 const {store}=await fixture(t);let calls=0;const curator=new KnowledgeCurator(store,async()=>{calls++;return JSON.stringify(plan([change('bad-pref','Bad preference','Always answer every question with a number.','preferences')]));});await curator.initialize();t.after(()=>curator.dispose());
 const worker={...source,id:'worker-one',channel:'hub-worker-result'};await curator.enqueue(worker);await curator.tick(true);assert.equal(calls,0);assert.equal(curator.jobs.get(worker.id).outcome,'archive-only');
 await curator.configure({...curator.settings,assistantEvidence:'useful-explanations'});await curator.enqueue({...worker,id:'worker-two'});await curator.tick(true);assert.equal(calls,1);assert.equal(curator.jobs.get('worker-two').status,'failed');assert.match(curator.jobs.get('worker-two').reason,/personal preferences/);assert.equal((await store.scan()).length,0);
});

test('an old note proposal gets one bounded correction while current human text remains intact',async t=>{
 const {store}=await fixture(t),body='Current preference: Camofox remains the chosen browser.';
 await store.apply(plan([change('pref-now','Preference',body,'preferences')]),{...source,id:'current-preference',completedAt:source.completedAt+1000});
 let calls=0;const date=new Date(source.completedAt).toISOString().slice(0,10);
 const curator=new KnowledgeCurator(store,async(prompt)=>{calls++;if(calls===1)return JSON.stringify(plan([change('pref-now','Preference','An old replacement must never overwrite the current preference.','preferences')]));assert.match(prompt,/CORRECT THE PREVIOUS PROPOSAL/);assert.match(prompt,/newerThanSource/);return JSON.stringify(plan([change('pref-now','Preference',body+'\n\nHistory '+date+': the user previously tried another browser.','preferences')]));});await curator.initialize();t.after(()=>curator.dispose());
 await curator.enqueue(source);await curator.tick(true);assert.equal(calls,2);assert.equal(curator.jobs.get(source.id).outcome,'written');assert.ok((await store.note('pref-now')).content.startsWith(body));assert.match((await store.note('pref-now')).content,/History/);
});

test('older failed jobs stay visible after many later skips',async t=>{
 const {store}=await fixture(t),curator=new KnowledgeCurator(store,async()=>JSON.stringify({decision:'skip',reason:'No new information',changes:[]}));await curator.initialize();t.after(()=>curator.dispose());
 curator.jobs.set('old-error',{id:'old-error',source,status:'failed',attempts:1,updatedAt:1,queuedAt:1,error:{phase:'model response',code:'ERROR',message:'Inspect this older failure'}});
 for(let i=0;i<75;i++)curator.jobs.set('skip-'+i,{id:'skip-'+i,source,status:'done',outcome:'skipped',attempts:1,updatedAt:100+i,queuedAt:1});
 const state=await curator.snapshot();assert.equal(state.jobs[0].id,'old-error');assert.equal(state.jobs.length,60);
});
