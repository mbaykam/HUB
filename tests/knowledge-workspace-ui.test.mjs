import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {registerHooks} from 'node:module';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';

// Exercise the actual workspace and graph data model; JSDOM has no canvas.
// Only the renderer is replaced with Cytoscape's own headless renderer.
const graphModule=import.meta.resolve('cytoscape');
const rendererHook=registerHooks({resolve(specifier,context,next){
  if(specifier==='cytoscape'&&context.parentURL?.endsWith('/knowledge-workspace.ts'))return {
    shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(`import cy from ${JSON.stringify(graphModule)}; export default options=>{const instance=cy({...options,headless:true});options.container.fixtureCy=instance;return instance;};`)
  };
  return next(specifier,context);
}});
const {openKnowledgeWorkspace}=await import('../packages/harness-overlay/src/client/memory/knowledge-workspace.ts');
rendererHook.deregister();

const noteId='00000000-0000-4000-8000-000000000001';
const graph={nodes:[{id:noteId,title:'Reading list',permalink:'Notes/Reading list'}],edges:[]};
const button=(root,label)=>[...root.querySelectorAll('button')].find(node=>node.textContent===label);
async function fixture(t,options={}){
  const displayedGraph=options.graph??graph;
  const dom=new JSDOM('<main></main>',{url:'https://hub.test/',pretendToBeVisual:true});
  const view=dom.window,root=view.document,requests=[];
  Object.defineProperty(view,'innerWidth',{value:390,configurable:true});
  view.ResizeObserver=class{observe(){}disconnect(){}};
  view.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  view.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new view.Event('close'));};
  const note={...displayedGraph.nodes[0],content:'Original reading plan.',hash:'a'.repeat(64),protected:!!options.protected,links:[],backlinks:[],sources:[],assets:[]};
  view.fetch=async(url,request)=>{
    requests.push({url,...request});
    if(request.method!=='GET'){
      assert.equal(request.method,'POST');assert.ok(options.save,'Navigation must never write the vault');
      const command=JSON.parse(request.body);assert.equal(command.action,'save-note');assert.equal(command.id,noteId);
      if(options.save==='fail')return {ok:false,json:async()=>({})};
      note.content=command.content;note.hash='b'.repeat(64);
      return {ok:true,json:async()=>structuredClone(note)};
    }
    const query=new URL(url,'https://hub.test').searchParams;
    const value=query.get('view')==='note'?(options.noteDetails?.[query.get('id')]??note):query.get('view')==='search'?{nodes:displayedGraph.nodes}:query.get('view')==='assets'?{assets:[]}:query.get('view')==='graph'?displayedGraph:{vault:'C:/fixture/vault'};
    return {ok:true,json:async()=>structuredClone(value)};
  };
  const dispose=openKnowledgeWorkspace(root.querySelector('main'),root,displayedGraph,()=>{});
  t.after(()=>{dispose();dom.window.close();});
  if(options.openNote!==false){
    button(root,'Notes').click();
    root.querySelector('aside').scrollTop=180;
    button(root,'Reading list').click();await setImmediate();
    assert.equal(root.querySelector('dialog').dataset.mobilePane,'note');
  }
  return {view,root,requests,note};
}

test('returning from a searched Knowledge note restores the note list, query and reading position',async t=>{
  const {view,root}=await fixture(t);
  button(root,'‹ Back').click();
  const search=root.querySelector('[aria-label="Search knowledge"]');
  search.value='Reading';search.dispatchEvent(new view.Event('input'));
  await new Promise(resolve=>view.setTimeout(resolve,280));
  const sidebar=root.querySelector('aside');sidebar.scrollTop=180;
  button(root,'Reading list').focus();button(root,'Reading list').click();await setImmediate();
  button(root,'‹ Back').click();
  assert.equal(root.querySelector('dialog').dataset.mobilePane,'files');
  assert.equal(search.value,'Reading');
  assert.equal(sidebar.scrollTop,180);
  assert.equal(root.querySelector('[data-graph-note]').hidden,true);
});

test('a source exposes connections through More actions without changing its text',async t=>{
 const {root,requests,note}=await fixture(t);const details=[...root.querySelectorAll('[data-graph-note] details')].find(d=>d.querySelector('summary')?.textContent==='Links, sources & history'),more=root.querySelector('[data-graph-note] [data-hub-action-menu]');assert.equal(details.open,false);assert.equal(more.open,false);more.querySelector('summary').click();assert.equal(more.open,true);button(root,'Connections').click();assert.equal(more.open,false);assert.equal(details.open,true);assert.equal(requests.filter(request=>request.method==='POST').length,0);assert.equal(note.content,'Original reading plan.');
});

test('unsaved Knowledge edits survive navigation and closing until explicitly discarded',async t=>{
  const {view,root,requests,note}=await fixture(t),dialog=root.querySelector('dialog');
  button(root,'Edit').click();
  const editor=root.querySelector('[aria-label="Note Markdown"]');
  editor.value=note.content+'\nUnsaved fixture addition.';editor.dispatchEvent(new view.Event('input'));
  for(const label of ['Graph','Notes','Chat archive','Attachments','Home','‹ Back']){
    button(root,label).click();await setImmediate();
    assert.equal(dialog.open,true,label+' must not close a dirty note');
    assert.equal(dialog.dataset.mobilePane,'note',label+' must not hide a dirty note');
    assert.equal(editor.hidden,false);
    assert.match(editor.value,/Unsaved fixture addition/);
    assert.match(root.querySelector('[role=status]').textContent,/save|discard/i);
  }
  const escape=new view.Event('cancel',{cancelable:true});dialog.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented,true);
  assert.equal(editor.hidden,false);
  button(root,'Discard changes').click();
  assert.equal(editor.hidden,true);assert.equal(editor.value,note.content);
  assert.equal(button(root,'Save').hidden,true);
  // A stale hidden Save must not submit text from a discarded editor.
  button(root,'Save').click();await setImmediate();
  button(root,'Graph').click();assert.equal(dialog.dataset.mobilePane,'graph');
  button(root,'Home').click();assert.equal(root.querySelector('dialog'),null);
  assert.ok(requests.every(request=>request.method==='GET'));
});

test('leaving an unchanged Knowledge editor hides Save and returns to the original list',async t=>{
  const {root}=await fixture(t);
  button(root,'Edit').click();button(root,'‹ Back').click();
  assert.equal(root.querySelector('dialog').dataset.mobilePane,'files');
  assert.equal(button(root,'Save').hidden,true);
  button(root,'Reading list').click();await setImmediate();
  assert.equal(button(root,'Edit').textContent,'Edit');
});

test('an explicit Knowledge save updates the note once and allows navigation',async t=>{
  const {root,requests}=await fixture(t,{save:'ok'});
  button(root,'Edit').click();root.querySelector('[aria-label="Note Markdown"]').value='Human-authored revision.';
  button(root,'Save').click();await setImmediate();
  assert.equal(requests.filter(request=>request.method==='POST').length,1);
  assert.equal(button(root,'Edit').textContent,'Edit');assert.equal(button(root,'Save').hidden,true);
  assert.match(root.querySelector('[data-graph-note]').textContent,/Human-authored revision/);
  button(root,'Save').click();await setImmediate();
  assert.equal(requests.filter(request=>request.method==='POST').length,1);
  button(root,'‹ Back').click();assert.equal(root.querySelector('dialog').dataset.mobilePane,'files');
});

test('a failed Knowledge save keeps the draft and navigation protection',async t=>{
  const {root}=await fixture(t,{save:'fail'});
  button(root,'Edit').click();const editor=root.querySelector('[aria-label="Note Markdown"]');editor.value='Keep my failed-save draft.';
  button(root,'Save').click();await setImmediate();button(root,'Home').click();
  assert.equal(root.querySelector('dialog').open,true);assert.equal(editor.hidden,false);
  assert.equal(editor.value,'Keep my failed-save draft.');assert.equal(button(root,'Save').disabled,false);
});

test('original conversation records remain protected from manual note editing',async t=>{
  const {root,requests}=await fixture(t,{protected:true});
  assert.equal(button(root,'Edit').disabled,true);button(root,'Edit').click();
  assert.equal(root.querySelector('[aria-label="Note Markdown"]').hidden,true);
  assert.ok(requests.every(request=>request.method==='GET'));
});

const sparseGraph={nodes:Array.from({length:98},(_,i)=>({id:'fixture-source-'+i,title:'Synthetic source '+(i+1),permalink:'Notes/Source '+i})),edges:[{source:'fixture-source-0',target:'fixture-source-1'}]};
const frames=view=>new Promise(resolve=>view.requestAnimationFrame(()=>view.requestAnimationFrame(resolve)));
function measurableCanvas(root){const canvas=root.querySelector('[data-graph-canvas]');Object.defineProperties(canvas,{clientWidth:{get:()=>canvas.hidden?0:360},clientHeight:{get:()=>canvas.hidden?0:612}});return canvas;}

test('98 sparse records have a two-dimensional layout and their own working zoom controls',async t=>{
  const {view,root}=await fixture(t,{graph:sparseGraph,openNote:false}),canvas=measurableCanvas(root),cy=canvas.fixtureCy;
  assert.equal(canvas.hidden,false);
  assert.equal(root.querySelector(".knowledge-color-key"),null);
  const points=cy.nodes().map(n=>n.position()),xs=points.map(p=>p.x),ys=points.map(p=>p.y),ratio=(Math.max(...xs)-Math.min(...xs))/(Math.max(...ys)-Math.min(...ys));
  assert.equal(points.length,98);assert.equal(cy.edges().length,1);
  assert.ok(points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)));
  assert.ok(ratio>.4&&ratio<2.5,'sparse sources must occupy an area, not a four-column vertical strip');
  await frames(view);
  assert.equal(canvas.hidden,false);assert.equal(root.querySelector('[data-knowledge-cloud]').hidden,true);
  assert.equal(root.querySelector('.knowledge-brain-controls').hidden,true);
  const controls=root.querySelector('[aria-label="2D graph controls"]');assert.equal(controls.hidden,false);
  const zoom=cy.zoom();controls.querySelector('[aria-label="Zoom in"]').click();assert.ok(cy.zoom()>zoom);
  controls.querySelector('[aria-label="Zoom out"]').click();assert.ok(Math.abs(cy.zoom()-zoom)<1e-8);
  assert.deepEqual(cy.nodes().map(n=>n.position()),points,'fitting a newly visible canvas must not repack the sources');
  button(root,'2D').click();assert.equal(controls.hidden,true);assert.equal(root.querySelector('.knowledge-brain-controls').hidden,false);
});

test('2D source positions survive manual dragging, note navigation and reopening',async t=>{
  const {view,root,requests}=await fixture(t,{graph:sparseGraph,openNote:false}),canvas=measurableCanvas(root),cy=canvas.fixtureCy;
  await frames(view);
  const node=cy.getElementById('fixture-source-5');node.position({x:777,y:888});node.emit('dragfree');
  const saved=JSON.parse(view.localStorage.getItem('hub-knowledge-positions-v1'));saved['other-dataset-source']={x:12,y:34};view.localStorage.setItem('hub-knowledge-positions-v1',JSON.stringify(saved));
  button(root,'Notes').click();button(root,'Graph').click();await frames(view);
  assert.deepEqual(node.position(),{x:777,y:888});
  assert.deepEqual(JSON.parse(view.localStorage.getItem('hub-knowledge-positions-v1'))['fixture-source-5'],{x:777,y:888});
  button(root,'Home').click();const dispose=openKnowledgeWorkspace(root.querySelector('main'),root,sparseGraph,()=>{});t.after(dispose);
  const reopened=measurableCanvas(root);await frames(view);
  assert.deepEqual(reopened.fixtureCy.getElementById('fixture-source-5').position(),{x:777,y:888});
  button(root,'Reset 2D layout').click();await frames(view);
  assert.notDeepEqual(reopened.fixtureCy.getElementById('fixture-source-5').position(),{x:777,y:888});
  const reset=JSON.parse(view.localStorage.getItem('hub-knowledge-positions-v1'));
  assert.equal(reset['fixture-source-5'],undefined);assert.deepEqual(reset['other-dataset-source'],{x:12,y:34});
  assert.equal(reopened.fixtureCy.nodes().length,98);assert.ok(requests.every(r=>r.method==='GET'));
});

const sourceChat={id:'conversation-source',title:'Original bilingual chat',kind:'conversation',protected:true,permalink:'Conversations/Source'};
const brainRecord={...graph.nodes[0],kind:'note'};
const mixedGraph={nodes:[brainRecord,sourceChat],edges:[{source:noteId,target:sourceChat.id}]};
test('Notes and Chat archive expose separate searchable lists in the same Knowledge window',async t=>{
 const {root,view,requests}=await fixture(t,{graph:mixedGraph,openNote:false});
 assert.match(root.querySelector('[role=status]').textContent,/1 brain notes · 1 chats/);
 button(root,'Notes').click();assert.equal(root.querySelector('[aria-label="Record collection"]').value,'brain');assert.ok(button(root,'Reading list'));assert.equal(button(root,sourceChat.title),undefined);
 button(root,'Chat archive').click();assert.equal(root.querySelector('[aria-label="Record collection"]').value,'archive');assert.ok(button(root,sourceChat.title));assert.equal(button(root,'Reading list'),undefined);
 const search=root.querySelector('[aria-label="Search knowledge"]');search.value='bilingual';search.dispatchEvent(new view.Event('input'));await new Promise(resolve=>view.setTimeout(resolve,280));
 assert.ok(requests.some(r=>r.url.includes('scope=archive')));assert.equal(button(root,'Reading list'),undefined);assert.ok(requests.every(r=>r.method==='GET'));
});

test('the full-screen reader is outside its launcher so responsive hidden drawers cannot hide an open modal',async t=>{
 const {root}=await fixture(t,{graph:mixedGraph,openNote:false}),launcher=root.querySelector('main'),reader=root.querySelector('[data-knowledge-workspace]');
 assert.equal(reader.parentElement,root.body);launcher.hidden=true;launcher.inert=true;assert.equal(reader.closest('[hidden],[inert]'),null);assert.equal(reader.open,true);
 button(root,'Chat archive').click();assert.ok(button(root,sourceChat.title));button(root,'Home').click();assert.equal(root.querySelector('[data-knowledge-workspace]'),null);
});

test('a visible source trail opens the original chat and returns to linked brain information',async t=>{
 const note={...brainRecord,content:'Original reading plan.',hash:'a'.repeat(64),links:[sourceChat],backlinks:[],sources:[{id:'save-source',conversationId:sourceChat.id,channel:'pwa',completedAt:1}]};
 const chat={...sourceChat,content:'My original words. Türkçe and English.',hash:'b'.repeat(64),links:[],backlinks:[brainRecord],sources:[]};
 const {root,requests}=await fixture(t,{graph:mixedGraph,noteDetails:{[noteId]:note,[sourceChat.id]:chat}});
 let trail=root.querySelector('[data-knowledge-source-trail]');assert.match(trail.textContent,/Source conversations/);assert.equal(trail.querySelectorAll('[data-source-link]').length,1);
 trail.querySelector('[data-source-link]').click();await setImmediate();assert.equal(root.querySelector('[data-graph-note]>h3').textContent,sourceChat.title);assert.equal(button(root,'Edit').disabled,true);assert.match(root.querySelector('[data-knowledge-source-trail]').textContent,/Linked brain notes/);
 root.querySelector('[data-knowledge-source-trail] [data-source-link]').click();await setImmediate();assert.equal(root.querySelector('[data-graph-note]>h3').textContent,'Reading list');assert.equal(button(root,'Edit').disabled,false);assert.ok(requests.every(r=>r.method==='GET'));
});
