import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KnowledgeStore,digest} from '../packages/harness-overlay/src/host/knowledge-store.ts';
import {KnowledgeTopology} from '../packages/harness-overlay/src/host/knowledge-topology.ts';

test('a note growing beyond the existing scan ceiling stays intact and never becomes a forget request',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'hub-eval-scan-')),store=new KnowledgeStore(join(directory,'vault'),join(directory,'state'));t.after(()=>rm(directory,{recursive:true,force:true}));await store.initialize();
 const path=join(store.vault,'Original.md'),header='---\nhub_id: original-note\ntitle: Original\n---\n';await writeFile(path,header+'Original sentence.');await store.refreshInventory();const before=await store.cutoff(),large=header+'Original sentence. '+'Long original text. '.repeat(30000);await writeFile(path,large);await store.refreshInventory();
 const graph=await store.graph();assert.equal(graph.partial,true);assert.equal(graph.hiddenNodes,1);assert.equal(graph.sourceCoverage.omitted,1);assert.equal(graph.sourceCoverage.noteSize,1);assert.equal(await store.cutoff(),before);assert.equal(digest(await readFile(path,'utf8')),digest(large));assert.notEqual(JSON.parse(await readFile(join(store.root,'notes.json'),'utf8'))['original-note'].deleted,true);
 await new KnowledgeStore(store.vault,store.root).initialize();assert.equal(await store.cutoff(),before);await writeFile(path,header+'Still retained and searchable.');assert.equal((await store.search('retained'))[0].id,'original-note');assert.equal((await store.graph()).partial,false);
});

test('an omitted source cannot turn an unfinished connection search into an exhaustive absence',()=>{
 const graph={nodes:['one','two'].map(id=>({id,title:id})),relationships:[],partial:true},path=new KnowledgeTopology(graph).path('one','two');assert.equal(path.found,false);assert.equal(path.complete,false);assert.equal(path.limitedBy,'source-coverage');
});
