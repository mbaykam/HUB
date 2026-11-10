import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import {createNativeVoiceEntry} from '../packages/harness-overlay/src/client/host/native-voice-entry.ts';
import {installMobileHubs} from '../packages/harness-overlay/src/client/host/mobile-hubs.ts';

test('iPhone wrapper presents a plain fixed confirmation link with no conversation, command or credential payload',()=>{
 const dom=new JSDOM('<main></main>',{url:'https://hub.example.com/?hubSession=private-chat&token=do-not-copy#section'});
 Object.defineProperty(dom.window.navigator,'userAgent',{value:'Mozilla/5.0 (iPhone) Safari/605.1 HUBiOS/0.1'});
 try{const link=createNativeVoiceEntry(dom.window.document);assert.equal(link.tagName,'A');assert.equal(link.href,'https://hub.example.com/?hubNative=voice');assert.equal(link.getAttribute('aria-label'),'Open iPhone voice controls');assert.equal(link.querySelectorAll('[data-voice-glyph] i').length,5);assert.doesNotMatch(link.outerHTML,/private-chat|token=|messageHandlers|webkit\./);}
 finally{dom.window.close();}
});
test('normal Safari/PWA and unrelated UA strings keep the existing browser voice entry',()=>{
 for(const ua of ['Mozilla/5.0 (iPhone) Safari/605.1','Mozilla Chrome/130','HUBiOS/not-a-version','NotHUBiOS/0.1']){
  const dom=new JSDOM('<main></main>',{url:'https://hub.example.com/'});Object.defineProperty(dom.window.navigator,'userAgent',{value:ua});
  try{assert.equal(createNativeVoiceEntry(dom.window.document),undefined);}finally{dom.window.close();}
 }
});
test('a UA hint cannot create a native entry on cleartext pages',()=>{
 const dom=new JSDOM('<main></main>',{url:'http://localhost/'});Object.defineProperty(dom.window.navigator,'userAgent',{value:'HUBiOS/0.1'});
 try{assert.equal(createNativeVoiceEntry(dom.window.document),undefined);}finally{dom.window.close();}
});
test('installed iPhone Home surface hides browser audio and cannot start it through the old button',async()=>{
 const dom=new JSDOM('<main data-minke-mobile-web><div data-slot="conversation"><section data-phase="hero"><div data-conversation-scroll></div><div data-composer-seat><div data-slot="conversation.composer.bar"></div></div></section></div></main>',{url:'https://hub.example.com/',pretendToBeVisual:true}),root=dom.window.document;
 Object.defineProperty(dom.window.navigator,'userAgent',{value:'Mozilla/5.0 HUBiOS/0.1'});
 const previous={Element:globalThis.Element,CustomEvent:globalThis.CustomEvent};Object.assign(globalThis,{Element:dom.window.Element,CustomEvent:dom.window.CustomEvent});
 dom.window.matchMedia=()=>({matches:true});dom.window.ResizeObserver=class{observe(){}disconnect(){}};dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
 const calls=[];dom.window.fetch=async(path,options)=>{calls.push({path,options});return path==='/api/hub/voice/status'?Response.json({enabled:true,busy:false}):Response.json({error:'isolated fixture'},{status:503});};
 const off=installMobileHubs({sessions:{list:{getSnapshot:()=>({current:undefined,byId:{},phase:'ready'}),subscribe:()=>()=>{}},refresh:async()=>{}},connection:{state:{getSnapshot:()=> 'connected',subscribe:()=>()=>{}}}},root);
 try{
  await new Promise(r=>setTimeout(r,80));
  const native=root.querySelector('[data-native-voice-entry]'),web=root.querySelector('button[data-voice-start]');
  assert.ok(native?.isConnected);assert.equal(native.hidden,false);assert.equal(native.getAttribute('aria-disabled'),'false');assert.equal(web.hidden,true);
  let destination;native.addEventListener('click',event=>{event.preventDefault();destination=native.href;});native.click();web.click();
  await new Promise(r=>setTimeout(r,20));assert.equal(destination,'https://hub.example.com/?hubNative=voice');assert.ok(calls.every(c=>c.path!=='/api/hub/voice/open'&&!c.path.endsWith('/client.js')));
 }finally{try{off();}finally{Object.assign(globalThis,previous);dom.window.close();}}
});
