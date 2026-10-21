import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import {installDesktopRightPanel} from '../packages/harness-overlay/src/client/host/desktop-right-panel.ts';

test('wide PWA secondary panel does not steal Escape or focus from native Settings',()=>{
 const dom=new JSDOM('<main data-slot="sidebar.settings"><div role="dialog"><button>Settings control</button></div></main>',{url:'https://hub.test',pretendToBeVisual:true}),root=dom.window.document;
 dom.window.ResizeObserver=class{observe(){}disconnect(){}};
 dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
 dom.window.fetch=async url=>Response.json(url.includes('/goals')?{goals:[],characters:[],tools:[]}:url.includes('/automations')?{automations:[],characters:[]}:{nodes:[],edges:[]});const off=installDesktopRightPanel(root);
 try{const opener=root.querySelector('[data-hub-desktop-panel-open]'),panel=root.querySelector('[data-hub-desktop-right-panel]'),settings=root.querySelector('[role=dialog] button');opener.click();settings.focus();root.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape'}));assert.equal(panel.hidden,false);assert.equal(root.activeElement,settings);root.querySelector('[role=dialog]').remove();root.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape'}));assert.equal(panel.hidden,true);assert.equal(root.activeElement,opener);}
 finally{off();dom.window.close();}
});
