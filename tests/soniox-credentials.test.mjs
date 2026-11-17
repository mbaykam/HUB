import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createSonioxCredentialsHandler,createSonioxDictationHandler} from '@minke/harness-overlay/host/soniox-credentials.ts';

test('Voice typing gets a short-lived Soniox key and never the stored one',async()=>{
 let key,status=200,calls=[];
 const credentials={async resolve(ref){assert.equal(ref,'SONIOX_API_KEY');return key?{value:key}:undefined;},async set(){}};
 const provider=async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify(status===200?{api_key:'temp:fixture-short-lived',expires_at:'2026-11-17T06:00:00Z'}:{detail:'account 42'}),{status});};
 const handler=createSonioxDictationHandler({credentials,reject:req=>req.headers.cookie==='fixture=1'?undefined:401,fetch:provider});
 const server=createServer((req,res)=>void handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
 const url=`http://127.0.0.1:${server.address().port}/api/hub/voice/dictation`,headers={cookie:'fixture=1','x-hub-dictation':'1','content-type':'application/json'};
 const post=extra=>fetch(url,{method:'POST',headers:{...headers,...extra},body:'{}'});
 try{
  assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,401);
  assert.equal((await post({'sec-fetch-site':'cross-site'})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers:{cookie:'fixture=1'},body:'{}'})).status,403);
  assert.equal((await fetch(url,{headers})).status,405);
  const missing=await post();assert.equal(missing.status,409);assert.deepEqual(await missing.json(),{error:'soniox-not-connected'});assert.equal(calls.length,0);
  key='fixture-private-key-123';
  const ready=await post();assert.equal(ready.status,200);assert.equal(ready.headers.get('cache-control'),'no-store, private');
  const body=await ready.json();
  assert.equal(body.url,'wss://stt-rt.soniox.com/transcribe-websocket');assert.equal(body.config.api_key,'temp:fixture-short-lived');
  assert.deepEqual(body.config.language_hints,['en','tr']);assert.equal(body.config.audio_format,'pcm_s16le');assert.equal(body.config.sample_rate,16000);
  assert.ok(!JSON.stringify(body).includes(key));
  assert.equal(calls[0].url,'https://api.soniox.com/v1/auth/temporary-api-key');assert.equal(calls[0].init.headers.authorization,'Bearer '+key);
  assert.deepEqual(JSON.parse(calls[0].init.body),{usage_type:'transcribe_websocket',expires_in_seconds:120});
  status=402;const balance=await post();assert.equal(balance.status,409);assert.deepEqual(await balance.json(),{error:'soniox-balance'});
  status=401;const access=await post();assert.equal(access.status,502);assert.deepEqual(await access.json(),{error:'soniox-access'});
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('Soniox setup uses the native credential store and never returns the key',async()=>{
 let key,changed=0;
 const credentials={async resolve(ref){assert.equal(ref,'SONIOX_API_KEY');return key?{value:key}:undefined;},async set(ref,value){assert.equal(ref,'SONIOX_API_KEY');key=value;}};
 const handler=createSonioxCredentialsHandler({credentials,reject:req=>req.headers.cookie==='fixture=1'?undefined:401,changed(){changed++;}});
 const server=createServer((req,res)=>void handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
 const url=`http://127.0.0.1:${server.address().port}/api/hub/voice/soniox`,headers={cookie:'fixture=1','x-hub-speech-settings':'1','content-type':'application/json'};
 try{
  assert.equal((await fetch(url)).status,401);
  assert.equal((await fetch(url,{headers:{...headers,'sec-fetch-site':'cross-site'}})).status,403);
  assert.deepEqual(await(await fetch(url,{headers})).json(),{configured:false});
  const saved=await fetch(url,{method:'POST',headers,body:JSON.stringify({apiKey:'fixture-private-key-123'})});assert.equal(saved.status,200);assert.deepEqual(await saved.json(),{configured:true});
  assert.equal(key,'fixture-private-key-123');assert.equal(changed,1);
  const read=await fetch(url,{headers});assert.equal(read.headers.get('cache-control'),'no-store, private');assert.deepEqual(await read.json(),{configured:true});
  for(const body of [{apiKey:'short'},{apiKey:'fixture-private-key-123',extra:true},null])assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify(body)})).status,400);
  assert.equal(changed,1);assert.equal(key,'fixture-private-key-123');
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
