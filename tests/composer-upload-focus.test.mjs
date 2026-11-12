import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {installComposerUploads} from '../packages/harness-overlay/src/client/host/composer-uploads.tsx';

test('attachment submenu takes focus and Escape returns to the visible consolidated menu without changing the draft',async()=>{
 const dom=new JSDOM('<style>[aria-label="Attach photos or files"]{visibility:hidden}</style><div data-composer-card><button aria-label="More actions">+</button><div contenteditable="true">Keep this draft</div><span id="slot"></span></div>',{url:'https://hub.test',pretendToBeVisual:true});
 const root=dom.window.document,previous={window:globalThis.window,document:globalThis.document,IS_REACT_ACT_ENVIRONMENT:globalThis.IS_REACT_ACT_ENVIRONMENT};
 Object.assign(globalThis,{window:dom.window,document:root,IS_REACT_ACT_ENVIRONMENT:true});
 let Control;const snapshot={draft:'Keep this draft',draftRev:2,imageIds:[],occurrences:[]};
 const off=installComposerUploads({slots:{register(_o,c){Control=c;return()=>{};}},sessions:{scope:()=>({})}}, {input:{for:()=>({state:{getSnapshot:()=>snapshot}})}},{registerSource:()=>()=>{}},root);
 const react=createRoot(root.querySelector('#slot'));
 try{
  await act(async()=>react.render(React.createElement(Control,{sessionId:'hub-eval-files',useInput:f=>f({phase:'plain'})})));
  await act(async()=>root.querySelector('[aria-label="Attach photos or files"]').click());
  assert.equal(root.activeElement.textContent,'Photos');assert.ok(root.querySelector('[aria-label="Add attachment"]'));
  await act(async()=>root.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  assert.equal(root.querySelector('[aria-label="Add attachment"]'),null);assert.equal(root.activeElement,root.querySelector('[aria-label="More actions"]'));
  assert.equal(root.querySelector('[contenteditable]').textContent,'Keep this draft');assert.equal(snapshot.draftRev,2);assert.deepEqual(snapshot.imageIds,[]);
 }finally{await act(async()=>react.unmount());off();Object.assign(globalThis,previous);dom.window.close();}
});
