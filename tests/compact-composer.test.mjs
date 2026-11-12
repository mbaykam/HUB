import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import {compactComposer} from '../packages/harness-overlay/src/client/host/compact-composer.ts';
test('compact layout retains draft, file and send handlers across repeated reconciliation',()=>{
 const {document}=new JSDOM('<div data-composer-card><div data-input-scroll><div contenteditable="true" aria-label="Ask anything…">Keep my draft</div><div data-composer-placeholder>Ask anything… / commands</div></div><div><div><span><button aria-label="More actions">+</button></span><span><button aria-label="Attach photos or files"></button></span></div><div><button aria-label="Send"></button></div></div></div>').window;
 const card=document.querySelector('[data-composer-card]'),send=card.querySelector('[aria-label="Send"]'),file=card.querySelector('[aria-label="Attach photos or files"]');let sends=0,files=0;send.onclick=()=>sends++;file.onclick=()=>files++;
 compactComposer(card);compactComposer(card);send.click();file.click();
 assert.equal(card.querySelector('[contenteditable]').textContent,'Keep my draft');assert.equal(card.querySelector('[data-composer-placeholder]').textContent,'Chat…');assert.equal(card.querySelectorAll('[data-hub-composer-send]').length,1);assert.ok(card.querySelector('[data-hub-composer-send]')===send,'existing Send owns primary seat');assert.equal(sends,1);assert.equal(files,1);
});

// Render the upstream component itself: this catches slot wrappers that a
// hand-written DOM approximation omits. The browser fixture uses the same entry.
test('actual upstream InputBar wrappers keep menu, primary and independent Stop in their correct seats',async()=>{
 const {build}=await import('esbuild');
 const {readFileSync}=await import('node:fs');
 const {resolve}=await import('node:path');
 const built=await build({entryPoints:['tests/fixtures/real-composer.jsx'],bundle:true,write:false,outdir:'.tmp/composer-unit',loader:{'.module.css':'local-css','.css':'css','.ttf':'dataurl','.woff':'dataurl','.woff2':'dataurl'},plugins:[{name:'overlay-style-text',setup(b){b.onLoad({filter:/harness-overlay.*\.css$/},a=>({contents:readFileSync(a.path,'utf8'),loader:'text'}));}}],alias:{react:'./node_modules/react','react-dom':'./node_modules/react-dom'},jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},logLevel:'silent'});
 const script=built.outputFiles.find(file=>file.path.endsWith('.js')).text;
 for(const search of ['', '?child', '?before', '?pending']){
  const dom=new JSDOM('<!doctype html><html data-minke-mobile-web><div id="root"></div></html>',{url:'http://localhost/'+search,pretendToBeVisual:true,runScripts:'outside-only'});
  try{
   dom.window.eval(script);
   const ready=Date.now()+5000;
   while(!dom.window.fixtureReady&&Date.now()<ready)await new Promise(r=>setTimeout(r,20));
   assert.equal(dom.window.fixtureReady,true,'actual React component mounted');
   const d=dom.window.document,card=d.querySelector('[data-composer-card]'),more=card.querySelector('[aria-label="More actions"]'),send=card.querySelector('[aria-label="Send"]');
   if(search==='?before'){
    assert.equal(card.querySelector('[data-hub-composer-send]').getAttribute('aria-label'),'Attach photos or files','old parent counting reproduces the production bug');
    compactComposer(card);
   }
   assert.ok(card.querySelector('[data-hub-composer-menu]')===more,'existing menu owns compact action seat');
   assert.ok(card.querySelector('[data-hub-composer-send]')===send,'existing Send owns primary seat');
   assert.equal(send.disabled,true,'empty draft retains native disabled gate');
   assert.equal(card.querySelector('[data-hub-composer-row]').parentElement,card);
   assert.equal(card.querySelector('[data-hub-composer-tools]').className,'InputBar_tools');
   if(search!=='?pending')assert.equal(card.querySelector('[data-slot="conversation.input.left"]').hasAttribute('data-hub-composer-tools'),false);
   if(search==='?child')assert.equal(card.querySelector('[data-hub-composer-stop]').getAttribute('aria-label'),'Stop');
   more.click();
   if(search==='?pending'){
    assert.deepEqual([...d.querySelectorAll('[role="dialog"] button')].map(b=>b.textContent),['Choose workspace…']);
    d.querySelector('[role="dialog"] button').click();
    assert.equal(dom.window.fixtureWorkspaceRequests,1,'recovery forwards to the existing workspace picker');
    assert.equal(send.disabled,true,'opening recovery never unlocks Send');
    assert.equal(card.querySelector('[data-composer-placeholder]').textContent,'Chat…');
    dom.window.fixtureAttachSession();
    const until=Date.now()+3000;
    while(card.querySelector('[data-hub-workspace-menu]')&&Date.now()<until)await new Promise(r=>setTimeout(r,20));
    assert.equal(card.querySelector('[data-hub-workspace-menu]'),null,'real session actions replace recovery');
    assert.equal(card.querySelectorAll('[aria-label="More actions"]').length,1,'only one menu survives connection');
    continue;
   }
   assert.deepEqual([...d.querySelectorAll('[role="dialog"] button')].map(b=>b.textContent),['Photos or files','Choose character','Research…','Research tasks','Chat options','Close']);
   d.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
   assert.equal(d.querySelector('[role="dialog"]'),null);assert.equal(d.activeElement,more);
   more.click();assert.ok(d.querySelector('[role="dialog"]'),'menu reopens');
  }finally{dom.window.fixtureDispose?.();dom.window.close();}
 }
});
