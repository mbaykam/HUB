// Real native voice session, tools, character routes and child persistence;
// scripted responses avoid paid inference and physical-microphone claims.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {native} from '../scripts/tests/native-harness-resolver.mjs';
import {MockAdapter,textResponse,toolCallResponse} from '../vendor/deepseek-harness/packages/core/agent-loop/tests/mock-adapter.ts';

const {Context}=await native('@deepseek-ai/cordis');
const {mountAgentLoopTestDependencies}=await import('../vendor/deepseek-harness/packages/test-support/agent-loop-testkit/src/index.ts');
const {installModelSelection}=await import('../vendor/deepseek-harness/packages/core/agent/src/model-selection.ts');
const {HubCharacters}=await import('../packages/harness-overlay/src/characters.ts');
const {CamofoxRuntime}=await import('../packages/harness-overlay/src/host/camofox.ts');
const {openNativeVoiceSession}=await import('../packages/harness-overlay/src/host/voice-session.ts');
const {attachNativeVoiceTasks}=await import('../packages/harness-overlay/src/host/voice-tasks.ts');
const {createVoiceTaskPolicies}=await import('../packages/harness-overlay/src/host/voice-task-policy.ts');
const {TestSessionQuery}=await import('../vendor/deepseek-harness/packages/subagent/subagent/tests/test-session-query.ts');
const {createUserMessage}=await native('@deepseek-ai/dsh-llm');
const {default:Projections}=await native('@deepseek-ai/dsh-session-projection');
const {default:Persistence}=await native('@deepseek-ai/dsh-session-persistence-jsonl');
const {default:AgentLoop}=await native('@deepseek-ai/dsh-agent-loop');
const {default:Subagents}=await native('@deepseek-ai/dsh-subagent');
const Spawn=await native('@deepseek-ai/dsh-subagent-spawn-in-process');
const {default:Storage}=await native('@deepseek-ai/dsh-storage');
const {DomainFacility}=await native('@deepseek-ai/dsh-storage-domain');
const {JsonStorageBackend}=await native('@deepseek-ai/dsh-storage-json');

test('direct picker queues a running voice reply, handles a start/save race and preserves worker continuations',async()=>{
 const first={id:'first',name:'First',route:{provider:'fixture',model:'first'},tools:{mode:'inherit'}},second={...first,id:'second',name:'Second',route:{provider:'fixture',model:'second'}},state={revision:1,mainId:'first',voiceId:'first',characters:[first,second],bindings:{}},agent={id:'hub-eval-picker',status:'running',session:{header:{}}};
 let active=state,sync=0,disposals=0;const worker={dispose:async()=>{disposals++;}},mount={revision:1,fibers:[worker],names:new Map([['first','worker-first']]),snapshot:state,turnSnapshot:state,assembled:{character:first,state},voiceCharacter:first};
 const manager={mounts:new Map([[agent.id,mount]]),voiceCalls:new Set([agent.id]),store:{snapshot:()=>active,selected:(_id,s)=>s.characters.find(c=>c.id===(s.bindings[agent.id]??s.mainId)),change:async c=>active={...state,revision:2,bindings:{[agent.id]:c.id}}},host:{sessionController:{resolveAgent:async()=>({agent})}},validate:async()=>{},syncNativeRoute:async()=>{sync++;}};
 const result=await HubCharacters.prototype.selectFromUI.call(manager,{action:'select',revision:1,id:'second',sessionId:agent.id});assert.equal(result.pending,true);assert.equal(mount.assembled.character.id,'first');assert.equal(mount.voiceCharacter.id,'first');assert.equal(mount.pendingVoiceCharacter.id,'second');assert.equal(sync,0);
 await HubCharacters.prototype.prepare.call(manager,agent,active);assert.equal(disposals,0);assert.equal(mount.fibers[0],worker);assert.equal(mount.snapshot.bindings[agent.id],'second');
 agent.status='idle';const immediate=await HubCharacters.prototype.selectFromUI.call(manager,{action:'select',revision:2,id:'second',sessionId:agent.id});assert.equal(immediate.pending,false);assert.equal(mount.voiceCharacter.id,'second');assert.equal(mount.pendingVoiceCharacter,undefined);assert.equal(mount.assembled,undefined);assert.equal(sync,1);
 await assert.rejects(HubCharacters.prototype.selectFromUI.call(manager,{action:'select',revision:2,id:'second',sessionId:'hub-goal-managed'}),/assigned character/);
});

test('live voice switches its actual model, persona, tool policy and worker target in the same conversation',{timeout:25000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub-eval-voice-handoff-')),ctx=new Context();
 let backend,facility,policies,voice;
 try{
  await mountAgentLoopTestDependencies(ctx,{systemPrompt:{persona:'You are powered by {{provider}}/{{model}}.'}});
  await ctx.plugin(Projections);await ctx.plugin(Persistence,{root:join(root,'sessions')});await ctx.plugin(AgentLoop,{agents:[]});
  await ctx.plugin(TestSessionQuery);await ctx.plugin(Subagents);await ctx.plugin(Spawn,{providerName:'hub-character-spawn'});await ctx.plugin(Storage);
  backend=new JsonStorageBackend(join(root,'domains'));ctx.storage.backend.register('json',backend);facility=new DomainFacility(ctx,{backend:'json'});ctx.storage.mount('domain',facility);
  let deployment={provider:'main',model:'mock'},specialistId;const selections=new Map(),children=[];
  ctx.on('agent/created',({agent})=>{if(agent.session.header.origin==='subagent'){children.push(agent);return;}const ref={current:{provider:'main',model:'mock'},assembled:undefined};selections.set(agent.id,ref);installModelSelection(agent.ctx,ref);},{global:true});
  const main=new MockAdapter([textResponse('The main assistant is back.')]);
  class WithEffort extends MockAdapter{async resolveModel(provider,model){return {...await super.resolveModel(provider,model),reasoning:{efforts:[{id:'low',name:'Low'}]}};}}
  const fast=new WithEffort([()=>toolCallResponse('voice-handoff','hub_switch_character',{character:specialistId})]);
  const specialist=new MockAdapter([
   textResponse('The specialist is speaking.'),textResponse('I use specialist/mock.'),
   toolCallResponse('specialist-work','hub_task',{description:'Check a harmless fixture',prompt:'Use fixture_allowed once and report the result.'},'I will check it.'),
   toolCallResponse('specialist-check','fixture_allowed',{}),textResponse('Fixture verified.'),textResponse('My worker verified the fixture.'),
   toolCallResponse('return-main','hub_switch_character',{character:'HUB'}),
  ]);
  ctx.llm.registerAdapter(['main'],main);ctx.llm.registerAdapter(['fast'],fast);ctx.llm.registerAdapter(['specialist'],specialist);
  const controller={
   async resolveAgent(id){const agent=ctx.agents.get(id);return agent?{agent}:{error:'missing'};},
   async selectModel({sessionId,...route}){selections.get(sessionId).current=route;ctx.agents.get(sessionId).session.append('model/selection',route);},
   async prompt({sessionId,requestId,content}){ctx.agents.get(sessionId).followup(createUserMessage({source:{kind:'user',rpcId:requestId},content}));},
  };
  for(const [name,value]of Object.entries({sessionController:controller,agentDefaultModel:{currentSelection:()=>deployment,saveSelection:async value=>{deployment={...value};}},storageDomain:facility,connection:{requestRejection:()=>undefined},webServer:{register:()=>()=>{}}}))Object.defineProperty(ctx,name,{value,configurable:true});
  let checks=0;ctx.tools.register({name:'fixture_allowed',description:'Check an isolated harmless fixture',parameters:{type:'object',properties:{}},output:{schema:{type:'string'},render:()=>[]},execute:async()=>{checks++;return 'Fixture verified.';}});
  const camo=new CamofoxRuntime({},new AbortController().signal,async()=>new Response(JSON.stringify({ok:true,engine:'camoufox',version:'test'})));
  const characters=new HubCharacters(ctx,join(root,'characters'),camo);await characters.ready;
  let state=characters.store.snapshot();const initial=state.characters.find(c=>c.id===state.voiceId),special=state.characters.find(c=>c.id!==state.mainId&&c.id!==state.voiceId);specialistId=special.id;
  const names=['hub_task','hub_delegate','list_agents','send_message','interrupt_agent','hub_present'];
  await characters.store.change({action:'save',revision:state.revision,character:{...initial,route:{provider:'fast',model:'mock',reasoningEffort:'low',temperature:0.1},instructions:'VOICE_PERSONA_ONLY',tools:{mode:'allow',names}}},c=>characters.validate(c));
  state=characters.store.snapshot();await characters.store.change({action:'save',revision:state.revision,character:{...special,name:'Renamed specialist',route:{provider:'specialist',model:'mock',maxTokens:12000,temperature:0.3},instructions:'SPECIALIST_PERSONA_ONLY',tools:{mode:'inherit'}}},c=>characters.validate(c));
  policies=createVoiceTaskPolicies(ctx,facility);
  const parent=ctx.agentLoop.create('hub-eval-voice-handoff',{provider:'main',model:'mock'}),profile=await characters.voiceProfile();let lease;
  voice=await openNativeVoiceSession(ctx,profile.route,{sessionId:parent.id,profile,taskPolicies:policies,tasks:async agent=>{
   lease=await characters.beginVoice(agent,profile);const off=await attachNativeVoiceTasks(agent,undefined,lease);
   return Object.assign(async()=>{await off();},{allowNested:off.allowNested,currentProfile:lease.currentProfile,releaseIdentity:lease.release});
  }});
  const events=[];
  await voice.speak(1,'Özel uzmanla konuşmak istiyorum, sözü ona bırakır mısın?',e=>events.push(e));
  assert.equal(fast.requests.length,1);assert.ok(fast.requests[0].tools.some(t=>t.name==='hub_switch_character'),'Human navigation remains available without editing saved action permissions');
  assert.equal(specialist.requests.length,1);assert.match(events.filter(e=>e.type==='text').map(e=>e.text).join(''),/The specialist is speaking/);
  assert.equal(ctx.agents.list().length,1,'A conversation handoff does not create a greeting worker');
  const request=specialist.requests[0];assert.equal(request.provider,'specialist');assert.equal(request.maxTokens,12000);assert.equal(request.temperature,0.3);assert.equal(request.reasoningEffort,undefined,'Previous speaker effort must not leak');
  assert.match(request.system,/powered by specialist\/mock/);assert.match(request.system,/SPECIALIST_PERSONA_ONLY/);assert.doesNotMatch(request.system,/VOICE_PERSONA_ONLY/);
  assert.ok(request.messages.some(m=>m.content.some(b=>b.type==='text'&&b.text.includes('Özel uzmanla'))),'Same conversation context is retained');
  assert.equal(characters.voiceTarget(parent.id).id,specialistId);assert.equal(characters.store.selected(parent.id).id,specialistId);
  assert.equal((await parent.ctx.tools.execute({agent:parent,name:'fixture_allowed',arguments:{},callId:'foreground-denied',signal:AbortSignal.timeout(1000)})).isError,true,'Substantial foreground actions remain blocked during speech');
  await voice.speak(2,'What model are you using?',()=>{});assert.equal(specialist.requests.length,2);
  await voice.speak(3,'Check the harmless fixture in the background.',()=>{});
  const deadline=Date.now()+8000;while(ctx.agents.list().some(a=>a.status!=='idle')||checks!==1||specialist.requests.length<6){assert.ok(Date.now()<deadline,'Specialist worker and completion notice did not settle');await new Promise(r=>setTimeout(r,10));}
  const child=children[0];assert.ok(child);assert.equal(child.session.header.parentSession,parent.id);assert.equal(checks,1);
  assert.equal(specialist.requests.length,6);assert.equal(main.requests.length,0,'A specialist worker must not silently use the main assistant model');
  const worker=specialist.requests[3];assert.match(worker.system,/SPECIALIST_PERSONA_ONLY/);assert.equal(worker.provider,'specialist');
  assert.match(worker.system,/specialist worker/);
  await voice.speak(4,'Ana asistanla devam edelim.',()=>{});assert.equal(main.requests.length,1);assert.equal(characters.effectiveCharacter(parent.id).id,characters.store.snapshot().mainId);
  assert.match(main.requests[0].system,/Voice personality: HUB/);assert.doesNotMatch(main.requests[0].system,/SPECIALIST_PERSONA_ONLY|VOICE_PERSONA_ONLY/);
  assert.deepEqual(deployment,{provider:'main',model:'mock'});assert.deepEqual(characters.store.snapshot().characters.find(c=>c.id===initial.id).tools,{mode:'allow',names},'Saved voice permissions are unchanged');
  const revision=characters.store.snapshot().revision;
  assert.equal((await parent.ctx.tools.execute({agent:parent,name:'hub_switch_character',arguments:{character:specialistId},callId:'no-human-turn',signal:AbortSignal.timeout(1000)})).isError,true,'Background notifications cannot switch the user speaker');
  assert.equal(characters.store.snapshot().revision,revision);
  await voice.close();voice=undefined;assert.equal(characters.voiceCalls.has(parent.id),false);assert.equal(parent.ctx.tools.get('hub_task',parent),undefined);
 }finally{await voice?.close();await policies?.close();await ctx.fiber.dispose();await facility?.closeAll();await backend?.close();assert.ok(root.startsWith(join(tmpdir(),'hub-eval-voice-handoff-')));await rm(root,{recursive:true,force:true});}
});
