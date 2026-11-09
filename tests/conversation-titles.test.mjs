import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {native} from '../scripts/tests/native-harness-resolver.mjs';
import {installConversationTitles,substantiveTitleMessages,topicTitle,waitForTitlePause} from '../packages/harness-overlay/src/host/conversation-titles.ts';
const {Context}=await native('@deepseek-ai/cordis');
const {default:Store,SessionId}=await native('@deepseek-ai/dsh-session');
const {default:Projections}=await native('@deepseek-ai/dsh-session-projection');
const {default:Titles}=await native('@deepseek-ai/dsh-session-title');
const {createUserMessage}=await native('@deepseek-ai/dsh-llm');
const tick=ms=>new Promise(r=>setTimeout(r,ms));

function visual(events,title='Pendulum simulator'){
 const args={kind:'app',title,html:'<p>Fixture</p>'},id=randomUUID();
 events.push({seq:events.length,time:100,type:'tool/call',data:{name:'hub_present',callId:'fixture',arguments:JSON.stringify(args)}},
  {seq:events.length+1,time:101,type:'tool/result',data:{message:{content:[{type:'tool-result',toolCallId:'fixture',isError:false,content:[{type:'text',text:JSON.stringify({id,title,status:'available'})}]}]}}});
}
test('titles ignore greetings in either language and accept short actual topics',()=>{
 assert.deepEqual(substantiveTitleMessages([{seq:0,text:'Selam, ne habersin?'},{seq:1,text:'Perfect.'},{seq:2,text:'DNA'}]),[{seq:2,text:'DNA'}]);
 const events=[{seq:0,time:1}],messages=[{seq:0,text:'Show me a visual explanation of a pendulum'}];visual(events);
 assert.equal(topicTitle(events,messages).title,'Pendulum simulator');
 events.push({seq:9,time:200});assert.equal(topicTitle(events,[...messages,{seq:9,text:'Now plan a trip'}]),undefined,'An old canvas must not rename an unrelated later topic');
 events[2].data.message.content[0].isError=true;assert.equal(topicTitle(events,messages),undefined,'Failed tools cannot name the conversation');
});
test('a title waits for turn completion and the pause, and cancellation removes the listener',async()=>{
 const events=[{type:'turn/start'}];let listener,active=0;
 const ctx={on:(_name,fn)=>{listener=fn;active++;return()=>active--;}};
 const session={id:'fixture',snapshotEvents:()=>events};let done=false;
 const controller=new AbortController(),pending=waitForTitlePause(ctx,session,controller.signal,15).then(()=>done=true);
 await tick(25);assert.equal(done,false);
 listener({header:{id:'other'}},{type:'turn/end'});await tick(20);assert.equal(done,false);
 listener({header:{id:'fixture'}},{type:'turn/end'});await pending;assert.equal(active,0);
 const cancelled=new AbortController(),second=waitForTitlePause(ctx,session,cancelled.signal,15);cancelled.abort(new Error('new user message'));
 await assert.rejects(second,/new user message/);assert.equal(active,0);
});

async function setup(){
 const ctx=new Context();await ctx.plugin(Store);await ctx.plugin(Projections);await ctx.plugin(Titles,{fallbackMaxWords:5,fallbackMaxBytes:40,maxTitleBytes:80});
 return ctx;
}
test('the real native title service persists a successful canvas subject and protects manual names',async()=>{
 const ctx=await setup();let calls=0;
 ctx.llm={stream:async function*(){calls++;throw Error('This test must never call a provider');}};
 const off=installConversationTitles(ctx,1),session=ctx.sessions.create(SessionId('hub-eval-topic-canvas'));
 try{
  const message=session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Please demonstrate a pendulum visually'}]}),{surfaceOp:'append'});
  const events=[];visual(events);for(const e of events)session.append(e.type,e.data,e.type==='tool/result'?{surfaceOp:'append'}:undefined);
  const result=await ctx.sessionTitle.refresh(session);assert.equal(result.title,'Pendulum simulator');assert.equal(result.source.kind,'provider');assert.deepEqual(result.messageSeqs,[message.seq]);assert.equal(calls,0);
  ctx.sessionTitle.rename(session,'My physics lesson');
  session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Try the gravity slider now'}]}),{surfaceOp:'append'});
  await tick(20);assert.equal(ctx.sessionTitle.get(session).title,'My physics lesson');assert.equal(calls,0);
 }finally{await off();await ctx.fiber.dispose();}
});
test('manual rename cancels pending native refinement instead of accepting a stale result',async()=>{
 const ctx=await setup(),off=installConversationTitles(ctx,50),session=ctx.sessions.create(SessionId('hub-eval-topic-cancel'));
 try{
  session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Show a pendulum demonstration'}]}),{surfaceOp:'append'});
  const events=[];visual(events);for(const e of events)session.append(e.type,e.data,e.type==='tool/result'?{surfaceOp:'append'}:undefined);
  const pending=ctx.sessionTitle.refresh(session);const rejected=assert.rejects(pending,/rename|superseded/);
  await tick(10);ctx.sessionTitle.rename(session,'Keep this name');await rejected;
  assert.equal(ctx.sessionTitle.get(session).title,'Keep this name');
 }finally{await off();await ctx.fiber.dispose();}
});
test('native automatic cadence replaces the greeting only after the completed topic turn',async()=>{
 const ctx=await setup(),off=installConversationTitles(ctx,10),session=ctx.sessions.create(SessionId('hub-eval-topic-automatic'));
 try{
  session.append('turn/start',{turn:1});
  session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Hello'}]}),{surfaceOp:'append'});
  session.append('request/header',{header:{config:{provider:'fixture',model:'existing'}},reason:'initial'});
  session.append('turn/end',{turn:1,reason:{kind:'completed'}});await tick(25);
  assert.equal(ctx.sessionTitle.get(session).title,'Hello');
  session.append('turn/start',{turn:2});
  session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Demonstrate a pendulum on screen'}]}),{surfaceOp:'append'});
  session.append('request/header',{header:{config:{provider:'fixture',model:'existing'}},reason:'change'});
  const events=[];visual(events);for(const e of events)session.append(e.type,e.data,e.type==='tool/result'?{surfaceOp:'append'}:undefined);
  await tick(25);assert.equal(ctx.sessionTitle.get(session).title,'Hello','Do not refine a still-running turn');
  session.append('turn/end',{turn:2,reason:{kind:'completed'}});
  const deadline=Date.now()+1000;while(ctx.sessionTitle.get(session).title!=='Pendulum simulator'){assert.ok(Date.now()<deadline);await tick(10);}
  assert.equal(ctx.sessionTitle.get(session).source.kind,'provider');
 }finally{await off();await ctx.fiber.dispose();}
});
test('model titles see bounded conversation text, supported low reasoning, no hidden reasoning or injected context',async()=>{
 let provider,options,logged;
 const messages=[{seq:1,text:'Hello'},{seq:2,text:'Compare the two study plans'}],events=[
  {seq:1,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'Hello'}]}},
  {seq:2,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:messages[1].text}]}},
  {type:'user/message',data:{source:{kind:'plugin'},content:[{type:'text',text:'PRIVATE CONTEXT'}]}},
  {type:'assistant/message',data:{message:{content:[{type:'reasoning',text:'HIDDEN REASONING'},{type:'text',text:'Here are two schedules with revision time.'}]}}},
 ];
 const ctx={on:()=>()=>{},sessionTitle:{register:p=>{provider=p;return()=>{};},get:()=>({title:'Hello',messageSeqs:[1],source:{kind:'fallback'}})},llm:{resolveModelInfo:async()=>({reasoning:{efforts:[{id:'low'},{id:'high'}]}}),stream:async function*(value){options=value;yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'Comparing two practical study schedules'};yield {type:'finish',reason:{kind:'stop'}};}}};
 installConversationTitles(ctx,1);
 const session={id:'hub-eval-topic-text',header:{},snapshotEvents:()=>events,append:(type,data)=>logged={type,data}},request={session,messages,route:{provider:'fixture',model:'existing-model'},signal:new AbortController().signal};
 const result=await provider.generate(request);assert.equal(result.title,'Comparing two practical study schedules');assert.deepEqual(result.messageSeqs,[2]);
 assert.equal(options.reasoningEffort,'low');assert.equal(options.maxTokens,512);assert.equal(options.purpose,'session-title');assert.deepEqual(result.model,request.route);
 const text=JSON.stringify(options.messages);assert.match(text,/Here are two schedules/);assert.doesNotMatch(text,/PRIVATE CONTEXT|HIDDEN REASONING|Hello/);assert.ok(text.length<7000);assert.equal(logged.type,'session/title-llm-request');
 session.header.parentSession='parent';options=undefined;await provider.generate(request);assert.equal(options,undefined,'Background workers must not trigger title calls');
});
