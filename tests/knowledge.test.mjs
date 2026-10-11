import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KnowledgeStore,validatePlan} from '../packages/harness-overlay/src/host/knowledge-store.ts';
import {KnowledgeCurator,bindKnowledgePlan,redactKnowledgeSecrets} from '../packages/harness-overlay/src/host/knowledge-curator.ts';
import {boundedKnowledgeRecall} from '../packages/harness-overlay/src/host/knowledge-recall.ts';
import {knowledgeTurnSources} from '../packages/harness-overlay/src/host/knowledge-episodes.ts';
import {previewKnowledgeImport} from '../packages/harness-overlay/src/host/knowledge-import.ts';
const source={id:'source-one',completedAt:2000000000000,channel:'hub',content:'## User\nHUB projesi için Telegram kullanacağım.'};
const change=(id,title,body,links=[])=>({id,title,body,expectedHash:null,links});
const plan=changes=>({decision:'update-knowledge',reason:'Useful preference',changes});
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'hub-knowledge-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new KnowledgeStore(join(root,'vault'),join(root,'state'));await store.initialize();return store;}
test('useful inline links connect real notes without link lists or visible technical metadata',async t=>{
 const s=await fixture(t);await s.apply(plan([change('note-hub','HUB','HUB projesinde Telegram hızlı erişim için kullanılacak.',[{targetId:'note-telegram',phrase:'Telegram'}]),change('note-telegram','Telegram','Telegram, HUB ile hızlı yazılı konuşmanın ana kanalıdır.')]),source);
 const graph=await s.graph();assert.equal(graph.nodes.length,2);assert.deepEqual(graph.edges,[{source:'note-hub',target:'note-telegram',label:''}]);
 const note=await s.note('note-hub');assert.match(note.content,/\[\[Notes\/Telegram\|Telegram\]\]/);assert.doesNotMatch(note.content,/part_of|Related notes|source-one|source:/);assert.equal(note.sources[0].id,source.id);assert.equal((await s.note('note-telegram')).backlinks[0].id,'note-hub');
});
test('reject dangling, self, invented, empty and filler relations before any vault write',async t=>{
 const s=await fixture(t);
 for(const c of [change('note-hub','HUB','Telegram for useful chat.',[{targetId:'missing-note',phrase:'Telegram'}]),change('note-hub','HUB','HUB for useful chat.',[{targetId:'note-hub',phrase:'HUB'}]),change('note-hub','HUB','Use [[missing]] for chat.'),change('note-hub','HUB',''),change('note-hub','HUB','Useful text.\nRelated notes: [[Notes/Telegram]]')])await assert.rejects(s.apply(plan([c]),source));
 assert.equal((await s.scan()).length,0);
});
test('link hints cannot insert new filler prose or links in headings/code',async t=>{
 const s=await fixture(t);await s.apply(plan([change('note-tg','Telegram','Telegram is a messaging service.')]),source);
 for(const body of ['A useful note about a different subject.','# Telegram\nA useful unrelated note.','```\nTelegram\n```\nUseful prose elsewhere.'])await assert.rejects(s.apply(plan([change('note-new','Other',body,[{targetId:'note-tg',phrase:'Telegram'}])]),{...source,id:'other'}));
});
test('CAS preserves external Obsidian edits and exact human frontmatter',async t=>{
 const s=await fixture(t);await mkdir(join(s.vault,'Notes'));await writeFile(join(s.vault,'Notes','Human.md'),'---\nhub_id: human-note\ntitle: Human\ncustom: keep-me\n---\nMy personal sentence.\n');const old=(await s.scan())[0];
 const c={...change('human-note','Human','My personal sentence. Another useful addition.'),expectedHash:old.hash};await writeFile(join(s.vault,'Notes','Human.md'),old.raw+'Human change.\n');await assert.rejects(s.apply(plan([c]),source));assert.equal((await s.scan())[0].raw,old.raw+'Human change.\n');
 c.expectedHash=(await s.scan())[0].hash;c.body+=' Human change.';await s.apply(plan([c]),source);assert.equal((await s.scan())[0].front,old.front);
});
test('old import cannot overwrite a newer AI correction and forget policy uses real Basic Memory filename',async t=>{
 const s=await fixture(t);await s.apply(plan([change('note-pref','Preference','The user now prefers Telegram.')]),source);const n=(await s.scan())[0];await assert.rejects(s.apply(plan([{...change(n.id,n.title,'The user used WhatsApp previously.'),expectedHash:n.hash}]),{...source,id:'older',completedAt:source.completedAt-1000}));
 await mkdir(join(s.vault,'control'));await writeFile(join(s.vault,'control','Memory policy.md'),'---\ntitle: Memory policy\n---\n{"forgetBefore":2000000000001}');await assert.rejects(s.apply(plan([change('new-note','Old','An old fact that must stay forgotten.')]),source));
});
test('undo refuses to clobber newer human edits and otherwise restores exact snapshots',async t=>{
 const s=await fixture(t);const revision=await s.apply(plan([change('note-hub','HUB','Useful project note to undo.')]),source);await s.undo(revision);assert.equal((await s.scan()).length,0);
 const next=await s.apply(plan([change('note-next','Next','Useful project note to keep.')]),{...source,id:'next'});await writeFile(join(s.vault,'Notes','Next.md'),'A human has rewritten this note.');await assert.rejects(s.undo(next));assert.equal(await readFile(join(s.vault,'Notes','Next.md'),'utf8'),'A human has rewritten this note.');
});
test('multifile preflight conflict causes zero writes',async t=>{
 const s=await fixture(t);await s.apply(plan([change('note-a','First','First useful content.'),change('note-b','Second','Second useful content.')]),source);const [a,b]=await s.scan();const c=[{...change(a.id,a.title,'Revised first useful note.'),expectedHash:a.hash},{...change(b.id,b.title,'Revised second useful note.'),expectedHash:b.hash}];await writeFile(join(s.vault,b.path),'An intervening human edit.');await assert.rejects(s.apply(plan(c),{...source,id:'new'}));assert.equal(await readFile(join(s.vault,a.path),'utf8'),a.raw);
});
test('queue is durable and duplicate-safe across restart; greeting can skip with no nodes',async t=>{
 const s=await fixture(t),generate=async()=>JSON.stringify({decision:'skip',reason:'Greeting only',changes:[]});const c=new KnowledgeCurator(s,generate);await c.initialize();assert.equal(await c.enqueue(source),true);assert.equal(await c.enqueue(source),false);await c.tick(true);assert.equal((await s.scan()).length,0);assert.equal(c.jobs.get(source.id).reason,'Greeting only');await c.dispose();
 const resumed=new KnowledgeCurator(s,generate);await resumed.initialize();assert.equal(await resumed.enqueue(source),false);assert.equal(resumed.jobs.get(source.id).status,'done');await resumed.dispose();
});
test('budget reserves before inference and never silently switches model',async t=>{
 const s=await fixture(t);let called=0;const c=new KnowledgeCurator(s,async()=>{called++;throw Error('provider failed');});await c.initialize();await c.configure({...c.settings,dailyBudget:.0000001});await c.enqueue(source);await c.tick(true);assert.equal(called,0);assert.equal(c.status,'budget-paused');await c.configure({...c.settings,dailyBudget:.1});await c.tick(true);assert.equal(called,1);assert.equal(c.jobs.get(source.id).status,'failed');assert.ok((await c.snapshot()).todayEstimatedCost>0);await c.dispose();
});
test('malformed model output creates no knowledge notes',async t=>{
 const s=await fixture(t),c=new KnowledgeCurator(s,async()=>JSON.stringify(plan([change('bad-node','Bad','Use [[nonexistent]] for graph decoration.')])));await c.initialize();await c.enqueue(source);await c.tick(true);assert.equal(c.jobs.get(source.id).status,'failed');assert.equal((await s.scan()).length,0);await c.dispose();
});
test('ChatGPT import respects branches, message roles, dates and duplicate source identities',()=>{
 const history=[{id:'chat-1',title:'My project',create_time:1700000000,current_node:'a2',mapping:{u1:{parent:null,children:['a1','a2'],message:{id:'u1',author:{role:'user'},create_time:1700000000,content:{parts:['I prefer Telegram.']}}},a1:{parent:'u1',children:[],message:{id:'a1',author:{role:'assistant'},create_time:1700000001,content:{parts:['First proposal']}}},a2:{parent:'u1',children:[],message:{id:'a2',author:{role:'assistant'},create_time:1700000002,content:{parts:['Other proposal']}}}}}];
 const p=previewKnowledgeImport([{name:'conversations.json',body:JSON.stringify(history)}]);assert.equal(p.conversations,1);assert.equal(p.messages,3);assert.equal(p.sources.length,3);assert.equal(new Set(p.sources.map(s=>s.id)).size,3);assert.equal(p.sources[0].completedAt,1700000000000);assert.match(p.sources[1].content,/Assistant \(proposal, not a user fact\)/);assert.deepEqual(previewKnowledgeImport([{name:'conversations.json',body:JSON.stringify(history)}]).sources,p.sources);
});
test('Gemini activity import skips untrustworthy dates and never manufactures missing replies',()=>{
 const p=previewKnowledgeImport([{name:'MyActivity.json',body:JSON.stringify([{title:'Prompted Remember my cat allergy',time:'2024-01-01T12:00:00Z',products:['Gemini Apps']},{title:'Prompted no date',products:['Gemini Apps']},{title:'YouTube video',time:'2024-01-02T12:00:00Z',products:['YouTube']}])}]);assert.equal(p.sources.length,1);assert.match(p.sources[0].content,/## User/);assert.doesNotMatch(p.sources[0].content,/## Assistant/);assert.equal(p.skipped,2);assert.ok(p.warnings.length);
});
test('failed interrupted transaction recovers only exact before/after files',async t=>{
 const s=await fixture(t);const id='00000000-0000-4000-8000-000000000001';await writeFile(join(s.root,'journal',id+'.json'),JSON.stringify({id,state:'prepared',source,changes:[{id:'note-recover',path:'Notes/Recover.md',before:null,after:'---\nhub_id: note-recover\ntitle: Recover\n---\nUseful recovery note.\n'}]}));await s.initialize();assert.equal((await s.scan()).length,1);assert.equal(JSON.parse(await readFile(join(s.root,'journal',id+'.json'),'utf8')).state,'committed');
});
test('host binds missing new-note bookkeeping and existing hashes without allowing unread updates',()=>{
 const p=bindKnowledgePlan({decision:'update-knowledge',reason:'Useful',changes:[{id:'new-main',title:'HUB',body:'HUB uses Telegram for quick conversations.',links:[{targetId:'new-telegram',phrase:'Telegram'}]},{id:'new-telegram',title:'Telegram',body:'Telegram is the main chat channel.'}]},[],[]);assert.match(p.changes[0].id,/^[0-9a-f-]{36}$/);assert.equal(p.changes[0].expectedHash,null);assert.equal(p.changes[0].links[0].targetId,p.changes[1].id);
 const raw=plan([{...change('existing-note','Project','The full existing note, preserved.'),expectedHash:undefined}]);const bound=bindKnowledgePlan(raw,[{id:'existing-note',hash:'a'.repeat(64)}],[{id:'existing-note'}]);assert.equal(bound.changes[0].expectedHash,'a'.repeat(64));assert.throws(()=>bindKnowledgePlan(raw,[],[{id:'existing-note'}]));raw.changes[0].expectedHash='b'.repeat(64);assert.equal(bindKnowledgePlan(raw,[{id:'existing-note',hash:'a'.repeat(64)}],[{id:'existing-note'}]).changes[0].expectedHash,'a'.repeat(64));
});
test('link-only lists and metadata headings are rejected even with valid targets',async t=>{
 const s=await fixture(t);await s.apply(plan([change('note-tg','Telegram','Telegram is the useful chat channel.')]),source);
 for(const body of ['Useful project description.\n\n## Related notes\nTelegram','Useful project description.\n\n- Telegram'])await assert.rejects(s.apply(plan([change('note-main','HUB',body,[{targetId:'note-tg',phrase:'Telegram'}])]),{...source,id:'second'}));assert.equal((await s.scan()).length,1);
});
test('a hung knowledge transport cannot stall chat and late results stay outside recall',async()=>{
 const kept=setTimeout(()=>{},100);let complete;const slow=new Promise(resolve=>complete=resolve),started=Date.now();await assert.rejects(boundedKnowledgeRecall(slow,AbortSignal.timeout(20)));assert.ok(Date.now()-started<100);complete('late context');clearTimeout(kept);await assert.rejects(boundedKnowledgeRecall(Promise.reject(Error('transport failure')),AbortSignal.abort()));
});
test('known credential formats are redacted from curator inputs and forbidden in notes',()=>{
 const sample='api_key=synthetic-key password: synthetic-password Bearer synthetic-session 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk sk-or-v1-syntheticcredential123456789';const clean=redactKnowledgeSecrets(sample);assert.doesNotMatch(clean,/synthetic-key|synthetic-password|synthetic-session|syntheticcredential|ABCDEFGHIJKLMNOPQRSTUVWXYZ/);assert.match(clean,/REDACTED/);assert.equal(redactKnowledgeSecrets(clean),clean);assert.throws(()=>bindKnowledgePlan(plan([change('new-note','Secrets','password: synthetic-password')]),[],[]));
});
test('historical additions preserve the complete current note and carry their real date',async t=>{
 const s=await fixture(t);await s.apply(plan([change('note-prefs','Preferences','Today the user prefers Telegram.')]),source);const n=(await s.scan())[0],older={...source,id:'old-history',completedAt:source.completedAt-86400000},date=new Date(older.completedAt).toISOString().slice(0,10);
 await assert.rejects(s.apply(plan([{...change(n.id,n.title,n.body.trim()+'\n\nThe user used WhatsApp previously.'),expectedHash:n.hash}]),older));
 await s.apply(plan([{...change(n.id,n.title,n.body.trim()+`\n\n## History · ${date}\nThe user previously used WhatsApp.`),expectedHash:n.hash}]),older);const next=await s.note(n.id);assert.match(next.content,/Today the user prefers Telegram/);assert.ok(next.content.includes(date));
});
test('long native messages preserve typed authorship in every chunk and workers cannot impersonate user facts',()=>{
 const start={type:'turn/start',data:{turn:1}},end={type:'turn/end',time:Date.now(),data:{turn:1,reason:{kind:'completed'}}},user={type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'A'.repeat(21000)}]}},assistant={type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:'B'.repeat(20000)}]}}};
 const parts=knowledgeTurnSources({id:'normal'},[start,user,assistant,end],end);assert.ok(parts.length>1);for(const p of parts){const messages=JSON.parse(p.content.split('CURRENT MESSAGES (author roles preserved; task is not a fresh human statement, assistant output is not proof of user facts or completed actions): ')[1]);assert.ok(messages.every(m=>['user','assistant'].includes(m.role)));assert.ok(p.content.length<24000);}const worker=knowledgeTurnSources({id:'worker',origin:'subagent'},[start,assistant,end],end);assert.ok(worker.length);assert.equal(worker[0].channel,'hub-worker-result');assert.match(worker[0].content,/"role":"assistant"/);assert.equal(knowledgeTurnSources({id:'hub-memory-maintenance',origin:'subagent'},[start,assistant,end],end).length,0);
});
test('native fork imports omit inherited turns and short confirmations keep prior proposal context',()=>{
 const end={type:'turn/end',time:Date.now(),data:{turn:1,reason:{kind:'completed'}}};const events=[{type:'turn/start',data:{turn:0}},{type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'An inherited preference'}]}},{type:'assistant/message',data:{turn:0,message:{content:[{type:'text',text:'Use Telegram as the main channel?'}]}}},{type:'turn/start',data:{turn:1}},{type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'Yes'}]}},{type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:'Confirmed'}]}}},end];const normal=knowledgeTurnSources({id:'normal'},events,end);assert.match(normal[0].content,/Use Telegram/);const fork=knowledgeTurnSources({id:'fork'},events,end,3);assert.doesNotMatch(fork[0].content,/An inherited preference/);assert.match(fork[0].content,/Yes/);
});
test('forgetting a rendered linked sentence removes the whole fact without leaving blank wiki aliases',async t=>{
 const s=await fixture(t);await s.apply(plan([change('note-main','HUB','Telegram is my quick chat channel.',[{targetId:'note-tg',phrase:'Telegram'}]),change('note-tg','Telegram','Telegram is a messaging app.')]),source);const n=await s.note('note-main');await s.forget(n.id,n.hash,'Telegram is my quick chat channel.');const after=await s.note(n.id);assert.doesNotMatch(after.content,/\[\[|quick chat/);assert.ok(await s.cutoff()>0);
});
test('review mode survives restart and writes only after approval, with no extra model call',async t=>{
 const s=await fixture(t);let calls=0;const generate=async()=>{calls++;return JSON.stringify(plan([change('new-topic','HUB','HUB is the useful project we are planning.')]))};const c=new KnowledgeCurator(s,generate);await c.initialize();await c.configure({...c.settings,mode:'review'});await c.enqueue(source);await c.tick(true);assert.equal((await s.scan()).length,0);assert.equal(c.jobs.get(source.id).status,'review');await c.dispose();const resumed=new KnowledgeCurator(s,generate);await resumed.initialize();assert.equal((await resumed.review(source.id)).plan.changes.length,1);await resumed.decideReview(source.id,true);assert.equal((await s.scan()).length,1);assert.equal(calls,1);await resumed.dispose();
});
test('manual mode and channel filters stop automatic inference and preserve the vault',async t=>{
 const s=await fixture(t);let calls=0;const c=new KnowledgeCurator(s,async()=>{calls++;return JSON.stringify({decision:'skip',reason:'Greeting',changes:[]})});await c.initialize();await c.configure({...c.settings,mode:'manual',channels:['telegram']});await c.enqueue(source);await c.tick();assert.equal(calls,0);await c.tick(true);assert.equal(calls,0);assert.equal(c.jobs.get(source.id).status,'done');await c.enqueue({...source,id:'tg-source',channel:'telegram'});await c.tick(true);assert.equal(calls,1);assert.equal((await s.scan()).length,0);await c.dispose();
});
test('a month budget is enforced even when daily budget is available',async t=>{
 const s=await fixture(t);let calls=0;const c=new KnowledgeCurator(s,async()=>{calls++;return '{}'});await c.initialize();await c.configure({...c.settings,dailyBudget:1,monthlyBudget:.00000001});await c.enqueue(source);await c.tick(true);assert.equal(calls,0);assert.equal(c.status,'budget-paused');await c.dispose();
});
test('host-owned hashes preserve human edits despite a model mistyping the hash; empty unchanged placeholders are no-ops',async t=>{
 const s=await fixture(t);await s.apply(plan([change('note-edit','Editable','Preserve my human content.')]),source);const old=(await s.scan())[0];const p=bindKnowledgePlan(plan([{...change(old.id,old.title,'Preserve my human content. Add a detail.'),expectedHash:'bad-model-echo'}]),[old],[old]);await writeFile(join(s.vault,old.path),old.raw+'Human change.');await assert.rejects(s.apply(p,{...source,id:'updated'}));const noop=bindKnowledgePlan(plan([{id:'blank',title:'Blank',body:'',links:[]}]),[{id:'blank',hash:'a'.repeat(64),body:''}],[{id:'blank'}]);assert.equal(noop.decision,'skip');assert.equal(noop.changes.length,0);
});
test('invalid relationship suggestions never block valid prose or produce fake graph edges',async t=>{
 const s=await fixture(t);const p=bindKnowledgePlan(plan([change('new-hub','HUB','HUB will use Telegram for quick conversations.',[{targetId:'new-hub',phrase:'HUB'},{targetId:'unknown',phrase:'Telegram'},{targetId:'new-tg',phrase:'Telegram'}]),change('new-tg','Telegram','Telegram is the quick written chat channel.')]),[],[]);assert.equal(p.changes[0].links.length,1);assert.match(p.reason,/2 uygunsuz/);await s.apply(p,source);assert.equal((await s.graph()).nodes.length,2);assert.equal((await s.graph()).edges.length,1);
});
