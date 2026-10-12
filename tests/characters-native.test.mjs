// Real pinned AgentLoop + continuation manager + JSONL persistence. Only the
// model response is scripted; no paid requests, user chats or live app state.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";


// Resolve the pinned monorepo packages just as the native test runner does.
const entries = new Map();
const packages = new URL("../vendor/deepseek-harness/packages/", import.meta.url);
for (const group of await readdir(packages, { withFileTypes: true })) {
  if (!group.isDirectory()) continue;
  for (const pkg of await readdir(new URL(group.name + "/", packages), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const directory = new URL(`${group.name}/${pkg.name}/`, packages);
    let manifest; try { manifest = JSON.parse(await readFile(new URL("package.json", directory), "utf8")); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const packageEntry = manifest.exports?.["."]?.default ?? manifest.main;
    if (packageEntry?.endsWith(".js")) entries.set(manifest.name, new URL(packageEntry, directory).href);
    for (const [key, value] of Object.entries(manifest.exports ?? {})) {
      const target = typeof value === "string" ? value : value?.default;
      if (key.startsWith("./") && target?.endsWith(".js")) entries.set(manifest.name + key.slice(1), new URL(target, directory).href);
    }
  }
}
registerHooks({ resolve(specifier, context, next) { return next(entries.get(specifier) ?? specifier, context); } });
const { mountAgentLoopTestDependencies } = await import("../vendor/deepseek-harness/packages/test-support/agent-loop-testkit/src/index.ts");
const { MockAdapter, textResponse, toolCallResponse } = await import("../vendor/deepseek-harness/packages/core/agent-loop/tests/mock-adapter.ts");
const { TestSessionQuery } = await import("../vendor/deepseek-harness/packages/subagent/subagent/tests/test-session-query.ts");

const requireNative = createRequire(new URL("../vendor/deepseek-harness/package.json", import.meta.url));
const native = name => import(entries.get(name) ?? pathToFileURL(requireNative.resolve(name)).href);
const { Context } = await native("@deepseek-ai/cordis");
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
  state=characters.store.snapshot();const devil=state.characters.find(c=>c.name==='Devil');assert.equal(devil.route,null);
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

test('model identity and natural conversation handoffs stay consistent without a greeting worker',{timeout:25000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub-characters-native-'));
 const ctx=new Context();let facility,backend;
 try{
  await mountAgentLoopTestDependencies(ctx,{systemPrompt:{persona:'You are powered by {{provider}}/{{model}}.'}});
  await ctx.plugin(Projections);await ctx.plugin(Persistence,{root:join(root,'sessions')});await ctx.plugin(AgentLoop,{agents:[]});
  await ctx.plugin(TestSessionQuery);await ctx.plugin(Subagents);await ctx.plugin(Spawn,{providerName:'spawn'});await ctx.plugin(Storage);
  backend=new JsonStorageBackend(join(root,'domains'));ctx.storage.backend.register('json',backend);facility=new DomainFacility(ctx,{backend:'json'});ctx.storage.mount('domain',facility);
  const main=new MockAdapter([toolCallResponse('natural-handoff','hub_switch_character',{character:'Mira'}),textResponse('HUB is back.'),textResponse('A new chat starts with HUB.')]);
  const fast=new MockAdapter([textResponse('Hi, I am Mira.'),textResponse('I run fast/mock.'),toolCallResponse('return-hub','hub_switch_character',{character:'HUB'})]);
  ctx.llm.registerAdapter(['main'],main);ctx.llm.registerAdapter(['fast'],fast);ctx.llm.registerAdapter(['legacy'],new MockAdapter([textResponse('Must not run')]));
  let deployment={provider:'main',model:'mock'};const selections=new Map();
  ctx.on('agent/created',({agent})=>{const ref={current:{provider:'legacy',model:'old-qwen'},assembled:undefined};selections.set(agent.id,ref);installModelSelection(agent.ctx,ref);},{global:true});
  Object.defineProperty(ctx,'agentDefaultModel',{value:{currentSelection:()=>deployment,saveSelection:async route=>{deployment={...route};}},configurable:true});
  Object.defineProperty(ctx,'sessionController',{value:{selectModel:async({sessionId,...route})=>{selections.get(sessionId).current=route;ctx.agents.get(sessionId).session.append('model/selection',route);}},configurable:true});
  Object.defineProperty(ctx,'storageDomain',{value:facility,configurable:true});Object.defineProperty(ctx,'connection',{value:{requestRejection:()=>undefined},configurable:true});Object.defineProperty(ctx,'webServer',{value:{register:()=>()=>{}},configurable:true});
  const camo=new CamofoxRuntime({},new AbortController().signal,async()=>new Response(JSON.stringify({ok:true,engine:'camoufox',version:'test'})));
  const characters=new HubCharacters(ctx,join(root,'characters'),camo);await characters.ready;
  const state=characters.store.snapshot(),voice=state.characters.find(c=>c.id===state.voiceId);
  await characters.store.change({action:'save',revision:state.revision,character:{...voice,name:'Mira',route:{provider:'fast',model:'mock'}}},c=>characters.validate(c));
  const parent=ctx.agentLoop.create('handoff-parent',{provider:'legacy',model:'old-qwen'});
  const instructionFiles=new InstructionFiles(join(root,'characters','instructions'));await instructionFiles.load();const soul=instructionFiles.files().find(f=>f.id==='SOUL.md');await instructionFiles.save('SOUL.md',soul.hash,'Shared instruction proof for native requests.');
  async function say(agent,text){const before=agent.session.snapshotEvents().filter(e=>e.type==='turn/end').length;agent.followup(createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}));const end=Date.now()+8000;while(agent.status!=='idle'||agent.session.snapshotEvents().filter(e=>e.type==='turn/end').length<=before){assert.ok(Date.now()<end,'Turn did not settle');await new Promise(r=>setTimeout(r,10));}}
  await say(parent,'Biraz Mira’yla sohbet etmek istiyorum; konuşmayı ona devretir misin?');
  assert.equal(main.requests.length,1);assert.equal(fast.requests.length,1);
  assert.match(JSON.stringify(main.requests[0]),/powered by main\/mock/);assert.doesNotMatch(JSON.stringify(main.requests[0]),/powered by legacy\/old-qwen/);
  assert.match(JSON.stringify(fast.requests[0]),/powered by fast\/mock/);assert.match(JSON.stringify(fast.requests[0]),/Character: Mira/);
  assert.match(main.requests[0].system,/Shared instruction proof/);assert.match(fast.requests[0].system,/Shared instruction proof/);
  const memory=ctx.agentLoop.create('hub-memory-instruction-test',{provider:'main',model:'mock'});const assembled=await ctx.systemPrompt.assemble({scope:memory});assert.ok(!assembled.sections.some(s=>s.text.includes('Shared instruction proof')));
  assert.equal(ctx.agents.list().filter(a=>a.session.header.origin==='subagent').length,0);
  assert.equal(characters.store.selected(parent.id).name,'Mira');assert.equal(deployment.provider,'main');
  await say(parent,'What model are you running?');assert.equal(fast.requests.length,2);assert.equal(main.requests.length,1);
  await say(parent,'Let your main assistant take over our conversation again.');assert.equal(main.requests.length,2);assert.equal(characters.store.selected(parent.id).name,'HUB');
  const newChat=ctx.agentLoop.create('new-default-chat',{provider:'legacy',model:'old-qwen'});await say(newChat,'Hello');assert.equal(main.requests.length,3);assert.equal(deployment.provider,'main');
  const revision=characters.store.snapshot().revision;
  const denied=await parent.ctx.tools.execute({agent:parent,name:'hub_switch_character',arguments:{character:'Mira'},callId:'notification-switch',signal:AbortSignal.timeout(1000)});
  assert.equal(denied.isError,true);assert.equal(characters.store.snapshot().revision,revision);
 }finally{await ctx.fiber.dispose();await facility?.closeAll();await backend?.close();assert.equal(dirname(root),tmpdir());assert.ok(basename(root).startsWith('hub-characters-native-'));await rm(root,{recursive:true,force:true});}
});
