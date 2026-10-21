import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import {createKnowledgeMedia} from '../packages/harness-overlay/src/client/memory/knowledge-media.ts';

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
