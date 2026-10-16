import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KnowledgeStore,digest,atomicJson} from '../packages/harness-overlay/src/host/knowledge-store.ts';
import {KnowledgeImportBatches,importedMediaMatches} from '../packages/harness-overlay/src/host/knowledge-import-batches.ts';
import {KnowledgeCurator} from '../packages/harness-overlay/src/host/knowledge-curator.ts';
import {conversationSources} from '../packages/harness-overlay/src/host/knowledge-archive.ts';
import {exportKnowledgeSnapshot,restoreKnowledgeSnapshot} from '../packages/harness-overlay/src/host/knowledge-portable.ts';
import {Context} from '@deepseek-ai/cordis';
import {Readable} from 'node:stream';
import {applyKnowledge} from '../packages/harness-overlay/src/host/knowledge.ts';
const at=1791900000;
const chat=(id,text='A meaningful bilingual source. Türkçe konuşurum.')=>({id,title:'Original '+id,current_node:'assistant',mapping:{user:{parent:null,children:['assistant'],message:{id:'user',author:{role:'user'},create_time:at,content:{parts:[text]}}},assistant:{parent:'user',children:[],message:{id:'assistant',author:{role:'assistant'},create_time:at+1,content:{parts:['An assistant proposal.']}}}}});
const bytes=(...records)=>Buffer.from(JSON.stringify(records));
const plan=(extra={})=>({version:1,decision:'organize',reason:'Sourced organization',tags:[],relations:[],reflections:[],profileSuggestions:[],...extra});
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'hub-import-batch-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new KnowledgeStore(join(root,'vault'),join(root,'private'));await store.initialize();const queued=[],imports=new KnowledgeImportBatches(store,async source=>{queued.push(source);return true;});return {root,store,imports,queued};}
function zip(files){let offset=0;const locals=[],central=[];for(const [name,body] of files){const data=Buffer.from(body),n=Buffer.from(name),local=Buffer.alloc(30),directory=Buffer.alloc(46);local.writeUInt32LE(0x04034b50);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(n.length,26);locals.push(local,n,data);directory.writeUInt32LE(0x02014b50);directory.writeUInt32LE(data.length,20);directory.writeUInt32LE(data.length,24);directory.writeUInt16LE(n.length,28);directory.writeUInt32LE(offset,42);central.push(directory,n);offset+=local.length+n.length+data.length;}const index=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(index.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,index,end]);}

test('exact-byte private archive survives restart without entering graph, retrieval, assets or curation',async t=>{
 const {store,imports,queued}=await fixture(t),raw=bytes(chat('one'),chat('two')),preview=await imports.stage(raw,'conversations.json');
 assert.equal(preview.conversations,2);assert.equal(preview.records[0].status,'new');assert.equal((await store.scan()).length,0);assert.equal((await store.graph()).nodes.length,0);assert.equal((await store.search('bilingual')).length,0);assert.equal((await store.assets.list()).length,0);assert.equal(queued.length,0);
 assert.deepEqual(await readFile(join(store.root,'import-batches',preview.id,'upload.bin')),raw);await imports.archive(preview.id);
 const restarted=new KnowledgeStore(store.vault,store.root);await restarted.initialize();const again=new KnowledgeImportBatches(restarted,async()=>{throw Error('No model/queue allowed');});assert.equal((await again.preview(preview.id)).state,'archived');assert.equal((await again.list()).batches.length,1);assert.equal((await restarted.scan()).length,0);
 const failed=await again.stage(Buffer.from('broken'),'history.json');assert.equal(failed.state,'failed');assert.deepEqual(await readFile(join(store.root,'import-batches',failed.id,'upload.bin')),Buffer.from('broken'));
});

test('selected admission is idempotent, preserves exact originals and withdraws influence without a forget cutoff',async t=>{
 const {store,imports,queued}=await fixture(t),preview=await imports.stage(bytes(chat('one'),chat('two'),chat('three')),'conversations.json'),ids=preview.records.slice(0,2).map(r=>r.id),result=await imports.admit(preview.id,ids,preview.previewHash);
 assert.equal(result.admitted,2);assert.equal(queued.length,4);assert.equal((await store.scan()).length,2);assert.ok(queued.every(s=>s.importBatchId===preview.id&&s.importAdmissionId));assert.equal((await imports.preview(preview.id)).records[2].status,'new');await store.refreshInventory();
 const original=await store.archive.read(ids[0]),source=queued.find(s=>s.conversationId===ids[0]&&s.authorRole==='user'),revision=await store.organization.apply(plan({relations:[{targetId:ids[1],label:'Bilingual sources',evidence:'Türkçe konuşurum.'}],reflections:[{scope:'user',observation:'Bilingual conversation.',evidence:'Türkçe konuşurum.'}]}),source);
 assert.ok(revision);const canonical=await readFile(join(store.root,'conversations',ids[0]+'.json'),'utf8');assert.equal((await store.organization.snapshot()).reflections.length,1);
 const current=await imports.preview(preview.id);assert.equal((await imports.admit(preview.id,ids,current.previewHash)).admitted,0);assert.equal(queued.length,4);
 assert.equal((await imports.withdraw(preview.id)).withdrawn,2);assert.equal((await store.graph()).nodes.length,0);assert.equal((await store.organization.snapshot()).reflections.length,0);assert.equal((await store.organization.canonicalRelations()).length,0);await store.refreshInventory();assert.equal(await store.cutoff(),0);assert.equal((await store.metadata())[ids[0]].deleted,undefined);
 assert.equal(await readFile(join(store.root,'conversations',ids[0]+'.json'),'utf8'),canonical);assert.deepEqual(await store.archive.read(ids[0]),original);assert.equal(await store.admission.allows(source),false);
 const restarted=new KnowledgeStore(store.vault,store.root);await restarted.initialize();assert.equal((await restarted.scan()).length,0);assert.equal(await restarted.cutoff(),0);
 const reopened=await imports.preview(preview.id);await imports.admit(preview.id,ids,reopened.previewHash);assert.equal((await store.scan()).length,2);assert.equal(await store.admission.allows(source),false);assert.equal(queued.length,8);
});

test('duplicates do not gain batch ownership; changed same-identity content and stale previews never overwrite',async t=>{
 const {store,imports}=await fixture(t),raw=bytes(chat('same')),first=await imports.stage(raw,'conversations.json');await imports.admit(first.id,[first.records[0].id],first.previewHash);const original=await readFile(join(store.root,'conversations',first.records[0].id+'.json'),'utf8');
 const duplicate=await imports.stage(raw,'history.json');assert.equal(duplicate.records[0].status,'duplicate');assert.equal((await imports.admit(duplicate.id,[duplicate.records[0].id],duplicate.previewHash)).duplicates,1);await imports.withdraw(duplicate.id);assert.equal((await store.scan()).length,1);
 const conflict=await imports.stage(bytes(chat('same','Different original content')),'conversations.json');assert.equal(conflict.records[0].status,'conflict');await assert.rejects(imports.admit(conflict.id,[conflict.records[0].id],conflict.previewHash),/different content/);assert.equal(await readFile(join(store.root,'conversations',first.records[0].id+'.json'),'utf8'),original);
 const fresh=await imports.stage(bytes(chat('new')),'conversations.json');await imports.withdraw(first.id);await assert.rejects(imports.admit(fresh.id,[fresh.records[0].id],fresh.previewHash),/refresh/);
});

test('partial admission remains hidden across restart, repairs a missing projection and preserves later human edits',async t=>{
 const {store,imports}=await fixture(t),preview=await imports.stage(bytes(chat('one'),chat('two')),'conversations.json'),ids=preview.records.map(r=>r.id),realPut=store.archive.put.bind(store.archive);let calls=0;store.archive.put=async record=>{if(++calls===2)throw Error('Simulated power loss');return realPut(record);};
 await assert.rejects(imports.admit(preview.id,ids,preview.previewHash),/power loss/);assert.equal((await store.scan()).length,0);assert.equal(await store.admission.allows({conversationId:ids[0]}),false);
 await unlink(join(store.vault,'Conversations',ids[0]+'.md'));const resumed=new KnowledgeStore(store.vault,store.root);await resumed.initialize();const again=new KnowledgeImportBatches(resumed,async()=>true);let p=await again.preview(preview.id);assert.equal(p.records[0].status,'interrupted');await again.admit(preview.id,ids,p.previewHash);assert.equal((await resumed.scan()).length,2);
 await again.withdraw(preview.id);const path=join(store.vault,'Conversations',ids[0]+'.md'),edited=(await readFile(path,'utf8'))+'\nA later human addition.\n';await writeFile(path,edited);p=await again.preview(preview.id);await assert.rejects(again.admit(preview.id,ids,p.previewHash),/edited externally/);assert.equal(await readFile(path,'utf8'),edited);assert.equal((await resumed.scan()).length,0);
});

test('media belongs to exact message pointers, ambiguity is retained privately, and changed bytes are a conflict',async t=>{
 const {store,imports}=await fixture(t),entry=chat('media');entry.mapping.user.message.content.parts.push({asset_pointer:'file-service://file-photo'});entry.mapping.assistant.message.content.parts.push({file_name:'ambiguous.png',file_id:'not-found'});
 const raw=zip([['conversations.json',JSON.stringify([entry])],['images/file-photo-image.png',Buffer.from([137,80,78,71,13,10,26,10,1])],['a/ambiguous.png','a'],['b/ambiguous.png','b']]),p=await imports.stage(raw,'history.zip');assert.equal((await store.assets.list()).length,0);await imports.admit(p.id,[p.records[0].id],p.previewHash);const record=await store.archive.read(p.records[0].id);assert.equal(record.messages[0].assets.length,1);assert.equal(record.messages[1].assets,undefined);assert.match((await imports.preview(p.id)).warnings.join(' '),/ambiguous/);
 assert.deepEqual(importedMediaMatches(['missing','ambiguous.png'],['a/ambiguous.png','b/ambiguous.png']).indices,[]);
 const changed=await imports.stage(zip([['conversations.json',JSON.stringify([entry])],['images/file-photo-image.png','Different bytes']]),'history.zip');assert.equal(changed.records[0].status,'conflict');
});

test('forget policy holds old imports and full portable restore keeps private batches and withdrawn state',async t=>{
 const {root,store,imports}=await fixture(t),p=await imports.stage(bytes(chat('one')),'conversations.json');await imports.admit(p.id,[p.records[0].id],p.previewHash);await imports.withdraw(p.id);await atomicJson(join(store.vault,'control','Knowledge forget policy.json'),{forgetBefore:(at+100)*1000});
 const held=await imports.stage(bytes(chat('old')),'conversations.json');assert.equal(held.records[0].status,'held-by-forget-policy');await assert.rejects(imports.admit(held.id,[held.records[0].id],held.previewHash),/forget policy/);
 const snapshot=join(root,'snapshot');await exportKnowledgeSnapshot(store,snapshot);const restored=await restoreKnowledgeSnapshot(snapshot,join(root,'restore')),copy=new KnowledgeStore(restored.vault,restored.root);await copy.initialize();const copied=new KnowledgeImportBatches(copy,async()=>false);assert.equal((await copied.preview(p.id)).records[0].status,'withdrawn');assert.deepEqual(await readFile(join(copy.root,'import-batches',p.id,'upload.bin')),bytes(chat('one')));assert.equal((await copy.scan()).length,0);
});

test('withdrawal during an in-flight model call cannot save new organization or later approve a profile',async t=>{
 const {store}=await fixture(t);let enter,finish;const entered=new Promise(r=>enter=r),answer=new Promise(r=>finish=r),curator=new KnowledgeCurator(store,async()=>{enter();return answer;});await curator.initialize();const imports=new KnowledgeImportBatches(store,s=>curator.enqueue(s)),p=await imports.stage(bytes(chat('one')),'conversations.json');await imports.admit(p.id,[p.records[0].id],p.previewHash);
 const running=curator.tick(true);await entered;await imports.withdraw(p.id);finish(JSON.stringify(plan({reflections:[{scope:'user',observation:'Not admitted anymore.',evidence:'Türkçe konuşurum.'}]})));await running;assert.equal((await store.organization.state()).revisions.length,0);assert.equal([...curator.jobs.values()][0].outcome,'skipped');await curator.tick(true);assert.equal([...curator.jobs.values()][1].outcome,'skipped');await curator.dispose();
});

test('undo of a selected pass rejects only its own pending profile suggestion',async t=>{
 const {store}=await fixture(t),imports=new KnowledgeImportBatches(store,async()=>true),p=await imports.stage(bytes(chat('one')),'conversations.json');await imports.admit(p.id,[p.records[0].id],p.previewHash);const source=conversationSources(await store.archive.read(p.records[0].id))[0],a=await store.organization.apply(plan({profileSuggestions:[{target:'USER.md',text:'First proposal.',evidence:'Türkçe konuşurum.'}]}),source,'pass-a'),b=await store.organization.apply(plan({profileSuggestions:[{target:'USER.md',text:'Second proposal.',evidence:'Türkçe konuşurum.'}]}),source,'pass-b');await store.organization.undo(b);const suggestions=(await store.organization.state()).suggestions;assert.equal(suggestions.find(s=>s.revisionId===a).status,'pending');assert.equal(suggestions.find(s=>s.revisionId===b).status,'rejected');
});

test('actual authenticated host routes persist previews, reject bulk legacy import and hide withdrawn originals',async t=>{
 const {store}=await fixture(t),effects=[];let route;await atomicJson(join(store.root,'settings.json'),{...new KnowledgeCurator(store,async()=>{throw Error('No model call');}).settings,mode:'manual'});
 const ctx=new Context();Object.assign(ctx,{get:()=>undefined,on:()=>()=>{},emit:()=>{},agents:{},sessionQuery:{listSessions:async()=>[]},webServer:{register:r=>{route=r;return ()=>{};}},connection:{requestRejection:()=>undefined},effect:fn=>effects.push(fn())});applyKnowledge(ctx,{vault:store.vault,knowledgeRoot:store.root,captureSince:0});t.after(()=>effects[0]());
 const call=(method,query,data,headers={})=>new Promise((resolve,reject)=>{const body=data instanceof Buffer?data:data?Buffer.from(JSON.stringify(data)):undefined,req=Readable.from(body?[body]:[]);Object.assign(req,{url:'/api/hub/memory'+(query?'?'+query:''),method,headers:{'x-hub-memory':'1',...(method==='POST'?{'content-type':'application/json'}:{}),...headers}});let code;route.handler(req,{writeHead:c=>code=c,end:body=>resolve({code,data:JSON.parse(body)})}).catch(reject);});
 const p=await call('POST','action=preview-import',bytes(chat('host-one'),chat('host-two')),{'x-hub-filename':'conversations.json','content-type':'application/octet-stream'});assert.equal(p.code,200);assert.equal(p.data.conversations,2);assert.equal((await store.scan()).length,0);
 assert.equal((await call('POST','',{action:'start-import',id:p.data.id})).code,409);const id=p.data.records[1].id;assert.equal((await call('POST','',{action:'start-import',id:p.data.id,recordIds:[id],previewHash:p.data.previewHash})).data.admitted,1);assert.equal((await call('GET','view=conversation&id='+id)).code,200);
 assert.equal((await call('POST','',{action:'withdraw-import',id:p.data.id})).data.withdrawn,1);assert.equal((await call('GET','view=conversation&id='+id)).code,409);assert.equal((await call('GET','view=import-batch&id='+p.data.id)).data.records[1].status,'withdrawn');assert.equal((await store.scan()).length,0);
});

test('applied profile changes block withdrawal until explicit undo; conflicting duplicate entries remain a failed private batch',async t=>{
 const {store,imports}=await fixture(t),p=await imports.stage(bytes(chat('profile')),'history.json');await imports.admit(p.id,[p.records[0].id],p.previewHash);const source=conversationSources(await store.archive.read(p.records[0].id))[0];await store.organization.apply(plan({profileSuggestions:[{target:'USER.md',text:'Uses two languages.',evidence:'Türkçe konuşurum.'}]}),source);const suggestion=(await store.organization.snapshot()).suggestions[0];let text='Existing user instructions.';const ports={read:async()=>({content:text,hash:digest(text)}),save:async(_target,_hash,next)=>text=next};await store.organization.decideProfile(suggestion.id,'approve',ports);await assert.rejects(imports.withdraw(p.id),/Undo.*profile/);assert.equal((await store.scan()).length,1);await store.organization.decideProfile(suggestion.id,'undo',ports);await imports.withdraw(p.id);assert.equal(text,'Existing user instructions.');assert.equal((await store.scan()).length,0);
 const conflict=await imports.stage(bytes(chat('same'),chat('same','Changed text in the same upload')),'history.json');assert.equal(conflict.state,'failed');assert.match(conflict.error,/conflicting versions/);assert.equal((await store.scan()).length,0);
});
