import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KnowledgeStore} from '../packages/harness-overlay/src/host/knowledge-store.ts';
import {nativeConversation} from '../packages/harness-overlay/src/host/knowledge-archive.ts';
import {KnowledgeCurator} from '../packages/harness-overlay/src/host/knowledge-curator.ts';
import {dropUnsupportedRelations,transientKnowledgeFailure} from '../packages/harness-overlay/src/host/knowledge-organization.ts';

const at=1791900000000;
const message=(seq,role,text)=>({seq,time:at+seq,type:role==='user'?'user/message':'assistant/message',data:role==='user'?{source:{kind:'user'},content:[{type:'text',text}]}:{message:{content:[{type:'text',text}]}}});
const chat=(id,text)=>nativeConversation({id},[message(0,'user',text),message(1,'assistant','Noted.')],'pwa');
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'hub-resilience-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new KnowledgeStore(join(root,'vault'),join(root,'private'));await store.initialize();return store;}

test('one misquoted link is dropped while verified links in the same plan are kept',()=>{
 const source={id:'s',channel:'pwa',completedAt:at,conversationId:'c-now',content:'I keep HUB on the mini PC. Telegram is my daily chat.'};
 const candidates=[{id:'c-pc',body:'The mini PC runs HUB at home.'},{id:'c-tg',body:'Telegram bot setup notes.'}];
 const plan={version:2,decision:'organize',relations:[
  {targetId:'c-pc',label:'Same machine',evidence:'I keep HUB on the mini PC.',targetEvidence:'The mini PC runs HUB at home.'},
  {targetId:'c-tg',label:'Invented quote',evidence:'Telegram is my daily chat.',targetEvidence:'Telegram is the only app.'},
  {targetId:'c-unread',label:'Never read',evidence:'Telegram is my daily chat.',targetEvidence:'Anything here.'},
  {targetId:'c-tg',label:'Source quote invented',evidence:'I never said this.',targetEvidence:'Telegram bot setup notes.'},
  {targetId:'c-now',label:'Self link',evidence:'I keep HUB on the mini PC.',targetEvidence:'The mini PC runs HUB at home.'}]};
 const dropped=dropUnsupportedRelations(plan,source,['c-pc','c-tg','c-unread','c-now'],candidates);
 assert.equal(dropped,4);
 assert.deepEqual(plan.relations.map(r=>r.targetId),['c-pc']);
 assert.equal(dropUnsupportedRelations({decision:'skip'},source,[],[]),0);
});

test('only timeouts and cut-off model answers count as transient',()=>{
 assert.equal(transientKnowledgeFailure('model response',{code:'23',message:'The operation was aborted due to timeout'}),true);
 assert.equal(transientKnowledgeFailure('model response',{code:'REFLECTION_INCOMPLETE',message:'Reflection did not complete'}),true);
 assert.equal(transientKnowledgeFailure('organization validation',{code:'23',message:'timeout'}),false);
 assert.equal(transientKnowledgeFailure('model response',{code:'QUOTA',message:'Out of credits'}),false);
 assert.equal(transientKnowledgeFailure('model response',{code:'401',message:'unauthorized'}),false);
});

test('a plan with one bad link still saves the good link and records the drop',async t=>{
 const store=await fixture(t),now=chat('link-now','I run HUB on my mini PC every day.'),earlier=chat('link-earlier','My mini PC is the HUB host at home.');
 await store.archive.put(earlier);await store.archive.put(now);
 const earlierBody=(await store.note(earlier.id)).content;const targetQuote='My mini PC is the HUB host at home.';assert.ok(earlierBody.includes(targetQuote));
 const curator=new KnowledgeCurator(store,async()=>JSON.stringify({version:2,expectedRegistryRevision:0,domainOps:[],decision:'organize',reason:'Same host machine',tags:['HUB'],
  relations:[{targetId:earlier.id,label:'Same HUB host',evidence:'I run HUB on my mini PC every day.',targetEvidence:targetQuote},
             {targetId:earlier.id,label:'Bad quote',evidence:'I run HUB on my mini PC every day.',targetEvidence:'A sentence that is not in the target.'}],
  reflections:[],profileSuggestions:[]}));
 await curator.initialize();await curator.configure({...curator.settings,mode:'manual',maxLinks:3});
 const pass=await curator.reorganize([now.id]);await curator.tick(true);
 const job=curator.jobs.get(pass.jobIds[0]);
 assert.equal(job.status,'done',job.reason);assert.equal(job.outcome,'organized');assert.equal(job.droppedRelations,1);
 assert.ok((await store.graph()).edges.some(e=>[e.source,e.target].includes(earlier.id)));
 await curator.dispose();
});

test('a model timeout is retried once automatically, then left for the owner',async t=>{
 const store=await fixture(t),c=chat('retry-chat','Please remember my HUB setup.');await store.archive.put(c);
 let calls=0;const curator=new KnowledgeCurator(store,async()=>{calls++;throw Object.assign(Error('The operation was aborted due to timeout'),{code:'23'});});
 await curator.initialize();await curator.configure({...curator.settings,mode:'manual'});
 const pass=await curator.reorganize([c.id]);const id=pass.jobIds[0];
 await curator.tick(true);
 assert.equal(calls,1);assert.equal(curator.jobs.get(id).status,'queued');assert.equal(curator.jobs.get(id).autoRetries,1);
 await curator.tick(true);
 assert.equal(calls,2);assert.equal(curator.jobs.get(id).status,'failed');assert.equal(curator.jobs.get(id).previousAttempts.length,1);
 await curator.tick(true);assert.equal(calls,2);
 await curator.dispose();
});
