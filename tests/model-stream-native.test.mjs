// Exercise the real streaming middleware and agent loop without a paid API.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {native} from '../scripts/tests/native-harness-resolver.mjs';
const {Context}=await native('@deepseek-ai/cordis');
const {default:AgentLoop}=await native('@deepseek-ai/dsh-agent-loop');
const {default:Persistence}=await native('@deepseek-ai/dsh-session-persistence-jsonl');
const {default:Projections}=await native('@deepseek-ai/dsh-session-projection');
const {createUserMessage}=await native('@deepseek-ai/dsh-llm');
const {mountAgentLoopTestDependencies}=await import('../vendor/deepseek-harness/packages/test-support/agent-loop-testkit/src/index.ts');
const {MockAdapter,textResponse}=await import('../vendor/deepseek-harness/packages/core/agent-loop/tests/mock-adapter.ts');
const {apply}=await import('../packages/harness-overlay/src/models.ts');

test('catalogue capability middleware preserves native streaming for every provider, including no-tool Knowledge workers',{timeout:15000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub-eval-model-stream-')),ctx=new Context();let route;
 try{
  await mountAgentLoopTestDependencies(ctx);await ctx.plugin(Projections);await ctx.plugin(Persistence,{root:join(root,'sessions')});await ctx.plugin(AgentLoop,{agents:[]});
  for(const [key,value] of Object.entries({credentials:{async resolve(){return undefined}},settings:{},sessionController:{},agentDefaultModel:{},connection:{requestRejection:()=>undefined},webServer:{register(r){if(r.path==='/api/hub/models')route=r;return()=>{}}}}))Object.defineProperty(ctx,key,{value,configurable:true});
  const answer='{"version":1,"decision":"skip","reason":"Fixture has no personal facts","tags":[],"relations":[],"reflections":[],"profileSuggestions":[]}';
  const adapter=new MockAdapter([textResponse(answer),textResponse(answer)]);ctx.llm.registerAdapter(['openrouter','unlid'],adapter);
  apply(ctx,{root,fetch:async()=>{throw Error('No real network in this regression')}});
  await route.handler({method:'GET',url:'/api/hub/models',headers:{'x-hub-models':'1'}},{writeHead(code){assert.equal(code,200)},end(){}});
  for(const provider of ['openrouter','unlid']){
   const agent=ctx.agentLoop.create('hub-eval-model-stream-'+provider,{provider,model:'fixture'});
   agent.followup(createUserMessage({source:{kind:'plugin',plugin:'hub-memory'},content:[{type:'text',text:'Return the synthetic organization result.'}]}));
   const deadline=Date.now()+10000;while(!agent.session.snapshotEvents().some(e=>e.type==='turn/end')){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,10));}await agent.whenIdle();
   const end=agent.session.snapshotEvents().findLast(e=>e.type==='turn/end');assert.equal(end.data.reason.kind,'completed',JSON.stringify(end.data.reason));
   const message=agent.session.snapshotEvents().findLast(e=>e.type==='assistant/message');assert.equal(message.data.message.content.filter(b=>b.type==='text').map(b=>b.text).join(''),answer);
  }
  assert.deepEqual(adapter.requests.map(r=>r.provider),['openrouter','unlid']);
  assert.equal(adapter.requests[0].maxTokens,32768,'assembled OpenRouter request carries an operating allowance, not the provider ceiling');
 }finally{await ctx.fiber.dispose();assert.equal(dirname(root),tmpdir());assert.ok(basename(root).startsWith('hub-eval-model-stream-'));await rm(root,{recursive:true,force:true});}
});
