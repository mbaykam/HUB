import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import {installPanelNavigation} from '../packages/harness-overlay/src/client/host/panel-navigation.ts';
import {installPanelDisclosure} from '../packages/harness-overlay/src/client/host/panel-disclosure.ts';
import {installMobileSettings} from '../packages/harness-overlay/src/client/host/mobile-settings.ts';
const settle=()=>new Promise(r=>setTimeout(r,40));

test('compact navigation uses original handlers, follows selection and respects a draft guard',async t=>{
 const dom=new JSDOM('<html data-minke-mobile-web><body><div data-hub-mobile-settings><nav role="tablist" aria-label="HUB Settings"></nav></div></body></html>',{pretendToBeVisual:true}),root=dom.window.document,nav=root.querySelector('nav');let guarded=false,calls=0;
 for(let i=0;i<5;i++){const b=root.createElement('button');b.role='tab';b.textContent='Section '+i;b.setAttribute('aria-selected',String(i===0));b.addEventListener('click',()=>{calls++;if(guarded)return;for(const button of nav.children)button.setAttribute('aria-selected',String(button===b));});nav.append(b);}
 const dispose=installPanelNavigation(root);t.after(()=>{dispose();dom.window.close();});const select=root.querySelector('select');assert.equal(select.options.length,5);assert.equal(select.value,'0');select.value='2';select.dispatchEvent(new dom.window.Event('change'));await settle();assert.equal(nav.children[2].getAttribute('aria-selected'),'true');assert.equal(select.value,'2');guarded=true;select.value='4';select.dispatchEvent(new dom.window.Event('change'));await settle();assert.equal(select.value,'2');assert.equal(calls,2);dispose();assert.equal(root.querySelector('select'),null);assert.equal(nav.hasAttribute('data-hub-compact-navigation'),false);
});

test('action menus have an explicit close label and Escape closes the menu before the containing dialog',async t=>{
 const dom=new JSDOM('<body><dialog open data-hub-graph-dialog><details data-hub-action-menu="More actions"><summary>More actions</summary><div><button>Edit source</button></div></details></dialog></body>',{pretendToBeVisual:true}),root=dom.window.document,menu=root.querySelector('details');const dispose=installPanelDisclosure(root);t.after(()=>{dispose();dom.window.close();});let dialogEscape=0;root.querySelector('dialog').addEventListener('keydown',()=>dialogEscape++);menu.open=true;await settle();assert.equal(menu.querySelector('summary').textContent,'Close actions');assert.equal(menu.querySelector('[data-hub-collapse]'),null);menu.querySelector('button').dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await settle();assert.equal(menu.open,false);assert.equal(dialogEscape,0);assert.equal(menu.querySelector('summary').textContent,'More actions');assert.equal(root.activeElement,menu.querySelector('summary'));
});

test('PWA Settings removes the host-document action even when native markup has no aria-label',async t=>{
 const dom=new JSDOM('<html data-minke-mobile-web><body><div data-slot="sidebar.settings"><div role="dialog"><nav><div><button>General</button><button>Models</button></div></nav><section><header><button>Close</button></header><main><footer><button id="document">Open configuration file</button></footer></main></section></div></div></body></html>',{pretendToBeVisual:true,url:'https://hub.test'}),root=dom.window.document;
 dom.window.fetch=async()=>Response.json({});const dispose=installMobileSettings(root);t.after(()=>{dispose();dom.window.close();});await settle();assert.ok(root.querySelector('#document').hasAttribute('data-hub-legacy-setting'));const models=[...root.querySelectorAll('nav button')].find(b=>b.textContent==='Models');assert.ok(models.hasAttribute('data-hub-legacy-setting'));dispose();assert.equal(root.querySelector('#document').hasAttribute('data-hub-legacy-setting'),false);
});

for(const [name,wrapper] of [
 ['Tools','<section data-hub-tools>'],
 ['Knowledge AI','<section data-knowledge-menu>'],
 ['Telegram','<dialog open aria-label="Telegram connection">'],
])test(`${name} expanded settings have an explicit collapse action and restore keyboard focus`,async t=>{
 const closing=wrapper.startsWith('<dialog')?'</dialog>':'</section>';
 const dom=new JSDOM(`<body>${wrapper}<details open><summary>Advanced options</summary><p>Configuration</p></details>${closing}</body>`,{pretendToBeVisual:true}),root=dom.window.document;
 const dispose=installPanelDisclosure(root);t.after(()=>{dispose();dom.window.close();});
 const details=root.querySelector('details'),close=details.querySelector('button');
 assert.equal(close.getAttribute('aria-label'),'Collapse Advanced options');close.click();
 assert.equal(details.open,false);assert.equal(root.activeElement,details.querySelector('summary'));
 dispose();assert.equal(root.querySelector('[data-hub-collapse]'),null);
});
