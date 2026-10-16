import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import {installMobileWork} from '../packages/harness-overlay/src/client/host/mobile-work.ts';
import {defaultGoal} from '../packages/harness-overlay/src/goal-contract.ts';
import {defaultAutomation} from '../packages/harness-overlay/src/automation-contract.ts';
const flush=()=>new Promise(r=>setTimeout(r,25));
const button=(root,text)=>[...root.querySelectorAll('button')].find(b=>b.textContent===text);
test('one Tasks window lists both kinds, fences dirty navigation, preserves schedules and opens after closing',async()=>{
 const dom=new JSDOM('<aside></aside>',{url:'https://hub.test',pretendToBeVisual:true}),view=dom.window,root=view.document;view.ResizeObserver=class{observe(){}disconnect(){}};
 view.HTMLDialogElement.prototype.show=view.HTMLDialogElement.prototype.showModal=function(){this.open=true};view.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new view.Event('close'));};
 const character={id:'main',name:'HUB',route:{provider:'mock',model:'mock'}},goal={...structuredClone(defaultGoal),id:'goal1',revision:3,title:'Long-term fixture',characterId:'main',state:'paused',status:'paused',plan:[],rounds:[],cycles:[],evidence:[],approvals:[],history:[],activeMs:0,updatedAt:2},routine={...structuredClone(defaultAutomation),id:'routine1',title:'Daily fixture',characterId:'main',state:'active',status:'scheduled',nextAt:Date.now()+10000,updatedAt:1,runs:[]};
 const commands=[];view.fetch=async(url,init)=>{const kind=url.endsWith('/goals')?'goals':'automations';if(init.body)commands.push({kind,...JSON.parse(init.body)});return Response.json(kind==='goals'?{revision:4,goals:[goal],characters:[character],tools:[]}:{revision:5,automations:[routine],characters:[character],goals:[]});};
 const dispose=installMobileWork(root.querySelector('aside'),root);
 try{root.querySelector('[data-hub-work-tile]').click();await flush();const dialog=root.querySelector('[data-hub-work]');assert.equal(dialog.open,true);assert.match(dialog.textContent,/Long-term fixture/);assert.match(dialog.textContent,/Daily fixture/);assert.equal(root.querySelector('aside').children.length,1,'right panel has one work entry');
 const cards=dialog.querySelectorAll('[data-work-id]');button(cards[1],'Pause').click();await flush();assert.equal(commands[0].kind,'automations');assert.equal(commands[0].revision,5);
 const summary=[...dialog.querySelectorAll('summary')].find(n=>n.textContent==='New task');summary.click();button(dialog,'Work toward a goal').click();await flush();const input=dialog.querySelector('[aria-label="Desired outcome"]');input.value='Keep my draft';input.dispatchEvent(new view.Event('input',{bubbles:true}));button(dialog,'‹ Tasks').click();await flush();assert.equal(input.isConnected,true);assert.match(dialog.textContent,/Save or discard/);button(dialog,'Discard changes').click();await flush();button(dialog,'‹ Tasks').click();await flush();assert.equal(dialog.querySelector('[data-work-editor][open]'),null);
 button(dialog,'Done').click();assert.equal(dialog.open,false);root.querySelector('[data-hub-work-tile]').click();await flush();assert.equal(dialog.open,true);assert.equal(dialog.querySelector('[data-work-editor][open]'),null);assert.match(dialog.querySelector(':scope>section').textContent,/Daily fixture/);
 }finally{dispose();view.close();}
});
