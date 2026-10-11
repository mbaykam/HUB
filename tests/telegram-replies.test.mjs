import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {createTelegramTransport,createTelegramGatewayProvider} from '@lencx/minke-im-telegram';
import {withTelegramLiveReplies,TelegramReplyReceipts} from '../desktop/main/remote-hub/telegram-replies.ts';

const key='a'.repeat(64);
const packet=(revision,markdown,final=false)=>({kind:'hub-live-reply',key,revision,markdown,final});
const memoryStore=()=>{const rows=new Map();return {get:k=>structuredClone(rows.get(k)),set:(k,v)=>rows.set(k,structuredClone(v))};};
async function fixture(store=memoryStore(),generation=1){
 const calls=[],messages=new Map();let nextId=1,editFailure;
 const transport=createTelegramTransport({credential:{token:'123456789:abcdefghijklmnopqrstuvwxyz_123456789'},clearWebhookBeforePolling:false,fetch:async(url,init)=>{
  const method=new URL(url).pathname.split('/').at(-1),body=JSON.parse(init.body);calls.push({method,body});
  if(method==='getMe')return Response.json({ok:true,result:{id:123456789,is_bot:true,first_name:'HUB',username:'test_bot'}});
  if(method==='editMessageText'&&editFailure){const error=editFailure;editFailure=undefined;return Response.json({ok:false,...error},{status:error.error_code});}
  const id=method==='editMessageText'?body.message_id:nextId++;messages.set(id,body.rich_message?.markdown??body.text??'attachment');
  return Response.json({ok:true,result:{message_id:id,date:1700000000,chat:{id:Number(body.chat_id),type:'private'}}});
 }});
 await transport.start();const base=createTelegramGatewayProvider({accountKey:'telegram:123456789',generation,transport});
 const provider=withTelegramLiveReplies(base,transport,store);
 async function deliver(reply,recipientId='42'){
  const operationId='operation-'+recipientId+'-'+reply.revision;
  const prepared=await provider.prepare({operationId,recipientId,payload:reply});assert.equal(prepared.status,'ready');
  return await provider.deliver({operationId,recipientId,preparedPayload:prepared.preparedPayload});
 }
 return {provider,transport,calls,messages,deliver,failNextEdit:error=>{editFailure=error}};
}
test('preamble, delegated work and final answer edit one Telegram message; late progress cannot replace the answer',async t=>{
 const f=await fixture();t.after(()=>f.transport.close());
 for(const p of [packet(1,'İnceliyorum…'),packet(2,'Web sayfasını inceliyorum…'),packet(3,'Temiz sonuç.',true),packet(3,'Temiz sonuç.',true),packet(4,'Late tool chatter')])assert.equal((await f.deliver(p)).status,'accepted');
 assert.equal(f.calls.filter(c=>c.method==='sendRichMessage').length,1);
 assert.equal(f.calls.filter(c=>c.method==='editMessageText').length,2);
 assert.deepEqual([...f.messages.values()],['Temiz sonuç.']);
 assert.deepEqual(f.calls.filter(c=>c.method==='editMessageText').map(c=>c.body.message_id),[1,1]);
});
test('known not-modified is idempotent; deleted preview has one safe replacement; rate limits retry without a new bubble',async t=>{
 const f=await fixture();t.after(()=>f.transport.close());await f.deliver(packet(1,'Draft'));
 f.failNextEdit({error_code:400,description:'Bad Request: message is not modified'});assert.equal((await f.deliver(packet(2,'New draft'))).status,'accepted');
 f.failNextEdit({error_code:429,description:'Too Many Requests',parameters:{retry_after:2}});assert.deepEqual(await f.deliver(packet(3,'Final',true)),{status:'retry',errorCode:'rate-limited',retryAfterMs:2000});
 assert.equal(f.calls.filter(c=>c.method==='sendRichMessage').length,1);
 assert.equal((await f.deliver(packet(3,'Final',true))).status,'accepted');
 f.failNextEdit({error_code:400,description:'Bad Request: message to edit not found'});assert.equal((await f.deliver(packet(4,'Replacement final',true))).status,'accepted');
 assert.equal(f.calls.filter(c=>c.method==='sendRichMessage').length,2);
});
test('long final keeps preview as first chunk, preserves the remainder, and deduplicates retries',async t=>{
 const f=await fixture();t.after(()=>f.transport.close());await f.deliver(packet(1,'Draft'));
 const text='🙂 paragraph words\n'.repeat(600);
 assert.equal((await f.deliver(packet(2,text,true))).status,'accepted');const count=f.calls.length;
 assert.equal((await f.deliver(packet(2,text,true))).status,'accepted');assert.equal(f.calls.length,count);
 assert.equal([...f.messages.values()].join(''),text);
 assert.equal(f.calls.filter(c=>c.method==='editMessageText').length,1);
 assert.ok([...f.messages.values()].every(s=>s.length<=4096));
});
test('recipient and account generation isolate preview ownership',async t=>{
 const store=memoryStore(),a=await fixture(store,1),b=await fixture(store,2);t.after(()=>Promise.all([a.transport.close(),b.transport.close()]));
 await a.deliver(packet(1,'A'),'42');await a.deliver(packet(2,'B'),'43');await b.deliver(packet(3,'C'),'42');
 assert.equal(a.calls.filter(c=>c.method==='editMessageText').length,0);assert.equal(b.calls.filter(c=>c.method==='editMessageText').length,0);
 assert.equal(a.calls.filter(c=>c.method==='sendRichMessage').length,2);
});
test('encrypted receipts survive restart and retain the existing edit target',async t=>{
 const root=await mkdtemp(join(tmpdir(),'hub-telegram-replies-')),secret=randomBytes(32);
 const cipher={seal(data){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',secret,iv);return Buffer.concat([iv,c.update(data),c.final(),c.getAuthTag()]);},open(data){const d=createDecipheriv('aes-256-gcm',secret,data.subarray(0,12));d.setAuthTag(data.subarray(-16));return Buffer.concat([d.update(data.subarray(12,-16)),d.final()]);}};
 t.after(async()=>{assert.equal(dirname(root),tmpdir());assert.ok(basename(root).startsWith('hub-telegram-replies-'));await rm(root,{recursive:true,force:true});});
 const path=join(root,'receipts.enc'),a=await fixture(new TelegramReplyReceipts(path,()=>cipher));await a.deliver(packet(1,'Draft'));await a.transport.close();
 const bytes=await readFile(path);assert.equal(bytes.includes(Buffer.from('revision')),false);assert.equal(bytes.includes(Buffer.from('Draft')),false);
 const b=await fixture(new TelegramReplyReceipts(path,()=>cipher));t.after(()=>b.transport.close());assert.equal((await b.deliver(packet(2,'Final',true))).status,'accepted');
 assert.equal(b.calls.filter(c=>c.method==='sendRichMessage').length,0);assert.equal(b.calls.find(c=>c.method==='editMessageText').body.message_id,1);
});
