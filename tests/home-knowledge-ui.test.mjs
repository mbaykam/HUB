import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import {createHomeKnowledge} from '../packages/harness-overlay/src/client/host/mobile-home-knowledge.ts';

test('home Knowledge uses the protected graph protocol, preserves data on retry and releases hidden preview work',async()=>{
 const dom=new JSDOM('<main></main>',{url:'https://hub.test',pretendToBeVisual:true}),root=dom.window.document;let fail=true,requests=0;
 dom.window.fetch=async(url,init)=>{requests++;assert.equal(url,'/api/hub/memory?view=graph');assert.equal(init.headers['x-hub-memory'],'1','Native server refuses graph reads without this header');return{ok:!fail,json:async()=>({secondBrain:true,nodes:[{id:'note',title:'A real note',kind:'note'},{id:'chat',title:'Archived chat',kind:'conversation'}],edges:[],domains:[]})};};
 const home=createHomeKnowledge(root);root.querySelector('main').append(home.panel);
 try{home.update(true);await setImmediate();assert.match(home.panel.textContent,/Retry knowledge/);fail=false;home.panel.querySelector('button').click();await setImmediate();assert.match(home.panel.textContent,/Explore knowledge/);assert.equal(home.panel.querySelectorAll('dd').length,4);assert.equal(home.panel.querySelectorAll('svg').length,1);assert.equal(home.panel.querySelectorAll('svg [role=button]').length,1);assert.equal(home.panel.querySelector('svg [role=button]').getAttribute('aria-label'),'Read A real note');home.update(false);assert.equal(home.panel.hidden,true);assert.equal(home.panel.querySelectorAll('svg').length,0);assert.equal(requests,2);
 }finally{home.dispose();dom.window.close();}
});

test('full graph loads only on demand and cannot open after Home is hidden',async()=>{
 const dom=new JSDOM('<main></main>',{url:'https://hub.test',pretendToBeVisual:true}),root=dom.window.document;
 dom.window.fetch=async()=>({ok:true,json:async()=>({secondBrain:true,nodes:[],edges:[],domains:[]})});
 let loads=0,opened=0,closed=0,resolveLoad;
 const home=createHomeKnowledge(root,()=>{loads++;return new Promise(resolve=>{resolveLoad=resolve;});});root.querySelector('main').append(home.panel);
 const module={openMemoryGraph(){opened++;return()=>closed++;}};
 try{
  home.update(true);await setImmediate();assert.equal(loads,0,'initial preview does not download the graph engine');
  const button=home.panel.querySelector('button');button.click();button.click();assert.equal(loads,1);assert.equal(button.getAttribute('aria-busy'),'true');
  home.update(false);resolveLoad(module);await setImmediate();assert.equal(opened,0,'late download cannot open a hidden screen');
  home.update(true);await setImmediate();button.click();resolveLoad(module);await setImmediate();assert.equal(opened,1);assert.equal(button.disabled,false);
  home.update(false);assert.equal(closed,1,'hiding Home disposes its viewer');
 }finally{home.dispose();dom.window.close();}
});

test('graph download failure leaves an explicit working retry',async()=>{
 const dom=new JSDOM('<main></main>',{url:'https://hub.test',pretendToBeVisual:true});
 dom.window.fetch=async()=>({ok:true,json:async()=>({secondBrain:true,nodes:[],edges:[],domains:[]})});
 let attempts=0;const home=createHomeKnowledge(dom.window.document,async()=>{if(++attempts===1)throw Error('offline');return{openMemoryGraph(){return()=>{};}};});
 try{home.update(true);await setImmediate();const button=home.panel.querySelector('button');button.click();await setImmediate();assert.match(home.panel.textContent,/Couldn’t open Knowledge/);assert.equal(button.disabled,false);button.click();await setImmediate();assert.equal(attempts,2);}finally{home.dispose();dom.window.close();}
});
