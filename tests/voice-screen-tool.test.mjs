import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {attachVoiceScreenTool,installVoiceScreenTools,SCREEN_VIEW_TOOL} from '../packages/harness-overlay/src/host/voice-screen-tool.ts';
import {createVoiceWeb} from '../packages/harness-overlay/src/host/voice-web.ts';

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

test('isolated HTTP upload reaches the authorized image result and Stop revokes it without touching a provider',async()=>{
 const require=createRequire(new URL('../vendor/deepseek-harness/packages/attachment/attachment-local/package.json',import.meta.url)),sharp=require('sharp');
 const jpeg=await sharp({create:{width:12,height:8,channels:3,background:'#35738d'}}).jpeg().toBuffer();
 const root=agent(),call={callId:randomUUID(),sessionId:root.id,sidecar:{done:new Promise(()=>{}),request:async()=>({status:200,body:{status:'waiting'}})}};
 const web=createVoiceWeb({reject:req=>req.headers.cookie==='hub-eval=1'?undefined:401,open:async()=>call,close:async()=>{},validateScreen:async bytes=>{const decoded=await sharp(bytes).raw().toBuffer({resolveWithObject:true});assert.equal(decoded.info.width,12);}});
 const server=createServer((req,res)=>void web.handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
 const url=`http://127.0.0.1:${server.address().port}/api/hub/voice/`,shareId=randomUUID();
 const json=(path,input,extra={},method='POST')=>fetch(url+path,{method,headers:{cookie:'hub-eval=1','content-type':'application/json',...extra},body:JSON.stringify(input)});
 const screenHeaders={'x-hub-voice-screen':'1','x-hub-voice-call':call.callId};let writes=0,time=Date.now();
 const off=attachVoiceScreenTool(root,{current:id=>web.screenIdentity(id),frame:id=>web.screenFrame(id),vision:async()=>true,allowed:()=>true,now:()=>time,save:async bytes=>{writes++;assert.deepEqual(bytes,jpeg);return{attachmentId:'fixture-real-jpeg',mediaType:'image/jpeg',width:12,height:8,bytes:bytes.length};}});
 const exec={agent:root,signal:new AbortController().signal};
 try{
  assert.equal((await json('open',{requestId:randomUUID(),requestedAt:Date.now()})).status,200);
  assert.equal((await json('screen',{shareId},screenHeaders)).status,200);assert.equal(writes,0);
  const upload=await fetch(url+'screen',{method:'PUT',headers:{cookie:'hub-eval=1',...screenHeaders,'content-type':'image/jpeg','x-hub-screen-share':shareId,'x-hub-screen-sequence':'0','x-hub-screen-age-ms':'0'},body:jpeg});
  assert.equal(upload.status,200);assert.equal(writes,0); // Streaming alone never persists an analysis image.
  const value=await root.tool.execute({},exec);assert.equal(writes,1);
  assert.equal(root.tool.finalizeContent(exec,{value,content:root.tool.output.render({},value)})[1].type,'image');
  const pendingValue=await (async()=>{time+=3000;return root.tool.execute({},exec);})();
  assert.equal((await json('screen',{shareId},screenHeaders,'DELETE')).status,200);
  const withheld=root.tool.finalizeContent(exec,{value:pendingValue,content:root.tool.output.render({},pendingValue)});assert.equal(withheld.length,1);assert.match(withheld[0].text,/No screen image/);
  time+=3000;await assert.rejects(root.tool.execute({},exec),/No fresh/);assert.equal(writes,2);
 }finally{off();await web.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
