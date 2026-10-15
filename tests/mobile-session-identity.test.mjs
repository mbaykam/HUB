import test from 'node:test';
import assert from 'node:assert/strict';
import {readMobileSessionIdentity} from '../packages/harness-overlay/src/client/host/mobile-session-identity.ts';

const goalSession='hub-goal-00000000-0000-4000-8000-000000000001-00000000-0000-4000-8000-000000000002';
function fixture(snapshot){
  const requests=[];
  const view={async fetch(url,options){requests.push({url,...options});return {ok:true,json:async()=>url.startsWith('/api/hub/characters')?{character:{name:'HUB',route:{provider:'openai-codex',model:'gpt-6-astra'}}}:snapshot};}};
  return {view,requests};
}

test('an ordinary conversation keeps its actual selected character identity',async()=>{
  const {view,requests}=fixture({});
  assert.deepEqual(await readMobileSessionIdentity(view,'chat-fixture',AbortSignal.timeout(1000)),{name:'HUB',model:'gpt-6-astra',title:'HUB · openai-codex/gpt-6-astra'});
  assert.match(requests[0].url,/sessionId=chat-fixture/);assert.equal(requests[0].credentials,'same-origin');
});

test('a Goal work log uses the recorded round, not the default HUB or a subsequently edited profile',async()=>{
  const {view,requests}=fixture({characters:[{id:'mira',name:'Mira',route:{provider:'new-provider',model:'new-model'}}],goals:[{title:'Checked work',cycles:[{id:'old',sessionId:goalSession}],rounds:[
    {cycleId:'old',sessionId:goalSession,characterId:'mira',route:'openai-codex/gpt-6-luna',status:'done'},
    {cycleId:'new',sessionId:'other-cycle',characterId:'mira',route:'new-provider/new-model',status:'running'}
  ]}]});
  const result=await readMobileSessionIdentity(view,goalSession,AbortSignal.timeout(1000));
  assert.equal(result.name,'Mira · Last run');assert.equal(result.model,'gpt-6-luna');
  assert.match(result.title,/Goal work log.*openai-codex\/gpt-6-luna/);
  assert.equal(requests[0].url,'/api/hub/goals');assert.equal(requests[0].headers['x-hub-goals'],'1');
});

test('missing Goal evidence never falls back to an unrelated main character',async()=>{
  const {view}=fixture({goals:[],characters:[]});
  assert.equal(await readMobileSessionIdentity(view,goalSession,AbortSignal.timeout(1000)),undefined);
});

test('running Goal work uses its recorded provider and retains a multi-part model ID',async()=>{
  const {view}=fixture({characters:[{id:'worker',name:'Worker'}],goals:[{cycles:[{id:'c',sessionId:goalSession}],rounds:[{sessionId:goalSession,characterId:'worker',route:'openrouter/qwen/example-model',status:'running'}]}]});
  const result=await readMobileSessionIdentity(view,goalSession,AbortSignal.timeout(1000));
  assert.equal(result.name,'Worker · Working');assert.equal(result.model,'qwen/example-model');
});

test('unavailable Goal metadata fails closed instead of displaying a main-model guess',async()=>{
  await assert.rejects(readMobileSessionIdentity({fetch:async()=>({ok:false})},goalSession,AbortSignal.timeout(1000)),/unavailable/);
});
