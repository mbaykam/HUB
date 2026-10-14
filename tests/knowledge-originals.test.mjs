import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,unlink,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KnowledgeStore,digest,memoryExcerpt,atomicJson} from '../packages/harness-overlay/src/host/knowledge-store.ts';
import {nativeConversation,conversationSources} from '../packages/harness-overlay/src/host/knowledge-archive.ts';
import {KnowledgeCurator} from '../packages/harness-overlay/src/host/knowledge-curator.ts';
import {validateCuration} from '../packages/harness-overlay/src/host/knowledge-organization.ts';
import {previewKnowledgeImport} from '../packages/harness-overlay/src/host/knowledge-import.ts';
import {InstructionFiles} from '../packages/harness-overlay/src/host/instruction-files.ts';
import {Context} from '@deepseek-ai/cordis';
import {applyKnowledge} from '../packages/harness-overlay/src/host/knowledge.ts';
const at=1791900000000;
const message=(seq,role,text)=>({seq,time:at+seq,type:role==='user'?'user/message':'assistant/message',data:role==='user'?{source:{kind:'user'},content:[{type:'text',text}]}:{message:{content:[{type:'text',text}]}}});
const original=(id='real-chat')=>nativeConversation({id},[message(0,'user','I use Telegram. Türkçe de konuşurum.'),message(1,'assistant','We can connect HUB.')],'pwa');
const proposal=(extra={})=>({version:1,decision:'organize',reason:'Actual relationship',tags:['HUB'],relations:[],reflections:[],profileSuggestions:[],...extra});
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'hub-originals-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new KnowledgeStore(join(root,'vault'),join(root,'private'));await store.initialize();return {root,store};}

test('failed and interrupted public messages archive without inference, including bilingual original text',async t=>{
 const {store}=await fixture(t);const events=[message(0,'user','Please help. Yardım et.'),{...message(1,'assistant','Partial response'),data:{interrupted:true,message:{content:[{type:'text',text:'Partial response'}]}}},{seq:2,time:at+2,type:'turn/end',data:{reason:{kind:'error',error:{code:'QUOTA',message:'Out of credits'}}}}];
 const c=nativeConversation({id:'real-failed'},events,'voice');await store.archive.put(c);const saved=await store.archive.read(c.id);assert.deepEqual(saved.messages,c.messages);assert.equal(saved.messages[1].interrupted,true);assert.match(saved.messages[2].text,/QUOTA/);assert.equal((await store.scan()).length,1);assert.equal((await store.note(c.id)).protected,true);
 await assert.rejects(store.edit(c.id,(await store.note(c.id)).hash,'Rewrite'),/read-only/);
 assert.equal(nativeConversation({id:'hub-eval-fixture'},events,'pwa'),undefined);
});
test('host capture records a quota-failed chat even though successful episode capture returns nothing',async t=>{
 const {store}=await fixture(t),handlers=new Map(),effects=[];let route;
 const ctx=new Context();Object.assign(ctx,{attachments:undefined,get:()=>undefined,on:(name,fn)=>{handlers.set(name,fn);return ()=>{};},emit:()=>{},agents:{},sessionQuery:{listSessions:async()=>[]},webServer:{register:r=>{route=r;return ()=>{};}},connection:{requestRejection:()=>undefined},effect:fn=>effects.push(fn())});
 applyKnowledge(ctx,{vault:store.vault,knowledgeRoot:store.root,captureSince:0});
 const events=[message(0,'user','A request without credits.'),{seq:1,time:at+1,type:'turn/end',data:{turn:1,reason:{kind:'error',error:{code:'QUOTA',message:'No credits'}}}}],session={header:{id:'actual-failed-chat'},snapshotEvents:()=>events};
 handlers.get('session/event')(session,events[1]);await new Promise(r=>setTimeout(r,60));await effects[0]();
 const c=nativeConversation(session.header,events,'pwa');assert.match((await store.archive.read(c.id)).messages[0].text,/without credits/);assert.equal(route.path,'/api/hub/memory');
});
test('original body and raw messages stay unchanged when real relations are projected for Obsidian',async t=>{
 const {store}=await fixture(t),a=original('first'),b=original('second');await store.archive.put(a);await store.archive.put(b);
 const before=await store.note(a.id),canonical=await readFile(join(store.root,'conversations',a.id+'.json'),'utf8'),source={...conversationSources(a)[0],authorRole:'user'};
 const p=proposal({relations:[{targetId:b.id,label:'Same HUB project',evidence:'I use Telegram.'}],reflections:[{scope:'user',observation:'Two languages appear in the conversation.',evidence:'Türkçe de konuşurum.'}]});
 const revision=await store.organization.apply(p,source);assert.equal((await store.note(a.id)).content,before.content);assert.equal(await readFile(join(store.root,'conversations',a.id+'.json'),'utf8'),canonical);assert.equal((await store.graph()).edges[0].target,b.id);assert.deepEqual(JSON.parse((await store.scan()).find(n=>n.id===a.id).front.split('hub_related: ')[1].split('\n')[0]),['[[Conversations/'+b.id+']]']);
 assert.equal((await store.scan()).length,2);assert.equal((await store.organization.snapshot()).reflections.length,1);await store.organization.undo(revision);assert.equal((await store.graph()).edges.length,0);assert.equal((await store.note(a.id)).content,before.content);
});
test('continuations preserve original identities, prior messages and relation metadata; external body edits survive',async t=>{
 const {store}=await fixture(t),c=original();await store.archive.put(c);await store.archive.projectRelations(c.id,['Notes/Some actual note']);
 const extended={...c,updatedAt:at+10,messages:[...c.messages,{id:'10',role:'user',at:at+10,text:'A continuation\n---\nwith a divider.'}]};await store.archive.put(extended);await store.archive.put(c);assert.equal((await store.archive.read(c.id)).messages.length,3);assert.equal((await store.scan()).length,1);
 const path=join(store.vault,'Conversations',c.id+'.md');assert.equal((await store.scan()).find(n=>n.id===c.id).front.includes('hub_related:'),true);await writeFile(path,(await readFile(path,'utf8'))+'Human change.');await assert.rejects(store.archive.put({...extended,updatedAt:at+11}),/edited externally/);assert.equal((await store.note(c.id)).content.endsWith('Human change.'),true);
});
test('long imported chats with regeneration branches stay a single source; full export and late text survive',async t=>{
 const {store}=await fixture(t),long='Start. '+('x'.repeat(600000))+' LATE_UNIQUE_FACT';const raw={id:'one-export',title:'Bilingual project',create_time:1700000000,mapping:{u:{parent:null,children:['a','b'],message:{id:'u',author:{role:'user'},content:{parts:[long]}}},a:{parent:'u',children:[],message:{id:'a',author:{role:'assistant'},content:{parts:['Türkçe yanıt']}}},b:{parent:'u',children:[],message:{id:'b',author:{role:'assistant'},content:{parts:['English response']}}}}};
 const preview=previewKnowledgeImport([{name:'conversations.json',body:JSON.stringify([raw])}]);assert.equal(preview.records.length,1);await store.archive.put(preview.records[0]);assert.equal((await store.scan()).length,1);assert.equal((await store.archive.read(preview.records[0].id)).raw.mapping.u.message.content.parts[0],long);assert.equal(preview.records[0].messages.length,3);assert.ok(conversationSources(preview.records[0]).every(s=>s.content.length<16000));assert.match(memoryExcerpt(long,'LATE_UNIQUE_FACT'),/LATE_UNIQUE_FACT/);
});
test('continuing a forgotten conversation cannot merge retired messages back into searchable memory',async t=>{
 const {store}=await fixture(t),c=original();await store.archive.put(c);await unlink(join(store.vault,'Conversations',c.id+'.md'));
 const next=nativeConversation({id:'real-chat'},[message(0,'user','Retired information.'),{...message(10,'user','New information only.'),time:at+10}],'pwa',0,at+2);await store.archive.put(next);assert.deepEqual((await store.archive.read(c.id)).messages.map(m=>m.text),['New information only.']);assert.equal((await store.note(c.id)).content.includes('Retired information.'),false);
});
test('Obsidian renames retain the original identity, continuation and real relation projection',async t=>{
 const {store}=await fixture(t),c=original();await store.archive.put(c);await rename(join(store.vault,'Conversations',c.id+'.md'),join(store.vault,'Conversations','Readable conversation.md'));
 await store.archive.put({...c,updatedAt:at+12,messages:[...c.messages,{id:'12',role:'user',text:'Continuation after renaming.',at:at+12}]});await store.archive.projectRelations(c.id,['Notes/Existing']);assert.equal((await store.scan()).length,1);assert.equal((await store.note(c.id)).permalink,'Conversations/Readable conversation');assert.match((await store.note(c.id)).content,/Continuation after renaming/);
});
test('profile suggestions require current genuine user evidence and never write shared SOUL or another character',async t=>{
 const {store}=await fixture(t),c=original();await store.archive.put(c);const source={...conversationSources(c)[0],characterId:'mira-id'};
 for(const extra of [{profileSuggestions:[{target:'USER.md',text:'Invented preference',evidence:'We can connect HUB.'}]},{profileSuggestions:[{target:'SOUL.md',text:'Rewrite everybody',evidence:'I use Telegram.'}]},{reflections:[{scope:'character',characterId:'hub-id',observation:'Wrong character',evidence:'I use Telegram.'}]}])assert.throws(()=>validateCuration(proposal(extra),source,[c.id]));
 const p=proposal({profileSuggestions:[{target:'USER.md',text:'Uses Telegram.',evidence:'I use Telegram.'}]});await store.organization.apply(p,source);
 const files=new InstructionFiles(join(store.root,'instructions'));await files.load();await files.save('USER.md',digest(''),'Operator content stays.');const ports={read:async id=>({content:files.text(id),hash:digest(files.text(id))}),save:(id,hash,content)=>files.save(id,hash,content)};
 const s=(await store.organization.snapshot()).suggestions[0];assert.equal(files.text('USER.md'),'Operator content stays.');await store.organization.decideProfile(s.id,'approve',ports);assert.ok(files.text('USER.md').startsWith('Operator content stays.'));assert.equal(files.text('SOUL.md'),'');await store.organization.decideProfile(s.id,'undo',ports);assert.equal(files.text('USER.md'),'Operator content stays.');
});
test('prepared profile receipt recovers exactly once and newer human changes block undo',async t=>{
 const {store}=await fixture(t),c=original();await store.archive.put(c);await store.organization.apply(proposal({profileSuggestions:[{target:'USER.md',text:'Uses Telegram.',evidence:'I use Telegram.'}]}),conversationSources(c)[0]);
 const state=await store.organization.state(),s=state.suggestions[0];s.before='Human';s.after='Human\nAlready added';await atomicJson(join(store.root,'organization.json'),state);let text=s.after,writes=0;
 const ports={read:async()=>({content:text,hash:digest(text)}),save:async(_target,_hash,next)=>{writes++;text=next;}};await store.organization.decideProfile(s.id,'approve',ports);assert.equal(writes,0);text+='\nHuman edited';await assert.rejects(store.organization.decideProfile(s.id,'undo',ports),/Newer profile/);
});
test('QUOTA holds the entire curator route without repeated calls; sources survive restart and explicit recovery',async t=>{
 const {store}=await fixture(t);let calls=0;const c=new KnowledgeCurator(store,async()=>{calls++;throw Object.assign(Error('Out of credits'),{code:'QUOTA'});});await c.initialize();const source={id:'quota-one',channel:'pwa',completedAt:at,content:'Original evidence.'};await c.enqueue(source);await c.enqueue({...source,id:'quota-two'});await c.tick(true);await c.tick(true);assert.equal(calls,1);assert.equal(c.jobs.get('quota-one').status,'waiting-credit');assert.equal(c.jobs.get('quota-two').status,'queued');await c.dispose();
 const resumed=new KnowledgeCurator(store,async()=>{calls++;return JSON.stringify({decision:'skip',reason:'Probe',changes:[]});});await resumed.initialize();await resumed.tick(true);assert.equal(calls,1);assert.equal(resumed.jobs.get('quota-one').source.content,source.content);await resumed.retryFailed();await resumed.tick(true);assert.equal(resumed.jobs.get('quota-one').status,'done');await resumed.dispose();
});
