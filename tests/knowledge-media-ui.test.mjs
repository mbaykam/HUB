import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import {createKnowledgeMedia} from '../packages/harness-overlay/src/client/memory/knowledge-media.ts';

test('saved HTML opens inside the PWA with existing authentication and game controls; Download keeps the original route',async()=>{
 const dom=new JSDOM('<main></main>',{url:'https://hub.test'}),w=dom.window,root=w.document;w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
 const requests=[];w.fetch=async(url,init)=>{requests.push({url,init});return Response.json({name:'snake.html',document:'<!doctype html><canvas></canvas><script>game()</script>'});};
 try{const media=createKnowledgeMedia(root),path='Attachments/snake (fixture).html';media.file(root.querySelector('main'),'Original snake.html',path,'text/html');const open=root.querySelector('button');assert.equal(open.textContent,'Open app');assert.equal(root.querySelectorAll('a[target=_blank]').length,0);assert.equal(new URL(root.querySelector('a[download]').href).searchParams.get('path'),path);open.focus();open.click();await new Promise(r=>setTimeout(r,20));
  assert.equal(requests.length,1);assert.equal(new URL(requests[0].url,'https://hub.test').searchParams.get('view'),'app-document');assert.equal(new URL(requests[0].url,'https://hub.test').searchParams.get('path'),path);assert.equal(requests[0].init.credentials,'same-origin');assert.equal(requests[0].init.redirect,'error');const frame=root.querySelector('iframe');assert.equal(frame.getAttribute('sandbox'),'allow-scripts');assert.match(frame.srcdoc,/<canvas>/);assert.equal(root.querySelector('dialog').open,true);assert.ok([...root.querySelectorAll('button')].some(b=>b.textContent==='Restart'));
  root.querySelector('dialog header button').click();assert.equal(root.querySelector('dialog'),null);assert.equal(root.activeElement,open);assert.equal(requests[0].init.signal.aborted,true);
 }finally{dom.window.close();}
});

test('closing an HTML preview cancels its read, and a sign-in failure gives feedback instead of an empty frame',async()=>{
 const dom=new JSDOM('<main></main>',{url:'https://hub.test'}),w=dom.window,root=w.document;w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};let finish,requestSignal;
 w.fetch=async(_url,init)=>{requestSignal=init.signal;return new Promise(r=>{finish=r;});};
 try{const media=createKnowledgeMedia(root);media.file(root.querySelector('main'),'snake.html','Attachments/snake.html','text/html');root.querySelector('button').click();root.querySelector('dialog header button').click();assert.equal(requestSignal.aborted,true);finish(Response.json({name:'snake.html',document:'<canvas></canvas>'}));await new Promise(r=>setTimeout(r,20));assert.equal(root.querySelector('iframe'),null);
  w.fetch=async()=>new Response('sign in',{status:401});root.querySelector('button').click();await new Promise(r=>setTimeout(r,20));assert.equal(root.querySelector('iframe'),null);assert.match(root.querySelector('[role=status]').textContent,/sign-in expired/);root.querySelector('dialog header button').click();assert.equal(root.querySelector('dialog'),null);
 }finally{dom.window.close();}
});

test('original chat attachment links retain parentheses, percent signs and Unicode without rewriting the transcript',()=>{
 const dom=new JSDOM('<main></main>',{url:'https://hub.test'}),root=dom.window.document,media=createKnowledgeMedia(root);
 try{for(const filename of ['Brief (draft (v2)) (abc123).txt','Türkçe 100% (abc123).pdf','Literal%20name (abc123).txt']){
  const path='Attachments/'+filename,asset={id:'a'.repeat(64),path,name:filename,mediaType:'text/plain',bytes:10},content=`[${filename}](../${path})`,note={id:'original',permalink:'Conversations/original',content,assets:[asset]};
  media.renderBody(root.querySelector('main'),note,()=>assert.fail(),[]);const link=root.querySelector('a[download]');assert.ok(link,filename);assert.equal(new URL(link.href).searchParams.get('path'),path);assert.equal(root.querySelector('main').textContent,filename+'Open fileDownload');assert.equal(note.content,content);
  const encoded=path.split('/').map(part=>encodeURIComponent(part).replace(/[()]/g,c=>'%'+c.charCodeAt(0).toString(16))).join('/');media.renderBody(root.querySelector('main'),{...note,content:`[${filename}](../${encoded})`},()=>assert.fail(),[]);assert.equal(new URL(root.querySelector('a[download]').href).searchParams.get('path'),path);
 }}finally{dom.window.close();}
});

test('inline links preserve following text and reject executable links or malformed destinations',()=>{
 const dom=new JSDOM('<main></main>',{url:'https://hub.test'}),root=dom.window.document,media=createKnowledgeMedia(root),render=content=>media.renderBody(root.querySelector('main'),{permalink:'Notes/one',content,assets:[]},()=>{},[]);
 try{render('Read [the source](https://example.com/topic_(detail)) and continue.');assert.equal(root.querySelector('a').href,'https://example.com/topic_(detail)');assert.match(root.querySelector('main').textContent,/ and continue\.$/);
  render('[bad](javascript:alert(1)) [bad](data:text/html,payload)');assert.equal(root.querySelectorAll('a').length,0);
  const malformed='[unfinished](Attachments/(nested';render(malformed);assert.equal(root.querySelector('main').textContent,malformed);assert.equal(root.querySelectorAll('a').length,0);
  media.renderBody(root.querySelector('main'),{permalink:'Root note',content:'[file](Attachments/Brief%20%28id%29.txt)',assets:[]},()=>{},[]);assert.equal(new URL(root.querySelector('a[download]').href).searchParams.get('path'),'Attachments/Brief (id).txt');
 }finally{dom.window.close();}
});
