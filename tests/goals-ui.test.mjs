import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import {installMobileGoals} from '../packages/harness-overlay/src/client/host/mobile-goals.ts';
import {installHubDeepLink} from '../packages/harness-overlay/src/client/host/hub-deep-link.ts';
const flush=()=>new Promise(r=>setTimeout(r,15));
function fixture(){const d=new JSDOM('<main data-home></main><aside></aside>',{url:'https://hub.test',pretendToBeVisual:true});d.window.ResizeObserver=class{observe(){}disconnect(){}};d.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};d.window.HTMLDialogElement.prototype.close=function(){this.open=false;};return d;}
const button=(root,text)=>[...root.querySelectorAll('button')].find(b=>b.textContent===text);

test('the general Goal editor preserves the research preset when saving settings',async()=>{
 const {defaultGoal}=await import('../packages/harness-overlay/src/goal-contract.ts');
 const d=fixture(),root=d.window.document,commands=[],research={version:1,requestId:'fixture-research-ui-0001',requesterId:'main',allowedTools:['minke_web_search','web_fetch'],depth:'quick',sources:'web',freshness:'current',asOf:'2026-10-23T00:00:00Z'};
 const g={...structuredClone(defaultGoal),title:'Research fixture',objective:'Read a public fixture',criteria:['Retain observed evidence'],characterId:'main',research,id:'research-job',revision:1,state:'paused',status:'paused',plan:[],planRevision:0,criteriaEvidence:[],rounds:[],cycles:[],evidence:[],approvals:[],history:[],activeMs:0};let state={revision:1,goals:[g],characters:[{id:'main',name:'HUB',route:{provider:'fixture',model:'mock'}}],tools:['minke_web_search','web_fetch']};
 d.window.fetch=async(_url,options)=>{if(options.body){const c=JSON.parse(options.body);commands.push(c);state={...state,changedId:g.id,goals:[{...g,...c.goal,revision:2}]};}return {ok:true,json:async()=>state};};const dispose=installMobileGoals(root.querySelector('aside'),root);
 try{root.querySelector('[data-hub-goals-tile]').click();await flush();button(root,'Open goal').click();const name=root.querySelector('[aria-label="Goal name"]');name.value='Renamed research fixture';name.dispatchEvent(new d.window.Event('input'));root.querySelector('form').dispatchEvent(new d.window.Event('submit',{cancelable:true,bubbles:true}));await flush();assert.equal(commands.length,1);assert.deepEqual(commands[0].goal.research,research);assert.equal(commands[0].goal.title,'Renamed research fixture');}finally{dispose();d.window.close();}
});
test('Goals lives in the right panel, all six tabs preserve edits, and saving a recurring draft does not Start',async()=>{const d=fixture(),root=d.window.document,commands=[];let state={revision:0,goals:[],hostRunsOnlyWhileOnline:true,maxBackgroundWorkers:1,characters:[{id:'main',name:'HUB',route:{provider:'openai-codex',model:'gpt-6-astra',reasoningEffort:'high'}}],tools:['web_search']};d.window.fetch=async(url,options)=>{assert.equal(url,'/api/hub/goals');assert.equal(options.headers['x-hub-goals'],'1');if(options.body){const c=JSON.parse(options.body);commands.push(c);state={...state,revision:state.revision+1,changedId:'created',goals:[{...c.goal,id:'created',revision:1,state:'draft',status:'draft',plan:[],rounds:[],cycles:[],evidence:[],approvals:[],history:[],activeMs:0}]};}return {ok:true,json:async()=>state};};const dispose=installMobileGoals(root.querySelector('aside'),root);try{root.querySelector('[data-hub-goals-tile]').click();await flush();button(root,'New goal').click();const field=label=>root.querySelector('[aria-label="'+label+'"]');field('Goal name').value='Weekly fixture';field('Desired outcome').value='Make a checked brief';field('What counts as done').value='Output saved\nSources checked';field('Desired outcome').dispatchEvent(new d.window.Event('input'));assert.equal(root.querySelectorAll('[role=tab]').length,6);button(root,'Limits & schedule').click();field('Start / recurrence trigger').value='calendar';field('Start / recurrence trigger').dispatchEvent(new d.window.Event('change'));field('Scheduled weekdays').value='1,3,5';field('Schedule timezone').value='Europe/Istanbul';field('Scheduled time').value='09:30';field('On recurring starts').value='fresh';button(root,'Overview').click();assert.equal(field('Desired outcome').value,'Make a checked brief');const dialog=root.querySelector('[data-hub-goals]');dialog.scrollTop=400;button(root,'Back').click();assert.match(dialog.textContent,/unsaved/);root.querySelector('form').dispatchEvent(new d.window.Event('submit',{cancelable:true,bubbles:true}));await flush();assert.equal(commands.length,1);assert.equal(commands[0].action,'save');assert.equal(commands[0].goal.schedule.repeat,'fresh');assert.deepEqual(commands[0].goal.schedule.trigger,{kind:'calendar',hour:9,minute:30,days:[1,3,5],timezone:'Europe/Istanbul'});assert.deepEqual(commands[0].goal.criteria,['Output saved','Sources checked']);assert.equal(commands[0].goal.notification,'pwa');assert.equal(root.querySelector('[data-home]').children.length,0);assert.equal(dialog.scrollTop,0);assert.ok(button(root,'Start'));dialog.scrollTop=400;button(root,'Back').click();assert.equal(dialog.scrollTop,0);assert.ok(button(root,'New goal'));}finally{dispose();d.window.close();}});
test('failed saves retain the user input, and closing a dirty editor is prevented',async()=>{const d=fixture(),root=d.window.document;d.window.fetch=async(_url,options)=>({ok:!options.body,json:async()=>options.body?{detail:'Revision conflict'}:{revision:0,goals:[],characters:[{id:'m',name:'HUB',route:{provider:'mock',model:'mock'}}],tools:[]}});const dispose=installMobileGoals(root.querySelector('aside'),root);try{root.querySelector('[data-hub-goals-tile]').click();await flush();button(root,'New goal').click();const objective=root.querySelector('[aria-label="Desired outcome"]');objective.value='Keep this draft';objective.dispatchEvent(new d.window.Event('input'));root.querySelector('form').dispatchEvent(new d.window.Event('submit',{cancelable:true,bubbles:true}));await flush();assert.equal(objective.value,'Keep this draft');assert.match(root.querySelector('[role=status]').textContent,/Revision conflict/);const event=new d.window.Event('cancel',{cancelable:true});root.querySelector('dialog').dispatchEvent(event);assert.equal(event.defaultPrevented,true);}finally{dispose();d.window.close();}});
test('a goal work link resolves only through the authenticated native session catalog',()=>{const id='hub-goal-00000000-0000-4000-8000-000000000001-00000000-0000-4000-8000-000000000002',d=new JSDOM('<body></body>',{url:'https://hub.test/?hubSession='+id});let refresh=0;const opened=[],sessions={refresh:()=>refresh++,list:{getSnapshot:()=>({byId:{[id]:{}}}),subscribe:()=>()=>{}},open:id=>opened.push(id)};const off=installHubDeepLink({sessions},d.window.document);assert.equal(refresh,1);assert.deepEqual(opened,[id]);off();d.window.close();});


test('paused goals stay discoverable by default and do not advertise a scheduled next run',async()=>{
 const {defaultGoal}=await import('../packages/harness-overlay/src/goal-contract.ts');
 const d=fixture(),root=d.window.document;
 const paused={...structuredClone(defaultGoal),id:'paused-fixture',revision:1,title:'Paused fixture',criteria:[],characterId:'main',state:'paused',status:'paused',nextAt:Date.now()+60000,plan:[],planRevision:0,rounds:[],cycles:[],evidence:[],approvals:[],history:[],criteriaEvidence:[],activeMs:0};
 const scheduled={...paused,id:'scheduled-fixture',title:'Scheduled fixture',state:'active',status:'scheduled'};
 const archived={...paused,id:'archived-fixture',title:'Archived fixture',state:'archived',status:'archived'};
 d.window.fetch=async()=>({ok:true,json:async()=>({revision:1,goals:[paused,scheduled,archived],characters:[{id:'main',name:'HUB',route:{provider:'mock',model:'mock'}}],tools:[]})});
 const dispose=installMobileGoals(root.querySelector('aside'),root);
 try{
  root.querySelector('[data-hub-goals-tile]').click();await flush();
  assert.equal(button(root,'All (2)').getAttribute('aria-pressed'),'true');
  assert.ok(button(root,'Waiting / paused (1)'));
  const cards=[...root.querySelectorAll('article')],card=cards.find(c=>c.textContent.includes('Paused fixture'));
  assert.ok(card);assert.doesNotMatch(card.textContent,/Next work/);
  assert.ok(cards.find(c=>c.textContent.includes('Scheduled fixture')).textContent.includes('Next work'));
  assert.ok(!cards.some(c=>c.textContent.includes('Archived fixture')));
  card.querySelector('button').click();assert.doesNotMatch(root.querySelector('.goal-summary').textContent,/Next work/);
  button(root,'Back').click();assert.ok([...root.querySelectorAll('article')].some(c=>c.textContent.includes('Paused fixture')));
 }finally{dispose();d.window.close();}
});

test('polling preserves expanded goal evidence, scroll and keyboard focus as new receipts arrive',async()=>{
 const {defaultGoal}=await import('../packages/harness-overlay/src/goal-contract.ts');
 const d=fixture(),root=d.window.document;let poll;
 d.window.setInterval=callback=>{poll=callback;return 1;};d.window.clearInterval=()=>{};
 const receipt={id:'file:one',kind:'file',label:'Checked output',detail:'Verified fixture',path:'C:/fixture/check.md',sha256:'a'.repeat(64),at:1};
 let goal={...structuredClone(defaultGoal),id:'poll-fixture',revision:1,title:'Poll fixture',criteria:[],characterId:'main',state:'paused',status:'paused',plan:[],planRevision:0,rounds:[],cycles:[],evidence:[receipt],approvals:[],history:[],criteriaEvidence:[],activeMs:0};
 d.window.fetch=async(_url,options)=>{assert.equal(options.method,'GET');return {ok:true,json:async()=>({revision:goal.revision,goals:[structuredClone(goal)],characters:[{id:'main',name:'HUB',route:{provider:'mock',model:'mock'}}],tools:[]})};};
 const dispose=installMobileGoals(root.querySelector('aside'),root);
 try{
  root.querySelector('[data-hub-goals-tile]').click();await flush();button(root,'Open goal').click();button(root,'Activity & results').click();
  const dialog=root.querySelector('dialog'),initial=root.querySelector('[data-goal-details=evidence]');initial.open=true;initial.querySelector('summary').focus();dialog.scrollTop=240;
  poll();await flush();assert.equal(root.querySelector('[data-goal-details=evidence]'),initial);assert.equal(root.activeElement,initial.querySelector('summary'));assert.equal(dialog.scrollTop,240);
  goal={...goal,revision:2,evidence:[receipt,{...receipt,id:'file:two',label:'New checked output'}]};poll();await flush();
  const updated=root.querySelector('[data-goal-details=evidence]');assert.notEqual(updated,initial);assert.equal(updated.open,true);assert.match(updated.querySelector('summary').textContent,/\(2\)/);assert.equal(root.activeElement,updated.querySelector('summary'));assert.equal(dialog.scrollTop,240);
  const download=[...updated.querySelectorAll('button')].find(node=>node.dataset.goalFocus==='download:file:one');download.focus();
  goal={...goal,revision:3,history:[{at:2,kind:'checkpoint',message:'New observed checkpoint'}]};poll();await flush();assert.equal(root.activeElement.dataset.goalFocus,'download:file:one');assert.equal(root.querySelector('[data-goal-details=evidence]').open,true);
 }finally{dispose();d.window.close();}
});

test('keyboard focus reveals goal controls covered by the sticky actions without moving visible controls',async()=>{
 const {defaultGoal}=await import('../packages/harness-overlay/src/goal-contract.ts');
 const d=fixture(),root=d.window.document,frames=[];
 d.window.requestAnimationFrame=callback=>{frames.push(callback);return frames.length;};
 const goal={...structuredClone(defaultGoal),id:'focus-fixture',revision:1,title:'Focus fixture',criteria:[],characterId:'main',state:'paused',status:'paused',plan:[],rounds:[],cycles:[],evidence:[{id:'file:one',kind:'file',label:'Output',path:'C:/fixture/check.md',at:1}],approvals:[],history:[],criteriaEvidence:[],activeMs:0};
 d.window.fetch=async()=>({ok:true,json:async()=>({revision:1,goals:[goal],characters:[{id:'main',name:'HUB',route:{provider:'mock',model:'mock'}}],tools:[]})});
 const dispose=installMobileGoals(root.querySelector('aside'),root);
 try{
  root.querySelector('[data-hub-goals-tile]').click();await flush();button(root,'Open goal').click();button(root,'Activity & results').click();
  const dialog=root.querySelector('dialog'),actions=root.querySelector('.goal-actions'),download=button(root,'Download checked output');root.querySelector('[data-goal-details=evidence]').open=true;
  dialog.getBoundingClientRect=()=>({top:8,bottom:836,height:828});
  dialog.querySelector('header').getBoundingClientRect=()=>({top:8,bottom:75,height:67});
  actions.getBoundingClientRect=()=>({top:712,bottom:835,height:123});
  dialog.scrollTop=492;download.getBoundingClientRect=()=>({top:784+(492-dialog.scrollTop),bottom:828+(492-dialog.scrollTop),height:44});
  download.focus();for(const callback of frames.splice(0))callback(0);
  assert.equal(root.activeElement,download);assert.ok(download.getBoundingClientRect().bottom<=704,'Focused download must clear the action bar with an8px gap');
  const visible=root.querySelector('[data-goal-details=evidence] summary');visible.getBoundingClientRect=()=>({top:200,bottom:242,height:42});
  const scroll=dialog.scrollTop;visible.focus();for(const callback of frames.splice(0))callback(0);assert.equal(dialog.scrollTop,scroll,'Already visible focus must not move reading position');
  button(root,'Save changes').focus();for(const callback of frames.splice(0))callback(0);assert.equal(dialog.scrollTop,scroll,'Sticky actions must not scroll their own form');
  visible.getBoundingClientRect=()=>({top:40,bottom:82,height:42});visible.focus();for(const callback of frames.splice(0))callback(0);
  assert.equal(dialog.scrollTop,scroll-43,'Focus hidden behind the sticky header must move below it');
 }finally{dispose();d.window.close();}
});
