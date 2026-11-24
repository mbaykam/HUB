import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NotesStore,noteTitle} from '../packages/harness-overlay/src/host/notes-store.ts';
import {installNotes} from '../packages/harness-overlay/src/host/notes-web.ts';

const temp=()=>mkdtemp(join(tmpdir(),'hub-notes-'));

test('notes are Markdown files with a title, snippet and to-do count; changes keep the old version',async()=>{
 const root=await temp();const store=new NotesStore(root);
 try{
  const {note}=await store.save({body:'# Market\n- [ ] süt\n- [x] ekmek\nYumurta da lazım'});
  assert.equal(note.title,'Market');assert.equal(note.checklist.total,2);assert.equal(note.checklist.done,1);assert.match(note.snippet,/süt.*ekmek/);
  assert.ok((await readdir(root)).includes(note.id+'.md'),'one Markdown file per note');
  const reopened=await new NotesStore(root).read(note.id);assert.equal(reopened.body,note.body);assert.equal(reopened.createdAt,note.createdAt);
  const {note:changed}=await store.save({id:note.id,body:note.body+'\n- [ ] peynir',baseVersion:note.version});
  assert.equal(changed.checklist.total,3);
  const history=await store.history(note.id);assert.equal(history.length,1);assert.equal(history[0].body,note.body);
  const restored=await store.restoreVersion(note.id,history[0].at);assert.equal(restored.note.body,note.body);
  assert.equal(noteTitle('\n\n- [ ] **Call** mom'),'Call mom');assert.equal(noteTitle(''),'New Note');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('an edit made on an older version is kept as a second note instead of overwriting',async()=>{
 const root=await temp();const store=new NotesStore(root);
 try{
  const {note}=await store.save({body:'Plan\nA'});
  await store.save({id:note.id,body:'Plan\nA, edited on the PC',baseVersion:note.version});
  const result=await store.save({id:note.id,body:'Plan\nA, edited on the phone offline',baseVersion:note.version});
  assert.ok(result.conflict);assert.equal(result.note.body,'Plan\nA, edited on the PC');assert.equal(result.conflict.body,'Plan\nA, edited on the phone offline');
  assert.equal((await store.list()).length,2);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('folders, pinning, Recently Deleted and search',async()=>{
 const root=await temp();const store=new NotesStore(root);
 try{
  await store.createFolder('Noodle');
  const {note:a}=await store.save({body:'Noodle tedarikçileri\nIndomie, Nissin',folder:'Noodle'});
  const {note:b}=await store.save({body:'Alışveriş\nnoodle paketleri'});
  await store.setPinned(b.id,true);
  const list=await store.list();assert.equal(list[0].id,b.id,'pinned first');assert.equal(list.find(n=>n.id===a.id).folder,'Noodle');
  const found=await store.search('noodle');assert.equal(found[0].id,a.id,'a title match ranks first');assert.equal(found.length,2);
  await store.renameFolder('Noodle','Noodle standı');assert.deepEqual(await store.folders(),['Noodle standı']);
  await store.deleteFolder('Noodle standı');assert.equal((await store.read(a.id)).folder,'','its notes go back to Notes');
  await store.remove(a.id);assert.equal((await store.list()).length,1);
  const deleted=await store.deleted();assert.equal(deleted[0].id,a.id);
  await store.restore(a.id);assert.equal((await store.list()).length,2);
  await assert.rejects(store.createFolder('../escape'),/folder name/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('the phone API needs its header; the assistant can find, read and change notes when asked',async()=>{
 const root=await temp();const store=new NotesStore(root);const routes=new Map(),tools=new Map();
 const ctx={connection:{requestRejection:r=>r.headers.authorization==='fixture'?undefined:401},webServer:{register(r){routes.set(r.path,r);return()=>routes.delete(r.path);}},
  tools:{register(spec){tools.set(spec.name,spec);return()=>tools.delete(spec.name);}}};
 const off=installNotes(ctx,store);
 const call=async(path,{method='GET',headers={},body}={})=>{let code,value,raw;const req=(async function*(){if(body!==undefined)yield Buffer.from(typeof body==='string'?body:JSON.stringify(body));})();
  Object.assign(req,{method,url:path,headers:{authorization:'fixture','x-hub-notes':'1',...headers}});
  await routes.get(path.split('?')[0]).handler(req,{writeHead(c){code=c},end(s){raw=s;try{value=JSON.parse(s)}catch{}}});return {code,value,raw};};
 try{
  assert.equal((await call('/api/hub/notes',{headers:{'x-hub-notes':undefined}})).code,403);
  const saved=(await call('/api/hub/notes',{method:'POST',body:{action:'save',body:'Market\n- [ ] süt'}})).value.note;
  assert.equal((await call('/api/hub/notes')).value.notes[0].title,'Market');
  assert.equal((await call(`/api/hub/notes?id=${saved.id}`)).value.note.body,'Market\n- [ ] süt');
  const found=JSON.parse(await tools.get('hub_notes_find').execute({query:'market'}));assert.equal(found.notes[0].id,saved.id);
  await tools.get('hub_note_write').execute({id:saved.id,mode:'append',content:'- [ ] yumurta'});
  assert.equal((await store.read(saved.id)).body,'Market\n- [ ] süt\n- [ ] yumurta');
  assert.equal((await store.history(saved.id)).length,1,'the assistant\'s change can be undone');
  const created=JSON.parse(await tools.get('hub_note_write').execute({content:'Fikirler\nnoodle kartı'}));assert.ok(created.created);
  const upload=await call('/api/hub/notes/attachment',{method:'POST',headers:{'x-hub-note-ext':'png'},body:'png-bytes'});
  assert.match(upload.value.path,/^attachments\/[a-f0-9]{64}\.png$/);
  assert.equal((await call(`/api/hub/notes/attachment?name=${upload.value.name}`)).raw.toString(),'png-bytes');
  assert.deepEqual((await readdir(join(root,'attachments'))).length,1);
 }finally{off();await rm(root,{recursive:true,force:true});}
 assert.equal(tools.size,0);assert.equal(routes.size,0);
});

test('recall finds the user notes that share real words with a message',async()=>{
 const root=await temp();const store=new NotesStore(root);
 try{
  await store.save({body:'Noodle tedarikçileri\nIndomie ve Nissin fiyatları, toptan alım'});
  await store.save({body:'Market\n- [ ] süt'});
  const found=await store.related('Noodle standı için tedarikçi fiyatları ne kadar?');
  assert.equal(found.length,1);assert.equal(found[0].title,'Noodle tedarikçileri');
  assert.deepEqual(await store.related('ok'),[],'short words alone find nothing');
 }finally{await rm(root,{recursive:true,force:true});}
});