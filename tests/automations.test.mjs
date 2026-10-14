import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AutomationsStore,nextOccurrence,validateAutomation} from '../packages/harness-overlay/src/host/automations-store.ts';
import {defaultAutomation} from '../packages/harness-overlay/src/automation-contract.ts';
import {operationFailure} from '../packages/harness-overlay/src/host/operation-failure.ts';
import {isPublicAddress,readPublicWatch} from '../packages/harness-overlay/src/host/automations.ts';
const start=Date.parse('2026-10-14T09:00:00Z');
const input=(extra={})=>({...defaultAutomation,title:'Fixture task',prompt:'Read and report an observed result.',characterId:'main-id',trigger:{kind:'once',at:start+1000},...extra});
async function fixture(t,ports={}){const root=await mkdtemp(join(tmpdir(),'hub-automations-'));t.after(()=>rm(root,{recursive:true,force:true}));let now=start,calls=0;const store=new AutomationsStore(root,{now:()=>now,route:async id=>'provider/'+id,read:async()=>'{"price":10}',run:async()=>{calls++;return 'Observed fixture result.';},...ports});await store.initialize();t.after(()=>store.dispose());return {root,store,advance:ms=>now+=ms,calls:()=>calls,save:async extra=>{await store.change({action:'save',revision:store.snapshot().revision,automation:input(extra)});return store.snapshot().automations.at(-1);}};}
test('one-time dispatch is durably recorded before execution and success cannot run twice',async t=>{
 const f=await fixture(t,{run:async(_job,run)=>{const disk=JSON.parse(await readFile(join(f.root,'automations.json'),'utf8'));assert.equal(disk.automations[0].runs[0].id,run.id);assert.equal(disk.automations[0].runs[0].status,'running');return 'Observed actual completion.';}});await f.save();f.advance(1000);await f.store.tick();await f.store.tick();const j=f.store.snapshot().automations[0];assert.equal(j.runs.length,1);assert.equal(j.status,'completed');assert.equal(j.runs[0].result,'Observed actual completion.');assert.equal(j.nextAt,undefined);
});
test('interval and event triggers need no open conversation; unrelated event data cannot trigger',async t=>{
 const f=await fixture(t);await f.save({trigger:{kind:'interval',seconds:300}});f.advance(300000);await f.store.tick();assert.equal(f.calls(),1);await f.save({trigger:{kind:'event',event:'task.failed',path:'code',operator:'equals',value:'QUOTA'}});await f.store.event('task.completed',{code:'QUOTA'});await f.store.event('task.failed',{code:'OTHER'});await f.store.tick();assert.equal(f.calls(),1);await f.store.event('task.failed',{code:'QUOTA'});await f.store.tick();assert.equal(f.calls(),2);
});
test('public watch establishes baseline without a model; a real state transition fires only once',async t=>{
 let price=10;const f=await fixture(t,{read:async()=>JSON.stringify({price})});await f.save({trigger:{kind:'watch',url:'https://example.org/data',seconds:300,rule:'above',value:'15',jsonPath:'price'}});f.advance(300000);await f.store.tick();assert.equal(f.calls(),0);price=20;f.advance(300000);await f.store.tick();assert.equal(f.calls(),1);price=21;f.advance(300000);await f.store.tick();assert.equal(f.calls(),1);price=10;f.advance(300000);await f.store.tick();price=20;f.advance(300000);await f.store.tick();assert.equal(f.calls(),2);
});
test('quota blocks only its provider route; another route proceeds and recovery is explicit',async t=>{
 let attempts=0;const f=await fixture(t,{run:async job=>{attempts++;if(job.characterId==='main-id')throw Object.assign(Error('Out of credits'),{code:'QUOTA'});return 'Other route completed.';}});const first=await f.save();await f.save();await f.save({characterId:'other-id'});f.advance(1000);await f.store.tick();await f.store.tick();await f.store.tick();assert.equal(attempts,2);assert.equal(f.store.snapshot().automations[0].status,'waiting-credit');assert.equal(f.store.snapshot().automations[1].runs.length,0);assert.equal(f.store.snapshot().automations[2].status,'completed');await f.store.change({action:'resume-credit',revision:f.store.snapshot().revision,id:first.id});await f.store.tick();assert.equal(attempts,3);
});
test('failed native reason is not a completed automation or Telegram activity',()=>{
 assert.equal(operationFailure({kind:'completed'}),undefined);assert.equal(operationFailure({kind:'error',error:{code:'QUOTA',message:'Out of credits'}}).quota,true);assert.ok(operationFailure({kind:'cancelled'}));assert.ok(operationFailure(undefined));
});
test('interrupted native run after a power loss needs review and never auto-replays',async t=>{
 const f=await fixture(t);await f.save();let release,started;const entered=new Promise(r=>started=r);f.store.ports.run=async()=>{started();return new Promise(r=>release=r);};f.advance(1000);const pending=f.store.tick();await entered;
 const restored=new AutomationsStore(f.root,{...f.store.ports,run:async()=>assert.fail('Must not replay')});await restored.initialize();await restored.tick();assert.equal(restored.snapshot().automations[0].runs[0].status,'interrupted');assert.equal(restored.snapshot().automations[0].state,'paused');release('Old process settles');await pending;await restored.dispose();
});
test('pausing cancels in-flight work and prevents new runs; stale edits preserve configuration',async t=>{
 let entered;const started=new Promise(r=>entered=r);const f=await fixture(t,{run:async(_job,_run,signal)=>{entered();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('Cancelled')),{once:true}));}});const job=await f.save();const stale=f.store.snapshot().revision;f.advance(1000);const pending=f.store.tick();await started;await assert.rejects(f.store.change({action:'cancel',revision:stale,id:job.id}),/changed/);await f.store.change({action:'pause',revision:f.store.snapshot().revision,id:job.id});await pending;await f.store.tick();assert.equal(f.store.snapshot().automations[0].status,'paused');assert.equal(f.store.snapshot().automations[0].runs.length,1);
});
test('missed-once skip/catch-up and daily run budgets have explicit truthful outcomes',async t=>{
 const f=await fixture(t);await f.save({missed:'skip'});await f.save({missed:'catch-up'});f.advance(120000);await f.store.tick();await f.store.tick();assert.equal(f.calls(),1);assert.equal(f.store.snapshot().automations[0].lastError,'Missed while host was offline; skipped by your policy.');await f.save({trigger:{kind:'interval',seconds:300},dailyMaxRuns:1});f.advance(300000);await f.store.tick();f.advance(300000);await f.store.tick();const j=f.store.snapshot().automations.at(-1);assert.equal(j.status,'budget-paused');assert.equal(j.runs.length,1);
});
test('calendar uses IANA timezone and skips nonexistent DST hours',()=>{
 const t={kind:'calendar',hour:9,minute:30,timezone:'Europe/Istanbul',days:[1,2,3,4,5]};assert.equal(nextOccurrence(t,start),Date.parse('2026-10-15T06:30:00Z'));assert.equal(nextOccurrence({kind:'calendar',hour:2,minute:30,timezone:'America/New_York',days:[0]},Date.parse('2026-03-08T06:00:00Z')),Date.parse('2026-03-15T06:30:00Z'));
});
test('watch SSRF, unapproved write tools, and unowned notification destinations are refused',async()=>{
 for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','172.16.0.1','192.168.1.2','::1','::ffff:127.0.0.1','fd00::1'])assert.equal(isPublicAddress(ip),false);assert.equal(isPublicAddress('1.1.1.1'),true);await assert.rejects(readPublicWatch('https://127.0.0.1/',AbortSignal.timeout(1000)),/Private network/);assert.throws(()=>validateAutomation(input({tools:['shell'],allowWrites:false})),/permission/);assert.throws(()=>validateAutomation(input({notification:'telegram',sourceSessionId:'arbitrary'})),/authorized/);assert.throws(()=>validateAutomation(input({trigger:{kind:'interval',seconds:1}})),/five minutes/);
});
