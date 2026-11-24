import test from 'node:test';
import assert from 'node:assert/strict';
import {librarySnapshot,libraryPrompt,parseLibraryPlan,describeLibraryPlan,libraryDue,LIBRARY_RETRY_MS,LIBRARY_INTERVAL_MS} from '../packages/harness-overlay/src/host/knowledge-library.ts';
import {changeKnowledgeDomains} from '../packages/harness-overlay/src/host/knowledge-domains.ts';
import {emptyKnowledgeDomains} from '../packages/harness-overlay/src/knowledge-domain-contract.ts';

function shelf(){
  let state=emptyKnowledgeDomains();
  const notes=['a1','a2','b1','u1','u2','u3'].map((id,i)=>({id,title:`Note ${id}`,modifiedAt:1000+i}));
  state=changeKnowledgeDomains(state,[{type:'create',ref:'new-ai',title:'AI Assistant'},{type:'create',ref:'new-food',title:'Food'},
    {type:'assign',nodeId:'a1',domainId:'new-ai'},{type:'assign',nodeId:'a2',domainId:'new-ai'},{type:'assign',nodeId:'b1',domainId:'new-food'}],
    {expectedRevision:0,actor:'user',knownNodeIds:notes.map(n=>n.id),revisionId:'r0'});
  const id=t=>state.domains.find(d=>d.title===t).id;
  return {state,notes,id};
}

test('the snapshot shows every domain and groups unfiled notes with their nearest domain, using short keys',()=>{
 const {state,notes,id}=shelf();
 const digest={domains:{[id('AI Assistant')]:{typical:['a2','a1'],coherence:0.71}},nearest:{u1:{domain:id('Food'),score:0.62},u3:{domain:id('AI Assistant'),score:0.4}},clusters:[['u1','u2'],['u3']]};
 const {snapshot,keys}=librarySnapshot(state,notes,digest);
 assert.equal(snapshot.domains.length,2);
 const ai=snapshot.domains.find(d=>d.title==='AI Assistant');assert.equal(ai.notes,2);assert.deepEqual(ai.typical,['Note a2','Note a1']);assert.equal(ai.coherence,0.71);
 assert.equal(snapshot.unfiled.count,3);
 assert.deepEqual(snapshot.unfiled.groups[0],{key:'g1',size:2,titles:['Note u1','Note u2'],nearest:{domainId:id('Food'),title:'Food',similarity:0.62}});
 assert.equal(snapshot.unfiled.singles[0].key,'n1');
 assert.deepEqual(keys.get('g1'),['u1','u2']);assert.deepEqual(keys.get('n1'),['u3']);
 const prompt=libraryPrompt(snapshot,'tr','Active main-domain limit reached');
 assert.match(prompt,/at most 10 active/);assert.match(prompt,/Titles in Turkish/);assert.match(prompt,/could not be applied: Active main-domain limit reached/);
});

test('a plan opens parents before children, files whole groups, and applies to the shelf in one undoable change',()=>{
 const {state,notes,id}=shelf();
 const keys=new Map([['g1',['u1','u2']],['n1',['u3']]]);
 const text=JSON.stringify({note:'Raflar düzenlendi.',operations:[
  {type:'assign',domainId:'new-home',items:['g1']},
  {type:'create',ref:'new-home',title:'Home Cooking',parentId:'new-life'},
  {type:'create',ref:'new-life',title:'Life'},
  {type:'reparent',id:id('Food'),parentId:'new-life'},
  {type:'rename',id:id('AI Assistant'),title:'Technology',aliases:['Teknoloji']},
  {type:'assign',domainId:id('AI Assistant'),items:['n1','missing']},
 ]});
 const plan=parseLibraryPlan(text,state,keys);
 assert.deepEqual(plan.operations.slice(0,2).map(o=>o.ref),['new-life','new-home'],'parents first');
 assert.equal(plan.operations.filter(o=>o.type==='assign').length,3,'a group becomes one filing per note; unknown keys are ignored');
 const changes=describeLibraryPlan(plan.operations,state,notes);
 assert.ok(changes.includes('New main domain "Life"'));assert.ok(changes.includes('New subdomain "Home Cooking" under "Life"'));
 assert.ok(changes.includes('Rename "AI Assistant" to "Technology"'));assert.ok(changes.some(c=>c.startsWith('File 2 notes in "Home Cooking"')));
 const after=changeKnowledgeDomains(state,plan.operations,{expectedRevision:state.revision,actor:'curator',steward:true,knownNodeIds:notes.map(n=>n.id),revisionId:'lib1'});
 const life=after.domains.find(d=>d.title==='Life');
 assert.equal(after.domains.find(d=>d.title==='Food').parentId,life.id);
 assert.deepEqual(after.memberships.filter(m=>m.domainId===after.domains.find(d=>d.title==='Home Cooking').id).map(m=>m.nodeId).sort(),['u1','u2']);
 assert.equal(after.history.at(-1).id,'lib1','one entry in the domain history, so it can be undone');
});

test('a plan naming a domain that does not exist, or new domains in a loop, is refused',()=>{
 const {state}=shelf();
 assert.throws(()=>parseLibraryPlan('{"note":"x","operations":[{"type":"rename","id":"nope","title":"A"}]}',state,new Map()),/does not exist/);
 assert.throws(()=>parseLibraryPlan(JSON.stringify({note:'x',operations:[{type:'create',ref:'new-a',title:'A',parentId:'new-b'},{type:'create',ref:'new-b',title:'B',parentId:'new-a'}]}),state,new Map()),/loop/);
 assert.throws(()=>parseLibraryPlan('{"operations":[]}',state,new Map()),/structured answer/);
});

test('the review runs only for a real library with something to do; a plan waiting for approval holds it',()=>{
 const now=10*LIBRARY_INTERVAL_MS;
 assert.equal(libraryDue({history:[]},{notes:5,unfiled:5,organizedSince:0},now),false,'a handful of notes needs no librarian');
 assert.equal(libraryDue({history:[]},{notes:40,unfiled:3,organizedSince:0},now),true);
 assert.equal(libraryDue({history:[]},{notes:40,unfiled:0,organizedSince:0},now),false);
 assert.equal(libraryDue({history:[],plan:{status:'proposed'}},{notes:40,unfiled:3,organizedSince:9},now),false);
 assert.equal(libraryDue({history:[],lastRunAt:now-LIBRARY_RETRY_MS},{notes:40,unfiled:3,organizedSince:0},now),false,'before approval, at most one plan a day');
 assert.equal(libraryDue({history:[],approvedAt:1,lastRunAt:now-LIBRARY_RETRY_MS},{notes:40,unfiled:3,organizedSince:0},now),true,'after approval, unfiled notes are handled every half hour');
});

test('a crowded domain lists its own notes, and the plan moves them into new subdomains (a note the user filed stays)',async()=>{
 const {crowdedDomains,LIBRARY_CROWDED}=await import('../packages/harness-overlay/src/host/knowledge-library.ts');
 let state=emptyKnowledgeDomains();
 const notes=Array.from({length:LIBRARY_CROWDED+2},(_,i)=>({id:`h${i}`,title:`HUB note ${i}`,modifiedAt:1000+i}));
 state=changeKnowledgeDomains(state,[{type:'create',ref:'new-hub',title:'HUB System'},...notes.map(n=>({type:'assign',nodeId:n.id,domainId:'new-hub'}))],
  {expectedRevision:0,actor:'curator',steward:true,knownNodeIds:notes.map(n=>n.id),revisionId:'r0'});
 const hub=state.domains[0].id;
 state=changeKnowledgeDomains(state,[{type:'assign',nodeId:'h1',domainId:hub}],{expectedRevision:state.revision,actor:'user',knownNodeIds:notes.map(n=>n.id),revisionId:'r1'});
 assert.deepEqual(crowdedDomains(state,notes.map(n=>n.id)),[hub]);
 assert.equal(libraryDue({approvedAt:1,lastRunAt:0},{notes:notes.length,unfiled:0,organizedSince:0,crowded:1},LIBRARY_INTERVAL_MS+1),true);
 const {snapshot,keys,moves}=librarySnapshot(state,notes);
 const entry=snapshot.domains.find(d=>d.id===hub);
 assert.equal(entry.crowded.length,notes.length);assert.equal(moves.get('c1'),hub);
 assert.match(libraryPrompt(snapshot,'en'),/crowded/);
 const first=entry.crowded.find(c=>c.title==='HUB note 0').key,user=entry.crowded.find(c=>c.title==='HUB note 1').key;
 const plan=parseLibraryPlan(JSON.stringify({note:'Split.',operations:[{type:'create',ref:'new-voice',title:'Voice',parentId:hub},{type:'assign',domainId:'new-voice',items:[first,user]}]}),state,keys,moves);
 assert.deepEqual(plan.operations.filter(o=>o.type==='unassign').map(o=>o.nodeId).sort(),['h0','h1']);
 assert.ok(describeLibraryPlan(plan.operations,state,notes).some(line=>/Move 2 notes out of "HUB System"/.test(line)));
 const after=changeKnowledgeDomains(state,plan.operations,{expectedRevision:state.revision,actor:'curator',steward:true,knownNodeIds:notes.map(n=>n.id),revisionId:'r2'});
 const voice=after.domains.find(d=>d.title==='Voice').id;
 assert.ok(after.memberships.some(m=>m.nodeId==='h0'&&m.domainId===voice));
 assert.ok(!after.memberships.some(m=>m.nodeId==='h0'&&m.domainId===hub),'Moved out of the crowded domain');
 assert.ok(after.memberships.some(m=>m.nodeId==='h1'&&m.domainId===hub),'The user\'s own filing stays');
});