import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KnowledgeStore} from '../packages/harness-overlay/src/host/knowledge-store.ts';
import {KnowledgeCurator} from '../packages/harness-overlay/src/host/knowledge-curator.ts';
import {nativeConversation} from '../packages/harness-overlay/src/host/knowledge-archive.ts';
import {ProviderGate} from '../packages/harness-overlay/src/host/provider-gate.ts';

const skip=JSON.stringify({decision:'skip',reason:'No clear domain fit',changes:[]});
const quota=()=>Object.assign(Error('The usage limit has been reached'),{code:'QUOTA'});
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'hub-auto-domain-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new KnowledgeStore(join(root,'vault'),join(root,'private'));
  await store.initialize();await mkdir(join(store.vault,'Notes'),{recursive:true});
  const note=async(id,body)=>{const path=join(store.vault,'Notes',id+'.md'),raw=`---\nhub_id: ${id}\n---\n${body}`;await writeFile(path,raw);return {path,raw};};
  return {root,store,note};
}
async function drain(c){for(const job of c.jobs.values())if(job.status==='queued')job.queuedAt=Date.now()-c.settings.idleSeconds*1000-1;await c.tick();}

test('unassigned brain notes automatically receive versioned read-only passes; originals and archive stay separate',async t=>{
  const {store,note}=await fixture(t),before=await note('brain-one','I am building HUB.');
  const archive=nativeConversation({id:'personal-chat'},[{seq:0,time:Date.now(),type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'I am building HUB.'}]}}],'pwa');
  await store.archive.put(archive);let calls=0;
  const curator=new KnowledgeCurator(store,async prompt=>{
    calls++;assert.match(prompt,/Current source kind: note/);
    return JSON.stringify({version:2,expectedRegistryRevision:0,decision:'organize',reason:'Project source',domainOps:[{type:'create',ref:'new-projects',title:'Projects',evidence:'I am building HUB.'},{type:'assign',domainId:'new-projects',evidence:'I am building HUB.'}],tags:[],relations:[],reflections:[],profileSuggestions:[]});
  });
  await curator.initialize();await curator.tick();assert.equal(curator.jobs.size,1);assert.equal(calls,0);
  const job=[...curator.jobs.values()][0];assert.equal(job.source.conversationId,'brain-one');assert.equal(job.source.authorRole,'mixed');
  await drain(curator);assert.equal(calls,1);assert.equal(job.status,'done');assert.equal(job.outcome,'organized');
  const domains=await store.organization.domains();assert.equal(domains.memberships[0].nodeId,'brain-one');assert.equal(domains.memberships.length,1);
  assert.equal(await readFile(before.path,'utf8'),before.raw);assert.equal((await store.archive.read(archive.id)).messages[0].text,'I am building HUB.');
  await curator.tick();assert.equal(calls,1);assert.equal((await curator.snapshot()).organization.unassigned,0);await curator.dispose();
});

test('a considered version is not charged every scan or restart; changing its original body queues one new pass',async t=>{
  const {store,note}=await fixture(t),original=await note('brain-one','A short independent fact.');let calls=0;
  const generate=async()=>{calls++;return skip;};let c=new KnowledgeCurator(store,generate);await c.initialize();await c.tick();await drain(c);assert.equal(calls,1);assert.equal((await c.snapshot()).organization.considered,1);await c.dispose();
  c=new KnowledgeCurator(store,generate);await c.initialize();await c.tick();assert.equal(calls,1);assert.equal(c.jobs.size,1);
  await writeFile(original.path,original.raw+'\nA human correction.');await c.tick();assert.equal(c.jobs.size,2);await drain(c);assert.equal(calls,2);await c.dispose();
});

test('review mode waits for approval; manual, disabled and excluded channels never enqueue automatic note work',async t=>{
  const {store,note}=await fixture(t);await note('brain-one','I am building HUB.');let calls=0;
  const c=new KnowledgeCurator(store,async()=>{calls++;return JSON.stringify({version:1,decision:'organize',reason:'Review the topic',tags:['project'],relations:[],reflections:[],profileSuggestions:[]});});await c.initialize();
  for(const settings of [{mode:'manual'},{enabled:false},{channels:['telegram']}]){await c.configure({...c.settings,enabled:true,mode:'automatic',channels:['pwa'],...settings});await c.tick();assert.equal(c.jobs.size,0);}
  await c.configure({...c.settings,enabled:true,mode:'review',channels:['pwa']});await c.tick();await drain(c);assert.equal(calls,1);assert.equal([...c.jobs.values()][0].status,'review');assert.equal((await store.organization.state()).revisions.length,0);await c.tick();assert.equal(calls,1);await c.dispose();
});

test('long notes require a selected excerpt and exhausted budgets stop inference while leaving originals intact',async t=>{
  const {store,note}=await fixture(t),long=await note('long-note','Useful source. '.repeat(2000));await note('short-note','Useful short source.');let calls=0;
  const c=new KnowledgeCurator(store,async()=>{calls++;return skip;});await c.initialize();await c.configure({...c.settings,dailyBudget:.00000001});await c.tick();assert.equal(c.jobs.size,1);await drain(c);assert.equal(c.status,'budget-paused');assert.equal(calls,0);assert.equal((await c.snapshot()).organization.needsExcerpt,1);assert.equal(await readFile(long.path,'utf8'),long.raw);await c.dispose();
});

test('quota recovery is persisted, bounded and retries the original job after a successful small probe',async t=>{
  const {store,root}=await fixture(t),gate=new ProviderGate(join(root,'availability'));let now=Date.now(),calls=0,probeTokens;
  t.mock.method(Date,'now',()=>now);
  const generate=async(prompt,_settings,_signal,limits)=>{calls++;if(calls===1)throw quota();if(prompt.startsWith('Connection check'))probeTokens=limits.maxTokens;return skip;};
  let c=new KnowledgeCurator(store,generate,gate);await c.initialize();await c.enqueue({id:'source-quota',channel:'pwa',completedAt:now,content:'Original evidence.'});await c.tick(true);assert.equal(calls,1);const original=c.jobs.get('source-quota').source.content;await c.dispose();
  c=new KnowledgeCurator(store,generate,gate);await c.initialize();await c.tick(true);assert.equal(calls,1);assert.equal(c.status,'waiting-credit');assert.ok((await c.snapshot()).organization.retryAt>now);
  now+=15*60*1000+1;await c.tick(true);assert.equal(calls,3);assert.equal(probeTokens,512);assert.equal(c.jobs.get('source-quota').status,'done');assert.equal(c.jobs.get('source-quota').source.content,original);assert.equal(await gate.reason(c.settings.provider),undefined);await c.dispose();
});

test('failed quota probes back off across restarts rather than spending on every queued note',async t=>{
  const {store}=await fixture(t);let now=Date.now(),calls=0;t.mock.method(Date,'now',()=>now);
  const generate=async()=>{calls++;throw quota();};let c=new KnowledgeCurator(store,generate);await c.initialize();await c.enqueue({id:'source-quota',channel:'pwa',completedAt:now,content:'Original evidence.'});await c.tick(true);now+=900001;await c.tick(true);assert.equal(calls,2);await c.dispose();
  c=new KnowledgeCurator(store,generate);await c.initialize();for(let i=0;i<8;i++)await c.tick(true);assert.equal(calls,2);now+=900001;await c.tick(true);assert.equal(calls,3);assert.equal((await c.snapshot()).organization.retryAt,now+1800000);assert.equal(c.jobs.get('source-quota').attempts,1);await c.dispose();
});
