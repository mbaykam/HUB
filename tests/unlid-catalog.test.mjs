import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {parseUnlidModels,UnlidCatalogStore,prepareUnlidRequest} from '@minke/harness-overlay/host/unlid-catalog.ts';
import {apply} from '@minke/harness-overlay/models.ts';
const row=(id,options={})=>({id,created:1790000000,unlid:{name:id,context_length:131072,max_output:null,available:true,supports_tools:true,supports_reasoning:true,can_disable_reasoning:false,pricing:{input_usd_per_m:.24,output_usd_per_m:.96},...options}});
const data={data:[row('thinking'),row('chat-only',{supports_tools:false}),row('switchable',{can_disable_reasoning:true,max_output:16000}),row('paused',{available:false,supports_reasoning:false})]};
const credentials={async resolve(ref){assert.equal(ref,'UNLID_API_KEY');return{value:'synthetic-private-key'}}};

test('all Unlid entries retain true capabilities, paused state and prices without inventing vision or output limits',()=>{
 const models=parseUnlidModels(data);assert.equal(models.length,4);assert.equal(models[1].tools,false);assert.equal(models[3].available,false);
 assert.deepEqual(models[0].input,['text']);assert.equal(models[0].maxTokens,undefined);assert.equal(models[0].outputLimitFallback,true);assert.deepEqual(models[0].pricing,{input:.24,output:.96});assert.equal(models[0].created,1790000000);
 assert.ok(!models[0].efforts.some(e=>e.id==='off'));assert.ok(models[2].efforts.some(e=>e.id==='off'));assert.equal(models[3].efforts,undefined);
 for(const bad of [{data:[]},{data:[row('../bad')]},{data:[row('invalid',{context_length:NaN})]}])assert.throws(()=>parseUnlidModels(bad));
 assert.equal(parseUnlidModels({data:[row('unsafe',{max_output:'wrong'})]})[0].defaults.max_tokens,8192);
});

test('Unlid catalogue is host authenticated, bounded, cached without extras, and survives refresh/key failures',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub-eval-unlid-catalog-'));let calls=0,mode='ok';
 const store=new UnlidCatalogStore(root,credentials,async(url,init)=>{
  calls++;assert.equal(url,'https://api.unlid.ai/v1/models');assert.equal(init.redirect,'error');assert.equal(init.headers.authorization,'Bearer synthetic-private-key');
  if(mode==='fail')throw Error('synthetic-private-key');if(mode==='large')return new Response('x'.repeat(2*1024*1024+1));
  return new Response(JSON.stringify({...data,private:'synthetic-private-key',baseURL:'https://wrong.example'}));
 });
 try{await store.load();await Promise.all([store.refresh(),store.refresh()]);assert.equal(calls,1);assert.equal(store.snapshot().models.length,4);
  const disk=JSON.parse(await readFile(join(root,'unlid.json'),'utf8'));
  const publicData=data.data.map(m=>({id:m.id,created:m.created,unlid:{name:m.unlid.name,context_length:m.unlid.context_length,max_output:m.unlid.max_output??null,available:m.unlid.available,supports_tools:m.unlid.supports_tools,supports_reasoning:m.unlid.supports_reasoning,can_disable_reasoning:m.unlid.can_disable_reasoning===true,pricing:m.unlid.pricing}}));
  assert.deepEqual(disk,{at:store.snapshot().at,data:publicData});
  mode='fail';await assert.rejects(store.refresh(),/saved models remain/);assert.equal(store.snapshot().models.length,4);assert.doesNotMatch(store.snapshot().warning,/synthetic-private-key/);
  mode='large';await assert.rejects(store.refresh());assert.equal(store.snapshot().models.length,4);
  const resumed=new UnlidCatalogStore(root,{async resolve(){return undefined}},()=>{throw Error('must not fetch without key')});await resumed.load();await assert.rejects(resumed.refresh());assert.equal(resumed.snapshot().models[1].tools,false);resumed.dispose();
 }finally{store.dispose();await rm(root,{recursive:true,force:true});}
});

test('chat-only request omits tool schemas without changing history or stored permissions and leaves other routes alone',()=>{
 const permissions={mode:'allow',names:['hub_task']},messages=[{role:'user',content:'Hi'}],options={provider:'unlid',model:'chat-only',tools:[{name:'hub_task'}],messages,system:'Personality'};
 prepareUnlidRequest(options,parseUnlidModels(data));assert.deepEqual(options.tools,[]);assert.equal(options.messages,messages);assert.match(options.system,/Personality/);assert.match(options.system,/cannot call tools/);assert.deepEqual(permissions,{mode:'allow',names:['hub_task']});
 for(const p of ['other','unlid']){const o={provider:p,model:p==='unlid'?'thinking':'chat-only',tools:[{name:'kept'}]};prepareUnlidRequest(o,parseUnlidModels(data));assert.equal(o.tools.length,1);}
});

test('model API merges all Unlid models despite another provider outage; adding preserves settings and does not switch defaults',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub-eval-unlid-api-')),disposers=[];let route,hook,mutations=0;
 const original={apiKeyEnv:'UNLID_API_KEY',baseURL:'https://api.unlid.ai/v1',models:[{id:'thinking',name:'Existing',contextWindow:131072,reasoningEfforts:{low:'low'}}]},profile=structuredClone(original);
 const ctx={credentials,llm:{listProviders:()=>[{id:'unlid',name:'Unlid'}],async listModels(){return profile.models.map(m=>({...m,provider:'unlid'}))},async resolveCallConfig(s){return s}},
 settings:{get(){return{providers:{unlid:profile}}},describe(){return[{ns:'llm-pi-ai',revision:3}]},async mutate(ns,ops,revision){assert.equal(ns,'llm-pi-ai');assert.equal(revision,3);assert.deepEqual(ops[0].path,['providers','unlid','models']);profile.models=ops[0].value;mutations++;}},
 sessionController:{selectModel(){throw Error('No session selection')}},agentDefaultModel:{saveSelection(){throw Error('No default change')}},connection:{requestRejection:()=>undefined},
 webServer:{register(r){if(r.path==='/api/hub/models')route=r;return()=>{}}},on(event,callback){if(event==='llm/stream')hook=callback;return()=>{}},effect(f){disposers.push(f())}};
 apply(ctx,{root,fetch:async url=>{if(url==='https://api.unlid.ai/v1/models')return new Response(JSON.stringify(data));throw Error('Other catalogue offline');}});
 const server=createServer((req,res)=>void route.handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}/api/hub/models`,headers={'x-hub-models':'1','content-type':'application/json'};
 const command=async body=>fetch(url,{method:'POST',headers,body:JSON.stringify(body)});
 try{const refresh=await command({action:'refresh'});assert.equal(refresh.status,200);const catalogue=await refresh.json();assert.equal(catalogue.models.length,4);assert.match(catalogue.warning,/Refresh failed/);
  assert.equal((await command({action:'enable',provider:'unlid',model:'chat-only',maxTokens:8192})).status,200);assert.equal(mutations,1);assert.deepEqual(profile.models[0],original.models[0]);assert.equal(profile.baseURL,original.baseURL);assert.equal(profile.apiKeyEnv,original.apiKeyEnv);assert.deepEqual(profile.models[1].input,['text']);
  assert.equal((await command({action:'enable',provider:'unlid',model:'paused'})).status,409);assert.equal(mutations,1);
  assert.equal((await command({action:'enable',provider:'unlid',model:'chat-only',maxTokens:9000})).status,409);
  let dispatched;const input={provider:'unlid',model:'chat-only',tools:[{name:'test'}]},stream=hook(input,async function*(){dispatched=input;yield 'done'});
  assert.equal(typeof stream[Symbol.asyncIterator],'function');const chunks=[];for await(const chunk of stream)chunks.push(chunk);assert.deepEqual(chunks,['done']);assert.deepEqual(dispatched.tools,[]);
 }finally{disposers.forEach(d=>d());server.close();await once(server,'close');await rm(root,{recursive:true,force:true});}
});
