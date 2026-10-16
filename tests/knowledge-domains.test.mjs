import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {changeKnowledgeDomains,undoKnowledgeDomains,validateDomainState} from '../packages/harness-overlay/src/host/knowledge-domains.ts';
import {emptyKnowledgeDomains} from '../packages/harness-overlay/src/knowledge-domain-contract.ts';
import {KnowledgeStore,digest} from '../packages/harness-overlay/src/host/knowledge-store.ts';
import {organizationPrompt} from '../packages/harness-overlay/src/host/knowledge-organization.ts';
import {defaultKnowledgeSettings} from '../packages/harness-overlay/src/knowledge-contract.ts';
import {KnowledgeCurator} from '../packages/harness-overlay/src/host/knowledge-curator.ts';
const source={id:'source-one',conversationId:'record-one',completedAt:Date.now(),channel:'pwa',authorRole:'user',content:'I am building HUB. Türkçe ve İngilizce öğreniyorum.'};
const create=(ref,title,parentId)=>({type:'create',ref,title,...(parentId?{parentId}:{}),evidence:'I am building HUB.'});
let sequence=0;
const change=(state,ops,extra={})=>changeKnowledgeDomains(state,ops,{expectedRevision:state.revision,actor:'user',knownNodeIds:['record-one','record-two'],revisionId:'revision-'+ ++sequence,...extra});
test('active-root cap is independent of subdomains and knowledge retention; invalid changes are atomic',()=>{
 let state=change(emptyKnowledgeDomains(),[create('new-projects','Projects'),create('new-hub','HUB','new-projects')],{maxActiveDomains:1});assert.equal(state.domains.length,2);assert.equal(state.maxActiveDomains,1);
 const before=JSON.stringify(state);assert.throws(()=>change(state,[create('new-learning','Learning')]),/limit/);assert.equal(JSON.stringify(state),before);
 const root=state.domains.find(d=>!d.parentId);state=change(state,[{type:'status',id:root.id,status:'inactive'},create('new-learning','Learning')]);assert.equal(state.domains.filter(d=>d.status==='active'&&!d.parentId).length,1);assert.equal(state.domains.find(d=>d.title==='HUB').status,'inactive');
 assert.throws(()=>change(state,[],{maxActiveDomains:0}));assert.equal(state.domains.length,3);
});
test('cycles, depth, missing parents, merged targets and lowering the cap cannot silently damage a hierarchy',()=>{
 const state=change(emptyKnowledgeDomains(),[create('new-a','A'),create('new-b','B','new-a'),create('new-c','C','new-b'),create('new-d','D','new-c'),create('new-other','Other')]);const id=title=>state.domains.find(d=>d.title===title).id;
 assert.throws(()=>change(state,[create('new-e','E',id('D'))]),/four levels/);assert.throws(()=>change(state,[{type:'reparent',id:id('A'),parentId:id('C')}]),/cyclic/);assert.throws(()=>change(state,[create('new-f','F','missing')]));assert.throws(()=>change(state,[],{maxActiveDomains:1}),/limit/);assert.throws(()=>change(state,[{type:'status',id:id('A'),status:'inactive'},{type:'status',id:id('D'),status:'active'}]),/parent/);
 const merged=change(state,[{type:'merge',id:id('Other'),targetId:id('A')}]);assert.throws(()=>change(merged,[{type:'assign',nodeId:'record-one',domainId:id('Other')}]),/merged/);
});
test('curator gets host IDs, exact-source memberships and bounded creation, while lifecycle changes require review',()=>{
 let state=change(emptyKnowledgeDomains(),[create('new-projects','Projects'),create('new-hub','HUB','new-projects'),{type:'assign',domainId:'new-projects',evidence:'I am building HUB.'},{type:'assign',domainId:'new-hub',evidence:'I am building HUB.'}],{actor:'curator',source});
 assert.equal(state.memberships.length,2);assert.ok(state.domains.every(d=>/^[0-9a-f-]{36}$/.test(d.id)));assert.ok(state.memberships.every(m=>m.nodeId==='record-one'&&m.evidence[0].contentHash.length===64));
 const id=state.domains[0].id;assert.throws(()=>change(state,[{type:'assign',nodeId:'record-two',domainId:id,evidence:'I am building HUB.'}],{actor:'curator',source}),/current source/);assert.throws(()=>change(state,[{type:'assign',domainId:id,evidence:'Invented statement.'}],{actor:'curator',source}),/exact source/);assert.throws(()=>change(state,[{type:'status',id,status:'inactive'}],{actor:'curator',source}),/review/);
 state=change(state,[{type:'propose',operation:{type:'status',id,status:'inactive'},evidence:'I am building HUB.'}],{actor:'curator',source});assert.equal(state.domains[0].status,'active');assert.equal(state.proposals[0].status,'pending');
 assert.throws(()=>change(state,[{type:'create',ref:'new-x',title:'X',body:'Not allowed'}]),/fields/);assert.throws(()=>change(state,[create('new-one','One'),create('new-two','Two'),create('new-three','Three')],{actor:'curator',source}),/allowance/);
});
test('merge retains redirects, memberships and evidence; conservative undo preserves newer edits',()=>{
 let state=change(emptyKnowledgeDomains(),[create('new-a','A'),create('new-b','B'),{type:'assign',nodeId:'record-one',domainId:'new-a'},{type:'assign',nodeId:'record-one',domainId:'new-b'}]);const [a,b]=state.domains;
 state=change(state,[{type:'merge',id:a.id,targetId:b.id}]);const mergeId=state.history.at(-1).id;assert.equal(state.memberships.length,1);assert.equal(state.domains.find(d=>d.id===a.id).mergedInto,b.id);
 state=change(state,[{type:'rename',id:b.id,title:'Renamed B'}]);const renameId=state.history.at(-1).id;assert.throws(()=>undoKnowledgeDomains(state,mergeId),/Newer/);state=undoKnowledgeDomains(state,renameId);state=undoKnowledgeDomains(state,mergeId);assert.equal(state.domains.find(d=>d.id===a.id).status,'active');assert.equal(state.memberships.length,2);validateDomainState(state);
 assert.throws(()=>change(state,[],{expectedRevision:state.revision-1}),/changed/);
});
async function storeFixture(t){const directory=await mkdtemp(join(tmpdir(),'hub-domain-')),store=new KnowledgeStore(join(directory,'vault'),join(directory,'canonical'));await mkdir(join(store.vault,'Notes'),{recursive:true});await writeFile(join(store.vault,'Notes','One.md'),'---\nhub_id: "record-one"\n---\n# Original\nI am building HUB.');await store.initialize();t.after(()=>rm(directory,{recursive:true,force:true}));return store;}
test('legacy organization loads without a write; v2 domains survive reopen and original body bytes remain unchanged',async t=>{
 const store=await storeFixture(t),path=join(store.root,'organization.json'),legacy=JSON.stringify({version:1,revisions:[],suggestions:[]});await writeFile(path,legacy);const before=await readFile(join(store.vault,'Notes','One.md'));
 assert.equal((await store.organization.domains()).maxActiveDomains,7);assert.equal(await readFile(path,'utf8'),legacy);let state=await store.organization.changeDomains(0,[create('new-projects','Projects'),{type:'assign',nodeId:'record-one',domainId:'new-projects'}]);
 const reopened=new KnowledgeStore(store.vault,store.root);assert.deepEqual(await reopened.organization.domains(),state);assert.deepEqual(await readFile(join(store.vault,'Notes','One.md')),before);const graph=await reopened.graph();assert.equal(graph.domains[0].title,'Projects');assert.deepEqual(graph.memberships,[{nodeId:'record-one',domainId:state.domains[0].id}]);assert.equal(JSON.stringify(graph).includes('contentHash'),false);
 await assert.rejects(store.organization.changeDomains(0,[create('new-other','Other')]),/changed/);state=await store.organization.changeDomains(state.revision,[{type:'status',id:state.domains[0].id,status:'inactive'}]);assert.equal((await store.search('HUB'))[0].id,'record-one');assert.equal(state.memberships.length,1);
});
test('a stale curator registry rejects the entire combined relation/domain transaction and undo never overwrites later human edits',async t=>{
 const store=await storeFixture(t),plan={version:2,expectedRegistryRevision:0,domainOps:[create('new-projects','Projects'),{type:'assign',domainId:'new-projects',evidence:'I am building HUB.'}],decision:'organize',reason:'Project source',tags:[],relations:[],reflections:[],profileSuggestions:[]};
 const revision=await store.organization.apply(plan,source),state=await store.organization.domains();assert.equal(state.memberships.length,1);const before=await readFile(join(store.root,'organization.json'),'utf8');await assert.rejects(store.organization.apply({...plan,reflections:[{scope:'user',observation:'Would be a partial write',evidence:'I am building HUB.'}]},{...source,id:'different-source'}),/changed/);assert.equal(await readFile(join(store.root,'organization.json'),'utf8'),before);
 await store.organization.changeDomains(state.revision,[{type:'rename',id:state.domains[0].id,title:'Human name'}]);await assert.rejects(store.organization.undo(revision),/Newer/);assert.equal((await store.organization.domains()).domains[0].title,'Human name');
 const prompt=organizationPrompt(source,[],defaultKnowledgeSettings,await store.organization.domains());assert.match(prompt,/expectedRegistryRevision/);assert.match(prompt,/HUMAN REVIEW/);assert.match(prompt,/Human name/);
});

test('review binds temporary references, re-previews stale proposals and undo restores proposal status',async t=>{
 const store=await storeFixture(t),plan={version:2,expectedRegistryRevision:0,domainOps:[create('new-projects','Projects'),{type:'assign',domainId:'new-projects',evidence:'I am building HUB.'},{type:'propose',operation:{type:'rename',id:'new-projects',title:'Building'},evidence:'I am building HUB.'}],decision:'organize',reason:'Project',tags:[],relations:[],reflections:[],profileSuggestions:[]};
 await store.organization.apply(plan,source);let state=await store.organization.domains();const proposal=state.proposals[0],id=state.domains[0].id;assert.equal(proposal.operation.id,id);
 let preview=await store.organization.domainPreview(proposal.id);state=await store.organization.changeDomains(state.revision,[{type:'assign',nodeId:'record-one',domainId:id}]);assert.equal(state.memberships[0].origin,'user');
 await assert.rejects(store.organization.reviewDomain(state.revision,proposal.id,true,preview.previewHash),/Preview/);preview=await store.organization.domainPreview(proposal.id);assert.equal(preview.stale,true);state=await store.organization.reviewDomain(state.revision,proposal.id,true,preview.previewHash);assert.equal(state.domains[0].title,'Building');assert.equal(state.proposals[0].status,'applied');
 state=await store.organization.undoDomains(state.revision,state.history.at(-1).id);assert.equal(state.domains[0].title,'Projects');assert.equal(state.proposals[0].status,'pending');
 state=await store.organization.reviewDomain(state.revision,proposal.id,false);assert.equal(state.proposals[0].status,'rejected');state=await store.organization.undoDomains(state.revision,state.history.at(-1).id);assert.equal(state.proposals[0].status,'pending');
});

test('split is one reversible transaction and a no-op keeps the same revision and bytes',()=>{
 let state=change(emptyKnowledgeDomains(),[create('new-all','All'),{type:'assign',nodeId:'record-one',domainId:'new-all'},{type:'assign',nodeId:'record-two',domainId:'new-all'}]);const before=structuredClone(state),id=state.domains[0].id;
 state=change(state,[{type:'rename',id,title:'All'}]);assert.deepEqual(state,before);
 assert.throws(()=>change(state,[{type:'split',id,groups:[{ref:'new-a',title:'A',nodeIds:['record-one']},{ref:'new-b',title:'B',nodeIds:['missing']}]}]),/source domain/);assert.deepEqual(state,before);
 state=change(state,[{type:'split',id,groups:[{ref:'new-a',title:'A',nodeIds:['record-one']},{ref:'new-b',title:'B',nodeIds:['record-two']}],deactivateSource:true}]);assert.equal(state.domains.find(d=>d.id===id).status,'inactive');assert.equal(state.memberships.length,2);assert.equal(state.memberships.some(m=>m.domainId===id),false);assert.equal(Object.keys(state.history.at(-1).resolvedReferences).length,2);
 const undone=undoKnowledgeDomains(state,state.history.at(-1).id);assert.deepEqual(undone.domains,before.domains);assert.deepEqual(undone.memberships,before.memberships);
});

test('unknown and incomplete organization schemas fail closed while legacy bytes stay untouched',async t=>{
 const store=await storeFixture(t),path=join(store.root,'organization.json');for(const state of [{version:2,revisions:[],suggestions:[]},{version:19,revisions:[],suggestions:[]}]){const raw=JSON.stringify(state);await writeFile(path,raw);await assert.rejects(store.organization.state(),/Invalid organization/);assert.equal(await readFile(path,'utf8'),raw);}
 const state=emptyKnowledgeDomains();state.proposals.push({id:'p',sourceId:'s',at:1,basedOnRevision:0,status:'pending',evidence:'source',operation:{type:'rename',id:'missing',title:123}});assert.throws(()=>validateDomainState(state),/Invalid/);
});

test('a failed projection remains committed and repairs after restart without a new plan',async t=>{
 const store=await storeFixture(t),plan={version:2,expectedRegistryRevision:0,domainOps:[create('new-projects','Projects')],decision:'organize',reason:'Project',tags:[],relations:[],reflections:[],profileSuggestions:[]};
 const original=store.organization.syncObsidianLinks;store.organization.syncObsidianLinks=async()=>{throw Error('disk fixture');};await assert.rejects(store.organization.apply(plan,source),e=>e.code==='KNOWLEDGE_PROJECTION_PENDING');assert.equal((await store.organization.state()).revisions[0].projection,'pending');assert.equal((await store.organization.domains()).domains.length,1);
 store.organization.syncObsidianLinks=original;const reopened=new KnowledgeStore(store.vault,store.root);await reopened.initialize();assert.equal((await reopened.organization.state()).revisions[0].projection,'ready');assert.equal((await reopened.organization.state()).revisions.length,1);
});
test('selected-source organization passes are durable, bounded and refuse changed originals before inference',async t=>{
 const store=await storeFixture(t);let calls=0;const curator=new KnowledgeCurator(store,async()=>{calls++;return JSON.stringify({version:1,decision:'organize',reason:'Read-only pass',tags:[],relations:[],reflections:[],profileSuggestions:[]});});await curator.initialize();await curator.configure({...curator.settings,mode:'manual'});const before=await readFile(join(store.vault,'Notes/One.md'),'utf8');const first=await curator.reorganize(['record-one']);await curator.tick(true);const second=await curator.reorganize(['record-one']);await curator.tick(true);assert.equal(calls,2);assert.equal((await store.organization.state()).revisions.length,2);assert.notEqual(first.passId,second.passId);assert.equal(await readFile(join(store.vault,'Notes/One.md'),'utf8'),before);await assert.rejects(curator.reorganize(['missing']));const third=await curator.reorganize(['record-one']);await writeFile(join(store.vault,'Notes/One.md'),before+'\nHuman correction.');await curator.tick(true);assert.equal(calls,2);assert.equal(curator.jobs.get(third.jobIds[0]).error.code,'KNOWLEDGE_SOURCE_CHANGED');await curator.dispose();
});

test('a long selected note uses a hash-bound excerpt, cites original offsets and refuses an edit during model work',async t=>{
 const store=await storeFixture(t),path=join(store.vault,'Notes/One.md'),body='Earlier original information.\n'.repeat(1800)+'Kedilere karşı alerjim var.\n',raw='---\nhub_id: record-one\ntitle: Long original\n---\n'+body;await writeFile(path,raw);await writeFile(join(store.vault,'Notes/Two.md'),'---\nhub_id: record-two\n---\nIndependent fixture reference.');const note=(await store.scan()).find(n=>n.id==='record-one'),sourcePreview=await store.organizationSource(note.id,body.length-1000);assert.ok(sourcePreview.start>23500);assert.equal(sourcePreview.content,body.slice(sourcePreview.start,sourcePreview.end));let edit=false,calls=0;
 const curator=new KnowledgeCurator(store,async()=>{calls++;if(edit)await writeFile(path,raw+'A human correction after generation started.');return JSON.stringify({version:1,decision:'organize',reason:'Source excerpt',tags:[],relations:[{targetId:'record-two',label:'Related fixture',evidence:'Kedilere karşı alerjim var.'}],reflections:[],profileSuggestions:[]});});await curator.initialize();await curator.configure({...curator.settings,mode:'manual'});await assert.rejects(curator.reorganize([note.id]),/choose an excerpt/);await assert.rejects(curator.reorganize([note.id],[{...sourcePreview,hash:'a'.repeat(64)}]),/Source changed/);
 const selected={nodeId:note.id,hash:sourcePreview.hash,start:sourcePreview.start,end:sourcePreview.end},pass=await curator.reorganize([note.id],[selected]);assert.equal(curator.jobs.get(pass.jobIds[0]).source.content,sourcePreview.content);await curator.tick(true);const relation=(await store.organization.canonicalRelations())[0];assert.equal(relation.evidence[0].contentHash,digest(body));assert.equal(relation.evidence[0].start,body.indexOf('Kedilere'));assert.equal(await readFile(path,'utf8'),raw);
 edit=true;const next=await curator.reorganize([note.id],[selected]);await curator.tick(true);assert.equal(curator.jobs.get(next.jobIds[0]).error.code,'KNOWLEDGE_SOURCE_CHANGED');assert.equal((await store.organization.state()).revisions.length,1);assert.equal(calls,2);assert.equal(await readFile(path,'utf8'),raw+'A human correction after generation started.');await curator.dispose();
});
test('registry conflict becomes a fresh review with a hash, without a second model call',async t=>{
 const store=await storeFixture(t);let calls=0;const curator=new KnowledgeCurator(store,async()=>{calls++;await store.organization.changeDomains(0,[create('new-human','Human topic')]);return JSON.stringify({version:2,expectedRegistryRevision:0,domainOps:[create('new-projects','Projects')],decision:'organize',reason:'Project',tags:[],relations:[],reflections:[],profileSuggestions:[]});});await curator.initialize();await curator.enqueue(source);await curator.tick(true);assert.equal(curator.jobs.get(source.id).status,'review');const review=await curator.review(source.id);assert.equal(review.stale,true);await assert.rejects(curator.decideReview(source.id,true),/Preview/);await curator.decideReview(source.id,true,review.reviewHash);assert.equal(calls,1);assert.equal((await store.organization.domains()).domains.length,2);await curator.dispose();
});
