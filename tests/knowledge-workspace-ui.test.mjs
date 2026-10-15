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
    shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(`import cy from ${JSON.stringify(graphModule)}; export default options=>cy({...options,headless:true});`)
  };
  return next(specifier,context);
}});
const {openKnowledgeWorkspace}=await import('../packages/harness-overlay/src/client/memory/knowledge-workspace.ts');
rendererHook.deregister();

const noteId='00000000-0000-4000-8000-000000000001';
const graph={nodes:[{id:noteId,title:'Reading list',permalink:'Notes/Reading list'}],edges:[]};
const button=(root,label)=>[...root.querySelectorAll('button')].find(node=>node.textContent===label);
async function fixture(t,options={}){
  const dom=new JSDOM('<main></main>',{url:'https://hub.test/',pretendToBeVisual:true});
  const view=dom.window,root=view.document,requests=[];
  Object.defineProperty(view,'innerWidth',{value:390,configurable:true});
  view.ResizeObserver=class{observe(){}disconnect(){}};
  view.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  view.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new view.Event('close'));};
  const note={...graph.nodes[0],content:'Original reading plan.',hash:'a'.repeat(64),protected:!!options.protected,links:[],backlinks:[],sources:[],assets:[]};
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
    const value=query.get('view')==='note'?note:query.get('view')==='search'?{nodes:graph.nodes}:query.get('view')==='assets'?{assets:[]}:query.get('view')==='graph'?graph:{vault:'C:/fixture/vault'};
    return {ok:true,json:async()=>structuredClone(value)};
  };
  const dispose=openKnowledgeWorkspace(root.querySelector('main'),root,graph,()=>{});
  t.after(()=>{dispose();dom.window.close();});
  button(root,'Notes').click();
  root.querySelector('aside').scrollTop=180;
  button(root,'Reading list').click();await setImmediate();
  assert.equal(root.querySelector('dialog').dataset.mobilePane,'note');
  return {view,root,requests,note};
}

test('returning from a searched Knowledge note restores the note list, query and reading position',async t=>{
  const {view,root}=await fixture(t);
  button(root,'‹ Knowledge').click();
  const search=root.querySelector('[aria-label="Search knowledge"]');
  search.value='Reading';search.dispatchEvent(new view.Event('input'));
  await new Promise(resolve=>view.setTimeout(resolve,280));
  const sidebar=root.querySelector('aside');sidebar.scrollTop=180;
  button(root,'Reading list').focus();button(root,'Reading list').click();await setImmediate();
  button(root,'‹ Knowledge').click();
  assert.equal(root.querySelector('dialog').dataset.mobilePane,'files');
  assert.equal(search.value,'Reading');
  assert.equal(sidebar.scrollTop,180);
  assert.equal(root.querySelector('[data-graph-note]').hidden,true);
});

test('unsaved Knowledge edits survive navigation and closing until explicitly discarded',async t=>{
  const {view,root,requests,note}=await fixture(t),dialog=root.querySelector('dialog');
  button(root,'Edit').click();
  const editor=root.querySelector('[aria-label="Note Markdown"]');
  editor.value=note.content+'\nUnsaved fixture addition.';editor.dispatchEvent(new view.Event('input'));
  for(const label of ['Graph','Notes','Attachments','Home','‹ Knowledge']){
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
  button(root,'Edit').click();button(root,'‹ Knowledge').click();
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
  button(root,'‹ Knowledge').click();assert.equal(root.querySelector('dialog').dataset.mobilePane,'files');
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
