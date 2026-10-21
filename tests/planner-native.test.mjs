// Real pinned agent loop and tool execution. Scripted responses avoid API cost.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {native} from '../scripts/tests/native-harness-resolver.mjs';
const {Context}=await native('@deepseek-ai/cordis');
const {default:AgentLoop}=await native('@deepseek-ai/dsh-agent-loop');
const {default:Persistence}=await native('@deepseek-ai/dsh-session-persistence-jsonl');
const {default:Projections}=await native('@deepseek-ai/dsh-session-projection');
const {createUserMessage}=await native('@deepseek-ai/dsh-llm');
const {mountAgentLoopTestDependencies}=await import('../vendor/deepseek-harness/packages/test-support/agent-loop-testkit/src/index.ts');
const {MockAdapter,textResponse,toolCallResponse}=await import('../vendor/deepseek-harness/packages/core/agent-loop/tests/mock-adapter.ts');
const {installPlanner}=await import('../packages/harness-overlay/src/host/planner.ts');

test('native tool calls save a personal item and independent observable work plan without touching tool permissions',{timeout:15000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub-eval-planner-native-')),ctx=new Context();let dispose;
 try{
  await mountAgentLoopTestDependencies(ctx);await ctx.plugin(Projections);await ctx.plugin(Persistence,{root:join(root,'sessions')});await ctx.plugin(AgentLoop,{agents:[]});
  Object.defineProperty(ctx,'connection',{value:{requestRejection:()=>undefined},configurable:true});Object.defineProperty(ctx,'webServer',{value:{register:()=>()=>{}},configurable:true});
  const permissions={mode:'inherit'},character={id:'00000000-0000-4000-8000-000000000001',tools:permissions,instructions:''};
  Object.defineProperty(ctx,'hubCharacters',{value:{effectiveCharacter:()=>character},configurable:true});
  const model=new MockAdapter([toolCallResponse('planner-add','hub_planner',{action:'save',item:{kind:'todo',title:'Read the synthetic brief',details:'Isolated test only',horizon:'near',timeZone:'Europe/Istanbul'}}),toolCallResponse('plan-update','hub_work_plan',{action:'update',version:0,title:'Fixture work',steps:[{title:'Inspect the saved brief',state:'active'}]}),textResponse('The requested item is saved; my work is still in progress.')]);
  ctx.llm.registerAdapter(['fixture'],model);dispose=installPlanner(ctx,{store:{root:join(root,'characters'),snapshot:()=>({characters:[character]})}});
  const agent=ctx.agentLoop.create('hub-eval-planner-native',{provider:'fixture',model:'mock'});agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Add the fixture brief to my to-dos and show your steps separately.'}]}));
  const deadline=Date.now()+10000;while(!agent.session.snapshotEvents().some(e=>e.type==='turn/end')){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,10));}await agent.whenIdle();await dispose();dispose=undefined;
  const saved=JSON.parse(await readFile(join(root,'hub-planner','planner.json'),'utf8'));assert.equal(saved.items.length,1);assert.equal(saved.items[0].sourceSessionId,agent.id);assert.equal(saved.plans.length,1);assert.equal(saved.plans[0].rootSessionId,agent.id);assert.equal(saved.plans[0].state,'paused');assert.equal(saved.items[0].title,'Read the synthetic brief');assert.deepEqual(permissions,{mode:'inherit'});
  assert.ok(model.requests[0].tools.some(t=>t.name==='hub_planner'));assert.ok(model.requests[0].tools.some(t=>t.name==='hub_work_plan'));assert.equal(agent.session.snapshotEvents().findLast(e=>e.type==='turn/end').data.reason.kind,'completed');
 }finally{if(dispose)await dispose();await ctx.fiber.dispose();assert.equal(dirname(root),tmpdir());assert.ok(basename(root).startsWith('hub-eval-planner-native-'));await rm(root,{recursive:true,force:true});}
});
