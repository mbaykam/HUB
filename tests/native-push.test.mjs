import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once,EventEmitter} from 'node:events';
import {createServer} from 'node:http';
import {generateKeyPairSync,verify,randomUUID} from 'node:crypto';
import {NativePushStore,createNativePushHandler,createApplePushSender} from '@minke/harness-overlay/host/native-push.ts';

const device=()=>({id:randomUUID(),token:'a'.repeat(64),origin:'https://hub.example.com',generation:1,environment:'development'});
const event=()=>({id:randomUUID(),kind:'task',status:'completed',sessionId:'session-hub-eval-native-push'});

test('native registration requires existing authentication and CSRF marker; tokens and keys are never returned',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub-eval-native-push-')),store=new NativePushStore(root,async()=> 'sent'),ready=store.initialize();
 const handler=createNativePushHandler({store,ready,configured:async()=>false,reject:req=>req.headers.cookie==='fixture=1'?undefined:401});
 const server=createServer((req,res)=>void handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
 const url=`http://127.0.0.1:${server.address().port}/api/hub/notifications`,headers={cookie:'fixture=1','x-hub-native-push':'1','content-type':'application/json',origin:'https://hub.example.com'},registered=device();
 try{
  assert.equal((await fetch(url)).status,401);
  assert.equal((await fetch(url,{headers:{cookie:'fixture=1'}})).status,403);
  assert.equal((await fetch(url,{headers:{...headers,'sec-fetch-site':'cross-site'}})).status,403);
  const response=await fetch(url,{method:'POST',headers,body:JSON.stringify({action:'register',device:registered})});
  assert.equal(response.status,200);const body=await response.text();assert.equal(body.includes(registered.token),false);assert.deepEqual(JSON.parse(body),{version:1,configured:false,devices:1,pending:0});
  await fetch(url,{method:'POST',headers,body:JSON.stringify({action:'revoke',deviceId:registered.id,generation:2})});assert.equal(store.snapshot().devices,0);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
});

test('delivery survives restart with the same Apple ID, deduplicates and retries without any model call',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub-eval-native-push-'));let now=100000,sends=[];
 try{
  const store=new NativePushStore(root,async(_d,delivery)=>{sends.push(delivery.id);return 'retry';},()=>now);await store.initialize();await store.register(device());const update=event();
  await store.publish(update);assert.equal(sends.length,1);assert.equal(store.snapshot().pending,1);
  const resumed=new NativePushStore(root,async(_d,delivery)=>{sends.push(delivery.id);return 'sent';},()=>now);await resumed.initialize();
  now+=120000;await Promise.all([resumed.tick(),resumed.tick()]);assert.equal(sends.length,2);assert.equal(new Set(sends).size,1);assert.equal(resumed.snapshot().pending,0);
  await resumed.publish(update);assert.equal(sends.length,2);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('revoked/invalid devices stop delivery and changing a token does not duplicate one phone',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub-eval-native-push-'));let sends=0;
 try{
  const store=new NativePushStore(root,async()=>{sends++;return 'invalid-device';});await store.initialize();const phone=device();await store.register(phone);await store.register({...phone,token:'b'.repeat(64),generation:2});assert.equal(store.snapshot().devices,1);
  await store.publish(event());assert.equal(sends,1);assert.equal(store.snapshot().devices,0);
  await store.publish(event());assert.equal(sends,1);
  await store.register({...phone,generation:3});await store.revoke(phone.id,4,phone.origin);await store.publish(event());assert.equal(sends,1);
  await assert.rejects(store.register({...phone,token:'../foreign-host'}));
  const saved=JSON.parse(await readFile(join(root,'native-push.json'),'utf8'));assert.equal(saved.devices.some(d=>d.enabled),false);assert.equal(saved.devices[0].token,'');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Apple sender pins endpoints, signs valid ES256 JWT and sends a generic private notification with a typed session link',async()=>{
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});let host,headers,payload;
 const open=url=>{host=url;const client=new EventEmitter();client.destroy=()=>{};client.request=value=>{headers=value;const request=new EventEmitter();request.end=body=>{payload=JSON.parse(body);queueMicrotask(()=>{request.emit('response',{':status':200});request.emit('end');});};return request;};return client;};
 const sender=createApplePushSender(async()=>({teamId:'ABCDEFGHIJ',keyId:'1234567890',topic:'com.example.hub',privateKey:privateKey.export({type:'pkcs8',format:'pem'})}),open);
 const update=event(),delivery={id:randomUUID(),event:update,deviceId:randomUUID(),attempts:1,nextAt:0,createdAt:0,state:'pending'};
 assert.equal(await sender(device(),delivery),'sent');assert.equal(host,'https://api.sandbox.push.apple.com');assert.equal(headers['apns-topic'],'com.example.hub');assert.equal(headers['apns-push-type'],'alert');
 const [head,body,sig]=headers.authorization.slice(7).split('.');assert.equal(JSON.parse(Buffer.from(head,'base64url')).alg,'ES256');assert.equal(JSON.parse(Buffer.from(body,'base64url')).iss,'ABCDEFGHIJ');
 assert.equal(verify('sha256',Buffer.from(head+'.'+body),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(sig,'base64url')),true);
 assert.deepEqual(payload.hub,{version:1,kind:'session',sessionId:update.sessionId,origin:'https://hub.example.com'});assert.equal(payload.aps.alert.body,'Your task is ready in HUB.');assert.equal(JSON.stringify(payload).includes('fixture-private-result'),false);
});

test('late registration cannot undo logout, and an old revoke cannot disable a newly enabled phone',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub-eval-native-push-'));
 try{const store=new NativePushStore(root,async()=> 'sent');await store.initialize();const phone=device();
  await store.revoke(phone.id,2,phone.origin);await store.register(phone);assert.equal(store.snapshot().devices,0);
  await store.register({...phone,generation:3});assert.equal(store.snapshot().devices,1);
  await store.revoke(phone.id,2,phone.origin);assert.equal(store.snapshot().devices,1);
 }finally{await rm(root,{recursive:true,force:true});}
});
