import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {PlannerStore,installPlanner} from '../packages/harness-overlay/src/host/planner.ts';
import {plannerDay,plannerItemDay} from '../packages/harness-overlay/src/planner-contract.ts';
const draft=(extra={})=>({id:randomUUID(),version:0,kind:'todo',title:'Read the fixture brief',details:'',horizon:'near',timeZone:'Europe/Istanbul',...extra});
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'hub-eval-planner-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new PlannerStore(root);await store.load();return{root,store};}

test('personal task edits, completion, recoverable removal and independent plans survive a restart',async t=>{
 const {root,store}=await fixture(t),created=await store.change({action:'save',item:draft()},'fixture-chat');
 const replay=await store.change({action:'save',item:draft({id:created.id,title:created.title})},'fixture-chat');assert.equal(replay.version,1);assert.equal(store.snapshot().items.length,1,'A lost creation response can be retried without a duplicate');
 await store.plan({sessionId:'fixture-chat',rootSessionId:'fixture-chat',version:0,title:'Agent work',steps:[{title:'Inspect the brief',state:'active'}]});
 const updated=await store.change({action:'save',item:{...draft({id:created.id,version:created.version}),title:'Read it tomorrow',horizon:'later'}});assert.equal(updated.version,2);assert.equal(store.snapshot().items.length,1);assert.equal(store.snapshot('fixture-chat').plans.length,1);
 await assert.rejects(store.change({action:'remove',id:created.id,version:1}),/changed/);
 let current=await store.change({action:'complete',id:created.id,version:2});assert.equal(current.state,'done');current=await store.change({action:'remove',id:current.id,version:current.version});assert.equal(current.deleted,true);
 const resumed=new PlannerStore(root);await resumed.load();current=await resumed.change({action:'restore',id:current.id,version:current.version});assert.equal(current.deleted,false);assert.equal(current.state,'done');assert.equal(current.sourceSessionId,'fixture-chat');
 assert.equal(resumed.snapshot('unrelated-chat').plans.length,0);await resumed.settle('fixture-chat',false);assert.equal(resumed.snapshot('fixture-chat').plans[0].state,'paused','Ending a turn cannot certify unfinished work');
});

test('calendar dates use the selected zone, UTC storage, valid ranges and dates instead of the host day',async t=>{
 const {store}=await fixture(t);assert.equal(plannerDay(new Date('2026-10-20T22:00:00Z'),'Europe/Istanbul'),'2026-10-21');
 const meeting=await store.change({action:'save',item:draft({kind:'event',start:'2026-10-21T00:30:00+03:00',end:'2026-10-21T01:30:00+03:00'})});assert.equal(meeting.start,'2026-10-20T21:30:00.000Z');assert.equal(plannerItemDay(meeting),'2026-10-21');
 for(const item of [draft({kind:'event'}),draft({date:'2026-02-31'}),draft({start:'2026-10-21T12:00'}),draft({start:'2026-10-21T12:00Z',end:'2026-10-21T11:00Z'}),draft({timeZone:'Invented/Zone'})])await assert.rejects(store.change({action:'save',item}));
 assert.equal(store.snapshot().items.length,1);
});

test('concurrent item updates cannot overwrite a newer edit; multiple active plan steps and lineage changes are rejected',async t=>{
 const {store}=await fixture(t),created=await store.change({action:'save',item:draft()}),item=draft({id:created.id,version:1});
 const replies=await Promise.allSettled([store.change({action:'save',item:{...item,title:'First edit'}}),store.change({action:'save',item:{...item,title:'Second edit'}})]);assert.equal(replies.filter(r=>r.status==='fulfilled').length,1);
 await assert.rejects(store.plan({sessionId:'worker',rootSessionId:'root',version:0,title:'Plan',steps:[{title:'One',state:'active'},{title:'Two',state:'active'}]}));
 await store.plan({sessionId:'worker',rootSessionId:'root',version:0,title:'Plan',steps:[{title:'One',state:'done'}]});await assert.rejects(store.plan({sessionId:'worker',rootSessionId:'other',version:1,title:'Changed lineage',steps:[]}));assert.equal(store.snapshot('root').plans[0].state,'completed');
});

test('agent tools bind plans to actual durable parents and enforce unchanged per-character permissions; API requires native auth',async t=>{
 const {root}=await fixture(t),tools=new Map(),routes=new Map(),events=new Map();let guide;const allowed={id:randomUUID(),tools:{mode:'inherit'}},blocked={id:randomUUID(),tools:{mode:'allow',names:[]}};
 const main={id:'fixture-main',session:{header:{id:'fixture-main'}}},worker={id:'fixture-worker',session:{header:{id:'fixture-worker',parentSession:'fixture-main',origin:'subagent'}}};
 const ctx={tools:{register(t){tools.set(t.name,t);return()=>tools.delete(t.name)}},agents:{get:id=>id===main.id?main:undefined},hubCharacters:{effectiveCharacter:id=>id==='blocked'?blocked:allowed},sessionPersistence:{async inspect(id){assert.equal(id,'fixture-main');return{meta:main.session.header}}},
  systemPrompt:{section(s){guide=typeof s.text==="function"?s.text({}):s.text;return()=>{}}},on(name,fn){events.set(name,fn);return()=>{}},connection:{requestRejection:r=>r.headers.authorization==='Bearer fixture'?undefined:401},webServer:{register(r){routes.set(r.path,r);return()=>{}}}};
 const dispose=installPlanner(ctx,{store:{root:join(root,'characters')}});t.after(dispose);assert.match(guide,/personal commitments/);
 const tool=tools.get('hub_work_plan'),signal=new AbortController().signal;
 const created=await tool.execute({action:'update',version:0,title:'Fixture research',steps:[{title:'Read source',state:'active'}]},{agent:worker,signal});assert.equal(created.rootSessionId,'fixture-main');assert.equal(created.sessionId,'fixture-worker');
 await assert.rejects(tool.execute({action:'read'},{agent:{id:'blocked',session:{header:{id:'blocked'}}},signal}),/disabled/);assert.deepEqual(blocked.tools.names,[]);
 const server=createServer((req,res)=>void routes.get('/api/hub/planner').handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.close();await once(server,'close');});
 const url=`http://127.0.0.1:${server.address().port}/api/hub/planner?sessionId=fixture-main`,headers={authorization:'Bearer fixture','x-hub-planner':'1'};
 assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{headers:{...headers,'sec-fetch-site':'cross-site'}})).status,403);
 const state=await(await fetch(url,{headers})).json();assert.equal(state.plans[0].title,'Fixture research');assert.deepEqual(state.items,[]);assert.equal(JSON.parse(await readFile(join(root,'hub-planner','planner.json'),'utf8')).plans.length,1);
});

test('native checklists preserve worker lineage and parallel steps, pause unfinished work and clear without personal items',async t=>{
 const {root}=await fixture(t),routes=new Map(),events=new Map(),main={id:'fixture-main',session:{header:{id:'fixture-main'}}};
 const ctx={tools:{register(){return()=>{}}},agents:{get:id=>id===main.id?main:undefined},sessionPersistence:{async inspect(id){assert.equal(id,main.id);return{meta:main.session.header}}},systemPrompt:{section(){return()=>{}}},on(name,handler){events.set(name,handler);return()=>{}},connection:{requestRejection:()=>undefined},webServer:{register(route){routes.set(route.path,route);return()=>{}}}};
 const dispose=installPlanner(ctx,{store:{root:join(root,'characters')}});t.after(dispose);
 const server=createServer((req,res)=>void routes.get('/api/hub/planner').handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.close();await once(server,'close');});
 const snapshot=async()=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/hub/planner?sessionId=fixture-main`,{headers:{'x-hub-planner':'1'}});assert.equal(response.status,200);return response.json();};
 const worker={header:{id:'fixture-worker',parentSession:main.id,origin:'subagent'}},emit=event=>events.get('session/event')(worker,event),longTitle='Check each source before writing the result. '.repeat(12);
 emit({type:'todo/write',data:{todos:[{content:longTitle,status:'in_progress'},{content:'Compare independent evidence',status:'in_progress'}]}});
 let state=await snapshot();assert.equal(state.plans.length,1);assert.equal(state.plans[0].sessionId,worker.header.id);assert.equal(state.plans[0].rootSessionId,main.id);assert.equal(state.plans[0].steps.filter(s=>s.state==='active').length,2);assert.match(state.plans[0].steps[0].title,/…$/);assert.equal(state.items.length,0);
 emit({type:'turn/end',data:{reason:{kind:'completed'}}});state=await snapshot();assert.equal(state.plans[0].state,'paused','Finished agent turn is not proof that checklist steps succeeded');
 emit({type:'todo/write',data:{todos:[]}});state=await snapshot();assert.equal(state.plans[0].state,'completed');assert.deepEqual(state.plans[0].steps,[]);assert.equal(state.items.length,0);
});
