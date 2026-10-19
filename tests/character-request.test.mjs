import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import {installCharacterRequests} from '../packages/harness-overlay/src/host/character-requests.ts';
import {characterRequestPanel} from '../packages/harness-overlay/src/client/host/character-request-panel.ts';
import {setImmediate} from 'node:timers/promises';
import {installKnowledgeToolPolicy} from '../packages/harness-overlay/src/host/knowledge-tool-policy.ts';
import {installCharactersClient} from '../packages/harness-overlay/src/client/host/mobile-characters.ts';
import {knowledgeToolChoices} from '../packages/harness-overlay/src/memory-tool-groups.ts';
import {HubCharacters} from '../packages/harness-overlay/src/characters.ts';

test('character catalog offers the six current Knowledge operations and retires legacy schemas only with second brain active',async()=>{
 let route,brain=true;const instance={ready:Promise.resolve(),store:{snapshot:()=>({revision:1})},speechSettings:{snapshot:()=>({})},host:{get:()=>brain?{}:undefined,connection:{requestRejection:()=>undefined},agentPresets:{standingKeyFor:async()=>({})},tools:{schemas:()=>[{name:'mcp__hub_memory__search',description:'Old store'},{name:'web_fetch',description:'Read a site'}]},webServer:{register:r=>{route=r;return()=>{};}}}};
 HubCharacters.prototype.installWeb.call(instance);const read=()=>new Promise(resolve=>route.handler({method:'GET',url:'/api/hub/characters',headers:{'x-hub-characters':'1'}},{writeHead:code=>assert.equal(code,200),end:body=>resolve(JSON.parse(body))}));
 const current=await read();assert.ok(current.tools.every(t=>!t.name.startsWith('mcp__hub_memory__')));for(const tool of knowledgeToolChoices)assert.equal(current.tools.filter(t=>t.name===tool.name).length,1);assert.ok(current.tools.some(t=>t.name==='web_fetch'));
 brain=false;const legacy=await read();assert.ok(legacy.tools.some(t=>t.name==='mcp__hub_memory__search'));assert.ok(!legacy.tools.some(t=>t.name==='hub_memory_index'));
});
test('second brain excludes retired memory schemas and blocks legacy dispatch without widening current permissions',async()=>{
 let hook,guard,removed=0;const off=installKnowledgeToolPolicy({on:(name,fn)=>{hook=fn;return()=>removed++;},tools:{guard:fn=>{guard=fn;return()=>removed++;}}});
 const tools=[{name:'mcp__hub_memory__search_notes'},{name:'mcp__hub_memory__write_note'},{name:'hub_knowledge_read'},{name:'hub_skill_save'},{name:'web_fetch'}];
 assert.deepEqual((await hook(null,null,async()=>({tools}))).tools,tools.slice(2));assert.match(guard({name:tools[0].name}),/retired/);assert.equal(guard({name:'hub_knowledge_read'}),undefined);assert.equal(tools.length,5);off();assert.equal(removed,2);
});
function fixture(){let hook,route,calls=0,removed=0;const manager={ready:Promise.resolve(),store:{snapshot:()=>({characters:[{id:'mira'},{id:'hub'}]})},effectiveCharacter:session=>({id:session==='voice'?'mira':'hub'})};const ctx={hubCharacters:manager,agents:{get:id=>({session:{header:{id}}})},connection:{requestRejection:()=>undefined},on:(name,fn)=>{hook=fn;return()=>removed++;},webServer:{register:r=>{route=r;return()=>removed++;}}};const off=installCharacterRequests(ctx,manager);const send=(headers={'x-hub-characters':'1'},id='mira',method='GET')=>new Promise(resolve=>route.handler({method,url:'/api/hub/character-request?characterId='+id,headers},{writeHead:code=>{},end:text=>resolve(JSON.parse(text))}));return {send,off,get removed(){return removed;},capture:request=>hook(request,()=>{calls++;return [];}),get calls(){return calls;}};}
test('inspector captures actual dispatch without truncation and separates characters; reads never call a model',async()=>{
 const f=fixture(),request={provider:'test',model:'fast',sessionId:'voice',system:'Rules '.repeat(20000),messages:[{role:'user',content:[{type:'text',text:'Full context'}]}],tools:[{name:'read',parameters:{type:'object',properties:{signal:{type:'string'}}}}],signal:new AbortController().signal};
 assert.equal((await f.send()).record,null);f.capture(request);assert.equal(f.calls,1);
 const reply=await f.send();const {signal,...input}=request;assert.deepEqual(JSON.parse(reply.record.json),input);assert.equal((await f.send(undefined,'hub')).record,null);assert.equal(f.calls,1);
 f.capture({...request,purpose:'session-title',system:'Auxiliary title instruction'});assert.deepEqual(JSON.parse((await f.send()).record.json),input);
 assert.equal((await f.send({})).error,'unauthorized');assert.equal((await f.send({'x-hub-characters':'1','sec-fetch-site':'cross-site'})).error,'unauthorized');assert.equal((await f.send(undefined,'missing')).error,'character-not-found');f.off();assert.equal(f.removed,2);
});
test('prompt panel renders literal full content and supports read-only refresh with honest empty state',async t=>{
 const dom=new JSDOM('<main/>',{url:'https://hub.test/'});t.after(()=>dom.window.close());let record=null,calls=0;dom.window.fetch=async()=>{calls++;return {ok:true,json:async()=>({record,boundary:'Before provider translation.',retention:'Kept in memory only.'})};};
 const panel=characterRequestPanel(dom.window.document,'mira');t.after(panel.dispose);dom.window.document.querySelector('main').append(panel.panel);panel.open();await setImmediate();assert.match(panel.panel.textContent,/No request captured/);
 record={json:JSON.stringify({system:'<script>literal</script>',messages:['Complete input']}),at:0,sessionId:'voice'};
 [...panel.panel.querySelectorAll('button')].find(b=>b.textContent==='Refresh').click();await setImmediate();assert.equal(panel.panel.querySelector('pre').textContent,record.json);assert.equal(panel.panel.querySelector('script'),null);assert.equal(calls,2);assert.match(panel.panel.textContent,/Before provider translation/);
});

test('character tabs group memory permissions without changing a partial allowlist; the full prompt stays read-only',async t=>{
 const dom=new JSDOM('<main/>',{url:'https://hub.test/',pretendToBeVisual:true}),view=dom.window,root=view.document;t.after(()=>view.close());
 view.ResizeObserver=class{observe(){}disconnect(){}};
 view.HTMLDialogElement.prototype.showModal=function(){this.open=true;};view.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new view.Event('close'));};view.HTMLMediaElement.prototype.pause=function(){};
 const hub='00000000-0000-4000-8000-000000000001',mira='00000000-0000-4000-8000-000000000002';
 const speech={stt:{engine:'nemotron',model:'3.5-560ms',language:'auto'},tts:{engine:'supertonic',model:'supertonic-3',voice:'F5',language:'auto',steps:6}};
 const base={avatar:'hub',description:'Fixture only',instructions:'Preserved instructions',route:{provider:'test',model:'mock'},tools:{mode:'inherit'},speech:null,delegateTo:null};
 let state={revision:2,mainId:hub,voiceId:mira,bindings:{},characters:[{...base,id:hub,name:'HUB'},{...base,id:mira,name:'Mira',avatar:'voice',speech,tools:{mode:'allow',names:['hub_knowledge_search','hub_skill_read','mcp__hub_memory__retired']}}]},saved,reads=0;
 const captured=JSON.stringify({system:'Every shared instruction. <literal>',messages:[{role:'user',content:'Original topic'}],tools:knowledgeToolChoices});
 view.fetch=async(url,options={})=>{
  if(url.startsWith('/api/hub/character-request')){reads++;assert.equal(options.method,undefined);return {ok:true,json:async()=>({record:{json:captured,at:0,sessionId:'fixture-voice'},boundary:'Before provider translation.',retention:'In memory only.'})};}
  if(url==='/api/hub/voice/catalog')return {ok:true,json:async()=>({speech:{stt:[{...speech.stt,language:undefined,available:true,reason:null}].map(({language,...item})=>item),tts:[{engine:'supertonic',model:'supertonic-3',voices:['F5'],available:true,reason:null}]}})};
  if(url==='/api/hub/voice/preview')return {ok:false};
  assert.equal(url,'/api/hub/characters');if(options.method==='POST'){saved=JSON.parse(options.body);state={...state,revision:3,characters:state.characters.map(c=>c.id===mira?saved.character:c)};}
  return {ok:true,json:async()=>({...structuredClone(state),tools:[...knowledgeToolChoices,{name:'web_fetch',description:'Read a website'}]})};
 };
 const dispose=installCharactersClient({sessions:{list:{getSnapshot:()=>({current:'fixture-chat'})}}},root);t.after(dispose);
 view.dispatchEvent(new view.Event('hub:characters-open'));await setImmediate();root.querySelector('[data-character-id="'+mira+'"]').click();await setImmediate();
 const tab=name=>[...root.querySelectorAll('[role=tab]')].find(b=>b.textContent===name);tab('Capabilities').click();
 const groups=[...root.querySelectorAll('.hub-character-tool-groups details')];assert.deepEqual(groups.map(d=>d.querySelector('summary').textContent),['Read memory','Save notes','Skills','Other tools','Legacy memory (unused)']);assert.ok(groups.every(d=>!d.open));
 const read=root.querySelector('input[aria-label="Read memory"]');assert.equal(read.checked,false);assert.equal(read.indeterminate,true);
 const instructions=root.querySelector('textarea');instructions.value='Unsaved draft stays outside recorded requests';tab('Full prompt').click();await setImmediate();assert.equal(reads,1);assert.equal(root.querySelector('[aria-label="Complete model request"]').textContent,captured);assert.equal(saved,undefined);
 assert.equal([...root.querySelectorAll('button')].find(b=>b.textContent==='Download full request').disabled,false);
 tab('Profile').click();instructions.value='Preserved instructions';root.querySelector('form').dispatchEvent(new view.Event('submit',{bubbles:true,cancelable:true}));await setImmediate();
 assert.equal(saved.action,'save');assert.deepEqual(saved.character.tools,{mode:'allow',names:['hub_knowledge_search','hub_skill_read','mcp__hub_memory__retired']});assert.deepEqual(saved.character.speech,speech);
 const done=[...root.querySelectorAll('[data-hub-characters] header button')].find(b=>b.textContent==='Done');done.click();assert.equal(root.querySelector('[data-hub-characters]').open,false);
});
