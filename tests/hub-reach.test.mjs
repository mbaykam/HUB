import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativePushStore,parsePushPreferences,quietRelease,pushAlert,DEFAULT_PUSH_PREFERENCES} from '../packages/harness-overlay/src/host/native-push.ts';
import {assistantExcerpt,turnMilliseconds,approvalEvent} from '../packages/harness-overlay/src/host/notification-sources.ts';
import {AppsStore,publishToHereNow} from '../packages/harness-overlay/src/host/apps.ts';
import {unarchiveSession} from '../packages/harness-overlay/src/host/archive-web.ts';

const temp=async()=>mkdtemp(join(tmpdir(),'hub-reach-'));

test('preferences are validated and quiet hours hold all but time-sensitive alerts',()=>{
 const prefs=parsePushPreferences({quiet:{enabled:true,start:'22:00',end:'07:00'},timeZone:'UTC'});
 assert.equal(prefs.kinds.reply,true);assert.equal(prefs.reminderMinutes,15);
 for(const bad of [{kinds:{spam:true}},{quiet:{enabled:true,start:'25:00',end:'07:00'}},{timeZone:'Mars/Base'},{reminderMinutes:7}])assert.throws(()=>parsePushPreferences(bad));
 const night=Date.UTC(2026,10,18,23,30),day=Date.UTC(2026,10,18,12,0);
 assert.equal(quietRelease(night,prefs,'active'),Date.UTC(2026,10,19,7,0));
 assert.equal(quietRelease(night,prefs,'time-sensitive'),night);
 assert.equal(quietRelease(day,prefs,'active'),day);
 assert.equal(quietRelease(night,{...prefs,quiet:{...prefs.quiet,enabled:false}},'active'),night);
});

test('each kind gets sensible text, buttons and urgency',()=>{
 assert.deepEqual(pushAlert({id:'a',sessionId:'s',kind:'approval',status:'attention'}),{title:'Approval needed',body:'Something is waiting for you in HUB.',category:'approval',level:'time-sensitive'});
 assert.equal(pushAlert({id:'b',sessionId:'s',kind:'brief',status:'info',title:'Your day',body:'x'}).level,'passive'.replace('passive','passive'));
 assert.equal(pushAlert({id:'c',sessionId:'s',kind:'task',status:'completed'}).body,'Your task is ready in HUB.');
 assert.equal(pushAlert({id:'d',sessionId:'s',kind:'assistant',status:'info',title:'Hi',body:'Q?',category:'reply'}).category,'reply');
});

test('turned-off kinds are dropped and quiet hours delay delivery without dropping it',async()=>{
 const root=await temp();let clock=Date.UTC(2026,10,18,23,0);const sent=[];
 try{
  const store=new NativePushStore(root,async(_d,delivery)=>{sent.push(delivery.event.id);return 'sent';},()=>clock);await store.initialize();
  await store.register({id:'11111111-1111-4111-8111-111111111111',token:'ab'.repeat(32),origin:'https://hub.example',generation:1,environment:'production'});
  await store.setPreferences({kinds:{brief:false},quiet:{enabled:true,start:'22:00',end:'07:00'},timeZone:'UTC'});
  assert.equal(await store.publish({id:'brief:1',sessionId:'hub-agenda',kind:'brief',status:'info'}),false);
  assert.equal(await store.publish({id:'reply:1',sessionId:'chat',kind:'reply',status:'completed',body:'Done'}),true);
  assert.equal(await store.publish({id:'approval:1',sessionId:'chat',kind:'approval',status:'attention'}),true);
  assert.deepEqual(sent,['approval:1'],'only the time-sensitive approval goes out at night');
  clock=Date.UTC(2026,10,19,7,5);await store.tick();
  assert.deepEqual(sent,['approval:1','reply:1']);
  assert.equal(store.snapshot().preferences.kinds.brief,false);
  await store.remember('brief:2026-11-19');assert.ok(store.remembered('brief:2026-11-19'));
  const reopened=new NativePushStore(root,async()=>'sent',()=>clock);await reopened.initialize();
  assert.equal(reopened.preferences().quiet.enabled,true,'preferences survive a restart');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('the last assistant words become a short plain excerpt, and turns are timed',()=>{
 const events=[{type:'turn/start',time:1000},{type:'user/message',data:{content:'hi'}},
  {type:'assistant/message',time:30000,data:{message:{content:[{type:'text',text:'## Result\n**Saved** the [report](https://x) and ```js\ncode\n``` here.'}]}}},{type:'turn/end',time:31000}];
 assert.equal(assistantExcerpt(events),'Result Saved the report and [code] here.');
 assert.equal(turnMilliseconds(events),30000);
 assert.ok(Number.isNaN(turnMilliseconds([{type:'turn/end'}])));
 assert.ok(assistantExcerpt([{type:'assistant/message',data:{content:'word '.repeat(100)}}]).length<=220);
});

test('a goal awaiting approval becomes an Approve/Deny notification with its ids',()=>{
 const event=approvalEvent({id:'g1',title:'Pay invoice',revision:3,cycles:[{sessionId:'goal-chat'}],approvals:[{id:'a1',status:'pending',revision:3,description:'Send 20 EUR to ACME'}]});
 assert.equal(event.kind,'approval');assert.equal(event.category,'approval');assert.deepEqual(event.data,{goalId:'g1',approvalId:'a1',revision:3});
 assert.equal(approvalEvent({id:'g1',revision:4,cycles:[{sessionId:'s'}],approvals:[{id:'a1',status:'pending',revision:3}]}),undefined,'a stale approval is not offered');
});

test('apps are saved, updated in place, renamed and removed',async()=>{
 const root=await temp();
 try{
  const store=new AppsStore(root);await store.load();
  const app=await store.save({title:'  Tip  calculator ',html:'<!doctype html><p>hi</p>',icon:'🧮'});
  assert.equal(app.title,'Tip calculator');assert.equal(app.icon,'🧮');assert.match(app.color,/^#/);
  assert.equal(await store.html(app.id),'<!doctype html><p>hi</p>');
  const updated=await store.save({id:app.id,title:'Tip calculator',html:'<p>v2</p>'});
  assert.equal(updated.createdAt,app.createdAt);assert.equal(store.list().length,1);
  await assert.rejects(store.save({title:'x',html:'no markup'}),/HTML/);
  await assert.rejects(store.save({title:'',html:'<p></p>'}),/title/);
  await assert.rejects(store.save({id:'00000000-0000-4000-8000-000000000000',title:'x',html:'<p></p>'}),/Unknown/);
  assert.equal((await store.rename(app.id,'Tips')).title,'Tips');
  const again=new AppsStore(root);await again.load();assert.equal(again.list()[0].title,'Tips');
  await store.remove(app.id);await assert.rejects(store.html(app.id));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('here.now publishing follows create, upload, finalize; expiry depends on the key',async()=>{
 const calls=[];
 const fake=async(url,init)=>{calls.push({url,method:init.method,auth:init.headers?.authorization,body:init.body});
  if(url==='https://here.now/api/v1/publish')return new Response(JSON.stringify({slug:'bright-otter',siteUrl:'https://bright-otter.here.now/',requiresFinalize:true,upload:{versionId:'v1',finalizeUrl:'https://here.now/api/v1/publish/bright-otter/finalize',uploads:[{path:'index.html',method:'PUT',url:'https://r2.example/put',headers:{'content-type':'text/html; charset=utf-8'}}]}}),{status:200});
  return new Response('{}',{status:200});};
 const anonymous=await publishToHereNow('<p>hi</p>',{title:'Hi',ttlSeconds:7*86400},fake);
 assert.equal(anonymous.url,'https://bright-otter.here.now/');assert.equal(anonymous.anonymous,true);
 assert.ok(anonymous.expiresAt-anonymous.createdAt<=86400000,'without a key a link lasts at most a day');
 assert.deepEqual(calls.map(c=>c.method+' '+c.url),['POST https://here.now/api/v1/publish','PUT https://r2.example/put','POST https://here.now/api/v1/publish/bright-otter/finalize']);
 assert.equal(JSON.parse(calls[0].body).ttlSeconds,undefined);
 calls.length=0;
 const owned=await publishToHereNow('<p>hi</p>',{title:'Hi',ttlSeconds:3*86400,apiKey:'k'.repeat(20)},fake);
 assert.equal(owned.anonymous,false);assert.equal(JSON.parse(calls[0].body).ttlSeconds,3*86400);assert.equal(calls[0].auth,'Bearer '+'k'.repeat(20));
 await assert.rejects(publishToHereNow('<p></p>',{title:'x',ttlSeconds:60},async()=>new Response('{}',{status:429})),/rate limiting/);
});

test('unarchive uses the registry write path and is a no-op for active chats',async()=>{
 let state={archivedSessionIds:['a','b'],workspaceIds:[]};const writes=[];
 const registry={requireState:()=>state,setState:async next=>{writes.push(next);state=next;},enqueueOperation:operation=>operation()};
 await unarchiveSession(registry,'a');assert.deepEqual(state.archivedSessionIds,['b']);
 await unarchiveSession(registry,'zzz');assert.equal(writes.length,1);
 await assert.rejects(unarchiveSession(registry,'bad id'),/Invalid/);
 await assert.rejects(unarchiveSession({},'a'),/cannot unarchive/);
});
