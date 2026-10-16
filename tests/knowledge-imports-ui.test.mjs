import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import {createKnowledgeImportsPanel} from '../packages/harness-overlay/src/client/memory/knowledge-imports-panel.ts';
const button=(root,name)=>[...root.querySelectorAll('button')].find(b=>b.textContent===name);
const record=(id,status='new')=>({id,title:'Original '+id,channel:'chatgpt',createdAt:1700000000000,messages:2,status,estimatedCalls:2,inputBytes:80});
const preview=(extra={})=>({id:'batch',filename:'history.json',state:'previewed',conversations:2,messages:4,admitted:0,previewHash:'version',records:[record('one'),record('two')],nextOffset:null,warnings:[],prices:{inputPrice:.1,outputPrice:.35},...extra});
function fixture(t,request){const dom=new JSDOM('<main></main>');t.after(()=>dom.window.close());const root=dom.window.document,panel=createKnowledgeImportsPanel(root,request);root.body.append(panel.pane);t.after(()=>panel.dispose());return {root,panel};}
const list={batches:[{id:'batch',filename:'history.json',state:'previewed',conversations:2,at:1}],total:1,nextOffset:null};

test('original selection requires a concrete review, survives message inspection and never admits the whole archive',async t=>{
 const commands=[];let admitted=false;const {root,panel}=fixture(t,async(query,command)=>{if(command){commands.push(command);admitted=true;return {admitted:1,duplicates:0,queued:2};}if(query.startsWith('view=import-batches'))return list;if(query.startsWith('view=import-record'))return {messages:[{role:'user',text:'<img src=x> Exact original.',at:1}],total:1,nextOffset:null};return preview(admitted?{admitted:1,previewHash:'new',records:[record('one'),record('two','admitted')]}:{});});
 await panel.show();button(root,'Inspect archive').click();await setImmediate();const selected=root.querySelectorAll('input[type=checkbox]')[1];selected.checked=true;selected.dispatchEvent(new root.defaultView.Event('change'));assert.equal(panel.canLeave(),false);assert.match(panel.pane.textContent,/planning estimate/);
 button(root,'Preview original messages').click();await setImmediate();assert.match(panel.pane.textContent,/<img src=x> Exact original/);assert.equal(root.querySelector('img'),null);assert.equal(selected.checked,true);assert.equal(commands.length,0);
 button(root,'Review selected admission').click();assert.equal(commands.length,0);button(root,'Admit 1 conversation').click();await setImmediate();await setImmediate();assert.deepEqual(commands,[{action:'start-import',id:'batch',recordIds:['two'],previewHash:'version'}]);assert.equal(panel.canLeave(),true);assert.match(panel.pane.textContent,/1 conversation admitted/);
});

test('failed admission keeps selection and recovers controls; full-batch withdrawal is an explicit separate review',async t=>{
 const commands=[];let fail=true;const {root,panel}=fixture(t,async(query,command)=>{if(command){commands.push(command);if(fail)throw Error('Original changed; refresh before admission');return {withdrawn:1,domainReviewRequired:['human-domain-edit']};}return query.startsWith('view=import-batches')?list:preview({admitted:1,records:[record('one'),record('two','admitted')]});});
 await panel.show();button(root,'Inspect archive').click();await setImmediate();const check=root.querySelector('input[type=checkbox]');check.checked=true;check.dispatchEvent(new root.defaultView.Event('change'));button(root,'Review selected admission').click();button(root,'Admit 1 conversation').click();await setImmediate();assert.equal(check.checked,true);assert.equal(button(root,'Admit 1 conversation').disabled,false);assert.match(panel.pane.textContent,/Original changed/);
 button(root,'Clear selection').click();button(root,'Review batch withdrawal').click();assert.equal(commands.length,1);fail=false;button(root,'Withdraw admitted batch').click();await setImmediate();await setImmediate();assert.equal(commands[1].action,'withdraw-import');assert.match(panel.pane.textContent,/later domain changes need manual review/);
});

test('archive paging preserves a selected pilot and refuses to reuse selection after an admission version changes',async t=>{
 let changed=false;const {root,panel}=fixture(t,async query=>query.startsWith('view=import-batches')?list:query.endsWith('50')?preview({conversations:51,offset:50,records:[record('last')],previewHash:changed?'changed':'version'}):preview({conversations:51,nextOffset:50}));await panel.show();button(root,'Inspect archive').click();await setImmediate();const check=root.querySelector('input[type=checkbox]');check.checked=true;check.dispatchEvent(new root.defaultView.Event('change'));button(root,'Next 50 conversations').click();await setImmediate();assert.match(panel.pane.textContent,/1 selected/);assert.equal(panel.canLeave(),false);assert.ok(button(root,'Previous page'));
 button(root,'Previous page').click();await setImmediate();assert.equal(root.querySelector('input[type=checkbox]').checked,true);changed=true;button(root,'Next 50 conversations').click();await setImmediate();assert.match(panel.pane.textContent,/Select up to 50/);assert.equal(panel.canLeave(),true);
});
