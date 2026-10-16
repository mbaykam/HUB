import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KnowledgeLexicalIndex} from '../packages/harness-overlay/src/host/knowledge-lexical-index.ts';
import {fuseKnowledgeRanks} from '../packages/harness-overlay/src/host/knowledge-retrieval.ts';
import {KnowledgeStore} from '../packages/harness-overlay/src/host/knowledge-store.ts';
import {emptyKnowledgeDomains} from '../packages/harness-overlay/src/knowledge-domain-contract.ts';

const registry=emptyKnowledgeDomains();
const notes=Array.from({length:250},(_,i)=>({id:`fixture-${i}`,title:`Routine ${i}`,body:`Daily entry ${i}: ${['kedilere karşı alerjim var','Hawaii accommodation research','IŞIK İstanbul AI','Ｈｅｌｌｏ Unicode café','𐐀𐐁𐐂 supplementary letters','a.b_c punctuation'][i%6]}.`,modifiedAt:i}));
const results=(items,query,semantic=[],state=registry,index)=>fuseKnowledgeRanks(items,query,state,semantic,500,index);

test('indexed ranks equal the complete scan for bilingual, Unicode, short, common and absent queries',()=>{
  const index=new KnowledgeLexicalIndex();
  const queries=['Hawaii accommodation','Kedilere alerjim','IŞIK','ışık','istanbul','İstanbul','AI','ai','café','cafe','Hello','Unicode','𐐨𐐩𐐪','a.b_c','entry','Routine 23','neverfound','ne ve bu',''];
  for(let pass=0;pass<2;pass++)for(const query of queries)assert.deepEqual(results(notes,query,[],registry,index),results(notes,query),query);
  assert.equal(index.coverage.generation,1);
  assert.equal(index.coverage.indexed,notes.length);
  assert.equal(index.candidates(['ai']),undefined);
  assert.equal(index.candidates(['entry']),undefined);
  assert.deepEqual([...index.candidates(['neverfound'])],[]);
});

test('edits, renames and deletions invalidate old candidates even when timestamps stay identical',()=>{
  const index=new KnowledgeLexicalIndex();
  const initial=[...notes,{id:'special',title:'Rare chrysanthemum',body:'Only old-identifier-here',modifiedAt:1}];
  assert.equal(results(initial,'chrysanthemum',[],registry,index)[0].id,'special');
  const edited=initial.map(n=>n.id==='special'?{...n,title:'New quetzal',body:'Replacement with a new identifier'}:n);
  assert.deepEqual(results(edited,'chrysanthemum old-identifier-here',[],registry,index),results(edited,'chrysanthemum old-identifier-here'));
  assert.equal(results(edited,'quetzal',[],registry,index)[0].id,'special');
  const deleted=edited.filter(n=>n.id!=='special');
  assert.deepEqual(results(deleted,'quetzal',[],registry,index),[]);
  assert.equal(index.coverage.records,notes.length);
  assert.equal(index.coverage.generation,3);
});

test('an allocation limit falls back to full content without losing late passages or other indexed hits',()=>{
  const index=new KnowledgeLexicalIndex({maxChars:150,maxPostings:100,maxRecordChars:100});
  const records=[{id:'short',title:'Short',body:'needle',modifiedAt:1},{id:'long',title:'Archive',body:'irrelevant '.repeat(2000)+'late-needle-at-the-end',modifiedAt:2},...notes];
  assert.deepEqual(results(records,'late-needle-at-the-end',[],registry,index),results(records,'late-needle-at-the-end'));
  assert.deepEqual(results(records,'needle',[],registry,index),results(records,'needle'));
  assert.ok(index.coverage.fallback>0);
  assert.ok(index.coverage.normalizedChars<=150);
  assert.ok(index.coverage.postings<=100);
  const noMemory=new KnowledgeLexicalIndex({maxChars:0});
  assert.deepEqual(results(records,'Hawaii',[],registry,noMemory),results(records,'Hawaii'));
});

test('lexical pruning preserves semantic-only hits and inactive domain navigation',()=>{
  const index=new KnowledgeLexicalIndex(),records=[...notes,{id:'semantic',title:'Old chat',body:'No matching query words.',modifiedAt:1},{id:'member',title:'Another chat',body:'Nothing matching here.',modifiedAt:2}];
  const state={...registry,domains:[{id:'domain',title:'Travel',aliases:['Seyahat'],status:'inactive'}],memberships:[{nodeId:'member',domainId:'domain'}]};
  const semantic=[{id:'semantic',score:.8,chunk:{id:'body-0',kind:'body',start:0,end:3}}];
  const value=results(records,'Seyahat exoticdestination',semantic,state,index);
  assert.deepEqual(value,results(records,'Seyahat exoticdestination',semantic,state));
  assert.ok(value.some(n=>n.id==='semantic'&&n.retrieval.kind==='semantic'));
  assert.ok(value.some(n=>n.id==='member'&&n.retrieval.kind==='domain-navigation'));
});

test('real store searches never return a stale edited or deleted source from the index',async t=>{
  const root=await mkdtemp(join(tmpdir(),'hub-eval-lexical-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new KnowledgeStore(join(root,'vault'),join(root,'state'));
  await store.initialize();
  const path=join(store.vault,'source.md'),source=body=>`---\nhub_id: "fixture-source"\ntitle: "Stable title"\n---\n${body}`;
  await writeFile(path,source('Unique chrysanthemum memory'));
  assert.equal((await store.search('chrysanthemum'))[0].id,'fixture-source');
  await writeFile(path,source('Different quetzal information'));
  assert.equal((await store.search('chrysanthemum')).length,0);
  assert.equal((await store.search('quetzal'))[0].id,'fixture-source');
  await rm(path);
  assert.equal((await store.search('quetzal')).length,0);
});
