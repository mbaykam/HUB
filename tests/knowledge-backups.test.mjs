import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,lstat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {KnowledgeStore,digest} from '../packages/harness-overlay/src/host/knowledge-store.ts';
import {KnowledgeBackups} from '../packages/harness-overlay/src/host/knowledge-backups.ts';
import {KnowledgeCurator} from '../packages/harness-overlay/src/host/knowledge-curator.ts';
import {verifyKnowledgeSnapshot,restoreKnowledgeSnapshot,knowledgeRestoreHold} from '../packages/harness-overlay/src/host/knowledge-portable.ts';
import {conversationSources} from '../packages/harness-overlay/src/host/knowledge-archive.ts';
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'hub-eval-backup-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new KnowledgeStore(join(root,'vault'),join(root,'state'));await store.initialize();return {root,store,backups:new KnowledgeBackups(store,join(root,'backups'))};}

test('operator backup controls certify a complete copy, restore separately and retain incomplete copy warnings',async t=>{
 const {root,store,backups}=await fixture(t);await store.assets.save(Buffer.from('Exact original bytes'),'fixture.txt');
 const created=await backups.create();assert.equal(created.verified,true);assert.equal((await backups.verify(created.id)).verified,true);
 const list=await backups.list();assert.equal(list.total,1);assert.equal(list.items[0].id,created.id);
 const broken=join(list.storage,randomUUID());await mkdir(broken);await writeFile(join(broken,'snapshot.json'),'{}');
 assert.equal((await backups.list()).incompleteCopies,1);assert.equal((await backups.list()).total,1);
 const copy=await backups.restoreCopy(created.id);assert.notEqual(copy.vault,store.vault);assert.equal(copy.activated,false);assert.equal(copy.backgroundWork,'paused-for-review');assert.equal((await knowledgeRestoreHold({vault:copy.vault,root:copy.root})).state,'needs-review');
 await assert.rejects(backups.verify('../escape'),/identity/);await assert.rejects(backups.list(-1),/page/);
 assert.equal((await store.assets.list()).length,1);assert.ok(copy.vault.startsWith(root));
});

test('portable case/Unicode collisions fail before a destination is created',async t=>{
 const {root,store,backups}=await fixture(t);await store.assets.save(Buffer.from('Source'),'Readme.txt');const snapshot=await backups.create(),path=join(snapshot.path,'snapshot.json'),value=JSON.parse(await readFile(path,'utf8'));
 const original=value.files.find(file=>file.path.includes('Attachments/'));value.files.push({...original,path:original.path.toUpperCase().replace(/^VAULT\//,'vault/')});value.bytes+=original.bytes;
 await writeFile(path,JSON.stringify(value));await assert.rejects(verifyKnowledgeSnapshot(snapshot.path),/collide/);
 await assert.rejects(restoreKnowledgeSnapshot(snapshot.path,join(root,'collision-copy')),/collide/);await assert.rejects(lstat(join(root,'collision-copy')),/ENOENT/);
 value.files=value.files.slice(0,-1);value.files.push({...original,path:'vault/Notes/caf\u00e9.md'},{...original,path:'vault/Notes/cafe\u0301.md'});await writeFile(path,JSON.stringify(value));await assert.rejects(verifyKnowledgeSnapshot(snapshot.path),/Unicode/);
});

test('a restored queue survives without model calls until explicitly resumed, and the review decision survives restart',async t=>{
 const {store,backups}=await fixture(t);let calls=0;const generate=async()=>{calls++;return JSON.stringify({version:1,decision:'skip',reason:'Synthetic check',tags:[],relations:[],reflections:[],profileSuggestions:[]});};
 const original=new KnowledgeCurator(store,generate);await original.initialize();await original.configure({...original.settings,mode:'automatic'});await original.enqueue({id:'fixture-queued',channel:'pwa',completedAt:Date.now(),content:'This fixture is awaiting a future organization pass.'});
 const snapshot=await backups.create(),copy=await backups.restoreCopy(snapshot.id),nextStore=new KnowledgeStore(copy.vault,copy.root),restored=new KnowledgeCurator(nextStore,generate);t.after(()=>{original.dispose();restored.dispose();});await restored.initialize();
 const settings=JSON.stringify(restored.settings);await restored.tick(true);assert.equal(calls,0);assert.equal(restored.status,'restored-work-paused');assert.equal(restored.jobs.get('fixture-queued').status,'queued');
 await restored.resumeRestoredWork();assert.equal(JSON.stringify(restored.settings),settings);await restored.tick(true);assert.equal(calls,1);assert.equal(restored.jobs.get('fixture-queued').status,'done');
 const reopened=new KnowledgeCurator(nextStore,generate);t.after(()=>reopened.dispose());await reopened.initialize();assert.equal(reopened.restoredWork.state,'resumed');await reopened.tick(true);assert.equal(calls,1);
 assert.equal(original.jobs.get('fixture-queued').status,'queued');
});

test('evidence inspection opens the exact archived message version and refuses an undone relationship',async t=>{
 const {store}=await fixture(t),at=1700000000000,record={id:'conversation-'+ 'a'.repeat(32),externalId:'fixture:atlas',title:'Project name',channel:'pwa',createdAt:at,updatedAt:at,messages:[{id:'user-one',role:'user',text:'The project is named Atlas.',at}]};
 await store.archive.put(record);await mkdir(join(store.vault,'Notes'),{recursive:true});await writeFile(join(store.vault,'Notes','Reference.md'),'---\nhub_id: record-reference\n---\nAtlas project documentation.');
 const target=(await store.scan()).find(n=>n.id==='record-reference'),source=conversationSources(record)[0],revision=await store.organization.apply({version:1,decision:'organize',reason:'Source',tags:[],relations:[{targetId:target.id,label:'Project reference',evidence:'Atlas',targetEvidence:target.body.trim(),targetHash:digest(target.body)}],reflections:[],profileSuggestions:[]},source),relation=(await store.graph()).relationships[0];
 const current=await store.inspectEvidence(relation.id,0);assert.equal(current.version,'current');assert.equal(current.citation.messageId,'user-one');assert.match(current.excerpt.text,/Atlas/);
 await store.archive.put({...record,updatedAt:at+1000,messages:[{...record.messages[0],text:'The project is now named Orion.',at:at+1000}]});
 const old=await store.inspectEvidence(relation.id,0);assert.equal(old.version,'archived');assert.match(old.excerpt.text,/Atlas/);assert.doesNotMatch(old.excerpt.text,/Orion/);
 await store.organization.undo(revision);await assert.rejects(store.inspectEvidence(relation.id,0),/retired or changed/);
});
