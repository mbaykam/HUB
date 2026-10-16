import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {KnowledgeStore} from '../packages/harness-overlay/src/host/knowledge-store.ts';
import {ensureKnowledgeDataset,exportKnowledgeSnapshot,verifyKnowledgeSnapshot,restoreKnowledgeSnapshot} from '../packages/harness-overlay/src/host/knowledge-portable.ts';
const digest=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'hub-portable-')),store=new KnowledgeStore(join(directory,'live-vault'),join(directory,'live-canonical'));await store.initialize();t.after(()=>rm(directory,{recursive:true,force:true}));return {directory,store};}
test('a complete snapshot restores originals, attachments, domains, provenance and undo in a genuinely different directory',async t=>{
 const {directory,store}=await fixture(t),record={id:'conversation-'+ 'a'.repeat(32),externalId:'fixture:one',title:'Bilingual project',channel:'pwa',createdAt:1700000000000,updatedAt:1700000000000,messages:[{id:'user-one',role:'user',text:'HUB üzerinde çalışıyorum. My original words.',at:1700000000000}],raw:{branches:['original','alternate']}};
 await store.archive.put(record);const asset=await store.assets.save(Buffer.from('original attachment bytes'),'source.txt');await store.assets.bindImage('b'.repeat(64),asset);
 const registry=await store.organization.changeDomains(0,[{type:'create',ref:'new-projects',title:'Projects',aliases:['Projeler']},{type:'assign',nodeId:record.id,domainId:'new-projects'}]);
 await mkdir(join(store.root,'jobs'),{recursive:true});await writeFile(join(store.root,'jobs','queued.json'),JSON.stringify({status:'queued',source:'fixture-source'}));await mkdir(join(store.root,'runtime'),{recursive:true});await writeFile(join(store.root,'runtime','embeddings.db'),'rebuildable cache');
 const original=await readFile(join(store.root,'conversations',record.id+'.json')),body=(await store.note(record.id)).content;
 const snapshot=await exportKnowledgeSnapshot(store,join(directory,'snapshot'));assert.equal(snapshot.records,1);assert.equal(snapshot.files.some(f=>f.path.includes('embeddings.db')),false);assert.ok(snapshot.files.some(f=>f.component==='continuity'));
 const restored=await restoreKnowledgeSnapshot(join(directory,'snapshot'),join(directory,'restored-vault'));assert.notEqual(restored.root,store.root);const next=new KnowledgeStore(restored.vault,restored.root);await next.initialize();
 assert.deepEqual(await next.archive.read(record.id),record);assert.equal(digest(await readFile(join(next.root,'conversations',record.id+'.json'))),digest(original));assert.equal((await next.note(record.id)).content,body);assert.equal((await next.assets.read(asset.path)).bytes.toString(),'original attachment bytes');assert.equal((await next.assets.original('b'.repeat(64))).id,asset.id);
 assert.deepEqual(await next.organization.domains(),registry);assert.equal((await next.search('Projeler'))[0].id,record.id);await next.organization.undoDomains(registry.revision,registry.history[0].id);assert.equal((await next.organization.domains()).domains.length,0);assert.equal((await next.note(record.id)).content,body);
 assert.equal((await ensureKnowledgeDataset(store)).datasetId,restored.datasetId);await assert.rejects(restoreKnowledgeSnapshot(join(directory,'snapshot'),restored.vault),/EEXIST/);
});
test('snapshot waits for admitted archive and media writes; no partial receipt is certified',async t=>{
 const {directory,store}=await fixture(t);let release;const held=new Promise(r=>release=r);const write=store.mutations.run(async()=>{await held;await store.assets.save(Buffer.from('admitted bytes'),'held.txt');});const exporting=exportKnowledgeSnapshot(store,join(directory,'snapshot'));release();await write;const snapshot=await exporting;assert.ok(snapshot.files.some(f=>f.path.includes('held')));await verifyKnowledgeSnapshot(join(directory,'snapshot'));
 await assert.rejects(exportKnowledgeSnapshot(store,join(store.vault,'nested-backup')),/outside/);
});
test('tampering and traversal fail verification before restore creates a destination',async t=>{
 const {directory,store}=await fixture(t);await store.assets.save(Buffer.from('stable bytes'),'file.txt');const destination=join(directory,'snapshot'),snapshot=await exportKnowledgeSnapshot(store,destination),asset=snapshot.files.find(f=>f.path.includes('Attachments/'));
 await writeFile(join(destination,asset.path),'tampered');await assert.rejects(verifyKnowledgeSnapshot(destination),/integrity/);await assert.rejects(restoreKnowledgeSnapshot(destination,join(directory,'bad-restore')),/integrity/);await assert.rejects(lstat(join(directory,'bad-restore')),/ENOENT/);
 const manifest=JSON.parse(await readFile(join(destination,'snapshot.json'),'utf8'));manifest.files[0].path='vault/../../escaped';await writeFile(join(destination,'snapshot.json'),JSON.stringify(manifest));await assert.rejects(verifyKnowledgeSnapshot(destination),/inventory/);
});
test('a vault cannot silently take a different global companion, and unknown manifest schemas fail closed',async t=>{
 const {directory,store}=await fixture(t),second=new KnowledgeStore(join(directory,'other-vault'),join(directory,'other-root'));await second.initialize();const binding=await readFile(join(store.root,'dataset-binding.json'),'utf8');
 await assert.rejects(ensureKnowledgeDataset({vault:second.vault,root:store.root}),/different datasets/);assert.equal(await readFile(join(store.root,'dataset-binding.json'),'utf8'),binding);
 const path=join(store.vault,'.hub','knowledge-manifest.json'),value=JSON.parse(await readFile(path,'utf8'));value.version=99;await writeFile(path,JSON.stringify(value));await assert.rejects(ensureKnowledgeDataset(store),/Unsupported/);
});
