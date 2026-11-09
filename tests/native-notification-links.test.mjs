import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import {installHubDeepLink} from '../packages/harness-overlay/src/client/host/hub-deep-link.ts';

test('native alert waits for authenticated catalog refresh and opens exactly once',()=>{
 const id='conversation-123',d=new JSDOM('<body/>',{url:'https://hub.test/?hubSession='+id});
 let byId={},reconcile,refresh=0; const opened=[];
 const sessions={refresh:()=>refresh++,list:{getSnapshot:()=>({byId}),subscribe:fn=>{reconcile=fn;return()=>{}}},open:id=>opened.push(id)};
 const off=installHubDeepLink({sessions},d.window.document);
 assert.equal(refresh,1);assert.deepEqual(opened,[]);
 byId={[id]:{}};reconcile();reconcile();
 assert.deepEqual(opened,[id]);assert.equal(new URL(d.window.location.href).searchParams.has('hubSession'),false);
 off();d.window.close();
});
test('native links cannot create unknown conversations or navigate through commands',()=>{
 for(const id of ['missing-chat','https://evil.test','../secret','voice/start','x'.repeat(201)]){
  const d=new JSDOM('<body/>',{url:'https://hub.test/?hubSession='+encodeURIComponent(id)}),opened=[];
  const sessions={refresh:()=>{},list:{getSnapshot:()=>({byId:{}}),subscribe:()=>()=>{}},open:id=>opened.push(id)};
  const off=installHubDeepLink({sessions},d.window.document);
  assert.deepEqual(opened,[]);off();d.window.close();
 }
});
