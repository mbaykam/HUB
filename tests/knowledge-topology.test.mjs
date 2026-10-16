import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KnowledgeLinkIndex,KnowledgeTopology} from '../packages/harness-overlay/src/host/knowledge-topology.ts';
import {KnowledgeStore} from '../packages/harness-overlay/src/host/knowledge-store.ts';

const node=id=>({id,title:id,permalink:id,hash:'h',modifiedAt:1});
const relation=(id,sourceId,targetId,extra={})=>({id,sourceId,targetId,predicate:'references',direction:'directed',origin:'document',interpretation:false,evidence:[{sourceId,contentHash:'hash',quote:'Exact source words'}],createdAt:1,updatedAt:1,status:'active',scope:'unclassified',...extra});

test('the source-link index preserves ambiguity, exact aliases and relative paths',()=>{
 const notes=[{id:'one',title:'Shared',permalink:'Notes/First'},{id:'two',title:'Shared',permalink:'Work/Second'},{id:'three',title:'Türkçe',permalink:'Notes/Üçüncü'},{id:'four',title:'First',permalink:'Different/Name'}],index=new KnowledgeLinkIndex(notes);
 assert.equal(index.resolve('Shared'),undefined);
 assert.equal(index.resolve('First',notes[2]).id,'one');
 assert.equal(index.resolve('First'),undefined);
 assert.equal(index.resolve('Notes/First.md#Heading|display label').id,'one');
 assert.equal(index.resolve('Türkçe').id,'three');
 assert.equal(index.resolve('missing'),undefined);
 assert.equal(index.resolve('#only-a-heading'),undefined);
});

test('adjacency retains every parallel predicate and dense neighborhood; paths carry original direction and evidence',()=>{
 const nodes=Array.from({length:50},(_,i)=>node(`n${i}`)),edges=nodes.slice(1).map((n,i)=>relation(`edge-${i}`,'n0',n.id));
 edges.push(relation('parallel','n0','n1',{predicate:'contradicts',origin:'curator',interpretation:true}));
 const topology=new KnowledgeTopology({nodes,relationships:edges});
 assert.equal(topology.neighbors('n0').length,50);
 assert.equal(topology.neighbors('n1').length,2);
 const path=topology.path('n2','n3');
 assert.equal(path.found,true);assert.equal(path.complete,true);
 assert.deepEqual(path.nodes.map(n=>n.id),['n2','n0','n3']);
 assert.equal(path.relations[0].sourceId,'n0');
 assert.equal(path.relations[0].evidence[0].quote,'Exact source words');
 assert.equal(topology.path('n2','n3',{directed:true}).found,false);
 assert.equal(topology.path('n2','n3',{directed:true}).complete,true);
});

test('traversal limits report incomplete work while known absence, direction and removed evidence stay truthful',()=>{
 const nodes=['a','b','c','d','disconnected'].map(node),edges=[relation('ab','a','b'),relation('bc','b','c'),relation('cd','c','d'),relation('retired','a','disconnected',{status:'retired'}),relation('missing','a','not-present')];
 const index=new KnowledgeTopology({nodes,relationships:edges});
 const depth=index.path('a','d',{depth:1});assert.equal(depth.found,false);assert.equal(depth.complete,false);assert.equal(depth.limitedBy,'depth');
 const visited=index.path('a','d',{records:2});assert.equal(visited.limitedBy,'records');assert.equal(visited.visited,2);
 const budget=index.path('a','d',{relations:1});assert.equal(budget.limitedBy,'relations');assert.equal(budget.inspectedRelations,1);
 assert.equal(index.path('a','disconnected').complete,true);assert.equal(index.path('a','disconnected').found,false);
 assert.equal(index.neighbors('a').length,1);assert.equal(index.path('a','a').nodes.length,1);
 assert.throws(()=>index.path('a','missing'),/existing/);assert.throws(()=>index.path('a','d',{depth:100}),/budget/);
});

test('actual graph and note paths use real wiki sources with exact evidence, and updates remove obsolete paths',async t=>{
 const root=await mkdtemp(join(tmpdir(),'hub-eval-topology-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new KnowledgeStore(join(root,'vault'),join(root,'state'));await mkdir(join(store.vault,'Notes'),{recursive:true});
 const source=(id,body)=>`---\nhub_id: record-${id}\ntitle: ${id}\n---\n${body}`;
 await writeFile(join(store.vault,'Notes','A.md'),source('A','A original [[B]] [[B|another display]].'));
 await writeFile(join(store.vault,'Notes','B.md'),source('B','B original [[C]].'));
 await writeFile(join(store.vault,'Notes','C.md'),source('C','C original content.'));
 await store.initialize();
 const path=await store.connectionPath('record-A','record-C');assert.equal(path.found,true);assert.equal(path.relations.length,2);
 assert.deepEqual(path.relations.map(r=>r.evidence[0].quote),['[[B]]','[[C]]']);
 assert.equal((await store.neighbors('record-B')).items.length,2);
 const note=await store.note('record-B');assert.deepEqual(note.links.map(n=>n.id),['record-C']);assert.deepEqual(note.backlinks.map(n=>n.id),['record-A']);
 await writeFile(join(store.vault,'Notes','B.md'),source('B','B corrected without a connection.'));
 assert.equal((await store.connectionPath('record-A','record-C')).found,false);
});
