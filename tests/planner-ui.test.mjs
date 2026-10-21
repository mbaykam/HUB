import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import {PlannerStore} from '../packages/harness-overlay/src/host/planner.ts';
import {createMobilePlanner,attachPlannerShortcut} from '../packages/harness-overlay/src/client/host/mobile-planner.ts';
import {plannerZonedInstant,plannerLocalTime} from '../packages/harness-overlay/src/planner-contract.ts';
const button=(root,text)=>[...root.querySelectorAll('button')].find(b=>b.textContent===text);
const field=(root,text)=>[...root.querySelectorAll('label')].find(l=>l.querySelector('span')?.textContent===text)?.querySelector('input,select,textarea');
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'hub-eval-planner-ui-')),store=new PlannerStore(directory);await store.load();const dom=new JSDOM('<main></main>',{url:'http://fixture.test',pretendToBeVisual:true}),root=dom.window.document;let fail=false,heldRead;
 dom.window.fetch=async(_url,init)=>{if(fail)return{ok:false,json:async()=>({detail:'Offline: retry your unchanged draft.'})};if(init.method==='POST')await store.change(JSON.parse(init.body));const snapshot=store.snapshot('voice-fixture');if(init.method!=='POST'&&heldRead){const wait=heldRead;heldRead=undefined;await wait;}return{ok:true,json:async()=>snapshot};};
 dom.window.ResizeObserver=class{observe(){}disconnect(){}};
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
 const planner=createMobilePlanner(root,()=>{});root.querySelector('main').append(planner.panel);planner.update({visible:true,voice:false});await setImmediate();await setImmediate();
 t.after(async()=>{planner.dispose();dom.window.close();await rm(directory,{recursive:true,force:true});});return{root,store,planner,view:dom.window,setFail:v=>{fail=v;},holdNextRead(){let release;heldRead=new Promise(resolve=>{release=resolve;});return release;}};
}

test('calendar has an explicit open/close control and switching to voice keeps separate work steps',async t=>{
 const {root,store,planner}=await fixture(t);const calendar=root.querySelector('.hub-calendar-header button:nth-child(2)');assert.equal(calendar.getAttribute('aria-expanded'),'false');assert.equal(root.querySelectorAll('.hub-calendar button').length,7);calendar.click();assert.equal(calendar.getAttribute('aria-expanded'),'true');assert.equal(root.querySelectorAll('.hub-calendar button').length,42);calendar.click();assert.equal(root.querySelectorAll('.hub-calendar button').length,7);
 await store.plan({sessionId:'worker',rootSessionId:'voice-fixture',version:0,title:'Fixture research',steps:[{title:'Read sources',state:'active'}]});planner.update({visible:true,voice:true,sessionId:'voice-fixture'});await setImmediate();await setImmediate();assert.equal(root.querySelector('.hub-work-plans').hidden,false);assert.match(root.querySelector('.hub-work-plans').textContent,/Fixture research/);assert.equal(store.snapshot().items.length,0,'Agent steps are not personal to-dos');
 await store.plan({sessionId:'worker',rootSessionId:'voice-fixture',version:1,title:'Fixture research',steps:[]});root.dispatchEvent(new root.defaultView.Event('hub:planner-changed'));await setImmediate();await setImmediate();assert.equal(root.querySelector('.hub-work-plans').hidden,true,'Cleared checklist does not leave an empty active card');
 planner.update({visible:false,voice:true,sessionId:'voice-fixture'});assert.equal(planner.panel.hidden,true);planner.open();assert.equal(root.querySelector('[data-hub-planner-dialog]').open,true);button(root,'Done').click();assert.equal(root.querySelector('[data-hub-planner-dialog]').open,false);
});

test('failed save preserves an editable draft, then retry succeeds without duplicating items',async t=>{
 const {root,store,view,setFail}=await fixture(t);root.querySelector('[aria-label="Add calendar event"]').click();field(root,'Title').value='Fixture review';setFail(true);root.querySelector('[data-hub-planner-editor] form').dispatchEvent(new view.Event('submit',{cancelable:true}));await setImmediate();await setImmediate();assert.equal(root.querySelector('[data-hub-planner-editor]').open,true);assert.equal(field(root,'Title').value,'Fixture review');assert.match(root.querySelector('[data-hub-planner-editor] [role=status]').textContent,/unchanged draft/);assert.equal(store.snapshot().items.length,0);
 setFail(false);root.querySelector('[data-hub-planner-editor] form').dispatchEvent(new view.Event('submit',{cancelable:true}));await setImmediate();await setImmediate();await store.drain();await setImmediate();assert.equal(store.snapshot().items.length,1);assert.equal(store.snapshot().items[0].kind,'event');assert.equal(root.querySelector('[data-hub-planner-editor]').open,false);
});

test('empty quick-add opens a focused editor; quick text submission saves a single personal item',async t=>{
 const {root,store,view}=await fixture(t),quick=root.querySelector('.hub-todo-quick'),input=quick.querySelector('input');
 quick.querySelector('button').click();assert.equal(root.querySelector('[data-hub-planner-editor]').open,true);assert.equal(field(root,'Type').value,'todo');assert.equal(root.activeElement,field(root,'Title'));assert.equal(store.snapshot().items.length,0);
 button(root,'Cancel').click();input.value='Read the fixture summary';quick.dispatchEvent(new view.Event('submit',{cancelable:true}));await setImmediate();await setImmediate();await store.drain();await setImmediate();assert.equal(store.snapshot().items.length,1);assert.equal(input.value,'');assert.equal(store.snapshot().items[0].title,'Read the fixture summary');
 root.querySelector('.hub-todo-row input').click();await setImmediate();await setImmediate();await store.drain();await setImmediate();assert.equal(store.snapshot().items[0].state,'done');button(root,'Reopen').click();await setImmediate();await setImmediate();await store.drain();await setImmediate();assert.equal(store.snapshot().items[0].state,'open');
});

test('a delayed background read cannot make a newly saved to-do disappear',async t=>{
 const {root,store,view,holdNextRead}=await fixture(t),release=holdNextRead();root.dispatchEvent(new view.Event('hub:planner-changed'));await setImmediate();root.querySelector('.hub-todo-quick input').value='Survive the delayed refresh';root.querySelector('.hub-todo-quick').dispatchEvent(new view.Event('submit',{cancelable:true}));await setImmediate();await setImmediate();await store.drain();await setImmediate();assert.match(root.querySelector('.hub-todo-row').textContent,/Survive/);release();await setImmediate();await setImmediate();assert.equal(store.snapshot().items.length,1);assert.match(root.querySelector('.hub-todo-row')?.textContent??'',/Survive/,'Old GET must not replace the newer POST result');
});

test('calendar wall times preserve the selected timezone and reject the skipped DST hour',()=>{
 assert.equal(plannerZonedInstant('2026-10-21T09:30','Europe/Istanbul'),'2026-10-21T06:30:00.000Z');assert.equal(plannerLocalTime('2026-10-21T06:30:00Z','Europe/Istanbul'),'2026-10-21T09:30');assert.throws(()=>plannerZonedInstant('2026-03-08T02:30','America/New_York'),/does not exist/);assert.equal(plannerZonedInstant('2026-11-01T01:30','America/New_York'),'2026-11-01T05:30:00.000Z');
});

test('the planner shortcut works with native sidebar slots and survives a lazy drawer footer',()=>{
 const dom=new JSDOM('<aside><div><div data-slot="sidebar.settings"><button>Settings</button></div></div></aside>'),root=dom.window.document,nav=root.createElement('button');nav.textContent='Agenda & to-dos';nav.hidden=true;
 try{attachPlannerShortcut(root,nav);assert.equal(nav.nextSibling,root.querySelector('[data-slot="sidebar.settings"]'));assert.equal(nav.hidden,true,'Home controls visibility, not sidebar placement');attachPlannerShortcut(root,nav);assert.equal(root.querySelectorAll('aside button').length,2);const footer=root.createElement('div');footer.dataset.hubMobileNavFooter='';root.querySelector('aside').append(footer);attachPlannerShortcut(root,nav);assert.equal(footer.firstChild,nav);footer.remove();attachPlannerShortcut(root,nav);assert.equal(nav.isConnected,true);assert.equal(nav.nextSibling,root.querySelector('[data-slot="sidebar.settings"]'));
 }finally{dom.window.close();}
});
