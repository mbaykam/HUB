import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import {toolCatalog} from '../packages/harness-overlay/src/host/tool-catalog.ts';
import {installToolBrowser} from '../packages/harness-overlay/src/client/preferences/ToolsSettings.tsx';
import {KnowledgeStore} from '../packages/harness-overlay/src/host/knowledge-store.ts';
import {KnowledgeSkills} from '../packages/harness-overlay/src/host/knowledge-skills.ts';
import {createKnowledgeSkillsPanel} from '../packages/harness-overlay/src/client/memory/knowledge-skills-panel.ts';
import {installPanelDisclosure} from '../packages/harness-overlay/src/client/host/panel-disclosure.ts';
const settle=async()=>{for(let i=0;i<5;i++)await setImmediate();};
const waitFor=async(predicate)=>{const deadline=Date.now()+5000;while(!predicate()){assert.ok(Date.now()<deadline,'File-backed UI action did not finish');await new Promise(resolve=>setTimeout(resolve,10));}};
const click=(root,text)=>[...root.querySelectorAll('button')].find(b=>b.textContent===text).click();

async function catalogFixture(){
  const characters=[{id:'hub',name:'HUB',route:{model:'fixture'},tools:{mode:'inherit'}},{id:'mira',name:'Mira',route:{model:'fixture'},tools:{mode:'allow',names:['web_fetch','missing_plugin']}}];
  const manager={ready:Promise.resolve(),store:{snapshot:()=>({revision:2,characters})},effectiveCharacter:id=>characters.find(c=>c.id===id)};
  const shared={name:'web_fetch',description:'Read a public page.',parameters:{type:'object'}};
  const agents=characters.map(c=>({id:c.id,session:{header:{id:c.id}}}));
  const ctx={hubCharacters:manager,agentPresets:{standingKeyFor:async()=> 'standing'},agents:{list:()=>agents},tools:{schemas:scope=>scope==='standing'?[shared]:scope.id==='hub'?[shared,{name:'hub_knowledge_read',description:'Read a saved source.',parameters:{type:'object'}}]:[shared]}};
  return toolCatalog(ctx,manager);
}

test('inventory reflects registered scopes, character policy and absent permission names without executing tools',async()=>{
  const data=await catalogFixture(),read=data.tools.find(t=>t.name==='hub_knowledge_read'),missing=data.tools.find(t=>t.name==='missing_plugin');
  assert.deepEqual(read.characterContexts,['hub']);assert.equal(read.hostRegistered,false);assert.equal(read.contexts,1);assert.equal(missing.contexts,0);assert.equal(missing.hostRegistered,false);assert.equal(data.characters[1].policy.mode,'allow');assert.match(data.meaning,/checked again at execution/);
});

test('Tools settings filters actual access and never sends a mutation',async t=>{
  const dom=new JSDOM('<main/>',{url:'https://hub.test',pretendToBeVisual:true}),root=dom.window.document,catalog=await catalogFixture(),requests=[];
  dom.window.fetch=async(url,options)=>{requests.push({url,options});return{ok:true,json:async()=>catalog};};const dispose=installToolBrowser(root.querySelector('main'),root);t.after(()=>{dispose();dom.window.close();});await settle();
  const character=root.querySelector('[aria-label="Character tool access"]'),filter=root.querySelector('[aria-label="Tool access filter"]');character.value='mira';character.dispatchEvent(new dom.window.Event('change'));filter.value='denied';filter.dispatchEvent(new dom.window.Event('change'));
  assert.match(root.querySelector('.hub-tool-list').textContent,/hub_knowledge_read.*Disabled/s);assert.doesNotMatch(root.querySelector('.hub-tool-list').textContent,/Read a public page/);
  filter.value='unavailable';filter.dispatchEvent(new dom.window.Event('change'));assert.match(root.querySelector('.hub-tool-list').textContent,/missing_plugin.*Not registered/s);
  click(root,'Refresh');await settle();assert.ok(requests.every(r=>!r.options.method||r.options.method==='GET'));assert.equal(character.value,'mira');
});

test('Skills editor saves a portable workflow, preserves a stale draft and requires explicit discard',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'hub-skills-ui-')),store=new KnowledgeStore(join(directory,'vault'),join(directory,'state'));await store.initialize();const skills=new KnowledgeSkills(store);
  const dom=new JSDOM('<main/>',{url:'https://hub.test',pretendToBeVisual:true}),root=dom.window.document;let saved=0;
  dom.window.fetch=async(url,options)=>{try{if(options.body){await skills.save(JSON.parse(options.body));return{ok:true,json:async()=>({skills:await skills.list()})};}const name=new URL(url,'https://hub.test').searchParams.get('name');return{ok:true,json:async()=>name?{skill:await skills.read(name)}:{skills:await skills.list()}};}catch(error){return{ok:false,json:async()=>({detail:error.message})};}};
  const panel=createKnowledgeSkillsPanel(root,()=>saved++);root.querySelector('main').append(panel.pane);t.after(async()=>{panel.dispose();dom.window.close();await rm(directory,{recursive:true,force:true});});await panel.show();click(root,'New skill');
  const title=root.querySelector('form>label input'),description=root.querySelectorAll('form>label input')[1],instructions=root.querySelector('textarea');title.value='Check a source';title.dispatchEvent(new dom.window.Event('input'));description.value='Before citing a page';instructions.value='Read the original and verify the date.';
  assert.equal(panel.canLeave(),false);root.querySelector('form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
  await waitFor(()=>saved!==0);assert.equal(saved,1);const original=await skills.read('check-a-source');assert.ok(original);assert.equal(panel.canLeave(),true);
  root.querySelector('.knowledge-skill-list button').click();await waitFor(()=>!root.querySelector('form').hidden);
  await skills.save({...original,content:'Changed outside this editor.',expectedHash:original.hash});instructions.value='Keep my draft.';instructions.dispatchEvent(new dom.window.Event('input',{bubbles:true}));root.querySelector('form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await settle();
  await waitFor(()=>!root.querySelector('button[type=submit]').disabled);
  assert.match(root.querySelector('[role=status]').textContent,/changed/);assert.equal(instructions.value,'Keep my draft.');assert.equal(panel.canLeave(),false);click(root,'Discard changes');assert.equal(panel.canLeave(),true);assert.equal((await skills.read('check-a-source')).content,'Changed outside this editor.\n');
});

test('expandable panels expose a collapse action while note folders stay native',async t=>{
  const dom=new JSDOM('<section data-hub-graph-dialog><details open><summary>Graph options</summary><button>Fit</button></details><div data-knowledge-tree><details open><summary>Notes</summary></details></div></section>',{pretendToBeVisual:true}),root=dom.window.document,dispose=installPanelDisclosure(root);t.after(()=>{dispose();dom.window.close();});
  const graph=root.querySelector('details'),close=graph.querySelector('[data-hub-collapse]');assert.ok(close);assert.equal(root.querySelector('[data-knowledge-tree] [data-hub-collapse]'),null);close.click();assert.equal(graph.open,false);assert.equal(root.activeElement,graph.querySelector('summary'));dispose();assert.equal(root.querySelector('[data-hub-collapse]'),null);
});
