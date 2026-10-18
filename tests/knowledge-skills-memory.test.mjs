import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KnowledgeStore} from '../packages/harness-overlay/src/host/knowledge-store.ts';
import {KnowledgeSkills} from '../packages/harness-overlay/src/host/knowledge-skills.ts';
import {knowledgeMemoryIndex} from '../packages/harness-overlay/src/host/knowledge-memory-index.ts';
import {InstructionFiles} from '../packages/harness-overlay/src/host/instruction-files.ts';
import {installKnowledgeSkills} from '../packages/harness-overlay/src/host/knowledge-skill-tools.ts';

async function fixture(t){const root=await mkdtemp(join(tmpdir(),'hub-skills-memory-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new KnowledgeStore(join(root,'vault'),join(root,'state'));await store.initialize();return {root,store,skills:new KnowledgeSkills(store)};}
const input={name:'check-a-source',title:'Check a source',description:'Verify a source before citing it',content:'Open the original source. Check its date and quote the supporting passage.',requiredTools:['web_fetch'],expectedHash:null};

test('skills survive restart as readable vault records, with a domain and stale edit protection',async t=>{
  const {root,store,skills}=await fixture(t),saved=await skills.save(input),registry=await store.organization.domains();
  assert.equal(registry.maxActiveDomains,7);assert.equal(registry.domains.length,1);assert.equal(registry.domains[0].title,'Skills');
  assert.ok(registry.memberships.some(m=>m.nodeId===saved.id&&m.domainId===registry.domains[0].id));
  assert.equal((await store.note(saved.id)).content,input.content+'\n');
  assert.ok((await store.search('Verify a source')).some(n=>n.id===saved.id));
  const originalSkillDocument=await readFile(saved.path,'utf8');assert.equal(originalSkillDocument.split('\n')[0],'---');assert.equal(JSON.parse(originalSkillDocument.split('\n').find(line=>line.startsWith('hub_id: ')).slice(8)),saved.id);
  const reloaded=new KnowledgeSkills(new KnowledgeStore(store.vault,store.root));assert.equal((await reloaded.read(input.name)).id,saved.id);
  await assert.rejects(skills.save({...input,content:'Wrong overwrite'}),/changed/);
  const changed=await skills.save({...input,expectedHash:saved.hash,content:'Check the original date and save the source URL.'});assert.notEqual(changed.hash,saved.hash);
  assert.equal(await readFile(join(root,'state','skills-history',saved.id,saved.hash+'.md'),'utf8'),originalSkillDocument);
  assert.equal((await skills.list()).length,1);assert.equal((await store.organization.domains()).domains.length,1);
  await assert.rejects(skills.read('../secrets'),/skill name/);
});

test('a full domain cap cannot create an orphan skill or change the user cap',async t=>{
  const {store,skills}=await fixture(t);await store.organization.changeDomains(0,[{type:'create',ref:'new-projects',title:'Projects'}],1);
  await assert.rejects(skills.save(input),/active|limit|cap/i);
  assert.equal((await skills.list()).length,0);assert.equal((await store.organization.domains()).maxActiveDomains,1);
});

test('memory.md regenerates on domain/skill changes and stays read-only and bounded',async t=>{
  const {root,store,skills}=await fixture(t),files=new InstructionFiles(join(root,'instructions'));await files.load();
  const soul=files.files().find(f=>f.id==='SOUL.md');await files.save('SOUL.md',soul.hash,'Keep my own instructions.');
  files.registerManaged('memory.md',async()=>knowledgeMemoryIndex((await store.organization.state()).domainState,await skills.list()));
  await files.refresh();const empty=files.files().find(f=>f.id==='memory.md');assert.equal(empty.editable,false);assert.match(empty.content,/No saved skills/);
  const first=(await lstat(empty.path)).mtimeMs;await files.refresh();assert.equal((await lstat(empty.path)).mtimeMs,first);
  await skills.save(input);await files.refresh();assert.match(files.text('memory.md'),/check-a-source/);assert.match(files.text('memory.md'),/Skills/);assert.notEqual(files.text('memory.md'),empty.content);
  const registry=await store.organization.domains();await store.organization.changeDomains(registry.revision,[{type:'rename',id:registry.domains[0].id,title:'Reusable skills',aliases:['Skills']}]);
  await files.refresh();assert.match(files.text('memory.md'),/Reusable skills/);assert.equal(files.text('SOUL.md'),'Keep my own instructions.');
  await assert.rejects(files.save('memory.md',empty.hash,'Manual overwrite'),/Invalid/);
  const many={...registry,domains:Array.from({length:1000},(_,i)=>({...registry.domains[0],id:String(i),title:'Long domain '+i+' '.repeat(40)+'x'.repeat(200)}))};
  assert.ok(Buffer.byteLength(knowledgeMemoryIndex(many,Array.from({length:100},(_,i)=>({name:'skill-'+i,title:'x'.repeat(100)})) ))<16000);
  assert.ok(Buffer.byteLength(knowledgeMemoryIndex({...many,domains:many.domains.map(d=>({...d,title:'界'.repeat(100)}))},[]))<16000);
});

test('character permissions apply to skills and generated memory visibility',async t=>{
  const {root,store}=await fixture(t),files=new InstructionFiles(join(root,'instructions'));await files.load();
  const listeners=new Map(),routes=new Map(),tools=new Map();let selected={id:'character',tools:{mode:'allow',names:['hub_skill_read']}};
  const manager={instructions:files,effectiveCharacter:()=>selected};
  const ctx={hubCharacters:manager,on:(name,handler)=>{listeners.set(name,handler);return()=>listeners.delete(name);},webServer:{register:route=>{routes.set(route.path,route);return()=>{};}},connection:{requestRejection:()=>undefined}};
  const dispose=installKnowledgeSkills(ctx,store,Promise.resolve());t.after(dispose);
  const agent={id:'hub-eval-skills',session:{header:{id:'hub-eval-skills'}},ctx:{tools:{register:tool=>{tools.set(tool.name,tool);return()=>tools.delete(tool.name);}}}};
  listeners.get('agent/created')({agent});await files.refresh();
  assert.equal(files.visible('memory.md',{scope:agent}),false);
  await assert.rejects(tools.get('hub_skill_save').execute(input),/disabled/);assert.deepEqual(await new KnowledgeSkills(store).list(),[]);
  selected={id:'character',tools:{mode:'inherit'}};assert.equal(files.visible('memory.md',{scope:agent}),true);
  ctx.tools={schemas:()=>[]};assert.equal(files.visible('memory.md',{scope:agent}),false,'A task restriction must also hide the private routing index');delete ctx.tools;
  const saved=JSON.parse(await tools.get('hub_skill_save').execute(input));assert.equal(saved.permissionsChanged,false);
  const loaded=JSON.parse(await tools.get('hub_skill_read').execute({name:input.name}));assert.equal(loaded.content,input.content+'\n');assert.match(loaded.authority,/permissions/);
  const index=JSON.parse(await tools.get('hub_memory_index').execute({collection:'skills'}));assert.equal(index.records[0].name,input.name);assert.equal(index.nextOffset,null);
  assert.ok(routes.has('/api/hub/skills'));assert.equal(await readFile(join(root,'instructions','memory.md'),'utf8'),files.text('memory.md'));
});

test('renaming the Skills domain preserves its identity and skill provenance',async t=>{
  const {store,skills}=await fixture(t),origin={kind:'character',sessionId:'hub-eval-learning',characterId:'mira'},saved=await skills.save(input,origin),registry=await store.organization.domains();
  await store.organization.changeDomains(registry.revision,[{type:'rename',id:saved.domainId,title:'Workflow library',aliases:[]}]);
  const updated=await skills.save({...input,expectedHash:saved.hash,content:'Updated workflow.'});
  const after=await store.organization.domains();assert.equal(after.domains.length,1);assert.equal(updated.domainId,saved.domainId);assert.deepEqual(updated.source,origin);assert.deepEqual(updated.updatedBy,{kind:'user'});assert.ok(after.memberships.some(m=>m.nodeId===saved.id&&m.domainId===saved.domainId));
});

test('one malformed skill does not disable the remaining catalog or get overwritten',async t=>{
  const {store,skills}=await fixture(t),good=await skills.save(input),bad=await skills.save({...input,name:'other-workflow',title:'Other workflow'});await writeFile(bad.path,'Malformed metadata; leave this exact text untouched.');
  const catalog=await skills.catalog();assert.equal(catalog.skills[0].id,good.id);assert.equal(catalog.issues.length,1);assert.equal(catalog.issues[0].name,bad.name);assert.equal(await readFile(bad.path,'utf8'),'Malformed metadata; leave this exact text untouched.');
  await assert.rejects(skills.save({...input,name:bad.name}),/metadata/);assert.equal((await skills.list()).length,1);
});

test('an interrupted skill save recovers its domain assignment without overwriting later external edits',async t=>{
  const {store,skills}=await fixture(t),registryBefore=await store.organization.state(),saved=await skills.save(input),skillBodyAfter=await readFile(saved.path,'utf8'),registryAfter=await store.organization.state();
  const pending={version:1,name:input.name,before:null,after:skillBodyAfter,registryBefore,registryAfter};
  await writeFile(join(store.root,'organization.json'),JSON.stringify(registryBefore));await writeFile(join(store.root,'skills-pending.json'),JSON.stringify(pending));
  await new KnowledgeSkills(store).recover();assert.ok((await store.organization.domains()).memberships.some(m=>m.nodeId===saved.id));await assert.rejects(readFile(join(store.root,'skills-pending.json')),{code:'ENOENT'});
  await writeFile(join(store.root,'skills-pending.json'),JSON.stringify(pending));await writeFile(saved.path,skillBodyAfter+'An external edit.\n');
  await assert.rejects(new KnowledgeSkills(store).recover(),/conflicts/);assert.equal(await readFile(saved.path,'utf8'),skillBodyAfter+'An external edit.\n');assert.equal((await store.organization.domains()).revision,registryAfter.domainState.revision);
});
