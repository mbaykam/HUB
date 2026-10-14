import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {installAutomations,automationActivity} from '../packages/harness-overlay/src/host/automations.ts';
import {parseHubAgentActivity} from '../packages/harness-overlay/src/agent-activity-contract.ts';
import {defaultAutomation} from '../packages/harness-overlay/src/automation-contract.ts';
import {ProviderGate} from '../packages/harness-overlay/src/host/provider-gate.ts';

test('long automation results produce accepted Telegram previews without replacing the durable result',()=>{
 const job={title:'Fixture result',sourceSessionId:'minke-im-telegram-'+('a'.repeat(32))},run={id:'fixture-run',sessionId:'hub-automation-fixture'},answer='Observed result: '+('bilingual Türkçe / English. '.repeat(400));
 const activity=automationActivity(job,run,'completed',answer);
 assert.ok(activity);assert.equal(parseHubAgentActivity({...activity,text:answer}),undefined,'The old full-answer payload was silently rejected');
 assert.equal(parseHubAgentActivity(activity),activity);assert.ok(activity.text.startsWith('Observed result: '));assert.ok(activity.text.endsWith('Full result is saved in HUB → Automations.'));assert.ok(activity.text.length<=8000);assert.ok(answer.length>activity.text.length);
 assert.equal(automationActivity(job,run,'failed','Provider unavailable').text,'Provider unavailable');
 assert.equal(automationActivity({...job,sourceSessionId:'untrusted-target'},run,'completed',answer),undefined);
});

test('automation HTTP service owns its character profile directory and authenticates before all mutations',async t=>{
 const root=await mkdtemp(join(tmpdir(),'hub-automation-host-'));t.after(()=>rm(root,{recursive:true,force:true}));let route,creates=0;
 const characters={ready:Promise.resolve(),quota:new ProviderGate(join(root,'provider-health')),validate:async()=>{},store:{root:join(root,'hub-characters'),snapshot:()=>({characters:[{id:'configured-id',name:'Fixture',route:{provider:'fixture',model:'small'},tools:{mode:'inherit'}}]})}};
 const ctx={webServer:{register:r=>{route=r;return ()=>{};}},connection:{requestRejection:req=>req.headers.auth==='fixture'?undefined:401},on:()=>()=>{},agents:{list:()=>[],create:()=>{creates++;throw Error('Not an execution test');}}};
 const dispose=installAutomations(ctx,characters);t.after(dispose);
 const call=(method,body,headers={})=>new Promise((resolve,reject)=>{const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);Object.assign(req,{method,headers:{'x-hub-automations':'1','content-type':'application/json',auth:'fixture',...headers}});let status;Promise.resolve(route.handler(req,{writeHead:code=>status=code,end:text=>resolve({status,data:JSON.parse(text)})})).catch(reject);});
 const state=await call('GET');assert.equal(state.status,200);assert.deepEqual(state.data.automations,[]);
 const body={action:'save',revision:state.data.revision,automation:{...defaultAutomation,characterId:'configured-id',title:'Profile scoped fixture',prompt:'A future isolated task',trigger:{kind:'once',at:Date.now()+86400000}}};
 assert.equal((await call('POST',body,{auth:'absent'})).status,401);assert.equal((await call('POST',body,{'sec-fetch-site':'cross-site'})).status,403);assert.equal((await call('POST',body,{'x-hub-automations':'0'})).status,403);
 const saved=await call('POST',body);assert.equal(saved.status,200);const disk=JSON.parse(await readFile(join(root,'hub-automations','automations.json'),'utf8'));assert.equal(disk.automations[0].title,body.automation.title);assert.equal(creates,0);
 const invented={...body,revision:saved.data.revision,automation:{...body.automation,notification:'telegram',sourceSessionId:'minke-im-telegram-'+('a'.repeat(32))}};assert.equal((await call('POST',invented)).status,409);assert.equal((await call('GET')).data.automations.length,1);
});
test('provider quota receipts are visible across separate queue instances and cleared explicitly',async t=>{
 const root=await mkdtemp(join(tmpdir(),'hub-provider-gate-'));t.after(()=>rm(root,{recursive:true,force:true}));const curator=new ProviderGate(root),automation=new ProviderGate(root);assert.equal(await curator.reason('provider-one'),undefined);await curator.block('provider-one','Out of credits');assert.equal(await automation.reason('provider-one'),'Out of credits');assert.equal(await automation.reason('other-provider'),undefined);await automation.clear('provider-one');assert.equal(await curator.reason('provider-one'),undefined);
});
