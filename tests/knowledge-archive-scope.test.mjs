import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KnowledgeStore,digest} from '../packages/harness-overlay/src/host/knowledge-store.ts';
import {changeKnowledgeDomains} from '../packages/harness-overlay/src/host/knowledge-domains.ts';
import {organizationPrompt} from '../packages/harness-overlay/src/host/knowledge-organization.ts';
import {defaultKnowledgeSettings} from '../packages/harness-overlay/src/knowledge-contract.ts';
import {discoverKnowledgeCommunities} from '../packages/harness-overlay/src/host/knowledge-communities.ts';
import {knowledgeLayout,projectKnowledgePreview} from '../packages/harness-overlay/src/client/memory/knowledge-layout.ts';
import {KNOWLEDGE_CHAT_ARCHIVE_ID} from '../packages/harness-overlay/src/knowledge-record-scope.ts';

const at=1791900000000;
const chat=(i=0)=>({id:'conversation-'+digest('hub:fixture-'+i).slice(0,32),externalId:'fixture-'+i,sessionId:'fixture-'+i,title:'Shared topic chat '+i,channel:'pwa',createdAt:at,updatedAt:at,messages:[{id:'user',role:'user',text:'Shared topic original words. Türkçe and English remain unchanged.',at}]});
const plan=id=>({decision:'update-knowledge',reason:'Explicit user request to save this information',changes:[{id,title:'Shared topic '+id,body:'Shared topic information explicitly saved by the user.',expectedHash:null,links:[]}]});
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'hub-archive-scope-')),store=new KnowledgeStore(join(root,'vault'),join(root,'state'));await store.initialize();t.after(()=>rm(root,{recursive:true,force:true}));return store;}

test('archived chats stay separate from brain domains and link back from an explicitly saved note',async t=>{
 const store=await fixture(t),original=chat();await store.archive.put(original);const before=await readFile(join(store.root,'conversations',original.id+'.json'));
 await store.apply(plan('brain-note'),{id:'explicit-save',conversationId:original.id,channel:'pwa',completedAt:at+1,content:'Explicit save from this chat.'});
 const registry=await store.organization.changeDomains(0,[{type:'create',ref:'new-projects',title:'Projects'},{type:'assign',nodeId:'brain-note',domainId:'new-projects'}],1);
 const bytes=await readFile(join(store.root,'organization.json'));
 await assert.rejects(store.organization.changeDomains(registry.revision,[{type:'assign',nodeId:original.id,domainId:registry.domains[0].id}]),/admitted current source record/);
 assert.deepEqual(await readFile(join(store.root,'organization.json')),bytes);
 const graph=await store.graph(),layout=knowledgeLayout(graph),source=graph.relationships.find(r=>r.predicate==='derived from conversation');
 assert.equal(graph.domains.length,1);assert.equal(graph.maxActiveDomains,1);assert.deepEqual(graph.memberships,[{nodeId:'brain-note',domainId:registry.domains[0].id}]);
 assert.equal(source.sourceId,'brain-note');assert.equal(source.targetId,original.id);assert.equal(source.scope,'archive');assert.equal(source.interpretation,false);assert.deepEqual(source.evidence,[],'a source reference must not fabricate a quote');
 const archived=layout.points.find(n=>n.id===original.id);assert.equal(archived.domainId,KNOWLEDGE_CHAT_ARCHIVE_ID);assert.deepEqual(archived.domainIds,[]);assert.deepEqual(archived.rootIds,[]);assert.equal(layout.groups.find(g=>g.id===KNOWLEDGE_CHAT_ARCHIVE_ID).status,'archive');
 assert.equal((await store.note('brain-note')).sources[0].conversationId,original.id);assert.ok((await store.note(original.id)).backlinks.some(n=>n.id==='brain-note'));
 assert.ok((await store.search('original words',5,undefined,'archive')).every(n=>n.kind==='conversation'));
 assert.deepEqual(await readFile(join(store.root,'conversations',original.id+'.json')),before);assert.equal((await store.archive.read(original.id)).messages[0].text,original.messages[0].text);
});

test('old memberships and source receipts remain byte intact while effective brain organization excludes chats',async t=>{
 const store=await fixture(t),original=chat();await store.archive.put(original);
 await store.apply(plan('legacy-brain'),{id:'legacy-save',sessionId:original.sessionId,channel:'pwa',completedAt:at+1,content:'Explicit source save.'});
 const old=changeKnowledgeDomains(await store.organization.domains(),[{type:'create',ref:'new-projects',title:'Projects'},{type:'assign',nodeId:original.id,domainId:'new-projects'}],{knownNodeIds:[original.id],actor:'user',expectedRevision:0,revisionId:'legacy-domain',now:at});
 const path=join(store.root,'organization.json');await writeFile(path,JSON.stringify({version:2,domainState:old,revisions:[],suggestions:[]}));const before=await readFile(path);
 const graph=await store.graph();assert.equal((await store.organization.domains()).memberships.length,0);assert.equal(graph.memberships.length,0);assert.equal(graph.domains.length,1);assert.ok(graph.edges.some(e=>e.source==='legacy-brain'&&e.target===original.id));assert.equal((await store.note('legacy-brain')).sources[0].conversationId,original.id);assert.deepEqual(await readFile(path),before);
});

test('chat bridges never create brain groups or change domain placement; actual source edges remain present',()=>{
 const graph={nodes:[{id:'a',title:'A',kind:'note'},{id:'b',title:'B',kind:'note'},{id:'chat',title:'Source',kind:'conversation'}],edges:[{source:'a',target:'chat'},{source:'chat',target:'b'}],memberships:[{nodeId:'chat',domainId:'projects'}],domains:[{id:'projects',title:'Projects',status:'active'}],communityCandidates:{groups:[{id:'old',label:'Old mixed hint',memberIds:['chat','a','b']}]},partial:false};
 const before=JSON.stringify(graph),communities=discoverKnowledgeCommunities(graph);assert.equal(communities.coverage.totalRecords,2);assert.equal(communities.groups.length,0);
 const layout=knowledgeLayout(graph),source=layout.points.find(p=>p.id==='chat');assert.equal(source.domainId,KNOWLEDGE_CHAT_ARCHIVE_ID);assert.deepEqual(source.domainIds,[]);assert.ok(layout.groups.find(g=>g.id===KNOWLEDGE_CHAT_ARCHIVE_ID).members.includes('chat'));assert.ok(!layout.groups.find(g=>g.id==='projects').members.includes('chat'));assert.ok(projectKnowledgePreview(graph).some(p=>p.id==='chat'));assert.equal(JSON.stringify(graph),before);
});

test('collection search filters before ranking and limiting so chats cannot crowd out brain notes',async t=>{
 const store=await fixture(t);for(let i=0;i<8;i++)await store.archive.put(chat(i));for(let i=0;i<3;i++)await store.apply(plan('brain-'+i),{id:'explicit-'+i,channel:'pwa',completedAt:at+i+1,content:'Shared topic.'});
 const brain=await store.search('Shared topic',2,undefined,'brain'),archive=await store.search('Shared topic',2,undefined,'archive');assert.equal(brain.length,2);assert.equal(archive.length,2);assert.ok(brain.every(n=>n.kind==='note'));assert.ok(archive.every(n=>n.kind==='conversation'));
});

test('curation may link a chat to knowledge but cannot create domains for the archived chat',async t=>{
 const store=await fixture(t),original=chat();await store.archive.put(original);const source={id:'curation',conversationId:original.id,channel:'pwa',completedAt:at,authorRole:'user',content:original.messages[0].text},curation={version:2,expectedRegistryRevision:0,domainOps:[{type:'create',ref:'new-source',title:'Chat subject',evidence:'Shared topic original words.'}],decision:'organize',reason:'Source relationship',tags:[],relations:[],reflections:[],profileSuggestions:[]};
 await assert.rejects(store.organization.apply(curation,source),/Chat archive records stay outside brain domains/);assert.equal((await store.organization.domains()).domains.length,0);
 const prompt=organizationPrompt(source,[],defaultKnowledgeSettings,undefined,undefined,'conversation');assert.match(prompt,/domainOps MUST be \[\]/);assert.match(prompt,/Do not create new notes from chat automatically/);
});
