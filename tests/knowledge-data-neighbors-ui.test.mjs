import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate,setTimeout} from 'node:timers/promises';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import {createKnowledgeDataPanel} from '../packages/harness-overlay/src/client/memory/knowledge-data-panel.ts';
import {createKnowledgeNeighbors} from '../packages/harness-overlay/src/client/memory/knowledge-neighbors.ts';
const byButton=(root,label)=>[...root.querySelectorAll('button')].find(b=>b.textContent===label);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const item=(id)=>({id,sourceId:'source',targetId:id,predicate:'related to',direction:'directed',origin:'curator',interpretation:true,status:'active',scope:'short',node:{id,title:id},evidence:[{sourceId:'source',contentHash:'hash',quote:'Exact original quote',role:'user',occurredAt:1700000000000}]});
function dom(t){const value=new JSDOM('<main></main>');t.after(()=>value.window.close());return value.window.document;}

test('backup UI blocks leaving during a verified copy and recovers controls after success or failure',async t=>{
 const root=dom(t),copy=deferred(),commands=[];let fail=false;
 const panel=createKnowledgeDataPanel(root,async(query,command)=>{if(command){commands.push(command);if(fail)throw Error('Snapshot changed during export');return copy.promise;}return {items:[],total:0,nextOffset:null,storage:'fixture'};});root.body.append(panel.pane);t.after(()=>panel.dispose());await panel.show();
 byButton(root,'Create verified backup').click();assert.equal(panel.canLeave(),false);assert.ok(byButton(root,'Create verified backup').disabled);
 copy.resolve({records:3,bytes:10,path:'fixture/copy'});await setImmediate();assert.equal(panel.canLeave(),true);assert.match(panel.pane.textContent,/Verified 3 records/);
 fail=true;byButton(root,'Create verified backup').click();await setImmediate();assert.match(panel.pane.textContent,/Snapshot changed/);assert.equal(byButton(root,'Create verified backup').disabled,false);assert.equal(commands.length,2);
});

test('backup paging cannot duplicate a page and restored work requires an explicit resume click',async t=>{
 const root=dom(t),page=deferred(),commands=[],seen=[];let held=true;
 const panel=createKnowledgeDataPanel(root,async(query,command)=>{if(command){commands.push(command);held=false;return {resumed:true};}seen.push(query);if(query.endsWith('30'))return page.promise;return {items:[{id:'one',at:1,records:2,bytes:3,path:'copy/one'}],total:31,nextOffset:30,storage:'fixture',incompleteCopies:1,...(held?{restoreHold:{queued:4,mode:'automatic',provider:'existing',model:'existing-model'}}:{})};});root.body.append(panel.pane);t.after(()=>panel.dispose());await panel.show();assert.match(panel.pane.textContent,/4 saved organization jobs/);assert.match(panel.pane.textContent,/incomplete or unreadable/);assert.equal(commands.length,0);
 const more=byButton(root,'Older backups');more.click();more.click();assert.equal(seen.filter(q=>q.endsWith('30')).length,1);page.resolve({items:[{id:'two',at:2,records:2,bytes:3,path:'copy/two'}],total:31,nextOffset:null,storage:'fixture',restoreHold:{queued:4,mode:'automatic',provider:'existing',model:'existing-model'}});await setImmediate();assert.equal(root.querySelectorAll('.knowledge-domain-card').length,2);assert.equal(byButton(root,'Older backups'),undefined);
 byButton(root,'Resume saved Knowledge work').click();await setImmediate();assert.deepEqual(commands,[{action:'resume-restored-work'}]);assert.equal(byButton(root,'Resume saved Knowledge work'),undefined);
});

test('full neighborhood paging retains sourced interpretations and ignores stale refreshes',async t=>{
 const root=dom(t),page=deferred(),old=deferred(),opened=[],evidence=[],calls=[];let refresh=0;
 const panel=createKnowledgeNeighbors(root,async query=>{calls.push(query);if(query.includes('cursor=next'))return page.promise;if(++refresh===2)return old.promise;return {recordId:'source',total:31,items:[item(refresh===1?'first':'new')],nextCursor:refresh===1?'next':null};},id=>opened.push(id),(...args)=>evidence.push(args));root.body.append(panel.pane);t.after(()=>panel.dispose());await panel.load('source');
 assert.match(panel.pane.textContent,/Knowledge AI interpretation/);byButton(root,'Inspect this source').click();assert.equal(evidence[0][2].quote,'Exact original quote');byButton(root,'first').click();assert.deepEqual(opened,['first']);
 const more=byButton(root,'More connections');more.click();more.click();assert.equal(calls.filter(q=>q.includes('cursor=next')).length,1);page.resolve({recordId:'source',total:31,items:[item('second')],nextCursor:null});await setImmediate();assert.match(panel.pane.textContent,/2 \/ 31/);
 const prior=panel.load('source');await panel.load('source');old.resolve({recordId:'source',total:1,items:[item('stale')],nextCursor:null});await prior;assert.equal(byButton(root,'stale'),undefined);assert.ok(byButton(root,'new'));
});

test('path UI distinguishes a bounded search from an exhaustive absence',async t=>{
 const root=dom(t);let complete=false;
 const panel=createKnowledgeNeighbors(root,async query=>query.startsWith('view=neighbors')?{recordId:'source',total:0,items:[],nextCursor:null}:query.startsWith('view=search')?{nodes:[{id:'target',title:'Target source'}]}:{found:false,complete},()=>{},()=>{});root.body.append(panel.pane);t.after(()=>panel.dispose());await panel.load('source');
 const input=root.querySelector('input');input.value='Target';input.dispatchEvent(new root.defaultView.Event('input'));await setTimeout(280);byButton(root,'Target source').click();await setImmediate();assert.match(panel.pane.textContent,/may exist beyond the search limit/);
 complete=true;byButton(root,'Target source').click();await setImmediate();assert.match(panel.pane.textContent,/No sourced connection chain was found/);assert.doesNotMatch(panel.pane.textContent,/may exist beyond/);
});
