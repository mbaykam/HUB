import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOpenRouterModels, parseCodexModelData, extractCodexTarData, ModelCatalogStore } from '@minke/harness-overlay/host/model-catalog.ts';
import { apply } from '@minke/harness-overlay/models.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';
const providerModel = { id: 'vendor/new-model', name: 'New model', context_length: 200000, top_provider: { max_completion_tokens: 16000 },
  architecture: { input_modalities: ['text','image'], output_modalities: ['text'] }, supported_parameters: ['tools','reasoning'], pricing: { prompt: '0.000001', completion: '0.000004' } };
const codex = { id:'gpt-6.1-sol', name:'GPT-6.1 Sol', api:'openai-codex-responses', provider:'openai-codex',baseUrl:'https://chatgpt.com/backend-api',contextWindow:272000,maxTokens:128000,reasoning:true,input:['text','image'],thinkingLevelMap:{off:null,low:'low',high:'high',max:'max'} };
test('provider catalogue keeps prices, capabilities and exact identities; excludes non-chat output', () => {
  const models = parseOpenRouterModels({data:[providerModel,{...providerModel,id:'image-only',architecture:{output_modalities:['image']}}]});
  assert.equal(models.length,1); assert.deepEqual(models[0].pricing,{input:1,output:4});assert.equal(models[0].tools,true);assert.equal(models[0].enabled,false);
  assert.throws(()=>parseOpenRouterModels({data:[]}));
});
test('Codex metadata cannot change transport/auth, inject unsupported reasoning or exceed capacity',()=>{
  const parse=m=>parseCodexModelData({'openai-codex-responses':{model:m}});
  assert.equal(parse(codex)[0].id,'gpt-6.1-sol');
  for(const change of [{baseUrl:'https://evil.example'},{api:'openai-responses'},{provider:'openai'},{maxTokens:900000},{thinkingLevelMap:{ultra:'ultra'}}])assert.throws(()=>parse({...codex,...change}));
  assert.throws(()=>extractCodexTarData(Buffer.from('not an archive')));
});
test('failed refresh is bounded and does not perform inference or touch provider credentials',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hub-catalog-'));
  const calls=[];const store=new ModelCatalogStore(root,async url=>{calls.push(url);throw new Error('Bearer private-value');});
  try {await store.load();await assert.rejects(store.refresh(),/last saved catalogue/);assert.equal(store.snapshot().stale,true);assert.doesNotMatch(store.snapshot().warning,/private-value/);assert.equal(calls[0],'https://openrouter.ai/api/v1/models');}
  finally{store.dispose();await rm(root,{recursive:true,force:true});}
});
test('favorite writes from two UI actions serialize and survive a fresh store',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hub-favorites-'));const store=new ModelCatalogStore(root);
  try{await Promise.all([store.favorite('openrouter','vendor/new-model',true),store.favorite('openai-codex','gpt-6.1-sol',true)]);
    const resumed=new ModelCatalogStore(root);assert.equal((await resumed.favorites()).size,2);await resumed.favorite('openrouter','vendor/new-model',false);assert.equal((await store.favorites()).size,1);resumed.dispose();}
  finally{store.dispose();await rm(root,{recursive:true,force:true});}
});
test('model API rejects untrusted writes, validates identities and preserves unrelated settings/defaults',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hub-model-api-'));let route;let selection;let defaults=0;const disposers=[];
  const ctx={llm:{listProviders:()=>[{id:'openai-codex',name:'Codex'}],async listModels(){return[{id:'gpt-5.6-luna',name:'Luna',provider:'openai-codex'}]},async resolveModelInfo(){return{reasoning:{efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}]}}},async resolveCallConfig(s){return s}},
    settings:{describe(){return[]},get(){throw new Error('No settings read for existing models')},async mutate(){throw new Error('No settings mutation')}},
    sessionController:{async selectModel(s){selection=s;return{selected:s}}},agentDefaultModel:{async saveSelection(){defaults++}},
    connection:{requestRejection(req){return req.headers.authorization==='Bearer synthetic'?undefined:401}},
    webServer:{register(r){route=r;return()=>{}}},effect(f){disposers.push(f())}};
  apply(ctx,{root,fetch:async()=>{throw new Error('Test blocks outbound network')}});const server=createServer((req,res)=>void route.handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}/api/hub/models`;
  const headers={authorization:'Bearer synthetic','x-hub-models':'1','content-type':'application/json'};
  try{
    assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{headers:{authorization:headers.authorization}})).status,403);
    assert.equal((await fetch(url,{method:'POST',headers:{...headers,'sec-fetch-site':'cross-site'},body:'{"action":"default","provider":"openai-codex","model":"gpt-5.6-luna"}'})).status,403);
    assert.equal((await fetch(url,{method:'POST',headers,body:'{"action":"default","provider":"openai","model":"gpt-5.6-luna"}'})).status,404);
    assert.equal(defaults,0);
    const catalogue=await(await fetch(url,{headers})).json();assert.deepEqual(catalogue.models[0].efforts,[{id:'low',name:'Low'},{id:'high',name:'High'}]);
    assert.equal((await fetch(url,{method:"POST",headers,body:JSON.stringify({action:"enable",provider:"openai-codex",model:"gpt-5.6-luna"})})).status,200);assert.equal(defaults,0);assert.equal(selection,undefined);
    const reply=await fetch(url,{method:'POST',headers,body:JSON.stringify({action:'select',provider:'openai-codex',model:'gpt-5.6-luna',sessionId:'session-test'})});
    assert.equal(reply.status,200);assert.deepEqual(selection,{sessionId:'session-test',provider:'openai-codex',model:'gpt-5.6-luna'});assert.equal(defaults,0);
    assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({action:'select',provider:'openai-codex',model:'gpt-5.6-luna',sessionId:'session-test',apiKey:'private'})})).status,400);
  }finally{disposers.forEach(d=>d());server.close();await once(server,'close');await rm(root,{recursive:true,force:true});}
});
