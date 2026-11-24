import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatQuotaResume,quotaReset,toolCheckpoint,installChatQuotaResume,readSubscriptionReset,publicResumeRecord,QUOTA_RESUME_INSTRUCTION} from '../packages/harness-overlay/src/host/chat-quota-resume.ts';
const route={provider:'claude-code',model:'sonnet',reasoningEffort:'high'};
const limit=reset=>({kind:'error',error:{code:'subscription-limit',message:'Subscription limit reached',subscriptionLimit:{kind:'subscription-quota',...route,...(reset?{resetsAt:reset}:{})}}});
const ev=(seq,type,data={})=>({seq,type,data});
const history=(reason=limit(2000000))=>[ev(0,'turn/start',{turn:1}),ev(1,'user/message',{source:{kind:'user',rpcId:'human-1'},content:[{type:'text',text:'Do unfinished work'}]}),ev(2,'turn/end',{turn:1,reason})];
async function fixture(options={}){
 const dir=await mkdtemp(join(tmpdir(),'hub-quota-resume-'));let clock=1000000;
 let snapshot={sessionId:'chat',route,authority:'same-tools-and-policy',active:false,archived:false,eligible:true,events:history(),...options.snapshot};
 const prompts=[],published=[],usageCalls=[];
 const port={inspect:async()=>snapshot,prompt:async request=>{prompts.push(request);return {accepted:true};},usage:async r=>{usageCalls.push(r);return options.usage?.();},publish:async(id,data)=>published.push({id,...data}),...options.port};
 const file=join(dir,'state.json'),engine=new ChatQuotaResume(file,port,()=>clock);await engine.ready;
 return {dir,file,engine,port,prompts,published,usageCalls,get snapshot(){return snapshot;},set snapshot(v){snapshot=v;},setClock:v=>clock=v,clean:()=>rm(dir,{recursive:true,force:true})};
}
async function arm(f){await f.engine.setEnabled('chat',0,true);await f.engine.observeEnd('chat',2);}

test('default OFF, explicit session-scoped optimistic preference, no retroactive replay',async()=>{
 const f=await fixture();try{
  assert.equal((await f.engine.read('chat')).enabled,false);
  await f.engine.observeEnd('chat',2);f.setClock(9000000);await f.engine.tick();assert.equal(f.prompts.length,0);
  const on=await f.engine.setEnabled('chat',0,true);assert.equal(on.revision,1);
  await assert.rejects(f.engine.setEnabled('chat',0,false),/Settings changed/);
  assert.equal((await f.engine.setEnabled('other',0,true)).revision,1);
  await f.engine.tick();assert.equal(f.prompts.length,0,'enabling is not a request to replay an earlier failure');
 }finally{await f.clean();}
});

test('reported reset only, exact route and deterministic queue schema, one attempt persisted before dispatch',async()=>{
 const f=await fixture();try{
  await arm(f);const checkpoint=(await f.engine.read('chat')).checkpoint;
  assert.equal(checkpoint.state,'waiting');assert.equal(checkpoint.resetsAt,2000000);assert.deepEqual(checkpoint.route,route);
  f.setClock(1999999);await f.engine.tick();assert.equal(f.prompts.length,0);
  f.port.prompt=async request=>{const disk=JSON.parse(await readFile(f.file,'utf8'));assert.equal(disk.records[0].checkpoint.state,'dispatching');assert.equal(disk.records[0].checkpoint.attempts,1);f.prompts.push(request);return {accepted:true};};
  f.setClock(2000000);await f.engine.tick();await f.engine.tick();assert.equal(f.prompts.length,1);
  assert.deepEqual(Object.keys(f.prompts[0]).sort(),['content','mode','requestId','sessionId']);assert.equal(f.prompts[0].mode,'queue');
  assert.equal(f.prompts[0].requestId,checkpoint.requestId);assert.equal(f.prompts[0].sessionId,'chat');
  assert.doesNotMatch(f.prompts[0].content[0].text,/Do unfinished work/,'not the original user prompt');
  assert.equal((await f.engine.read('chat')).checkpoint.state,'consumed');
  assert.deepEqual(f.published.map(e=>e.state),['waiting','dispatching','consumed']);
  assert.match(QUOTA_RESUME_INSTRUCTION,/Never repeat completed actions/);assert.match(QUOTA_RESUME_INSTRUCTION,/fresh explicit user approval/);
 }finally{await f.clean();}
});

test('unknown reset never guesses; bounded metadata refresh can discover a real reset',async()=>{
 let usage={};const f=await fixture({snapshot:{events:history(limit())},usage:()=>usage});try{
  await arm(f);assert.equal((await f.engine.read('chat')).checkpoint.state,'waiting-unknown');
  const initial=f.usageCalls.length;await f.engine.tick();assert.equal(f.usageCalls.length,initial);
  f.setClock(1300000);await f.engine.tick();assert.equal(f.usageCalls.length,initial+1);assert.equal(f.prompts.length,0);
  usage={resetsAt:1800000};f.setClock(1600000);await f.engine.tick();assert.equal((await f.engine.read('chat')).checkpoint.resetsAt,1800000);
  f.setClock(1800000);await f.engine.tick();assert.equal(f.prompts.length,1);
 }finally{await f.clean();}
});

test('Codex no reset timestamp can resume only after fresh usage confirms actual availability',async()=>{
 let available=false;const codex={provider:'openai-codex',model:'gpt-5.3-codex'};
 const f=await fixture({snapshot:{route:codex,events:history({kind:'error',error:{code:'usage_limit_reached',message:'limit'}})},usage:()=>({available,blocked:!available})});try{
  await arm(f);f.setClock(1300000);await f.engine.tick();assert.equal(f.prompts.length,0);
  available=true;f.setClock(1600000);await f.engine.tick();const c=(await f.engine.read('chat')).checkpoint;
  assert.equal(c.resetsAt,undefined,'availability is not a fabricated reset timestamp');assert.equal(c.availableAt,1600000);
  await f.engine.tick();assert.equal(f.prompts.length,1);assert.deepEqual(c.route,codex);
 }finally{await f.clean();}
});

test('all cancellation boundaries fail closed without a model call',async t=>{
 for(const [label,change] of [
  ['new-user-message',s=>({...s,events:[...s.events,ev(3,'user/message',{source:{kind:'user',rpcId:'new'},content:[{type:'text',text:'New request'}]})]})],
  ['route-changed',s=>({...s,route:{...route,model:'opus'}})],
  ['authority-changed',s=>({...s,authority:'new-grants'})],
  ['active-session',s=>({...s,active:true})],['archived',s=>({...s,archived:true})],
  ['history-changed',s=>({...s,events:s.events.map(e=>e.seq===1?{...e,data:{...e.data,changed:true}}:e)})]
 ])await t.test(label,async()=>{const f=await fixture();try{await arm(f);f.snapshot=change(f.snapshot);f.setClock(2000000);await f.engine.tick();assert.equal(f.prompts.length,0);assert.equal((await f.engine.read('chat')).checkpoint.state,'cancelled');}finally{await f.clean();}});
});

test('OFF and manual Stop cancel while retaining correct preference',async()=>{
 const f=await fixture();try{await arm(f);let r=await f.engine.read('chat');r=await f.engine.cancelPending('chat',r.revision);assert.equal(r.enabled,true);assert.equal(r.checkpoint.reason,'manual-stop');
  f.setClock(2000000);await f.engine.tick();assert.equal(f.prompts.length,0);
  const off=await f.engine.setEnabled('chat',r.revision,false);assert.equal(off.enabled,false);
 }finally{await f.clean();}
 const g=await fixture();try{await arm(g);let r=await g.engine.read('chat');r=await g.engine.setEnabled('chat',r.revision,false);assert.equal(r.checkpoint.reason,'disabled');g.setClock(2000000);await g.engine.tick();assert.equal(g.prompts.length,0);}finally{await g.clean();}
});

test('pending, failed, orphan and ambiguous tool results require review; completed tools are recorded not replayed',async()=>{
 const call=ev(2,'tool/call',{callId:'send-1',name:'send_message'});
 const result=failed=>ev(3,'tool/result',{message:{content:[{type:'tool-result',toolCallId:'send-1',isError:failed,content:[{type:'text',text:'recorded outcome'}]}]}});
 assert.equal(toolCheckpoint([call]).safe,false);assert.equal(toolCheckpoint([call,result(true)]).safe,false);
 assert.equal(toolCheckpoint([result(false)]).safe,false);assert.equal(toolCheckpoint([call,result(false),result(false)]).safe,false);
 for(const safe of [false,true]){const f=await fixture();try{
  f.snapshot={...f.snapshot,events:[...history().slice(0,2),call,...(safe?[result(false)]:[]),ev(4,'turn/end',{turn:1,reason:limit(2000000)})]};
  await f.engine.setEnabled('chat',0,true);await f.engine.observeEnd('chat',4);let r=await f.engine.read('chat');
  assert.equal(r.checkpoint.state,safe?'waiting':'needs-review');
  if(safe){assert.deepEqual(r.checkpoint.completedToolIds,['send-1']);f.setClock(2000000);await f.engine.tick();assert.match(f.prompts[0].content[0].text,/Completed tool call IDs: send-1/);}
 }finally{await f.clean();}}
});

test('auth/network/API credits/general rate limit never arm',async()=>{
 for(const code of ['AUTH','TRANSPORT','RATE_LIMIT','429','INSUFFICIENT_QUOTA'])assert.equal(quotaReset({kind:'error',error:{code,message:'usage limit'}},route),undefined);
 assert.equal(quotaReset(limit(2000000),{provider:'openrouter',model:'claude'}),undefined);
 const f=await fixture({snapshot:{events:history({kind:'error',error:{code:'TRANSPORT',message:'network'}})}});try{await arm(f);assert.equal((await f.engine.read('chat')).checkpoint,undefined);}finally{await f.clean();}
});

test('restart waiting persists; restart dispatching and ambiguous controller acknowledgement never retry',async()=>{
 const f=await fixture();try{
  await arm(f);const restart=new ChatQuotaResume(f.file,f.port,()=>1999999);await restart.ready;await restart.tick();assert.equal(f.prompts.length,0);
  const disk=JSON.parse(await readFile(f.file,'utf8'));disk.records[0].checkpoint.state='dispatching';disk.records[0].checkpoint.attempts=1;await writeFile(f.file,JSON.stringify(disk));
  const crashed=new ChatQuotaResume(f.file,f.port,()=>9000000);await crashed.ready;await crashed.tick();assert.equal((await crashed.read('chat')).checkpoint.state,'needs-review');assert.equal(f.prompts.length,0);
 }finally{await f.clean();}
 const g=await fixture({port:{prompt:async()=>{throw Error('timeout after acceptance unknown');}}});try{await arm(g);g.setClock(2000000);await g.engine.tick();assert.equal((await g.engine.read('chat')).checkpoint.reason,'uncertain-dispatch');await g.engine.tick();assert.equal((await g.engine.read('chat')).checkpoint.attempts,1);}finally{await g.clean();}
});

test('automatic continuation cannot rearm same quota episode and assembly rejects changed authority or new user',async()=>{
 const f=await fixture();try{
  await arm(f);f.setClock(2000000);await f.engine.tick();const c=(await f.engine.read('chat')).checkpoint;
  const continued={...f.snapshot,events:[...f.snapshot.events,ev(3,'turn/start',{turn:2}),ev(4,'user/message',{source:{kind:'user',rpcId:c.requestId},content:[{type:'text',text:'continuation'}]})]};
  assert.doesNotThrow(()=>f.engine.assertContinuation(continued,c.requestId));
  assert.doesNotThrow(()=>f.engine.assertRequestRoute('chat',c.requestId,route));
  assert.throws(()=>f.engine.assertRequestRoute('chat',c.requestId,{provider:'openrouter',model:route.model}));
  assert.throws(()=>f.engine.assertRequestRoute('chat',c.requestId,{...route,reasoningEffort:'low'}));
  assert.throws(()=>f.engine.assertContinuation({...continued,events:[...continued.events,ev(5,'model/selection',route)]},c.requestId));
  assert.throws(()=>f.engine.assertContinuation({...continued,authority:'changed'},c.requestId));
  assert.throws(()=>f.engine.assertContinuation({...continued,events:[...continued.events,ev(5,'user/message',{source:{kind:'user',rpcId:'new'}})]},c.requestId));
  f.snapshot={...continued,events:[...continued.events,ev(5,'turn/end',{turn:2,reason:limit(3000000)})]};await f.engine.observeEnd('chat',5);await f.engine.tick();assert.equal(f.prompts.length,1);assert.equal((await f.engine.read('chat')).checkpoint.endSeq,2);
 }finally{await f.clean();}
});

test('public status strips checkpoint evidence and provider usage never calls a model or credentials',async()=>{
 const f=await fixture();try{await arm(f);const status=publicResumeRecord(await f.engine.read('chat'),true);assert.equal(status.checkpoint,undefined);assert.equal(status.authority,undefined);assert.equal(status.historyDigest,undefined);}finally{await f.clean();}
 const calls=[];const ctx={webServer:{port:1234},fetch:async(url,opts)=>{calls.push({url,opts});return {ok:true,json:async()=>({status:'signed-in',usage:{rateLimits:[{id:'codex',windows:[{remainingPercent:50,windowSeconds:18000}]}]}})};},credentials:{resolve:()=>assert.fail('secret access')}};
 const usage=await readSubscriptionReset(ctx,{provider:'openai-codex',model:'gpt-5.3-codex'});assert.deepEqual(usage,{blocked:false,available:true});assert.equal(usage.resetsAt,undefined);assert.equal(calls.length,1);assert.match(calls[0].url,/auth\/status$/);assert.equal(calls[0].opts.redirect,'error');
});

test('installer registers authenticated bounded endpoint and actual created hook, using actual route over configured character',async()=>{
 const home=await mkdtemp(join(tmpdir(),'hub-quota-http-'));const old=process.env.DSH_HOME;process.env.DSH_HOME=home;
 let handler;const hooks=new Map(),attached=[];const actual={provider:'openai-codex',model:'gpt-5.3-codex'};
 const agent={id:'chat',status:'idle',session:{header:{id:'chat',origin:'web'},requestHeader:()=>({config:actual}),snapshotEvents:()=>history({kind:'completed'}),append:()=>{}},ctx:{on:(name)=>{attached.push(name);return ()=>{};},systemPrompt:{section:()=>()=>{}}}};
 const ctx={workspaceRegistry:{archivedSessionIds:[]},agents:{list:()=>[],get:()=>agent},sessionController:{resolveAgent:async()=>({agent}),prompt:()=>assert.fail('model call')},connection:{requestRejection:req=>req.headers.authorization==='denied'?401:undefined},webServer:{register:route=>{handler=route.handler;return ()=>{};}},on:(name,fn,opts)=>{hooks.set(name,{fn,opts});return ()=>{};}};
 const character={id:'smart',route,tools:{mode:'inherit'}},characters={ready:Promise.resolve(),store:{selected:()=>character,snapshot:()=>({})},effectiveCharacter:()=>character,pickerAllowed:()=>true};
 const off=installChatQuotaResume(ctx,characters);
 const request=async(method,headers={},body='',query='chat')=>{let status,value;const req={method,url:'/api/hub/chat-resume?sessionId='+query,headers:{host:'localhost','x-hub-chat-resume':'1',...headers},async *[Symbol.asyncIterator](){if(body)yield Buffer.from(body);}};await handler(req,{writeHead:c=>status=c,end:text=>value=JSON.parse(text)});return {status,value};};
 try{
  assert.equal(hooks.get('agent/created').opts.global,true);assert.notEqual(hooks.get('agent/created').opts.prepend,true,'attach after character middleware so final-route guard wraps it');hooks.get('agent/created').fn({agent});assert.ok(attached.includes('system-prompt/assemble'));assert.ok(attached.includes('agent/request'));assert.ok(hooks.has('llm/stream'));
  assert.equal((await request('GET',{'x-hub-chat-resume':'0'})).status,403);
  assert.equal((await request('GET',{authorization:'denied'})).status,401);
  assert.equal((await request('POST',{origin:'https://evil.invalid'},'{}')).status,403);
  assert.equal((await request('GET',{},'','../bad')).status,400);
  assert.equal((await request('POST',{},JSON.stringify({sessionId:'chat',revision:0,enabled:true,provider:'openrouter'}))).status,400);
  const initial=await request('GET');assert.equal(initial.status,200);assert.equal(initial.value.enabled,false);assert.equal(initial.value.eligible,true);
  const on=await request('POST',{},JSON.stringify({sessionId:'chat',revision:0,enabled:true}));assert.equal(on.status,200);assert.equal(on.value.enabled,true);
  assert.equal((await request('POST',{},JSON.stringify({sessionId:'chat',revision:0,enabled:false}))).status,409);
  const cancelled=await request('POST',{},JSON.stringify({sessionId:'chat',revision:on.value.revision,action:'cancel'}));assert.equal(cancelled.status,200);assert.equal(cancelled.value.enabled,true);
  ctx.workspaceRegistry.archivedSessionIds.push('chat');assert.equal((await request('GET')).value.eligible,false);
  assert.equal((await request('POST',{},JSON.stringify({sessionId:'chat',revision:on.value.revision,enabled:true}))).status,409,'actual workspace archive registry blocks opt-in');
 }finally{off();if(old===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=old;await rm(home,{recursive:true,force:true});}
});
