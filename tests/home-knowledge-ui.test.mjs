import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {setImmediate} from 'node:timers/promises';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
const hook=registerHooks({resolve(specifier,context,next){if(specifier.endsWith('/knowledge-cloud.ts')&&context.parentURL?.endsWith('/mobile-home-knowledge.ts'))return{shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent('export function createKnowledgeCloud(root){return{canvas:root.createElement("canvas"),update(){},resize(){},dispose(){}}}')};return next(specifier,context);}});
const {createHomeKnowledge}=await import('../packages/harness-overlay/src/client/host/mobile-home-knowledge.ts');hook.deregister();

test('home Knowledge uses the protected graph protocol, preserves data on retry and releases hidden preview work',async()=>{
 const dom=new JSDOM('<main></main>',{url:'https://hub.test',pretendToBeVisual:true}),root=dom.window.document;let fail=true,requests=0;
 dom.window.fetch=async(url,init)=>{requests++;assert.equal(url,'/api/hub/memory?view=graph');assert.equal(init.headers['x-hub-memory'],'1','Native server refuses graph reads without this header');return{ok:!fail,json:async()=>({secondBrain:true,nodes:[{id:'note',kind:'note'},{id:'chat',kind:'conversation'}],edges:[],domains:[]})};};
 const home=createHomeKnowledge(root);root.querySelector('main').append(home.panel);
 try{home.update(true);await setImmediate();assert.match(home.panel.textContent,/Retry knowledge/);fail=false;home.panel.querySelector('button').click();await setImmediate();assert.match(home.panel.textContent,/Explore knowledge/);assert.equal(home.panel.querySelectorAll('dd').length,4);assert.equal(home.panel.querySelectorAll('canvas').length,1);home.update(false);assert.equal(home.panel.hidden,true);assert.equal(home.panel.querySelectorAll('canvas').length,0);assert.equal(requests,2);
 }finally{home.dispose();dom.window.close();}
});
