import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,basename,dirname} from 'node:path';
import {KnowledgeAssets,knowledgeUrls} from '../packages/harness-overlay/src/host/knowledge-assets.ts';
import {KnowledgeStore} from '../packages/harness-overlay/src/host/knowledge-store.ts';
import {KnowledgeCurator} from '../packages/harness-overlay/src/host/knowledge-curator.ts';
import {archiveMedia,previewKnowledgeImport} from '../packages/harness-overlay/src/host/knowledge-import.ts';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aUkcAAAAASUVORK5CYII=','base64');
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'hub-media-test-'));t.after(()=>{assert.equal(dirname(root),tmpdir());assert.ok(basename(root).startsWith('hub-media-test-'));return rm(root,{recursive:true,force:true});});const store=new KnowledgeStore(join(root,'vault'),join(root,'state'));await store.initialize();return store;}
test('real originals are deduplicated in vault, readable after restart, and do not become artificial graph nodes',async t=>{
 const store=await fixture(t),asset=await store.assets.save(png,'Photo (English & Türkçe).png'),same=await store.assets.save(png,'Duplicate.png');assert.equal(asset.id,same.id);
 assert.deepEqual((await store.assets.read(asset.path)).bytes,png);assert.equal((await store.scan()).length,0);
 const cold=new KnowledgeAssets(store.vault,store.root);assert.deepEqual(await cold.get(asset.id),asset);
 await assert.rejects(cold.read('../private.env'));await assert.rejects(cold.read('Attachments/../../private.env'));await assert.rejects(cold.save(Buffer.alloc(25000001),'Huge.bin'));
});
test('host inserts only a source-owned real attachment into a useful note and preserves human Markdown',async t=>{
 const store=await fixture(t),asset=await store.assets.save(png,'Diagram.png');const source={id:'media-source',channel:'pwa',completedAt:Date.now(),content:'Use this diagram for the project.',assets:[asset]};
 const change={id:'useful-note',title:'Project diagram',body:'This diagram describes the project architecture.',expectedHash:null,links:[],media:[{id:asset.id,caption:'Project architecture'}]};await store.apply({decision:'update-knowledge',reason:'Useful diagram',changes:[change]},source);
 const note=await store.note('useful-note');assert.match(note.content,/!\[Project architecture\]\(\.\.\/Attachments\/Diagram%20%28/);assert.equal((await store.graph()).nodes.length,1);assert.equal((await store.graph()).omittedRelations,0);
 await assert.rejects(store.apply({decision:'update-knowledge',reason:'Wrong source',changes:[{...change,id:'unowned-note'}]},{...source,id:'unowned-source',assets:[]}));
});
test('URL extraction preserves real HTTP references and skips executable schemes',()=>{
 assert.deepEqual(knowledgeUrls('Visit https://example.com/report and https://example.com/report. javascript:alert(1) https://user:secret@example.com/'),['https://example.com/report']);
});
test('adding attachment metadata to an imported source does not rerun paid curation',async t=>{
 const store=await fixture(t);let generated=0;const curator=new KnowledgeCurator(store,async()=>{generated++;return JSON.stringify({decision:'skip',reason:'Greeting',changes:[]});});await curator.initialize();curator.settings.idleSeconds=10;
 const source={id:'same-source',channel:'pwa',completedAt:Date.now(),content:'Hello.'};await curator.enqueue(source);await curator.tick(true);assert.equal(generated,1);const asset=await store.assets.save(png,'Old photo.png');assert.equal(await curator.enqueue({...source,assets:[asset],urls:['https://example.com/']}),false);assert.equal(curator.jobs.get(source.id).source.assets[0].id,asset.id);assert.equal(curator.jobs.get(source.id).status,'done');await curator.tick(true);assert.equal(generated,1);await curator.dispose();
});
test('PDF text is extracted locally and history exports retain current-message attachment references',async t=>{
 const store=await fixture(t);const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];const stream='BT /F1 12 Tf 20 200 Td (Useful project planning notes.) Tj ET';objects.push('<< /Length '+stream.length+' >>\nstream\n'+stream+'\nendstream');let pdf='%PDF-1.4\n',offsets=[0];objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=(i+1)+' 0 obj\n'+object+'\nendobj\n';});const xref=Buffer.byteLength(pdf);pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF';const asset=await store.assets.save(Buffer.from(pdf),'Planning.pdf');assert.match(await store.assets.extract(asset),/Useful project planning notes/);
 const exported=[{id:'conv',title:'Photo',current_node:'node',mapping:{node:{parent:null,children:[],message:{id:'msg',author:{role:'user'},create_time:1700000000,content:{parts:[{content_type:'image_asset_pointer',asset_pointer:'file-service://file-photo'},'My project diagram.']}}}}}];const preview=previewKnowledgeImport([{name:'conversations.json',body:JSON.stringify(exported)}]);assert.deepEqual(preview.sources[0].importRefs,['file-service://file-photo']);assert.match(preview.sources[0].content,/My project diagram/);
});
