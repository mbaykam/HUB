import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import {installUploadHandoff} from '../packages/harness-overlay/src/client/host/upload-handoff.ts';
import {installDailyUseWeb} from '../packages/harness-overlay/src/host/daily-use-web.ts';
const id='bcb5ca3b-adbf-4920-afbd-cd38acaf3bd6',tick=()=>new Promise(r=>setTimeout(r,15));
function browser(){const d=new JSDOM('<main></main>',{url:`https://hub.test/?hubSession=chat&hubUpload=${id}`});d.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};return d;}
const button=(d,text)=>[...d.window.document.querySelectorAll('button')].find(b=>b.textContent===text);
test('handoff requires explicit consent, stages exact original, preserves text through caller and never submits a turn',async()=>{
 const d=browser(),calls=[],added=[];d.window.fetch=async(path,options)=>{calls.push({path,options});return path.endsWith('/draft')?Response.json({id,sessionId:'chat',name:'Notes.txt',bytes:7,mediaType:'text/plain'}):new Response('fixture');};
 const off=installUploadHandoff('chat',file=>added.push(file),d.window.document);
 try{assert.equal(calls.length,0);assert.equal(added.length,0);button(d,'Add to message').click();await tick();assert.equal(added.length,1);assert.equal(added[0].name,'Notes.txt');assert.equal(added[0].size,7);assert.equal(calls.length,2);assert.ok(calls.every(c=>!c.options.method&&c.options.redirect==='error'));assert.equal(calls[0].options.headers['x-hub-session'],'chat');assert.equal(d.window.document.querySelector('dialog'),null);assert.equal(new URL(d.window.location.href).search,'');}
 finally{off();d.window.close();}
});
test('foreign receipt and busy composer remain retryable without adding or losing the native draft URL',async()=>{
 const d=browser();let wrong=true,busy=true,attempts=0;
 d.window.fetch=async path=>path.endsWith('/draft')?Response.json({id,sessionId:wrong?'other':'chat',name:'Notes.txt',bytes:7,mediaType:'text/plain'}):new Response('fixture');
 const off=installUploadHandoff('chat',()=>{attempts++;if(busy)throw Error('Current message is busy; retry.');},d.window.document);
 try{button(d,'Add to message').click();await tick();assert.equal(attempts,0);assert.match(d.window.document.querySelector('[role=status]').textContent,/verified/);assert.ok(d.window.location.search.includes('hubUpload'));
 wrong=false;button(d,'Add to message').click();await tick();assert.equal(attempts,1);assert.match(d.window.document.querySelector('[role=status]').textContent,/busy/);assert.equal(button(d,'Add to message').disabled,false);
 busy=false;button(d,'Add to message').click();await tick();assert.equal(attempts,2);assert.equal(d.window.document.querySelector('dialog'),null);}
 finally{off();d.window.close();}
});
test('cancel and conversation change cannot fetch, attach or execute work automatically',async()=>{
 const d=browser();let fetched=0,added=0;d.window.fetch=async()=>{fetched++;throw Error('unexpected');};
 const wrong=installUploadHandoff('other',()=>added++,d.window.document);assert.equal(d.window.document.querySelector('dialog'),null);wrong();
 const off=installUploadHandoff('chat',()=>added++,d.window.document);button(d,'Keep for later').click();assert.equal(fetched,0);assert.equal(added,0);assert.equal(d.window.location.search,'');off();d.window.close();
});
test('home and conversation composers share one review and unmounting one cannot lose the other receiver',async()=>{
 const d=browser();let first=0,second=0;d.window.fetch=async path=>path.endsWith('/draft')?Response.json({id,sessionId:'chat',name:'Notes.txt',bytes:7,mediaType:'text/plain'}):new Response('fixture');
 const a=installUploadHandoff('chat',()=>first++,d.window.document),b=installUploadHandoff('chat',()=>second++,d.window.document);
 try{assert.equal(d.window.document.querySelectorAll('dialog').length,1);a();assert.equal(d.window.document.querySelectorAll('dialog').length,1);button(d,'Add to message').click();await tick();assert.equal(first,0);assert.equal(second,1);}
 finally{a();b();d.window.close();}
});
test('conversation chooser filters internal/archived/blank records, searches older titles and enforces read-only auth',async()=>{
 const routes=new Map(),items=Array.from({length:65},(_,i)=>({sessionId:'chat-'+i,updatedAt:i,projections:{values:{title:i===0?'Eski Türkçe sohbet':'Conversation '+i}}}));
 items.push({sessionId:'hub-eval-hidden',updatedAt:100},{sessionId:'agent-child',origin:'subagent',updatedAt:100},{sessionId:'blank',blank:true,updatedAt:100});
 const off=installDailyUseWeb({webServer:{register(r){routes.set(r.path,r);return()=>routes.delete(r.path);}},connection:{requestRejection:r=>r.headers.cookie==='fixture'?undefined:401},sessionController:{async list(){return{items};}},get:()=>({archivedSessionIds:['chat-64']})});
 async function request(headers={},method='GET'){let code,body;await routes.get('/api/hub/conversations').handler({method,headers:{cookie:'fixture','x-hub-daily-use':'1',...headers}},{writeHead(c){code=c;},end(v){body=JSON.parse(v);}});return{code,body};}
 try{const first=await request();assert.equal(first.code,200);assert.equal(first.body.hasMore,true);assert.equal(first.body.conversations.length,50);assert.equal(first.body.conversations[0].sessionId,'chat-63');
 const search=await request({'x-hub-session-query':encodeURIComponent('Türkçe')});assert.equal(search.body.conversations[0].sessionId,'chat-0');assert.equal(search.body.hasMore,false);
 assert.equal((await request({cookie:''})).code,401);assert.equal((await request({'sec-fetch-site':'cross-site'})).code,403);assert.equal((await request({},'POST')).code,405);assert.equal((await request({'x-hub-session-query':'%bad'})).code,400);}
 finally{off();}
});
