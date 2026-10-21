import test from 'node:test';
import assert from 'node:assert/strict';
import {openRouterReasoning,openRouterEffortProfile,prepareOpenRouterRequest} from '../packages/harness-overlay/src/host/openrouter-capabilities.ts';
import {parseOpenRouterModels,ModelCatalogStore} from '../packages/harness-overlay/src/host/model-catalog.ts';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const raw={id:'meta/fixture',name:'Fixture',context_length:1048576,top_provider:{max_completion_tokens:943718},supported_parameters:['reasoning','reasoning_effort','temperature','tools'],reasoning:{mandatory:true,supported_efforts:['max','high','low'],default_effort:'high'}};
test('provider vocabulary is exact, including mandatory reasoning and omitted/null effort schemas',()=>{
 const m=parseOpenRouterModels({data:[raw]})[0];assert.deepEqual(m.efforts.map(e=>e.id),['max','high','low']);assert.equal(m.defaultEffort,'high');assert.deepEqual(openRouterEffortProfile(m),{max:'max',high:'high',low:'low'});
 assert.equal(openRouterReasoning({mandatory:true}).efforts,undefined);assert.equal(openRouterReasoning({supported_efforts:null}).efforts.length,7);assert.equal(openRouterReasoning({supported_efforts:null,mandatory:true}).efforts.some(e=>e.id==='off'),false);
 assert.deepEqual(openRouterReasoning({supported_efforts:['none','low']}).efforts.map(e=>e.id),['off','low']);
});
test('huge capability ceilings never become automatic request reservations; explicit choices are honored',()=>{
 const m=parseOpenRouterModels({data:[raw]})[0],request={provider:'openrouter',model:m.id};prepareOpenRouterRequest(request,[m]);assert.equal(request.maxTokens,32768);
 for(const maxTokens of [4096,65536]){const r={provider:'openrouter',model:m.id,maxTokens};prepareOpenRouterRequest(r,[m]);assert.equal(r.maxTokens,maxTokens);}
 const small={...m,maxTokens:12000},r={provider:'openrouter',model:m.id};prepareOpenRouterRequest(r,[small]);assert.equal(r.maxTokens,12000);
 const other={provider:'unlid',model:m.id};prepareOpenRouterRequest(other,[m]);assert.equal(other.maxTokens,undefined);
});
test('saved provider reasoning schema survives a fresh catalogue store',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub-eval-reasoning-')),s=new ModelCatalogStore(root);
 try{const codex={id:'gpt-hub-eval',name:'Fixture',api:'openai-codex-responses',provider:'openai-codex',baseUrl:'https://chatgpt.com/backend-api',contextWindow:272000,maxTokens:128000,reasoning:true,input:['text'],thinkingLevelMap:{low:'low'}};
 await writeFile(join(root,'catalog.json'),JSON.stringify({schemaVersion:2,at:new Date().toISOString(),openrouter:[raw],codex:[codex]}));await s.load();
 assert.deepEqual(s.snapshot().openrouter[0].efforts.map(e=>e.id),['max','high','low']);assert.equal(s.snapshot().stale,false);
 }finally{s.dispose();assert.equal(root.startsWith(join(tmpdir(),'hub-eval-reasoning-')),true);await rm(root,{recursive:true,force:true});}
});
