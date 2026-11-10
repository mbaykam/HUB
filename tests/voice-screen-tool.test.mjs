import test from 'node:test';
import assert from 'node:assert/strict';
import {attachVoiceScreenTool,installVoiceScreenTools,SCREEN_VIEW_TOOL} from '../packages/harness-overlay/src/host/voice-screen-tool.ts';

const user=()=>[{type:'turn/start'},{type:'user/message',data:{source:{kind:'user'}}}];
function agent(id='hub-eval-voice',parent){
 const result={id,events:user(),session:{header:{id,...(parent?{origin:'subagent',parentSession:parent}:{})},snapshotEvents:()=>result.events,requestHeader:()=>({config:{provider:'fixture',model:'vision'}})},ctx:{tools:{register(tool){result.tool=tool;return()=>result.removed=true;}},systemPrompt:{section(value){result.guidance=value.text;return()=>{};}}}};return result;
}
function fixture(delegated){
 let time=10000,call={callId:'call-1',sessionId:'hub-eval-voice'},frame={bytes:Buffer.from('private-screen-fixture'),shareId:'share-1',sequence:0,remainingMs:5000},allowed=true,vision=true,writes=0;
 const a=agent(delegated?'worker':undefined),ports={current:()=>call,frame:()=>frame,vision:async()=>vision,save:async()=>{writes++;return{attachmentId:'fixture-image'};},allowed:()=>allowed,now:()=>time};
 const off=attachVoiceScreenTool(a,ports,delegated),exec={agent:a,signal:new AbortController().signal};
 return {a,ports,off,exec,tool:a.tool,setTime:v=>time=v,setCall:v=>call=v,setFrame:v=>frame=v,setAllowed:v=>allowed=v,setVision:v=>vision=v,writes:()=>writes};
}
const result=(f,value)=>({value,content:f.tool.output.render({},value)});
test('one explicit observation projects a real image only into the original guarded tool result',async()=>{
 const f=fixture();try{
  const value=await f.tool.execute({},f.exec);assert.equal(f.writes(),1);assert.equal(value.retained,'conversation attachment');
  const output=f.tool.finalizeContent(f.exec,result(f,value));assert.equal(output[1].type,'image');assert.equal(output[1].attachment.attachmentId,'fixture-image');
  assert.equal(f.tool.finalizeContent(f.exec,result(f,value)),undefined);
  assert.match(f.a.guidance,/do not poll/);assert.match(f.a.guidance,/untrusted evidence/);
 }finally{f.off();}
});
test('permissions, foreign executions, missing input capability, background notices and invalid arguments never save',async()=>{
 for(const configure of [f=>f.setAllowed(false),f=>f.setVision(false),f=>f.a.events.push({type:'turn/end'}),f=>f.setFrame(undefined),f=>f.setCall(undefined)]){
  const f=fixture();try{configure(f);await assert.rejects(f.tool.execute({},f.exec));assert.equal(f.writes(),0);}finally{f.off();}
 }
 const f=fixture();try{
  await assert.rejects(f.tool.execute({sessionId:'other'},f.exec));
  await assert.rejects(f.tool.execute({}, {...f.exec,agent:{id:f.a.id}}));
  const aborted=new AbortController();aborted.abort();await assert.rejects(f.tool.execute({}, {...f.exec,signal:aborted.signal}));
  f.off();await assert.rejects(f.tool.execute({},f.exec));assert.equal(f.writes(),0);
 }finally{f.off();}
});
test('expiry, stopped consent, permission loss and call replacement suppress image delivery even after save',async()=>{
 for(const revoke of [f=>f.setTime(15000),f=>f.setFrame(undefined),f=>f.setFrame({shareId:'share-2'}),f=>f.setAllowed(false),f=>f.setCall({callId:'call-2',sessionId:f.a.id}),f=>f.off()]){
  const f=fixture();try{const value=await f.tool.execute({},f.exec);revoke(f);const output=f.tool.finalizeContent(f.exec,result(f,value));assert.equal(output.length,1);assert.match(output[0].text,/No screen image/);}finally{f.off();}
 }
 const f=fixture();let finish;f.ports.save=()=>new Promise(r=>finish=r);
 try{const pending=f.tool.execute({},f.exec);await Promise.resolve();await Promise.resolve();f.setCall(undefined);finish({attachmentId:'late'});await assert.rejects(pending);}finally{f.off();}
});
test('a delegated worker cannot cross a reopened call, and read count bounds repeated polling',async()=>{
 const f=fixture({root:'hub-eval-voice',callId:'call-1',request:1});try{
  f.a.events=[];
  for(let i=0;i<3;i++){f.setTime(10000+i*3000);await f.tool.execute({},f.exec);}
  f.setTime(20000);await assert.rejects(f.tool.execute({},f.exec),/bounded/);assert.equal(f.writes(),3);
  f.setCall({callId:'call-2',sessionId:'hub-eval-voice'});await assert.rejects(f.tool.execute({},f.exec),/fresh worker/);
 }finally{f.off();}
});
test('installer mounts only voice owners and direct children of a real user request and checks actual request model',async()=>{
 const handlers=new Map(),agents=new Map(),root=agent(),child=agent('worker',root.id),ordinary=agent('ordinary');let writes=0,modalities=['image'];
 agents.set(root.id,root);let call={callId:'call-1',sessionId:root.id};
 const ctx={on(name,fn){handlers.set(name,fn);return()=>handlers.delete(name);},agents:{get:id=>agents.get(id)},hubCharacters:{effectiveCharacter:()=>({id:'fixture-character',tools:{mode:'inherit'}})},llm:{resolveModelInfo:async(p,m)=>{assert.equal(p,'fixture');assert.equal(m,'vision');return{inputModalities:modalities};}},attachments:{saveImage:async()=>{writes++;return{attachmentId:'fixture'};}}};
 const mounted=installVoiceScreenTools(ctx,{current:id=>id===root.id?call:undefined,frame:()=>({bytes:Buffer.from('fixture'),shareId:'s',sequence:0,remainingMs:5000})});
 try{
  handlers.get('agent/created')({agent:ordinary});assert.equal(ordinary.tool,undefined);
  const detach=mounted.attachVoice(root);handlers.get('agent/created')({agent:child});assert.equal(child.tool.name,SCREEN_VIEW_TOOL);
  const background=agent('background',root.id);root.events.push({type:'turn/end'});handlers.get('agent/created')({agent:background});assert.equal(background.tool,undefined);
  modalities=[];await assert.rejects(child.tool.execute({}, {agent:child,signal:new AbortController().signal}),/image input/);assert.equal(writes,0);
  call={callId:'reopened',sessionId:root.id};await assert.rejects(child.tool.execute({}, {agent:child,signal:new AbortController().signal}),/fresh worker/);
  detach();assert.equal(root.removed,true);
 }finally{mounted.dispose();}
});
