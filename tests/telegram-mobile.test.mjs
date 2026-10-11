import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { parseTelegramCommand, HUB_TELEGRAM_IPC } from '@minke/harness-overlay/telegram-control-contract.ts';
import { installTelegramWeb } from '@minke/harness-overlay/host/telegram-web.ts';
import { bindTelegramControl } from '../desktop/main/remote-hub/telegram-control.ts';
import { hubConversationUrl } from '../desktop/main/remote-hub/agent-preview.ts';
test('Telegram browser control is a narrow command set; rejects secret-copy/reset and malformed credentials',()=>{
  assert.deepEqual(parseTelegramCommand({action:'read'}),{action:'read'});
  for(const value of [{action:'telegram/token/copy'},{action:'connect',token:'bad'},{action:'approve',requestId:'ok',provider:'discord'},{action:'read',extra:true}])assert.throws(()=>parseTelegramCommand(value));
});
test('Telegram HTTP authenticates and projects only public state; never echoes tokens',async()=>{
  let route,calls=0;
  const host={connection:{requestRejection:req=>req.headers.authorization==='Bearer test'?undefined:401},webServer:{register(r){route=r;return()=>{}}}};
  const dispose=installTelegramWeb(host,async()=>{calls++;return{state:'connected',accountLabel:'@synthetic_bot',token:'private-secret',proxyUrl:'http://private',channels:{weixin:{token:'other-private'}}}});
  const server=createServer((req,res)=>void route.handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}/api/hub/telegram`;
  const headers={authorization:'Bearer test','x-hub-telegram':'1','content-type':'application/json'};
  try{
    assert.equal((await fetch(url)).status,401);
    assert.equal((await fetch(url,{headers:{...headers,'sec-fetch-site':'cross-site'}})).status,403);
    assert.equal((await fetch(url,{method:'POST',headers,body:'{"action":"telegram/token/copy"}'})).status,400);assert.equal(calls,0);
    const response=await fetch(url,{headers});assert.equal(response.status,200);assert.deepEqual(await response.json(),{state:'connected',accountLabel:'@synthetic_bot'});
  }finally{dispose();server.close();await once(server,'close');}
});
test('parent accepts only owned child requests and fences duplicate operation identities',async()=>{
  const child=new EventEmitter();child.connected=true;const sent=[];child.send=(v,done)=>{sent.push(v);done?.()};let calls=0;
  const dispose=bindTelegramControl(child,async()=>{calls++;return{state:'connected'}});
  const request={type:HUB_TELEGRAM_IPC,direction:'request',id:'00000000-0000-4000-8000-000000000001',command:{action:'read'}};
  child.emit('message',request);child.emit('message',request);await new Promise(r=>setImmediate(r));
  assert.equal(calls,1);assert.ok(sent.some(x=>x.ok===false));assert.ok(sent.some(x=>x.ok===true));dispose();child.emit('message',{...request,id:'00000000-0000-4000-8000-000000000002'});assert.equal(calls,1);
});
test('Telegram conversation links require stable authenticated HTTPS origin and exact native session identity',()=>{
  const session='minke-im-telegram-'+ 'a'.repeat(32);
  const remote={state:'active',method:'cloudflare',transport:'access',url:'https://hub.example/'};
  const url=new URL(hubConversationUrl(session,remote,'models'));assert.equal(url.searchParams.get('hubSession'),session);assert.equal(url.searchParams.get('hubPanel'),'models');assert.equal(url.searchParams.has('token'),false);
  assert.equal(hubConversationUrl('../private',remote),undefined);
  assert.equal(hubConversationUrl(session,{...remote,url:'https://hub.example/?token=secret'}),undefined);
});
