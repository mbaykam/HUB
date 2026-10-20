// Real pinned AgentLoop + continuation manager + JSONL persistence. Only the
// model response is scripted; no paid requests, user chats or live app state.
import test from "node:test";
import assert from "node:assert/strict";
import {native} from "../scripts/tests/native-harness-resolver.mjs";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";


const { mountAgentLoopTestDependencies } = await import("../vendor/deepseek-harness/packages/test-support/agent-loop-testkit/src/index.ts");
const { MockAdapter, textResponse, toolCallResponse } = await import("../vendor/deepseek-harness/packages/core/agent-loop/tests/mock-adapter.ts");
const { TestSessionQuery } = await import("../vendor/deepseek-harness/packages/subagent/subagent/tests/test-session-query.ts");

async function composedWebProfile() {
  const { loadOverlayPatches, composeEntries } = await native('@deepseek-ai/dsh-app-boot');
  const layers = [
    '../vendor/deepseek-harness/packages/bundle/base/cordis.patch.yml',
    '../vendor/deepseek-harness/packages/bundle/web-app/cordis.patch.yml',
    '../packages/harness-overlay/cordis.patch.yml',
  ].map(file => loadOverlayPatches('hub-goal-profile-test', fileURLToPath(new URL(file, import.meta.url))));
  const rows = [];
  const visit = entries => { for (const row of entries) { rows.push(row); if (row.group && Array.isArray(row.config)) visit(row.config); } };
  visit(composeEntries(layers));
  return rows.filter(row => row.disabled !== true);
}
test('the full Web profile reuses one native Goal service and leaves round admission to HUB', async () => {
  const active = await composedWebProfile();
  assert.equal(active.filter(row => row.name === '@deepseek-ai/dsh-goal').length, 1,
    'Registering native Goal twice prevents the installed host from booting');
  assert.equal(active.filter(row => row.name === '@deepseek-ai/dsh-goal-round-driver').length, 0,
    'The base automatic driver must not bypass HUB background limits');
  assert.equal(active.filter(row => row.id === 'hub-characters').length, 1);
});

test('the HUB profile lazily indexes original chat content and finds it after a restart without rewriting the log', async () => {
  const entry=(await composedWebProfile()).find(row=>row.id==='session-query-sqlite');
  const {default:SessionStore,SessionId,SESSION_FORMAT_VERSION}=await native('@deepseek-ai/dsh-session');
  const {default:Search}=await native('@deepseek-ai/dsh-session-query-sqlite');
  const root=await mkdtemp(join(tmpdir(),'hub-eval-session-search-')),contexts=[];
  const mount=async()=>{const ctx=new Context();contexts.push(ctx);await ctx.plugin(SessionStore);await ctx.plugin(Projections);await ctx.plugin(Persistence,{root:join(root,'originals'),compression:'none'});await ctx.plugin(Search,{...entry.config,path:join(root,'derived','search.db')});return ctx;};
  try{
    const ctx=await mount(),meta={version:SESSION_FORMAT_VERSION,id:SessionId('hub-eval-search-original'),createdAt:1,isSeeded:false,cwd:root};
    await ctx.sessionPersistence.create(meta);
    await ctx.sessionPersistence.append(meta.id,[{type:'user/message',seq:0,time:1,surfaceOp:'append',data:createUserMessage({content:[{type:'text',text:'A fictional telescope fixture needle.'}],source:{kind:'user'}})}]);
    const original=ctx.sessionPersistence.locate(meta).path,before=await readFile(original);
    await assert.rejects(readFile(join(root,'derived','search.db')),error=>error.code==='ENOENT','Startup must not build the index');
    const found=await ctx.sessionQuery.searchSessions({query:'fixture needle'});assert.equal(found.items[0].header.id,meta.id);
    assert.equal(entry.config.openAt,'first-search');assert.deepEqual(await readFile(original),before);
    await ctx.fiber.dispose();
    const reopened=await mount(),again=await reopened.sessionQuery.searchSessions({query:'telescope'});assert.equal(again.items[0].header.id,meta.id);assert.deepEqual(await readFile(original),before);
  }finally{for(const ctx of contexts)await ctx.fiber.dispose();assert.ok(root.startsWith(join(tmpdir(),'hub-eval-session-search-')));await rm(root,{recursive:true,force:true});}
});
const { Context, Service } = await native("@deepseek-ai/cordis");
const { default: AgentLoop } = await native("@deepseek-ai/dsh-agent-loop");
const { default: Persistence } = await native("@deepseek-ai/dsh-session-persistence-jsonl");
const { default: Projections } = await native("@deepseek-ai/dsh-session-projection");
const { default: Subagents } = await native("@deepseek-ai/dsh-subagent");
const Spawn = await native("@deepseek-ai/dsh-subagent-spawn-in-process");
const { queueHostSubagentPrompt } = await native("@deepseek-ai/dsh-subagent/internal");
const { default: Storage } = await native("@deepseek-ai/dsh-storage");
const { DomainFacility } = await native("@deepseek-ai/dsh-storage-domain");
const { JsonStorageBackend } = await native("@deepseek-ai/dsh-storage-json");


const { createUserMessage } = await native('@deepseek-ai/dsh-llm');
const { HubCharacters } = await import('../packages/harness-overlay/src/characters.ts');
const { InstructionFiles } = await import('../packages/harness-overlay/src/host/instruction-files.ts');
const { CamofoxRuntime } = await import('../packages/harness-overlay/src/host/camofox.ts');
const { attachNativeVoiceTasks } = await import('../packages/harness-overlay/src/host/voice-tasks.ts');
const { installModelSelection } = await import('../vendor/deepseek-harness/packages/core/agent/src/model-selection.ts');
const {Readable}=await import('node:stream');
const {installKnowledgeToolPolicy}=await import('../packages/harness-overlay/src/host/knowledge-tool-policy.ts');

test('native voice language context follows each correlated user turn, is logged, and never rewrites their words',async()=>{
 const {voiceReplyLanguage}=await import('../packages/harness-overlay/src/host/voice-reply-language.ts');
 const root=await mkdtemp(join(tmpdir(),'hub-eval-voice-language-')),ctx=new Context();let hints;
 try{
  await mountAgentLoopTestDependencies(ctx);await ctx.plugin(Projections);await ctx.plugin(Persistence,{root});await ctx.plugin(AgentLoop,{agents:[]});
  const adapter=new MockAdapter([textResponse('Hello.'),textResponse('Merhaba.')]);ctx.llm.registerAdapter(['fixture'],adapter);
  const agent=ctx.agentLoop.create('hub-eval-voice-language',{provider:'fixture',model:'mock'});hints=voiceReplyLanguage(agent);
  for(const [id,text,language]of [['one','Hello.','en'],['two','Merhaba.','tr']]){
   hints.admit(id,language,id==='one'?'Nearby people discussed a fixture topic.':undefined);agent.followup(createUserMessage({source:{kind:'user',rpcId:id},content:[{type:'text',text}]}));await agent.whenIdle();
   const messages=adapter.requests.at(-1).messages,last=messages.at(-1);
   assert.equal(last.source.kind,'plugin');assert.equal(last.source.plugin,'hub-voice-language');
   assert.match(last.content[0].text,new RegExp('identified '+(language==='en'?'English':'Turkish')));
   assert.equal(messages.filter(m=>m.source?.kind==='user').at(-1).content[0].text,text);
   if(id==='one'){assert.match(last.content[0].text,/untrusted overheard DATA/);assert.match(last.content[0].text,/Nearby people/);}
  }
  const events=agent.session.snapshotEvents();assert.equal(events.filter(e=>e.type==='user/message'&&e.data.source?.plugin==='hub-voice-language').length,2);
  const {knowledgeTurnSources}=await import('../packages/harness-overlay/src/host/knowledge-episodes.ts');
  for(const end of events.filter(e=>e.type==='turn/end'))assert.ok(knowledgeTurnSources(agent.session.header,events,end).every(s=>!s.content.includes('Nearby people')),'Injected background data is not new user evidence for Knowledge');
 }finally{hints?.close();await ctx.fiber.dispose();assert.ok(basename(root).startsWith('hub-eval-voice-language-'));await rm(root,{recursive:true,force:true});}
});

test('a real native voice delegation gives the HUB worker the shared image, preserves permissions and logs the exact image context',{timeout:20000},async()=>{
 const {KnowledgeAssets}=await import('../packages/harness-overlay/src/host/knowledge-assets.ts');
 const {installVoiceMediaContext}=await import('../packages/harness-overlay/src/host/voice-media.ts');
 const {randomUUID}=await import('node:crypto');
 const root=await mkdtemp(join(tmpdir(),'hub-eval-voice-photo-')),ctx=new Context();let facility,backend;
 try{
  await mountAgentLoopTestDependencies(ctx);await ctx.plugin(Projections);await ctx.plugin(Persistence,{root:join(root,'sessions')});await ctx.plugin(AgentLoop,{agents:[]});await ctx.plugin(TestSessionQuery);await ctx.plugin(Subagents);await ctx.plugin(Spawn,{providerName:'hub-character-spawn'});await ctx.plugin(Storage);
  backend=new JsonStorageBackend(join(root,'domains'));ctx.storage.backend.register('json',backend);facility=new DomainFacility(ctx,{backend:'json'});ctx.storage.mount('domain',facility);
  class Vision extends MockAdapter{async resolveModel(provider,model){return {...await super.resolveModel(provider,model),inputModalities:['text','image']};}}
  const worker=new Vision([textResponse('The fixture image is received.'),textResponse('The next photo is received.')]),mira=new MockAdapter([toolCallResponse('photo-task','hub_task',{description:'Inspect the user photo',prompt:'Analyze the photo the user shared.'},'I’ll ask HUB to look.'),textResponse('HUB received your photo.'),toolCallResponse('photo-task-2','hub_task',{description:'Inspect the next photo',prompt:'Analyze the next shared photo.'},'I’ll pass along the next one.'),textResponse('The next photo reached HUB.')]);
  ctx.llm.registerAdapter(['main'],worker);ctx.llm.registerAdapter(['fast'],mira);
  for(const [name,value]of Object.entries({agentDefaultModel:{currentSelection:()=>({provider:'main',model:'mock'})},storageDomain:facility,connection:{requestRejection:()=>undefined},webServer:{register:()=>()=>{}}}))Object.defineProperty(ctx,name,{value,configurable:true});
  const camo=new CamofoxRuntime({},new AbortController().signal,async()=>new Response(JSON.stringify({ok:true,engine:'camoufox',version:'test'}))),characters=new HubCharacters(ctx,join(root,'characters'),camo);await characters.ready;
  let state=characters.store.snapshot();const spoken=state.characters.find(c=>c.id===state.voiceId);await characters.store.change({action:'save',revision:state.revision,character:{...spoken,route:{provider:'fast',model:'mock'},tools:{mode:'allow',names:['hub_task','hub_delegate','list_agents','send_message','interrupt_agent','hub_present']}}},c=>characters.validate(c));
  const assets=new KnowledgeAssets(join(root,'vault'),join(root,'state')),receiptId=randomUUID(),image={attachmentId:'b'.repeat(64),mediaType:'image/png',width:1,height:1,bytes:68};
  await assets.bindUpload({id:receiptId,sessionId:'hub-eval-photo-parent',assetId:'c'.repeat(64),name:'Fixture.png',bytes:68,mediaType:'image/png',image});
  const children=[];ctx.on('agent/created',({agent})=>{if(agent.session.header.parentSession==='hub-eval-photo-parent')children.push(agent);},{global:true});
  const off=installVoiceMediaContext(ctx,assets),parent=ctx.agentLoop.create('hub-eval-photo-parent',{provider:'fast',model:'mock'});
  const profile=await characters.voiceProfile(),lease=await characters.beginVoice(parent,profile);const offTasks=await attachNativeVoiceTasks(parent,undefined,lease);
  const {attachVoiceProfilePolicy}=await import('../packages/harness-overlay/src/host/voice-profile-policy.ts');
  const offProfile=attachVoiceProfilePolicy(parent,profile,exec=>offTasks.allowNested(exec));
  parent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:`Please analyze my shared photo. {HUB_ATTACHMENT:${receiptId}}`}]}));
  const until=Date.now()+8000;while(!worker.requests.length||mira.requests.length<2||parent.status!=='idle'||ctx.agents.list().some(a=>a.status!=='idle')){assert.ok(Date.now()<until,'Native photo delegation did not settle');await new Promise(r=>setTimeout(r,10));}
  const request=worker.requests[0],images=request.messages.flatMap(m=>m.content).filter(b=>b.type==='image');assert.deepEqual(images,[{type:'image',attachment:image}]);
  assert.equal(mira.requests.flatMap(r=>r.messages.flatMap(m=>m.content)).filter(b=>b.type==='image').length,0,'Mira stays text-only');
  const child=children[0];assert.ok(child);
  const events=child.session.snapshotEvents(),injected=events.filter(e=>e.type==='user/message'&&e.data.source?.plugin==='hub-upload');assert.equal(injected.length,1);assert.deepEqual(injected[0].data.content.find(b=>b.type==='image').attachment,image);
  assert.equal(request.provider,'main');assert.equal(request.model,'mock');assert.ok(parent.ctx.tools.get('hub_task',parent));assert.ok(!child.ctx.tools.get('hub_task',child),'Call-only task alias does not leak into workers');
  const secondId=randomUUID(),secondImage={...image,attachmentId:'e'.repeat(64)};await assets.bindUpload({id:secondId,sessionId:parent.id,assetId:'f'.repeat(64),name:'Second.png',bytes:68,mediaType:'image/png',image:secondImage});
  parent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:`Now inspect this different photo. {HUB_ATTACHMENT:${secondId}}`}]}));
  const secondDeadline=Date.now()+8000;while(worker.requests.length<2||ctx.agents.list().some(a=>a.status!=='idle')){assert.ok(Date.now()<secondDeadline,'Second native photo task did not settle');await new Promise(r=>setTimeout(r,10));}
  assert.deepEqual(worker.requests[1].messages.flatMap(m=>m.content).filter(b=>b.type==='image'),[{type:'image',attachment:secondImage}],'A later shutter delivers its own photo, never a stale frame');
  offProfile();offTasks();lease.release();off();
 }finally{await ctx.fiber.dispose();await facility?.closeAll();await backend?.close();assert.equal(dirname(root),tmpdir());assert.ok(basename(root).startsWith('hub-eval-voice-photo-'));await rm(root,{recursive:true,force:true});}
});
test('native relayed worker results reach voice playback before and alongside the settled notice',{timeout:20000},async()=>{
 const {createVoiceConversation}=await import('../packages/harness-overlay/src/host/voice-conversation.ts');
 const root=await mkdtemp(join(tmpdir(),'hub-eval-spoken-result-')),ctx=new Context();let facility,backend,voice,offTasks,offProfile,lease,releaseWorker,releaseClosing;
 const workerGate=new Promise(resolve=>releaseWorker=resolve),closingGate=new Promise(resolve=>releaseClosing=resolve),parentId='hub-eval-spoken-result';
 try{
  await mountAgentLoopTestDependencies(ctx);await ctx.plugin(Projections);await ctx.plugin(Persistence,{root:join(root,'sessions')});await ctx.plugin(AgentLoop,{agents:[]});await ctx.plugin(TestSessionQuery);await ctx.plugin(Subagents);await ctx.plugin(Spawn,{providerName:'hub-character-spawn'});await ctx.plugin(Storage);
  backend=new JsonStorageBackend(join(root,'domains'));ctx.storage.backend.register('json',backend);facility=new DomainFacility(ctx,{backend:'json'});ctx.storage.mount('domain',facility);
  const result='HUB found the fixture price: 100 USD at the stated time.';
  const SubagentControl=await native('@deepseek-ai/dsh-tool-subagent-control');await ctx.plugin(SubagentControl);
  const worker=new MockAdapter([toolCallResponse('relay-result','send_message',{agent_id:parentId,message:'Fixture price: 100 USD, checked at the stated time.'}),textResponse('The requested fixture result is complete.')]);
  const mira=new MockAdapter([toolCallResponse('start-work','hub_task',{description:'Check the fixture price',prompt:'Return the isolated fixture quote.'},'I’ll ask HUB.'),textResponse(result),textResponse('The task is complete.')]);
  ctx.llm.registerAdapter(['main'],worker);ctx.llm.registerAdapter(['fast'],mira);
  for(const [name,value]of Object.entries({agentDefaultModel:{currentSelection:()=>({provider:'main',model:'mock'})},storageDomain:facility,connection:{requestRejection:()=>undefined},webServer:{register:()=>()=>{}}}))Object.defineProperty(ctx,name,{value,configurable:true});
  let workerRequests=0;
  ctx.on('agent/request',async({agent},next)=>{if(agent.session.header.parentSession===parentId)await (++workerRequests===1?workerGate:closingGate);return next();},{global:true});
  ctx.on('session/event',(session,event)=>{if(session.header.id===parentId&&event.type==='assistant/message'&&event.data.message.content.some(block=>block.type==='text'&&block.text===result))releaseClosing();},{global:true});
  const camo=new CamofoxRuntime({},new AbortController().signal,async()=>new Response(JSON.stringify({ok:true,engine:'camoufox',version:'test'}))),characters=new HubCharacters(ctx,join(root,'characters'),camo);await characters.ready;
  let state=characters.store.snapshot();const spoken=state.characters.find(c=>c.id===state.voiceId);await characters.store.change({action:'save',revision:state.revision,character:{...spoken,route:{provider:'fast',model:'mock'},tools:{mode:'allow',names:['hub_task','hub_delegate','send_message','list_agents','interrupt_agent','hub_present']}}},c=>characters.validate(c));
  const parent=ctx.agentLoop.create(parentId,{provider:'fast',model:'mock'}),profile=await characters.voiceProfile();lease=await characters.beginVoice(parent,profile);offTasks=await attachNativeVoiceTasks(parent,undefined,lease);
  const {attachVoiceProfilePolicy}=await import('../packages/harness-overlay/src/host/voice-profile-policy.ts');offProfile=attachVoiceProfilePolicy(parent,profile,exec=>offTasks.allowNested(exec));
  voice=createVoiceConversation({sessionId:parentId,running:()=>parent.status!=='idle',prompt:async request=>{parent.followup(createUserMessage({source:{kind:'user',rpcId:request.requestId},content:request.content}));},subscribe:fn=>ctx.on('session/event',(session,event)=>{if(session.header.id===parentId)fn(event);},{global:true}),cancel:()=>{},whenIdle:()=>parent.whenIdle()});
  const foreground=[];await voice.speak(1,'Ask HUB for the isolated price.',event=>foreground.push(event));assert.equal(worker.requests.length,0,'Mira remains available while work runs');
  releaseWorker();const deadline=Date.now()+10000;while(mira.requests.length<3||parent.status!=='idle'||ctx.agents.list().some(agent=>agent.status!=='idle')){assert.ok(Date.now()<deadline,'Native result relay did not settle: '+JSON.stringify({mira:mira.requests.length,worker:worker.requests.length,sources:parent.session.snapshotEvents().filter(e=>e.type==='user/message').map(e=>e.data.source.kind),tools:ctx.agents.list().flatMap(agent=>agent.session.snapshotEvents().filter(e=>e.type==='tool/result').map(e=>e.data.message.content))}));await new Promise(resolve=>setTimeout(resolve,10));}
  const events=parent.session.snapshotEvents(),sources=events.filter(e=>e.type==='user/message').map(e=>e.data.source.kind);assert.ok(sources.includes('agent-message'));assert.ok(sources.includes('subagent-settled'));
  const notices=voice.notifications(0).events;assert.equal(notices.flatMap(event=>event.text.split(result)).length-notices.length,1,'The actual result is spoken exactly once');assert.ok(!foreground.some(event=>event.text?.includes(result)),'Never mix a late task result into the foreground RPC');
  assert.equal(worker.requests.length,2,'Notifications must not start duplicate work');await voice.close();
 }finally{releaseWorker();releaseClosing();await voice?.close();offProfile?.();await offTasks?.();lease?.release();await ctx.fiber.dispose();assert.equal(dirname(root),tmpdir());assert.ok(basename(root).startsWith('hub-eval-spoken-result-'));await rm(root,{recursive:true,force:true});}
});

test('Goals uses native goal rounds, selected character, scoped files and durable completion without a forged human turn',{timeout:25000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub-goals-native-')),ctx=new Context();let facility,backend;
 try{
  await mountAgentLoopTestDependencies(ctx);await ctx.plugin(Projections);await ctx.plugin(Persistence,{root:join(root,'sessions')});await ctx.plugin(AgentLoop,{agents:[]});await ctx.plugin(TestSessionQuery);await ctx.plugin(Subagents);await ctx.plugin(Spawn,{providerName:'spawn'});await ctx.plugin(Storage);
  const {default:Goals}=await native('@deepseek-ai/dsh-goal');await ctx.plugin(Goals);
  backend=new JsonStorageBackend(join(root,'domains'));ctx.storage.backend.register('json',backend);facility=new DomainFacility(ctx,{backend:'json'});ctx.storage.mount('domain',facility);
  const main=new MockAdapter([toolCallResponse('verify-output','hub_goal_files',{action:'read',path:'result.md'}),toolCallResponse('final-checkpoint','hub_goal_checkpoint',{summary:'Existing output checked on the new owner.',nextAction:'',complete:true,result:'Fixture result saved.',criteria:[{index:0,evidence:['tool:output','tool:verify-output']}]})]),fast=new MockAdapter([toolCallResponse('output','hub_goal_files',{action:'write',path:'result.md',content:'# Checked native fixture'}),toolCallResponse('checkpoint','hub_goal_checkpoint',{summary:'Output saved and checked.',nextAction:'Have the next owner read and verify it.',complete:false,result:'Fixture result saved.',criteria:[{index:0,evidence:['tool:output']}]})]);ctx.llm.registerAdapter(['main'],main);ctx.llm.registerAdapter(['fast'],fast);
  const routes=new Map();class FixturePort extends Service{constructor(name,port){super(ctx,name);Object.assign(this,port);}}for(const [name,port]of Object.entries({agentPresets:{standingKeyFor:async()=>undefined,composedPreset:()=>undefined,composeFrom:async()=>undefined},agentDefaultModel:{currentSelection:()=>({provider:'main',model:'mock'}),saveSelection:async()=>{}},storageDomain:{open:spec=>facility.open(spec)},connection:{requestRejection:()=>undefined},webServer:{register:r=>{routes.set(r.path,r);return ()=>routes.delete(r.path);}},sessionController:{resolveAgent:async id=>({agent:ctx.agents.get(id)}),selectModel:async()=>{}},subprocess:{},attachments:{}}))new FixturePort(name,port);
  const camo=new CamofoxRuntime({},new AbortController().signal,async()=>new Response(JSON.stringify({ok:true,engine:'camoufox',version:'test'})));let characters;const module=await import('../packages/harness-overlay/src/characters.ts');await ctx.plugin({name:'hub-goal-injected-fixture',inject:module.inject,apply:async scoped=>{characters=new HubCharacters(scoped,join(root,'characters'),camo);await characters.ready;}});assert.ok(routes.has('/api/hub/goals'),'Real injected context must mount Goals');
  const catalog=await new Promise((resolve,reject)=>{let status;Promise.resolve(routes.get('/api/hub/characters').handler({method:'GET',url:'/api/hub/characters',headers:{'x-hub-characters':'1'}},{writeHead:code=>status=code,end:text=>status===200?resolve(JSON.parse(text)):reject(Error('Character catalog failed'))})).catch(reject);});
  assert.equal(catalog.tools.filter(tool=>tool.name==='hub_present').length,1,'Per-conversation visuals must be selectable in the character tool catalog');
  let state=characters.store.snapshot();const voice=state.characters.find(c=>c.id===state.voiceId);await characters.store.change({action:'save',revision:state.revision,character:{...voice,name:'Mira',route:{provider:'fast',model:'mock'},instructions:'Native goal owner proof.'}},c=>characters.validate(c));
  const call=(command)=>new Promise((resolve,reject)=>{const req=Readable.from(command?[Buffer.from(JSON.stringify(command))]:[]);Object.assign(req,{method:command?'POST':'GET',headers:{'x-hub-goals':'1','content-type':'application/json'}});let status;Promise.resolve(routes.get('/api/hub/goals').handler(req,{writeHead:code=>status=code,end:text=>{const data=JSON.parse(text);status===200?resolve(data):reject(Error(data.detail));}})).catch(reject);});
  const {defaultGoal}=await import('../packages/harness-overlay/src/goal-contract.ts');let goals=await call();goals=await call({action:'save',revision:goals.revision,goal:{...structuredClone(defaultGoal),title:'Native fixture',objective:'Save a checked fixture output.',criteria:['Output exists and was checked.'],characterId:voice.id,resources:{...defaultGoal.resources,knowledge:false,browser:false},limits:{...defaultGoal.limits,maxSteps:5}}});
  assert.equal(fast.requests.length,0,'Saving a draft cannot generate');const id=goals.changedId;await call({action:'start',id,revision:goals.goals[0].revision});await characters.goals.tick();goals=await call();let goal=goals.goals.find(g=>g.id===id);assert.equal(goal.status,'scheduled');const originalSession=goal.cycles[0].sessionId;const reader=await ctx.agents.resume({resumeSessionId:originalSession});goals=await call({action:'save',id,revision:goal.revision,goal:{...goal,characterId:characters.store.snapshot().mainId}});await characters.goals.tick();goals=await call();goal=goals.goals.find(g=>g.id===id);assert.equal(goal.cycles[0].sessionId,originalSession);assert.equal(goal.status,'completed',JSON.stringify({rounds:goal.rounds,criteria:goal.criteriaEvidence,evidence:goal.evidence,checkpoint:goal.checkpoint,reason:goal.reason}));assert.equal(fast.requests.length,2);assert.equal(main.requests.length,2);assert.match(JSON.stringify(main.requests[0]),/Checked native fixture/);assert.match(fast.requests[0].system,/Native goal owner proof/);assert.match(JSON.stringify(fast.requests[0].messages),/Objective:.*Save a checked fixture output/);assert.equal(await readFile(join(goal.workspace,'result.md'),'utf8'),'# Checked native fixture');assert.equal(goal.cycles[0].status,'completed');assert.equal(ctx.agents.get(originalSession),reader.agent,"History reader retains ownership of its live agent");assert.equal(ctx.goals.get(reader.agent).phase,"complete");await reader.dispose();
  const h=await ctx.agents.resume({resumeSessionId:goal.cycles[0].sessionId});try{const events=h.agent.session.snapshotEvents(),messages=events.filter(e=>e.type==='user/message');assert.ok(messages.length);assert.ok(messages.every(e=>e.data.source.kind==='goal'),'Scheduler must never forge human authority');assert.equal(ctx.goals.get(h.agent).phase,'complete');assert.equal(ctx.goals.get(h.agent).roundsStarted,2);assert.equal(ctx.goals.get(h.agent).activation,'disarmed');}finally{await h.dispose();}assert.equal(ctx.agents.list().length,0);

  // Pause after an observed write, while the next model request is pending.
  // Its receipt must survive, without treating an interrupted turn as complete.
  let retained;
  const pauseAdapter=new MockAdapter([
    toolCallResponse('pause-write','hub_goal_files',{action:'write',path:'before-pause.md',content:'# Retained before pause'}),
    'hang',
    ()=>toolCallResponse('resume-checkpoint','hub_goal_checkpoint',{summary:'The earlier saved output remains evidenced.',nextAction:'',complete:true,result:'Output retained across pause.',criteria:[{index:0,evidence:[retained.id]},{index:1,evidence:[retained.id]}]}),
  ]);
  ctx.llm.registerAdapter(['fixture-pause'],pauseAdapter);
  {const cs=characters.store.snapshot(),profile=cs.characters.find(c=>c.id===voice.id);await characters.store.change({action:'save',revision:cs.revision,character:{...profile,route:{provider:'fixture-pause',model:'mock'}}},c=>characters.validate(c));}
  goals=await call({action:'save',revision:goals.revision,goal:{...structuredClone(defaultGoal),title:'Pause evidence fixture',objective:'Retain the checked output through a pause.',criteria:['Output exists','Output is preserved'],characterId:voice.id,resources:{...defaultGoal.resources,knowledge:false,browser:false},limits:{...defaultGoal.limits,maxRounds:3,maxSteps:4}}});
  const pauseId=goals.changedId;await call({action:'start',id:pauseId,revision:goals.goals.find(g=>g.id===pauseId).revision});
  const pending=characters.goals.tick(),deadline=Date.now()+5000;
  while(pauseAdapter.requests.length<2&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(pauseAdapter.requests.length,2,'The write must finish before pausing the pending model request');
  goals=await call();await call({action:'pause',id:pauseId,revision:goals.goals.find(g=>g.id===pauseId).revision});await pending;
  goals=await call();let paused=goals.goals.find(g=>g.id===pauseId);retained=paused.evidence.find(e=>e.kind==='file');
  assert.ok(retained,'Pause must retain the receipt for a write that really completed');
  assert.equal(paused.state,'paused');assert.equal(paused.rounds[0].status,'interrupted');assert.equal(paused.criteriaEvidence.length,0);
  assert.equal(await readFile(retained.path,'utf8'),'# Retained before pause');
  await characters.goals.tick();assert.equal(pauseAdapter.requests.length,2,'A paused goal cannot admit another model call');
  await call({action:'resume',id:pauseId,revision:paused.revision});await characters.goals.tick();goals=await call();
  paused=goals.goals.find(g=>g.id===pauseId);assert.equal(paused.status,'completed');assert.equal(paused.criteriaEvidence.length,2);assert.equal(paused.cycles[0].evidence.filter(id=>id===retained.id).length,1);

  const helperOwner=new MockAdapter([toolCallResponse('ask-hub','hub_goal_delegate',{character:'HUB',description:'Bounded fixture review',prompt:'Give the fixture answer.'}),toolCallResponse('helper-checkpoint','hub_goal_checkpoint',{summary:'Helper supplied the answer.',nextAction:'',complete:true,result:'Helper answer checked.',criteria:[{index:0,evidence:['tool:ask-hub']}]})]),helperAndVerifier=new MockAdapter([textResponse('Observed helper fixture answer.'),textResponse('{"accepted":true,"reason":"The recorded helper output satisfies the fixture criterion."}')]);ctx.llm.registerAdapter(['fixture-owner'],helperOwner);ctx.llm.registerAdapter(['fixture-review'],helperAndVerifier);for(const id of [voice.id,characters.store.snapshot().mainId]){const cs=characters.store.snapshot(),profile=cs.characters.find(c=>c.id===id);await characters.store.change({action:'save',revision:cs.revision,character:{...profile,route:{provider:id===voice.id?'fixture-owner':'fixture-review',model:'mock'}}},c=>characters.validate(c));}
  goals=await call({action:'save',revision:goals.revision,goal:{...structuredClone(defaultGoal),title:'Helper and verifier fixture',objective:'Obtain and review the helper answer.',criteria:['Helper answer is returned and reviewed'],characterId:voice.id,helpers:[characters.store.snapshot().mainId],verifierId:characters.store.snapshot().mainId,resources:{...defaultGoal.resources,knowledge:false,browser:false},limits:{...defaultGoal.limits,maxSteps:8}}});const helperId=goals.changedId,helperDraft=goals.goals.find(g=>g.id===helperId);await call({action:'start',id:helperId,revision:helperDraft.revision});await characters.goals.tick();goals=await call();assert.equal(goals.goals.find(g=>g.id===helperId).status,'completed',JSON.stringify({rounds:goals.goals.find(g=>g.id===helperId).rounds,request:helperOwner.requests[1]?.messages,helperCalls:helperAndVerifier.requests.length}));assert.equal(helperOwner.requests.length,2);assert.equal(helperAndVerifier.requests.length,2);assert.ok((helperAndVerifier.requests[1].tools??[]).length===0,'Verifier must have no executable capability');assert.match(helperAndVerifier.requests[0].system,/You are HUB/);assert.doesNotMatch(helperAndVerifier.requests[0].system,/You are Mira, owner/);
 }finally{await ctx.fiber.dispose();await facility?.closeAll();await backend?.close();assert.equal(dirname(root),tmpdir());assert.ok(basename(root).startsWith('hub-goals-native-'));await rm(root,{recursive:true,force:true});}
});
test('memory plugin mounts second brain through the real injected Cordis context without model calls', {timeout:10000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub-memory-native-')),ctx=new Context(),routes=new Map();let modelCalls=0;
 try{
  const {ProviderGate}=await import('../packages/harness-overlay/src/host/provider-gate.ts');
  const Memory=await import('../packages/harness-overlay/src/memory.ts');
  const ports={agents:{list:()=>[],create:()=>{modelCalls++;throw Error('No model calls in startup test');}},tools:{register:()=>()=>{}},connection:{requestRejection:()=>undefined},webServer:{register:r=>{routes.set(r.path,r);return ()=>routes.delete(r.path);}},llm:{resolveCallConfig:()=>{modelCalls++;throw Error('No model calls in startup test');}},sessionQuery:{listSessions:async()=>[]},attachments:{},subprocess:{},hubCharacters:{quota:new ProviderGate(join(root,'providers')),instructions:new InstructionFiles(join(root,'instructions'))}};
  class FixtureService extends Service{constructor(name,port){super(ctx,name);Object.assign(this,port);}}
  for(const [name,port]of Object.entries(ports))new FixtureService(name,port);
  await ctx.plugin(Memory,{secondBrain:true,vault:join(root,'vault'),knowledgeRoot:join(root,'knowledge'),captureSince:Date.now(),project:'fixture',provider:'fixture',model:'small'});
  assert.ok(routes.has('/api/hub/memory'),'The actual plugin loader must mount Knowledge without an undeclared-service failure');
  const reply=await new Promise((resolve,reject)=>{Promise.resolve(routes.get('/api/hub/memory').handler({method:'GET',url:'/api/hub/memory',headers:{}},{writeHead:code=>assert.equal(code,200),end:text=>resolve(JSON.parse(text))})).catch(reject);});
  assert.equal(reply.secondBrain,true);assert.equal(reply.status,'ready');assert.equal(modelCalls,0);
 }finally{await ctx.fiber.dispose();assert.equal(dirname(root),tmpdir());assert.ok(basename(root).startsWith('hub-memory-native-'));await rm(root,{recursive:true,force:true});}
});
test('saved automation executes on the selected native character route with a durable root session', {timeout:25000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub-automation-native-')),ctx=new Context();let facility,backend;
 try{
  await mountAgentLoopTestDependencies(ctx);await ctx.plugin(Projections);await ctx.plugin(Persistence,{root:join(root,'sessions')});await ctx.plugin(AgentLoop,{agents:[]});await ctx.plugin(TestSessionQuery);await ctx.plugin(Subagents);await ctx.plugin(Spawn,{providerName:'spawn'});await ctx.plugin(Storage);
  backend=new JsonStorageBackend(join(root,'domains'));ctx.storage.backend.register('json',backend);facility=new DomainFacility(ctx,{backend:'json'});ctx.storage.mount('domain',facility);
  const main=new MockAdapter([textResponse('Wrong model')]),fast=new MockAdapter([textResponse('Observed fixture automation result.')]);ctx.llm.registerAdapter(['main'],main);ctx.llm.registerAdapter(['fast'],fast);
  Object.defineProperty(ctx,'agentDefaultModel',{value:{currentSelection:()=>({provider:'main',model:'mock'})},configurable:true});Object.defineProperty(ctx,'storageDomain',{value:facility,configurable:true});Object.defineProperty(ctx,'connection',{value:{requestRejection:()=>undefined},configurable:true});
  const routes=new Map();Object.defineProperty(ctx,'webServer',{value:{register:r=>{routes.set(r.path,r);return ()=>routes.delete(r.path);}},configurable:true});
  const camo=new CamofoxRuntime({},new AbortController().signal,async()=>new Response(JSON.stringify({ok:true,engine:'camoufox',version:'test'}))),characters=new HubCharacters(ctx,join(root,'characters'),camo);await characters.ready;
  let state=characters.store.snapshot();const voice=state.characters.find(c=>c.id===state.voiceId);await characters.store.change({action:'save',revision:state.revision,character:{...voice,name:'Mira',route:{provider:'fast',model:'mock'},instructions:'Native automation persona proof.'}},c=>characters.validate(c));
  const call=(command)=>new Promise((resolve,reject)=>{const req=Readable.from(command?[Buffer.from(JSON.stringify(command))]:[]);Object.assign(req,{method:command?'POST':'GET',headers:{'x-hub-automations':'1','content-type':'application/json'}});let status;Promise.resolve(routes.get('/api/hub/automations').handler(req,{writeHead:code=>status=code,end:text=>{const data=JSON.parse(text);status===200?resolve(data):reject(Error(data.detail));}})).catch(reject);});
  state=await call();state=await call({action:'save',revision:state.revision,automation:{title:'Isolated native task',prompt:'Return the fixture result.',characterId:voice.id,trigger:{kind:'once',at:Date.now()+3600000},missed:'catch-up',tools:[],allowWrites:false,maxOutputTokens:512,maxSteps:1,dailyMaxRuns:1,dailyBudget:1,inputPrice:.1,outputPrice:.5,notification:'pwa'}});await call({action:'run-once',revision:state.revision,id:state.automations[0].id});
  const until=Date.now()+18000;do{state=await call();if(state.automations[0].status==='completed')break;assert.ok(Date.now()<until,'Automation did not complete');await new Promise(r=>setTimeout(r,50));}while(true);
  assert.equal(main.requests.length,0);assert.equal(fast.requests.length,1);assert.match(fast.requests[0].system,/Native automation persona proof/);assert.equal(state.automations[0].runs[0].result,'Observed fixture automation result.');assert.equal(state.automations[0].runs[0].route,'fast/mock');
  const disk=JSON.parse(await readFile(join(root,'hub-automations','automations.json'),'utf8'));assert.equal(disk.automations[0].runs[0].status,'completed');assert.equal(ctx.agents.list().length,0);
 }finally{await ctx.fiber.dispose();await facility?.closeAll();await backend?.close();assert.equal(dirname(root),tmpdir());assert.ok(basename(root).startsWith('hub-automation-native-'));await rm(root,{recursive:true,force:true});}
});
test('native character delegation uses the target model/persona while the coordinator remains separate', {timeout:25000}, async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub-characters-native-'));
 const ctx=new Context();let facility,backend;
 try{
  await mountAgentLoopTestDependencies(ctx);await ctx.plugin(Projections);await ctx.plugin(Persistence,{root:join(root,'sessions')});
  await ctx.plugin(AgentLoop,{agents:[]});await ctx.plugin(TestSessionQuery);await ctx.plugin(Subagents);await ctx.plugin(Spawn,{providerName:'spawn'});await ctx.plugin(Storage);
  backend=new JsonStorageBackend(join(root,'domains'));ctx.storage.backend.register('json',backend);facility=new DomainFacility(ctx,{backend:'json'});ctx.storage.mount('domain',facility);
  const mainAdapter=new MockAdapter([textResponse('Verified specialist result')]);
  const fastAdapter=new MockAdapter([toolCallResponse('handoff','hub_delegate',{character:'HUB',description:'Test specialist work',prompt:'Return a brief result'}),textResponse('HUB is working; I can keep talking.'),toolCallResponse('unwanted-retry','hub_delegate',{character:'HUB',description:'Retry from a completion notice',prompt:'Repeat the work'}),textResponse('The specialist finished.')]);
  ctx.llm.registerAdapter(['main'],mainAdapter);ctx.llm.registerAdapter(['alternate'],new MockAdapter([textResponse('Wrong target')]));ctx.llm.registerAdapter(['fast'],fastAdapter);
  let releaseWorker;const workerGate=new Promise(resolve=>{releaseWorker=resolve});
  ctx.on('agent/request',async({agent},next)=>{if(agent.session.header.origin==='subagent')await workerGate;return next();},{global:true});
  Object.defineProperty(ctx,'agentDefaultModel',{value:{currentSelection:()=>({provider:'main',model:'mock'})},configurable:true});
  Object.defineProperty(ctx,'storageDomain',{value:facility,configurable:true});
  Object.defineProperty(ctx,'connection',{value:{requestRejection:()=>undefined},configurable:true});
  Object.defineProperty(ctx,'webServer',{value:{register:()=>()=>{}},configurable:true});
  const camo=new CamofoxRuntime({},new AbortController().signal,async()=>new Response(JSON.stringify({ok:true,engine:'camoufox',version:'test'})));
  const characters=new HubCharacters(ctx,join(root,'characters'),camo);await characters.ready;
  let state=characters.store.snapshot();const spoken=state.characters.find(c=>c.id===state.voiceId);
  await characters.store.change({action:'save',revision:state.revision,character:{...spoken,route:{provider:'fast',model:'mock'}}},c=>characters.validate(c));
  state=characters.store.snapshot();await characters.store.change({action:'select',revision:state.revision,id:state.voiceId,sessionId:'character-parent'},c=>characters.validate(c));
  const parent=ctx.agentLoop.create('character-parent',{provider:'fast',model:'mock'});
  await characters.prepare(parent);assert.ok(parent.ctx.tools.get('hub_delegate',parent));
  const voiceLease=await characters.beginVoice(parent,await characters.voiceProfile());
  const offVoiceTasks=await attachNativeVoiceTasks(parent,undefined,voiceLease);
  state=characters.store.snapshot();const oldMain=state.characters.find(c=>c.id===state.mainId);
  await characters.store.change({action:'save',revision:state.revision,character:{...oldMain,name:'Updated HUB',route:{provider:'alternate',model:'mock'}}},c=>characters.validate(c));
  parent.followup(createUserMessage({content:[{type:'text',text:'Please ask HUB to do specialist work.'}],source:{kind:'user'}}));
  const deadline=Date.now()+10000;while(fastAdapter.requests.length<1||parent.status!=='idle'){assert.ok(Date.now()<deadline,'Coordinator did not return promptly');await new Promise(r=>setTimeout(r,10));}
  assert.equal(mainAdapter.requests.length,0,'Specialist is still waiting while coordinator is available');
  parent.followup(createUserMessage({content:[{type:'text',text:'Can we keep talking?'}],source:{kind:'user'}}));
  while(fastAdapter.requests.length<2||parent.status!=='idle'){assert.ok(Date.now()<deadline,'Coordinator could not answer while specialist runs');await new Promise(r=>setTimeout(r,10));}
  releaseWorker();
  while(mainAdapter.requests.length<1){assert.ok(Date.now()<deadline,'Specialist did not run');await new Promise(r=>setTimeout(r,10));}
  while(fastAdapter.requests.length<3||parent.status!=='idle'){assert.ok(Date.now()<deadline,'Completion notice did not settle');await new Promise(r=>setTimeout(r,10));}
  assert.equal(mainAdapter.requests.length,1,'A completion notification must not start another paid specialist');
  const deniedRetry=parent.session.snapshotEvents().filter(e=>e.type==='tool/result').at(-1)?.data?.message?.content?.[0];
  assert.equal(deniedRetry?.isError,true);
  assert.match(JSON.stringify(deniedRetry),/not a new user request/);
  voiceLease.release();
  assert.equal(mainAdapter.requests[0].provider,'main');assert.ok(fastAdapter.requests.every(r=>r.provider==='fast'));
  assert.equal(mainAdapter.requests[0].maxTokens,8192,'Specialists must not reserve the provider’s full output window');
  assert.ok(fastAdapter.requests.every(request=>!request.tools.some(tool=>/camofox|web_search|web_fetch/.test(tool.name))),'Voice model must see its actual foreground capabilities');
  assert.match(JSON.stringify(mainAdapter.requests[0]),/Character: HUB/);
  assert.ok(mainAdapter.requests[0].tools.some(t=>t.name==='camofox_search'));
  await offVoiceTasks?.();
  state=characters.store.snapshot();const custom=state.characters.find(c=>c.name==='B4D');assert.equal(custom.route,null);
  assert.equal(characters.store.selected('minke-im-telegram-example').id,state.mainId);
  // Same-process recall must pass the real Telegram coordinator guard without
  // allowing a knowledge write tool or starting another paid model request.
  const telegram=ctx.agentLoop.create('minke-im-telegram-knowledge-check',{provider:'main',model:'mock'});await characters.prepare(telegram);
  let writeRan=false;
  for(const name of ['hub_knowledge_search','hub_knowledge_read','hub_knowledge_write'])telegram.ctx.tools.register({name,description:'Synthetic saved note test',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:String(value)}]},execute:async()=>{if(name==='hub_knowledge_write')writeRan=true;return 'Relevant saved note';}});
  for(const name of ['hub_knowledge_search','hub_knowledge_read']){const result=await telegram.ctx.tools.execute({agent:telegram,name,arguments:{},callId:'knowledge-'+name,signal:AbortSignal.timeout(1000)});assert.equal(result.isError,false,JSON.stringify(result));}
  const denied=await telegram.ctx.tools.execute({agent:telegram,name:'hub_knowledge_write',arguments:{},callId:'knowledge-write-denied',signal:AbortSignal.timeout(1000)});assert.equal(denied.isError,true);assert.equal(writeRan,false);
 }finally{await ctx.fiber.dispose();await facility?.closeAll();await backend?.close();assert.equal(dirname(root),tmpdir());assert.ok(basename(root).startsWith('hub-characters-native-'));await rm(root,{recursive:true,force:true});}
});

test('model identity and natural conversation handoffs stay consistent without a greeting worker',{timeout:25000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'hub-characters-native-'));
 const ctx=new Context();let facility,backend;
 try{
  await mountAgentLoopTestDependencies(ctx,{systemPrompt:{persona:'You are powered by {{provider}}/{{model}}.'}});
  await ctx.plugin(Projections);await ctx.plugin(Persistence,{root:join(root,'sessions')});await ctx.plugin(AgentLoop,{agents:[]});
  await ctx.plugin(TestSessionQuery);await ctx.plugin(Subagents);await ctx.plugin(Spawn,{providerName:'spawn'});await ctx.plugin(Storage);
  let legacyRan=false;ctx.tools.register({name:'mcp__hub_memory__search_notes',description:'Retired fixture store',parameters:{type:'object',properties:{}},output:{schema:{type:'string'},render:()=>[]},execute:async()=>{legacyRan=true;return 'Must not run';}});ctx.effect(()=>installKnowledgeToolPolicy(ctx));
  backend=new JsonStorageBackend(join(root,'domains'));ctx.storage.backend.register('json',backend);facility=new DomainFacility(ctx,{backend:'json'});ctx.storage.mount('domain',facility);
  let voiceIdentity;
  const main=new MockAdapter([()=>toolCallResponse('natural-handoff','hub_switch_character',{character:voiceIdentity}),textResponse('HUB is back.'),textResponse('A new chat starts with HUB.'),toolCallResponse('text-canvas','hub_present',{title:'Native conversation canvas',kind:'html',html:'<p>Fixture plan</p>'}),textResponse('The visual is available.'),textResponse('Telegram coordinator ready.')]);
  const fast=new MockAdapter([textResponse('Hi, I am Vera.'),textResponse('I run fast/mock.'),toolCallResponse('return-hub','hub_switch_character',{character:'HUB'})]);
  ctx.llm.registerAdapter(['main'],main);ctx.llm.registerAdapter(['fast'],fast);ctx.llm.registerAdapter(['legacy'],new MockAdapter([textResponse('Must not run')]));
  let deployment={provider:'main',model:'mock'};const selections=new Map();
  ctx.on('agent/created',({agent})=>{const ref={current:{provider:'legacy',model:'old-qwen'},assembled:undefined};selections.set(agent.id,ref);installModelSelection(agent.ctx,ref);},{global:true});
  Object.defineProperty(ctx,'agentDefaultModel',{value:{currentSelection:()=>deployment,saveSelection:async route=>{deployment={...route};}},configurable:true});
  Object.defineProperty(ctx,'sessionController',{value:{selectModel:async({sessionId,...route})=>{selections.get(sessionId).current=route;ctx.agents.get(sessionId).session.append('model/selection',route);}},configurable:true});
  Object.defineProperty(ctx,'storageDomain',{value:facility,configurable:true});Object.defineProperty(ctx,'connection',{value:{requestRejection:()=>undefined},configurable:true});Object.defineProperty(ctx,'webServer',{value:{register:()=>()=>{}},configurable:true});
  const camo=new CamofoxRuntime({},new AbortController().signal,async()=>new Response(JSON.stringify({ok:true,engine:'camoufox',version:'test'})));
  let inspectorRoute;ctx.webServer.register=route=>{if(route.path==='/api/hub/character-request')inspectorRoute=route;return()=>{};};
  const characters=new HubCharacters(ctx,join(root,'characters'),camo);await characters.ready;
  const state=characters.store.snapshot(),voice=state.characters.find(c=>c.id===state.voiceId);
  voiceIdentity=voice.id;
  assert.equal(voice.name,'Vera');assert.ok(state.characters.some(c=>c.name==='B4D'&&c.route===null));
  await characters.store.change({action:'save',revision:state.revision,character:{...voice,name:'Vera',route:{provider:'fast',model:'mock'}}},c=>characters.validate(c));
  const parent=ctx.agentLoop.create('handoff-parent',{provider:'legacy',model:'old-qwen'});
  const instructionFiles=new InstructionFiles(join(root,'characters','instructions'));await instructionFiles.load();const soul=instructionFiles.files().find(f=>f.id==='SOUL.md');await instructionFiles.save('SOUL.md',soul.hash,'Shared instruction proof for native requests.');
  let navigation='Memory index revision one: retrieve sources by stable identity.';
  const offMemory=characters.instructions.registerManaged('memory.md',async()=>navigation);t.after(offMemory);
  async function say(agent,text){const before=agent.session.snapshotEvents().filter(e=>e.type==='turn/end').length;agent.followup(createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}));const end=Date.now()+8000;while(agent.status!=='idle'||agent.session.snapshotEvents().filter(e=>e.type==='turn/end').length<=before){assert.ok(Date.now()<end,'Turn did not settle');await new Promise(r=>setTimeout(r,10));}}
  await say(parent,'Konuşma asistanıyla sohbet etmek istiyorum; konuşmayı ona devretir misin?');
  assert.equal(main.requests.length,1);assert.equal(fast.requests.length,1);
  assert.match(JSON.stringify(main.requests[0]),/powered by main\/mock/);assert.doesNotMatch(JSON.stringify(main.requests[0]),/powered by legacy\/old-qwen/);
  assert.ok(main.requests[0].tools.every(tool=>!tool.name.startsWith('mcp__hub_memory__')));const blockedLegacy=await parent.ctx.tools.execute({agent:parent,name:'mcp__hub_memory__search_notes',arguments:{},callId:'legacy-denied',signal:AbortSignal.timeout(1000)});assert.equal(blockedLegacy.isError,true);assert.equal(legacyRan,false);
  assert.match(JSON.stringify(fast.requests[0]),/powered by fast\/mock/);assert.match(JSON.stringify(fast.requests[0]),/Character: Vera/);
  assert.match(main.requests[0].system,new RegExp(`ID: ${voice.id} · Role: voice assistant · Display name: Vera`));
  assert.match(main.requests[0].system,/names are editable display labels/);
  assert.match(main.requests[0].system,/Shared instruction proof/);assert.match(fast.requests[0].system,/Shared instruction proof/);
  assert.match(main.requests[0].system,/Memory index revision one/);assert.match(fast.requests[0].system,/Memory index revision one/);
  const memory=ctx.agentLoop.create('hub-memory-instruction-test',{provider:'main',model:'mock'});const assembled=await ctx.systemPrompt.assemble({scope:memory});assert.ok(!assembled.sections.some(s=>s.text.includes('Shared instruction proof')));
  assert.equal(ctx.agents.list().filter(a=>a.session.header.origin==='subagent').length,0);
  assert.equal(characters.store.selected(parent.id).name,'Vera');assert.equal(deployment.provider,'main');
  const beforeRename=characters.store.snapshot(),bound=characters.store.selected(parent.id);
  await characters.store.change({action:'save',revision:beforeRename.revision,character:{...bound,name:'Nova'}},c=>characters.validate(c));
  assert.equal(characters.store.selected(parent.id).id,voice.id);assert.equal(characters.store.selected(parent.id).name,'Nova');
  navigation='Memory index revision two: changed domains are current.';
  await say(parent,'What model are you running?');assert.equal(fast.requests.length,2);assert.equal(main.requests.length,1);
  const inspected=await new Promise(resolve=>inspectorRoute.handler({method:'GET',url:'/api/hub/character-request?characterId='+voice.id,headers:{'x-hub-characters':'1'}},{writeHead:code=>assert.equal(code,200),end:body=>resolve(JSON.parse(body))}));
  assert.deepEqual(JSON.parse(inspected.record.json),JSON.parse(JSON.stringify(fast.requests[1],(k,v)=>k==='signal'?undefined:v)),'Inspector must match the native adapter request, including shared instructions, tool schemas and conversation history');
  assert.match(fast.requests[1].system,/Memory index revision two/);assert.doesNotMatch(fast.requests[1].system,/Memory index revision one/);
  assert.match(fast.requests[1].system,/Character: Nova/);assert.match(fast.requests[1].system,new RegExp(`ID: ${voice.id} · Role: voice assistant · Display name: Nova`));
  await say(parent,'Let your main assistant take over our conversation again.');assert.equal(main.requests.length,2);assert.equal(characters.store.selected(parent.id).name,'HUB');
  const newChat=ctx.agentLoop.create('new-default-chat',{provider:'legacy',model:'old-qwen'});await say(newChat,'Hello');assert.equal(main.requests.length,3);assert.equal(deployment.provider,'main');
  await say(newChat,'Show the fixture plan as a visual.');
  assert.equal(characters.presentations.summary(newChat.id)?.title,'Native conversation canvas');
  assert.equal(characters.presentations.summary(parent.id),null);
  assert.match(JSON.stringify(main.requests.at(-1)),/hub_present/);
  const revision=characters.store.snapshot().revision;
  const denied=await parent.ctx.tools.execute({agent:parent,name:'hub_switch_character',arguments:{character:voice.id},callId:'notification-switch',signal:AbortSignal.timeout(1000)});
  assert.equal(denied.isError,true);assert.equal(characters.store.snapshot().revision,revision);
  // A selected specialist owns its Telegram work; forced coordinator handoffs
  // must not override its instructions or its configured tool permissions.
  const specialistAdapter=new MockAdapter([textResponse('I will solve the specialist task myself.')]);ctx.llm.registerAdapter(['specialist'],specialistAdapter);
  const unconfigured=characters.store.snapshot().characters.find(c=>c.id!==state.mainId&&c.id!==state.voiceId);
  await characters.store.change({action:'save',revision:characters.store.snapshot().revision,character:{...unconfigured,route:{provider:'specialist',model:'mock'},instructions:'Own your task. Delegate only neutral auxiliary work.',tools:{mode:'allow',names:['fixture_local_check']}}},c=>characters.validate(c));
  const telegram=ctx.agentLoop.create('minke-im-telegram-specialist-policy',{provider:'legacy',model:'old-qwen'});let localRuns=0;
  telegram.ctx.tools.register({name:'fixture_local_check',description:'Isolated permitted fixture action',parameters:{type:'object',properties:{}},output:{schema:{type:'string'},render:()=>[]},execute:async()=>{localRuns++;return 'Done';}});
  telegram.ctx.tools.register({name:'fixture_disabled_check',description:'Isolated disabled fixture action',parameters:{type:'object',properties:{}},output:{schema:{type:'string'},render:()=>[]},execute:async()=>{throw Error('Must remain disabled');}});
  const execute=name=>telegram.ctx.tools.execute({agent:telegram,name,arguments:{},callId:'telegram-policy-'+name,signal:AbortSignal.timeout(1000)});
  await say(telegram,'Hello, main assistant.');assert.match(main.requests.at(-1).system,/Telegram conversation coordinator/);
  assert.equal((await execute('fixture_local_check')).isError,true);assert.equal(localRuns,0);
  await characters.store.change({action:'select',revision:characters.store.snapshot().revision,id:unconfigured.id,sessionId:telegram.id},c=>characters.validate(c));
  await say(telegram,'Please handle this specialist task yourself.');
  assert.match(specialistAdapter.requests[0].system,/Own your task/);assert.doesNotMatch(specialistAdapter.requests[0].system,/Telegram conversation coordinator/);
  assert.equal((await execute('fixture_local_check')).isError,false);assert.equal(localRuns,1);
  assert.equal((await execute('fixture_disabled_check')).isError,true);
 }finally{await ctx.fiber.dispose();await facility?.closeAll();await backend?.close();assert.equal(dirname(root),tmpdir());assert.ok(basename(root).startsWith('hub-characters-native-'));await rm(root,{recursive:true,force:true});}
});
