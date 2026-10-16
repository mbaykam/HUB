import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {discoverKnowledgeCommunities,KnowledgeCommunities} from '../packages/harness-overlay/src/host/knowledge-communities.ts';
import {KnowledgeStore} from '../packages/harness-overlay/src/host/knowledge-store.ts';
import {organizationPrompt} from '../packages/harness-overlay/src/host/knowledge-organization.ts';
import {defaultKnowledgeSettings} from '../packages/harness-overlay/src/knowledge-contract.ts';
const node=id=>({id,title:id,hash:'original',permalink:id,modifiedAt:1});
function fixture(){const nodes=['a0','a1','a2','a3','a4','a5','b0','b1','b2','b3','b4','b5','unlinked'].map(node),edges=[];for(const prefix of ['a','b'])for(let i=0;i<6;i++)for(let j=i+1;j<6;j++)edges.push({source:prefix+i,target:prefix+j,label:''});edges.push({source:'a0',target:'b0',label:''});return {nodes,edges,memberships:[],partial:false};}

test('derived groups find dense local relationships across a bridge without changing records or canonical domains',()=>{
 const graph=fixture(),before=JSON.stringify(graph),result=discoverKnowledgeCommunities(graph,undefined,1);
 assert.equal(result.groups.length,2);assert.equal(result.algorithm,'weighted-label-propagation-v1');assert.equal(result.authoritative,false);assert.equal(result.coverage.complete,true);assert.equal(result.groups.flatMap(g=>g.memberIds).length,12);assert.ok(result.groups.every(g=>g.memberIds.every(id=>id.startsWith(g.memberIds[0][0]))));assert.equal(JSON.stringify(graph),before);
 assert.deepEqual(result,discoverKnowledgeCommunities({...graph,nodes:[...graph.nodes].reverse(),edges:[...graph.edges].reverse()},undefined,1));
});

test('membership signatures change while overlap matching retains candidate identity and recalculates labels',()=>{
 const graph=fixture(),first=discoverKnowledgeCommunities(graph,undefined,1),old=first.groups.find(g=>g.memberIds.includes('a0'));graph.nodes.push(node('a6'));for(let i=0;i<6;i++)graph.edges.push({source:'a6',target:'a'+i,label:''});
 const next=discoverKnowledgeCommunities(graph,first,2),group=next.groups.find(g=>g.memberIds.includes('a0'));assert.equal(group.id,old.id);assert.notEqual(group.signature,old.signature);assert.equal(new Set(next.groups.map(g=>g.id)).size,next.groups.length);assert.equal(next.groups.flatMap(g=>g.memberIds).length,13);
});

test('a malformed matching derived cache is rebuilt rather than breaking curator hints or original sources',async t=>{
 const root=await mkdtemp(join(tmpdir(),'hub-community-malformed-'));t.after(()=>rm(root,{recursive:true,force:true}));const graph=fixture(),first=await new KnowledgeCommunities(root).update(graph);delete first.groups[0].domainIds;await writeFile(join(root,'indexes','community-candidates.json'),JSON.stringify(first));const rebuilt=await new KnowledgeCommunities(root).update(graph);assert.ok(rebuilt.groups.every(g=>Array.isArray(g.domainIds)));assert.equal(rebuilt.groups.length,2);
});

test('candidate work limits disclose incomplete source and similarity coverage without truncating stored relationships',()=>{
 const graph={nodes:Array.from({length:5001},(_,i)=>node('n'+String(i).padStart(5,'0'))),edges:[{source:'n00000',target:'n00001'}],partial:true,sourceCoverage:{omitted:2},similarityCoverage:{complete:false}},result=discoverKnowledgeCommunities(graph);
 assert.equal(result.coverage.consideredRecords,5000);assert.equal(result.coverage.complete,false);assert.deepEqual(result.coverage.limitedBy,['records','source-coverage','similarity-coverage']);assert.equal(graph.nodes.length,5001);assert.equal(graph.edges.length,1);
});

test('cache survives restart, ignores nonstructural hash changes and keeps original knowledge available on cache failure',async t=>{
 const root=await mkdtemp(join(tmpdir(),'hub-eval-groups-'));t.after(()=>rm(root,{recursive:true,force:true}));const index=new KnowledgeCommunities(root),graph=fixture(),one=await index.update(graph),two=await index.update({...graph,nodes:graph.nodes.map(n=>({...n,hash:'metadata-only'}))});assert.equal(one,two);assert.deepEqual(await new KnowledgeCommunities(root).update(graph),one);
 const store=new KnowledgeStore(join(root,'vault'),join(root,'state'));await store.initialize();const file=join(store.vault,'Original.md'),text='---\nhub_id: original-record\n---\nMy exact original text.';await writeFile(file,text);await writeFile(join(store.root,'indexes'),'A blocking file, not a directory');const data=await store.graph();assert.equal(data.nodes.length,1);assert.equal(data.communityCandidates,undefined);assert.equal(await readFile(file,'utf8'),text);
});

test('curator receives bounded suggestions as hints while original-evidence and domain-cap rules remain explicit',()=>{
 const graph=fixture(),groups=discoverKnowledgeCommunities(graph),source={id:'fixture',conversationId:'a0',channel:'pwa',completedAt:1,content:'A real original sentence.'},prompt=organizationPrompt(source,[{id:'a1',title:'Read source',body:'A second original sentence.'}],defaultKnowledgeSettings,undefined,groups);
 assert.match(prompt,/STRUCTURAL GROUP SUGGESTIONS/);assert.match(prompt,/derived, not factual domains/);assert.match(prompt,/readCandidateIds.*a1/);assert.match(prompt,/ORIGINAL CONVERSATIONS AND HUMAN NOTES ARE READ-ONLY/);assert.match(prompt,/At most 7 ACTIVE main domains/);
});

test('source group paging is read-only and refuses a stale graph version',async t=>{
 const root=await mkdtemp(join(tmpdir(),'hub-eval-community-page-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new KnowledgeStore(join(root,'vault'),join(root,'state'));await store.initialize();for(const id of ['one','two','three'])await writeFile(join(store.vault,id+'.md'),`---\nhub_id: record-${id}\ntitle: ${id}\n---\nOriginal ${id}. ${id==='one'?'[[two]] [[three]]':''}`);
 const page=await store.communities();assert.equal(page.total,1);const group=await store.community(page.groups[0].id,page.inputHash);assert.equal(group.total,3);assert.equal((await store.organization.domains()).domains.length,0);await writeFile(join(store.vault,'three.md'),'---\nhub_id: record-three\ntitle: Newly renamed\n---\nAn edited original.');await assert.rejects(store.community(page.groups[0].id,page.inputHash),/graph changed/);
});
