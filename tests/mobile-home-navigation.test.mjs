import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import {MobileSidebarDrawerRuntime} from '@minke/harness-overlay/client/host/mobile-sidebar-drawer.ts';
import {MobileRightDrawerRuntime} from '@minke/harness-overlay/client/host/mobile-right-drawer.ts';
import {returnToMobileHome} from '@minke/harness-overlay/client/host/mobile-home-navigation.ts';

const frames=view=>new Promise(resolve=>view.requestAnimationFrame(()=>view.requestAnimationFrame(resolve)));
function pointer(view,target,type,x,id=1){
 const e=new view.MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:120});
 Object.defineProperties(e,{isPrimary:{value:true},pointerId:{value:id},pointerType:{value:'touch'}});
 target.dispatchEvent(e);
}
function swipe(view,target,from,to,id=1){pointer(view,target,'pointerdown',from,id);pointer(view,target,'pointermove',to,id);pointer(view,target,'pointerup',to,id);}
async function fixture(run){
 const dom=new JSDOM('<!doctype html><html data-minke-mobile-web><body><main id="frame" data-sidebar-collapsed><aside><div data-slot="sidebar"><div role="treeitem" aria-selected="false">Saved chat</div><div data-slot="sidebar.settings"><div><button aria-haspopup="dialog" aria-expanded="false">Settings</button></div></div></div></aside><section id="content"><main data-hub-home id="home"><div contenteditable="true">Keep my draft</div></main></section><section id="details"></section><div data-shell-overlay></div></main></body></html>',{url:'https://navigation.test/',pretendToBeVisual:true});
 const view=dom.window,root=view.document,frame=root.querySelector('#frame');
 Object.defineProperty(view,'innerWidth',{value:390});view.matchMedia=()=>({matches:true});
 view.ResizeObserver=class{observe(){}disconnect(){}};
 const previous=globalThis.Element;globalThis.Element=view.Element;
 let current='saved-chat',toggles=0,starts=0,clears=0;const listeners=new Set();
 const sessions={clear(){clears++;current=undefined;for(const listener of listeners)listener();},list:{getSnapshot:()=>({current}),subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}}};
 const ctx={sessions,uiWorkspace:{startSession(){starts++;}}};
 const left=new MobileSidebarDrawerRuntime({toggleSidebar(){toggles++;frame.toggleAttribute('data-sidebar-collapsed');}},sessions.list,root);
 const right=new MobileRightDrawerRuntime(root);left.start();right.start();
 try{await frames(view);await run({view,root,frame,ctx,get toggles(){return toggles;},get starts(){return starts;},get clears(){return clears;}});}
 finally{right.dispose();left.dispose();view.close();if(previous===undefined)delete globalThis.Element;else globalThis.Element=previous;}
}

test('chat → Home cancels a pending right-panel gesture; one following right swipe opens only Recents',async()=>fixture(async f=>{
 const {view,root,frame}=f,home=root.querySelector('#home'),draft=home.querySelector('[contenteditable]');
 const rightEdge=root.querySelector('[data-minke-mobile-right-drawer-edge]');
 pointer(view,rightEdge,'pointerdown',386);pointer(view,rightEdge,'pointermove',180);
 assert.equal(frame.hasAttribute('data-minke-mobile-right-drawer-open'),true);
 returnToMobileHome(f.ctx,root);
 // Release from the old screen must not restore its canvas after Home.
 pointer(view,rightEdge,'pointerup',100);
 await frames(view);
 assert.equal(frame.hasAttribute('data-minke-mobile-right-drawer-open'),false);
 assert.equal(frame.hasAttribute('data-minke-mobile-sidebar-open'),false);
 assert.equal(frame.hasAttribute('data-sidebar-collapsed'),true);
 assert.equal(frame.querySelector('[data-minke-mobile-right-drawer-inert]'),null);
 assert.equal(f.clears,1);assert.equal(f.starts,1);
 swipe(view,root.querySelector('[data-minke-mobile-sidebar-edge]'),4,180,2);await frames(view);
 assert.equal(frame.hasAttribute('data-minke-mobile-sidebar-open'),true);
 assert.equal(frame.hasAttribute('data-minke-mobile-right-drawer-open'),false);
 assert.equal(root.querySelectorAll('[data-hub-home]').length,1);assert.equal(root.querySelector('#home'),home);
 assert.equal(draft.textContent,'Keep my draft');
 // A second rightward gesture cannot traverse a second Home or open Settings.
 swipe(view,root.querySelector('aside'),100,230,3);await frames(view);
 assert.equal(frame.hasAttribute('data-minke-mobile-right-drawer-open'),false);
 assert.equal(root.querySelector('[data-slot="sidebar.settings"] button').getAttribute('aria-expanded'),'false');
 swipe(view,rightEdge,386,120,4);await frames(view);
 assert.equal(frame.hasAttribute('data-minke-mobile-sidebar-open'),true);
 assert.equal(frame.hasAttribute('data-minke-mobile-right-drawer-open'),false,'opposite edge cannot create a second canvas over Recents');
}));

test('Home cancels a closing-sidebar timer instead of toggling the drawer back open later',async()=>fixture(async f=>{
 const {view,root,frame}=f;
 swipe(view,root.querySelector('[data-minke-mobile-sidebar-edge]'),4,200);await frames(view);
 assert.equal(frame.hasAttribute('data-minke-mobile-sidebar-open'),true);
 swipe(view,root.querySelector('aside'),220,10,2);
 returnToMobileHome(f.ctx,root);await frames(view);await new Promise(resolve=>view.setTimeout(resolve,20));
 assert.equal(frame.hasAttribute('data-sidebar-collapsed'),true);
 assert.equal(frame.hasAttribute('data-minke-mobile-sidebar-open'),false);
 assert.equal(frame.hasAttribute('data-minke-mobile-sidebar-settling'),false);
 assert.equal(root.querySelector('#content').hasAttribute('inert'),false);
}));

test('Settings/widget back gestures never open or drag a drawer behind their modal',async()=>fixture(async f=>{
 const {view,root,frame}=f;
 const modal=root.createElement('section');modal.setAttribute('role','dialog');
 const header=root.createElement('header');header.setAttribute('data-hub-widget-back-header','');modal.append(header);root.querySelector('#content').append(modal);
 swipe(view,header,4,180);await frames(view);
 assert.equal(f.toggles,0);assert.equal(frame.hasAttribute('data-minke-mobile-sidebar-open'),false);
 swipe(view,header,386,120,2);await frames(view);
 assert.equal(frame.hasAttribute('data-minke-mobile-right-drawer-open'),false);
 assert.equal(frame.hasAttribute('data-minke-mobile-right-drawer-dragging'),false);
 assert.equal(root.querySelector('#content').hasAttribute('inert'),false);
}));

test('a cancelled panel gesture cannot deliver its delayed Settings click after Home',async()=>fixture(async f=>{
 const {view,root,frame}=f;
 const source=root.querySelector('[data-slot="sidebar.settings"] button');let settings=0;
 source.addEventListener('click',()=>settings++);
 swipe(view,root.querySelector('[data-minke-mobile-right-drawer-edge]'),386,100);await frames(view);
 const button=root.querySelector('[data-minke-mobile-right-drawer-settings]');
 pointer(view,button,'pointerdown',100,2);pointer(view,button,'pointermove',280,2);
 returnToMobileHome(f.ctx,root);pointer(view,button,'pointerup',280,2);
 button.dispatchEvent(new view.MouseEvent('click',{bubbles:true,cancelable:true,detail:1}));await frames(view);
 assert.equal(settings,0);assert.equal(frame.hasAttribute('data-minke-mobile-right-drawer-open'),false);
 assert.equal(frame.hasAttribute('data-minke-mobile-settings-open'),false);
}));
