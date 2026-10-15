import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import {installMobileAutomations} from '../packages/harness-overlay/src/client/host/mobile-automations.ts';
import {installHubDeepLink} from '../packages/harness-overlay/src/client/host/hub-deep-link.ts';
import {installKnowledgeControls} from '../packages/harness-overlay/src/client/host/mobile-knowledge.ts';
import {defaultKnowledgeSettings} from '../packages/harness-overlay/src/knowledge-contract.ts';
import {defaultAutomation} from '../packages/harness-overlay/src/automation-contract.ts';
const flush=()=>new Promise(r=>setTimeout(r,15));
function dom(){const d=new JSDOM('<!doctype html><main data-home></main><aside></aside>',{url:'https://hub.test/',pretendToBeVisual:true});d.window.ResizeObserver=class{observe(){}disconnect(){}};d.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};d.window.HTMLDialogElement.prototype.close=function(){this.open=false;};return d;}
function button(root,text){return [...root.querySelectorAll('button')].find(b=>b.textContent===text);}

test('unsaved automation settings survive Back, Close, Escape and background refresh until explicitly discarded',async()=>{
 const d=dom(),root=d.window.document,posts=[];let poll;
 const state={revision:0,automations:[],characters:[{id:'hub',name:'HUB',route:{provider:'openai-codex',model:'main'}},{id:'mira',name:'Mira',route:{provider:'openai-codex',model:'fast'}}]};
 d.window.setInterval=fn=>{poll=fn;return 1;};d.window.clearInterval=()=>{};
 d.window.fetch=async(_url,request)=>{if(request.body)posts.push(request.body);return {ok:true,json:async()=>state};};
 const dispose=installMobileAutomations(root.querySelector('aside'),root);try{
  root.querySelector('[data-hub-automations-tile]').click();await flush();button(root,'Yeni otomasyon').click();
  const field=label=>root.querySelector('[aria-label="'+label+'"]'),dialog=root.querySelector('[data-hub-automations]'),form=root.querySelector('form');
  field('Ad').value='Weekly fixture';field('Yapılacak iş').value='Keep this unsaved plan.';field('Karakter').value='mira';field('Tetikleyici').value='calendar';field('Tetikleyici').dispatchEvent(new d.window.Event('change'));field('Saat').value='12:45';field('Hafta günleri').value='1,3,5';
  button(root,'Geri').click();assert.equal(form.hidden,false,'Back must not silently drop a populated automation draft');
  button(root,'Kapat').click();assert.equal(dialog.open,true,'Close must keep a dirty automation editor open');
  const cancel=new d.window.Event('cancel',{cancelable:true});dialog.dispatchEvent(cancel);assert.equal(cancel.defaultPrevented,true,'Escape must protect the draft');
  poll();await flush();assert.match(root.querySelector('[role="status"]').textContent,/kaydet|vazgeç/i,'Refresh must retain the save/discard guidance');
  assert.equal(field('Ad').value,'Weekly fixture');assert.equal(field('Karakter').value,'mira');assert.equal(field('Saat').value,'12:45');assert.equal(field('Hafta günleri').value,'1,3,5');
  button(root,'Değişikliklerden vazgeç').click();assert.equal(field('Ad').value,'');assert.equal(field('Karakter').value,'hub');assert.equal(field('Tetikleyici').value,'once');
  dialog.scrollTop=500;button(root,'Geri').click();assert.equal(form.hidden,true);assert.equal(dialog.scrollTop,0);button(root,'Kapat').click();assert.equal(dialog.open,false);assert.deepEqual(posts,[],'Navigating and discarding must not save or start a task');
 }finally{dispose();d.window.close();}
});

test('a failed automation save preserves edits and a successful retry clears the navigation guard',async()=>{
 const d=dom(),root=d.window.document,posts=[];let fail=true,state={revision:0,automations:[],characters:[{id:'mira',name:'Mira',route:{provider:'openai-codex',model:'fast'}}]};
 d.window.fetch=async(_url,request)=>{if(request.body){const data=JSON.parse(request.body);posts.push(data);if(fail)return {ok:false,json:async()=>({detail:'Fixture offline'})};state={...state,revision:1,automations:[{...data.automation,id:'saved',status:'scheduled',state:'active',runs:[],updatedAt:0}]};}return {ok:true,json:async()=>state};};
 const dispose=installMobileAutomations(root.querySelector('aside'),root);try{
  root.querySelector('[data-hub-automations-tile]').click();await flush();button(root,'Yeni otomasyon').click();const field=label=>root.querySelector('[aria-label="'+label+'"]'),form=root.querySelector('form');
  field('Ad').value='Retry fixture';field('Yapılacak iş').value='Keep my settings.';form.dispatchEvent(new d.window.Event('submit',{cancelable:true}));await flush();
  assert.match(root.querySelector('[role="status"]').textContent,/Fixture offline/);button(root,'Geri').click();assert.equal(form.hidden,false,'Failed save must not make a dirty draft disposable');assert.equal(field('Ad').value,'Retry fixture');
  fail=false;form.dispatchEvent(new d.window.Event('submit',{cancelable:true}));await flush();assert.equal(form.hidden,true);assert.equal(posts.length,2);assert.equal(posts[1].automation.title,'Retry fixture');
  button(root,'Kapat').click();assert.equal(root.querySelector('[data-hub-automations]').open,false);
 }finally{dispose();d.window.close();}
});

test('discard restores a saved paused automation and unchanged forms can close without a write',async()=>{
 const d=dom(),root=d.window.document,posts=[],job={...defaultAutomation,id:'paused',title:'Existing plan',prompt:'Read the checklist.',characterId:'mira',trigger:{kind:'interval',seconds:7200},state:'paused',status:'paused',runs:[],updatedAt:0};
 const state={revision:1,automations:[job],characters:[{id:'mira',name:'Mira',route:{provider:'openai-codex',model:'fast'}}]};d.window.fetch=async(_url,request)=>{if(request.body)posts.push(request.body);return {ok:true,json:async()=>state};};
 const dispose=installMobileAutomations(root.querySelector('aside'),root);try{
  root.querySelector('[data-hub-automations-tile]').click();await flush();button(root,'Düzenle').click();const field=label=>root.querySelector('[aria-label="'+label+'"]'),form=root.querySelector('form');
  field('Salt okuma dışındaki bu araçlara açıkça izin veriyorum').checked=true;button(root,'Geri').click();assert.equal(form.hidden,false,'Permission checkbox edits are also unsaved changes');
  button(root,'Değişikliklerden vazgeç').click();assert.equal(field('Ad').value,'Existing plan');assert.equal(field('Kontrol / tekrar aralığı (dakika)').value,'120');assert.equal(field('Salt okuma dışındaki bu araçlara açıkça izin veriyorum').checked,false);
  button(root,'Geri').click();assert.equal(form.hidden,true);button(root,'Düzenle').click();button(root,'Kapat').click();assert.equal(root.querySelector('[data-hub-automations]').open,false);assert.equal(job.state,'paused');assert.deepEqual(posts,[]);
 }finally{dispose();d.window.close();}
});
test('right-panel automation form creates a structured watch and does not add Home controls or call a model',async()=>{
 const d=dom(),root=d.window.document,calls=[];let state={revision:0,automations:[],blockedRoutes:[],hostRunsOnlyWhileOnline:true,characters:[{id:'mira',name:'Mira',route:{provider:'openai-codex',model:'gpt-6-luna'}}]};
 d.window.fetch=async(url,request)=>{assert.equal(url,'/api/hub/automations');assert.equal(request.headers['x-hub-automations'],'1');if(request.body){const command=JSON.parse(request.body);calls.push(command);state={...state,revision:state.revision+1,automations:[{...command.automation,id:'created',status:'scheduled',state:'active',runs:[]}]};}return {ok:true,json:async()=>state};};
 const dispose=installMobileAutomations(root.querySelector('aside'),root);try{root.querySelector('[data-hub-automations-tile]').click();await flush();button(root,'Yeni otomasyon').click();
   const field=label=>root.querySelector('[aria-label="'+label+'"]');field('Ad').value='User fixture';field('Yapılacak iş').value='Read public changes.';field('Tetikleyici').value='watch';field('Tetikleyici').dispatchEvent(new d.window.Event('change'));field('Kaynak URL').value='https://example.org/data';field('JSON alan yolu').value='data.price';field('Koşul').value='above';field('Karşılaştırılacak değer').value='15';const dialog=root.querySelector('[data-hub-automations]');
   button(root,'Değişikliklerden vazgeç').click();dialog.scrollTop=500;button(root,'Geri').click();assert.equal(dialog.scrollTop,0,'Returning from a long form must expose the list toolbar');
   button(root,'Yeni otomasyon').click();field('Ad').value='User fixture';field('Yapılacak iş').value='Read public changes.';field('Tetikleyici').value='watch';field('Tetikleyici').dispatchEvent(new d.window.Event('change'));field('Kaynak URL').value='https://example.org/data';field('JSON alan yolu').value='data.price';field('Koşul').value='above';field('Karşılaştırılacak değer').value='15';dialog.scrollTop=500;root.querySelector('form').dispatchEvent(new d.window.Event('submit',{cancelable:true,bubbles:true}));await flush();assert.equal(dialog.scrollTop,0,'Saving must return to a readable list');
   assert.equal(calls.length,1);assert.deepEqual(calls[0].automation.trigger,{kind:'watch',url:'https://example.org/data',seconds:3600,rule:'above',value:'15',jsonPath:'data.price',fireOnFirst:false});assert.equal(calls[0].automation.notification,'pwa');assert.equal(calls[0].automation.allowWrites,false);assert.equal(root.querySelector('[data-home]').children.length,0);assert.ok(button(root,'Geçmiş'));button(root,'Geçmiş').click();assert.equal(root.querySelector('[data-hub-automations]').textContent.includes('Henüz çalıştırılmadı.'),true);
 }finally{dispose();d.window.close();}
});
test('owned automation session links open native chat; arbitrary ids cannot navigate',async()=>{
 const id='hub-automation-00000000-0000-4000-8000-000000000001-00000000-0000-4000-8000-000000000002',d=new JSDOM('<body></body>',{url:'https://hub.test/?hubSession='+id});const opened=[];let refreshed=0;const sessions={refresh:async()=>refreshed++,list:{getSnapshot:()=>({byId:{[id]:{}}}),subscribe:()=>()=>{}},open:id=>opened.push(id)};const dispose=installHubDeepLink({sessions},d.window.document);assert.deepEqual(opened,[id]);assert.equal(refreshed,1);dispose();d.window.close();
 const unknown=new JSDOM('<body></body>',{url:'https://hub.test/?hubSession=arbitrary'});installHubDeepLink({sessions},unknown.window.document)();assert.equal(opened.length,1);unknown.window.close();
});
test('Knowledge menu explains protected originals and separates reviewed profile additions from source notes',async()=>{
 const d=dom(),root=d.window.document,commands=[];const snapshot={secondBrain:true,enabled:true,status:'ready',vault:'fixture vault',settings:{...defaultKnowledgeSettings,mode:'automatic'},todayEstimatedCost:0,monthEstimatedCost:0,notes:1,counts:{queued:0,working:0,review:0,done:0,failed:0,'waiting-credit':0},jobs:[],embedding:'Fixture local',historyArchivesReady:true};
 d.window.fetch=async(url,request)=>{if(request?.body)commands.push(JSON.parse(request.body));return {ok:true,json:async()=>String(url).includes('view=organization')?{reflections:[],suggestions:[{id:'suggestion-one',target:'USER.md',text:'Uses Telegram.',evidence:'I use Telegram.',at:1791900000000,status:'pending'}]}:String(url).includes('models')?{models:[],providers:[]}:snapshot};};
 const dispose=installKnowledgeControls(root.querySelector('aside'),root,snapshot);try{button(root,'Knowledge AI ayarları').click();await flush();assert.equal(root.querySelector('[data-knowledge-menu]').textContent.includes('Konuşma metinlerini ve mevcut notlarını yeniden yazmaz.'),true);assert.ok(button(root,'Reflection'));button(root,'Reflection').click();assert.ok(button(root,'Profile ekle'));button(root,'Profile ekle').click();await flush();assert.deepEqual(commands,[{action:'profile-review',id:'suggestion-one',decision:'approve'}]);assert.equal(root.querySelector('[aria-label="Reflection ve ilişki açıklamalarının dili"]').value,'auto');}finally{dispose();d.window.close();}
});
