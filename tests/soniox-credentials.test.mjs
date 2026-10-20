import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createSonioxCredentialsHandler} from '@minke/harness-overlay/host/soniox-credentials.ts';

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
