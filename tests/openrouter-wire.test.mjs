import test from 'node:test';
import assert from 'node:assert/strict';
import {native} from '../scripts/tests/native-harness-resolver.mjs';
import {registerHooks} from 'node:module';
import {readdir} from 'node:fs/promises';
import {memoryAuth} from '../vendor/deepseek-harness/packages/llm/llm-pi-ai/tests/auth-double.ts';
import {mockServer,textEvents,closeMockServers} from '../vendor/deepseek-harness/packages/llm/llm-pi-ai/tests/mock-server.ts';
const virtualStore=new URL('../vendor/deepseek-harness/node_modules/.pnpm/',import.meta.url),piDirectory=(await readdir(virtualStore)).find(n=>n.startsWith('@earendil-works+pi-ai@'));
const piRoot=new URL(piDirectory+'/node_modules/@earendil-works/pi-ai/',virtualStore);
registerHooks({resolve(specifier,context,next){return next(specifier==='@earendil-works/pi-ai'?new URL('dist/index.js',piRoot).href:specifier.startsWith('@earendil-works/pi-ai/')?new URL('dist/'+specifier.slice('@earendil-works/pi-ai/'.length)+'.js',piRoot).href:specifier,context);}});
const {PiAiAdapter}=await native('@deepseek-ai/dsh-llm-pi-ai');
const {resolveProfiles}=await import('../vendor/deepseek-harness/packages/llm/llm-pi-ai/src/config.ts');
test('native OpenRouter adapter forwards the chosen effort and explicit output allowance to the real HTTP transport',{timeout:15000},async()=>{
 const server=await mockServer([{events:textEvents},{events:textEvents}]);
 try{const profiles=resolveProfiles({openrouter:{baseURL:server.url,models:[{id:'meta/hub-eval-think',name:'Fixture',contextWindow:1048576,maxTokens:32768,input:['text'],reasoningEfforts:{minimal:'minimal',low:'low',high:'high',max:'max'}}]}}),adapter=new PiAiAdapter({profiles:()=>profiles,resolveApiKey:async()=> 'fixture-only',auth:memoryAuth()});
  for(const reasoningEffort of ['minimal','max']){const result=[];for await(const chunk of adapter.stream({provider:'openrouter',model:'meta/hub-eval-think',reasoningEffort,maxTokens:65536,messages:[],tools:[],signal:AbortSignal.timeout(10000)}))result.push(chunk);assert.equal(result.at(-1).reason.kind,'stop',JSON.stringify(result.at(-1)));}
  assert.equal(server.requests.length,2);assert.equal(server.requests[0].reasoning.effort,'minimal');assert.equal(server.requests[1].reasoning.effort,'max');assert.equal(server.requests[0].max_tokens??server.requests[0].max_completion_tokens,65536);
 }finally{await closeMockServers();}
});
