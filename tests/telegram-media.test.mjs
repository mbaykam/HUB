import test from 'node:test';import assert from 'node:assert/strict';
import {receiveTelegramMedia} from '../desktop/main/remote-hub/telegram-media.ts';
import {createTelegramBotDriver} from '../desktop/main/remote-hub/runtime.ts';
const item={fileId:'fixture-file',name:'Document.pdf',mediaType:'application/pdf',size:12};
test('Telegram media uses the paired transport and bounded official file paths without exposing credentials',async()=>{
 const requests=[];const fetcher=async(url,options)=>{requests.push({url,options});return requests.length===1?Response.json({ok:true,result:{file_path:'documents/file_1.pdf'}}):new Response(Buffer.from('fixture-pdf'));};
 const result=await receiveTelegramMedia('fixture-token',[item],fetcher,new AbortController().signal);assert.equal(result[0].name,item.name);assert.equal(Buffer.from(result[0].data,'base64').toString(),'fixture-pdf');assert.equal(requests.length,2);assert.equal(requests[0].options.redirect,'error');assert.equal(requests[1].options.redirect,'error');assert.doesNotMatch(JSON.stringify(result),/fixture-token/);
 await assert.rejects(receiveTelegramMedia('private-token',[item],async()=>Response.json({ok:true,result:{file_path:'../../private.env'}}),new AbortController().signal),error=>!error.message.includes('private-token'));
 let requested=false;await assert.rejects(receiveTelegramMedia('fixture-token',[{...item,size:20000001}],async()=>{requested=true;throw Error('Unexpected');},new AbortController().signal));assert.equal(requested,false);
});
