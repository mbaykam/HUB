import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KnowledgeStore,atomicJson} from '../packages/harness-overlay/src/host/knowledge-store.ts';
import {nativeConversation,conversationSources} from '../packages/harness-overlay/src/host/knowledge-archive.ts';
import {KnowledgeCurator} from '../packages/harness-overlay/src/host/knowledge-curator.ts';
import {applyKnowledge} from '../packages/harness-overlay/src/host/knowledge.ts';
import {KnowledgeImportBatches} from '../packages/harness-overlay/src/host/knowledge-import-batches.ts';
import {Context} from '@deepseek-ai/cordis';

const at=1791900000000;
const original=id=>nativeConversation({id},[{seq:0,time:at,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'I use Telegram. Türkçe de konuşurum.'}]}}],'pwa');
const plan=targetId=>({version:1,decision:'organize',reason:'Actual relationship',tags:[],relations:[{targetId,label:'Same project',evidence:'I use Telegram.'}],reflections:[],profileSuggestions:[]});
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'hub-projection-isolation-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new KnowledgeStore(join(root,'vault'),join(root,'private'));
  await store.initialize();
  const a=original('edited'),b=original('healthy');
  await store.archive.put(a);await store.archive.put(b);
  const revision=await store.organization.apply(plan(b.id),conversationSources(a)[0]);
  const state=await store.organization.state();state.revisions.find(r=>r.id===revision).projection='pending';
  await atomicJson(join(store.root,'organization.json'),state);
  const path=join(store.vault,'Conversations',a.id+'.md'),healthy=join(store.vault,'Conversations',b.id+'.md');
  const clean=await readFile(path,'utf8'),edited=clean+'Human addition must survive.\n';
  await writeFile(path,edited);
  // Put the stale record first, so an early abort would starve the healthy one.
  const scan=store.scan.bind(store);store.scan=async(...args)=>(await scan(...args)).sort((x,y)=>Number(y.id===a.id)-Number(x.id===a.id));
  await writeFile(healthy,(await readFile(healthy,'utf8')).replace(/^hub_related:.*\n/m,''));
  return {store,a,b,revision,path,healthy,clean,edited,ledger:await readFile(join(store.root,'conversations',a.id+'.json'),'utf8')};
}

test('stale projection preserves original bytes, continues healthy records, and leaves repair pending',async t=>{
  const {store,a,b,path,healthy,edited,ledger}=await fixture(t);
  const registry=await readFile(join(store.root,'organization.json'),'utf8');
  await assert.rejects(store.archive.projectRelations(a.id,[]),e=>e.code==='KNOWLEDGE_PROJECTION_DEFERRED'&&e.recordId===a.id);
  await assert.rejects(store.organization.repairPending(),e=>e.code==='KNOWLEDGE_PROJECTION_DEFERRED'&&e.recordIds.includes(a.id));
  assert.match(await readFile(healthy,'utf8'),/hub_related:/);
  assert.equal(await readFile(path,'utf8'),edited);
  assert.equal(await readFile(join(store.root,'conversations',a.id+'.json'),'utf8'),ledger);
  assert.equal(await readFile(join(store.root,'organization.json'),'utf8'),registry);
  assert.equal((await store.organization.state()).revisions[0].projection,'pending');
  assert.equal((await store.graph()).edges.some(e=>e.source===a.id&&e.target===b.id),true);
  await assert.rejects(store.archive.put({...a,updatedAt:at+1}),/edited externally/);
  assert.equal(await readFile(path,'utf8'),edited);
});

test('store and curator readiness resolve while reads work; explicit repair still refuses false success',async t=>{
  const {store,a,path,edited}=await fixture(t);
  const reopened=new KnowledgeStore(store.vault,store.root);
  await reopened.initialize();
  const curator=new KnowledgeCurator(reopened,async()=>{throw Error('No model call expected');});
  t.after(()=>curator.dispose());
  await curator.initialize();
  assert.equal(curator.status,'projection-pending');
  assert.match((await reopened.note(a.id)).content,/Human addition must survive/);
  assert.equal((await reopened.scan()).length,2);
  assert.equal((await reopened.organization.relations()).length,1);
  await assert.rejects(curator.repairProjections(),{code:'KNOWLEDGE_PROJECTION_DEFERRED'});
  assert.equal(await readFile(path,'utf8'),edited);
});

test('after an explicit external reconciliation, repair completes without another model call',async t=>{
  const {store,path,clean}=await fixture(t);
  await writeFile(path,clean);
  await store.organization.repairPending();
  assert.equal((await store.organization.state()).revisions[0].projection,'ready');
  await store.initialize();
});

test('actual Knowledge HTTP readiness survives deferred withdrawal recovery',async t=>{
  const {store,a,path,edited}=await fixture(t);
  const ledger=await store.admission.read();
  ledger.records['conversation-'+'f'.repeat(32)]={batchId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',receiptId:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',contentHash:'0'.repeat(64),state:'withdrawn',at};
  await store.admission.save(ledger);
  const handlers=new Map(),effects=[];let route;
  const ctx=new Context();Object.assign(ctx,{attachments:undefined,get:()=>undefined,on:(name,fn)=>{handlers.set(name,fn);return ()=>{};},emit:()=>{},agents:{},sessionQuery:{listSessions:async()=>[]},webServer:{register:r=>{if(r.path==='/api/hub/memory')route=r;return ()=>{};}},connection:{requestRejection:()=>undefined},effect:fn=>effects.push(fn())});
  applyKnowledge(ctx,{vault:store.vault,knowledgeRoot:store.root,captureSince:at});
  t.after(async()=>{for(const dispose of effects.reverse())if(typeof dispose==='function')await dispose();});
  let status,body;
  await route.handler({method:'GET',url:'/api/hub/memory?view=conversation&id='+a.id,headers:{'x-hub-memory':'1'}},{writeHead:code=>{status=code;},end:text=>{body=JSON.parse(text);}});
  assert.equal(status,200,JSON.stringify(body));assert.equal(body.id,a.id);
  assert.equal(await readFile(path,'utf8'),edited);
  assert.equal((await store.organization.state()).revisions[0].projection,'pending');
});

test('recovery resumes the queue after deferred batches, but explicit recovery and unsafe errors reject',async t=>{
  const {store}=await fixture(t),ledger=await store.admission.read();
  for(const [i,batchId] of ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'].entries())ledger.records['conversation-'+String(i).repeat(32)]={batchId,receiptId:batchId,contentHash:'0'.repeat(64),state:'withdrawn',at};
  await store.admission.save(ledger);
  const imports=new KnowledgeImportBatches(store,async()=>false,()=>({}));let attempts=0,resumed=0,deferrals=0;
  const deferred=Object.assign(Error('deferred'),{code:'KNOWLEDGE_PROJECTION_DEFERRED'});
  imports.finishWithdrawals=async()=>{attempts++;throw deferred;};imports.resumePendingQueue=async()=>{resumed++;return 7;};
  assert.equal(await imports.recover(()=>{deferrals++;}),7);assert.equal(attempts,2);assert.equal(deferrals,2);assert.equal(resumed,1);
  await assert.rejects(imports.recover(),e=>e===deferred);
  const unsafe=Object.assign(Error('permission failure'),{code:'EACCES'});imports.finishWithdrawals=async()=>{throw unsafe;};
  await assert.rejects(imports.recover(()=>{}),e=>e===unsafe);assert.equal(resumed,1);
});

test('unexpected projection errors still reject store and curator initialization',async t=>{
  const {store}=await fixture(t),failure=Object.assign(Error('permission failure'),{code:'EACCES'});
  store.archive.projectRelations=async()=>{throw failure;};
  await assert.rejects(store.organization.syncObsidianLinks(),e=>e===failure);
  await assert.rejects(store.initialize(),e=>e===failure);
  const curator=new KnowledgeCurator(store,async()=>{throw Error('No model call expected');});
  t.after(()=>curator.dispose());
  await assert.rejects(curator.initialize(),e=>e===failure);
  // Also cover the independent curator startup sync with no pending revisions.
  store.initialize=async()=>{};
  await assert.rejects(curator.initialize(),e=>e===failure);
});
