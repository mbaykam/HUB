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

test('empty legacy memory files are not unassigned brain records or automatic model work',async t=>{
 const {store,note}=await fixture(t);await note('empty-memory',' \r\n\t');await note('real-note','A useful original note.');
 const c=new KnowledgeCurator(store,async()=>skip);await c.initialize();await c.tick();assert.equal(c.jobs.size,1);assert.equal((await c.snapshot()).organization.unassigned,1);await c.dispose();
});

test('a focused retry uses only domain IDs, preserves notes, and cannot write links or profile suggestions',async t=>{
 const {store,note}=await fixture(t),original=await note('brain-one','I am building HUB.');let unsafe=true;
 const c=new KnowledgeCurator(store,async prompt=>{
  assert.match(prompt,/DOMAIN ASSIGNMENT pass only/);assert.match(prompt,/current record ID and related note IDs are NEVER domain IDs/);assert.match(prompt,/create BEFORE assign/);
  return JSON.stringify({version:2,expectedRegistryRevision:0,decision:'organize',reason:'Project classification',tags:[],domainOps:[{type:'create',ref:'new-projects',title:'Projects',evidence:'building HUB.'},{type:'assign',domainId:'new-projects',evidence:'building HUB.'}],relations:[],reflections:unsafe?[{scope:'user',observation:'Unrequested profile inference',evidence:'building HUB.'}]:[],profileSuggestions:[]});
 });await c.initialize();const pass=await c.reorganize(['brain-one'],[],'domains');await c.tick(true);assert.equal(c.jobs.get(pass.jobIds[0]).status,'failed');assert.equal((await store.organization.domains()).domains.length,0);
 unsafe=false;await c.retry(pass.jobIds[0]);await c.tick(true);assert.equal(c.jobs.get(pass.jobIds[0]).outcome,'organized');assert.equal((await store.organization.domains()).memberships[0].nodeId,'brain-one');assert.equal(await readFile(original.path,'utf8'),original.raw);await c.dispose();
});

test('model-declared local slugs resolve a new hierarchy, while note IDs and dangling targets remain invalid',async t=>{
 const {store,note}=await fixture(t),original=await note('brain-one','I am building HUB.');let variant='local';
 const c=new KnowledgeCurator(store,async()=>JSON.stringify({version:2,expectedRegistryRevision:0,decision:'organize',reason:'Source classification',tags:[],domainOps:variant==='local'?[{type:'create',ref:'personal-knowledge-system',title:'Projects',evidence:'building HUB.'},{type:'create',ref:'agent-file-settings',title:'HUB',parentId:'personal-knowledge-system',evidence:'building HUB.'},{type:'assign',domainId:'agent-file-settings',evidence:'building HUB.'}]:[{type:'create',ref:variant==='note'?'brain-one':'new-valid',title:'Do not commit',evidence:'building HUB.'},{type:'assign',domainId:variant==='note'?'brain-one':'undeclared-domain',evidence:'building HUB.'}],relations:[],reflections:[],profileSuggestions:[]}));
 await c.initialize();await c.configure({...c.settings,mode:'manual'});
 for(const mode of ['note','missing']){variant=mode;const failed=await c.reorganize(['brain-one'],[],'domains');await c.tick(true);assert.equal(c.jobs.get(failed.jobIds[0]).status,'failed');assert.equal((await store.organization.domains()).domains.length,0);}
 variant='local';const pass=await c.reorganize(['brain-one'],[],'domains');await c.tick(true);assert.equal(c.jobs.get(pass.jobIds[0]).outcome,'organized');const registry=await store.organization.domains(),parent=registry.domains.find(d=>d.title==='Projects'),child=registry.domains.find(d=>d.title==='HUB');assert.equal(child.parentId,parent.id);assert.equal(registry.memberships[0].domainId,child.id);assert.equal(registry.memberships[0].nodeId,'brain-one');assert.equal(await readFile(original.path,'utf8'),original.raw);await c.dispose();
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

test('changing the curator route requeues old credit waits without a call, preserves other failures and respects budgets',async t=>{
 const {store,root}=await fixture(t),gate=new ProviderGate(join(root,'availability'));let calls=0;
 const c=new KnowledgeCurator(store,async(_prompt,settings)=>{calls++;if(settings.provider==='openai-codex'){if(calls===1)return 'not JSON';throw quota();}return skip;},gate);
 await c.initialize();await c.configure({...c.settings,provider:'openai-codex',model:'old-fixture'});
 await c.enqueue({id:'bad-output',channel:'pwa',completedAt:Date.now(),content:'Keep this original malformed-response source.'});await c.tick(true);
 await c.enqueue({id:'credit-wait',channel:'pwa',completedAt:Date.now(),content:'Keep this original quota source.'});await c.tick(true);
 assert.equal(c.jobs.get('bad-output').status,'failed');assert.equal(c.jobs.get('credit-wait').status,'waiting-credit');assert.equal(calls,2);
 await c.configure({...c.settings,instructions:'An unrelated instruction edit.'});assert.equal(c.jobs.get('credit-wait').status,'waiting-credit');assert.equal(calls,2);
 await c.configure({...c.settings,provider:'openrouter',model:'glm-fixture',dailyBudget:.00000001});assert.equal(c.jobs.get('credit-wait').status,'queued');assert.equal(c.jobs.get('bad-output').status,'failed');assert.equal(calls,2);
 assert.ok(await gate.reason('openai-codex'));assert.equal(await gate.reason('openrouter'),undefined);
 await c.tick(true);assert.equal(calls,2);assert.equal(c.status,'budget-paused');
 await c.configure({...c.settings,dailyBudget:1});await c.tick(true);assert.equal(calls,3);assert.equal(c.jobs.get('credit-wait').status,'done');assert.equal(c.jobs.get('credit-wait').source.content,'Keep this original quota source.');assert.equal((await store.scan()).length,0);await c.dispose();
});
