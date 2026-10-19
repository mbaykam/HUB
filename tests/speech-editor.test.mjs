import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import { createSpeechEditor } from '@minke/harness-overlay/client/host/mobile-speech-editor.ts';

test('global recognition can be limited to English and Turkish without changing the output voice',async()=>{
 const dom=new JSDOM('<main></main>',{url:'http://localhost'}),view=dom.window;
 view.HTMLMediaElement.prototype.load=()=>{};view.HTMLMediaElement.prototype.pause=()=>{};view.URL.createObjectURL=()=> 'blob:fixture';view.URL.revokeObjectURL=()=>{};
 view.fetch=async url=>url.endsWith('/catalog')?Response.json({speech:{stt:[{engine:'nemotron',model:'3.5-560ms',available:true,reason:null}],tts:[{engine:'supertonic',model:'supertonic-3',available:true,reason:null,voices:['F5']}]}}):new Response(Buffer.alloc(48));
 const seed={stt:{engine:'nemotron',model:'3.5-560ms',language:'auto'},tts:{engine:'supertonic',model:'supertonic-3',voice:'F5',language:'auto',steps:6}},editor=createSpeechEditor(view.document,seed);view.document.querySelector('main').append(editor.panel);
 try{
  await new Promise(r=>setTimeout(r,30));
  const recognition=[...editor.panel.querySelectorAll('select')].find(select=>select.querySelector('option[value="en-tr"]'));
  assert.ok(recognition);recognition.value='en-tr';recognition.dispatchEvent(new view.Event('change'));
  assert.equal(editor.value().stt.language,'en-tr');assert.deepEqual(editor.value().tts,seed.tts);
  assert.equal(editor.panel.querySelectorAll('option[value="en-tr"]').length,1,'The recognition-only choice must not become a TTS output language');
 }finally{editor.dispose();view.close();}
});

test('loading another sample preserves an already ready audition button and its focus', async () => {
  const dom = new JSDOM('<main></main>', { url: 'http://localhost', pretendToBeVisual: true });
  const view = dom.window;
  const catalog = { stt: [{ engine: 'nemotron', model: '3.5-560ms', available: true, reason: null }], tts: [{ engine: 'supertonic', model: 'supertonic-3', available: true, reason: null, voices: ['F4', 'F5'] }] };
  let release, calls = 0, plays = 0;
  view.HTMLMediaElement.prototype.load = () => {};
  view.HTMLMediaElement.prototype.pause = () => {};
  view.HTMLMediaElement.prototype.play = async () => { plays++; };
  view.URL.createObjectURL = () => 'blob:sample-' + calls;
  view.URL.revokeObjectURL = () => {};
  view.fetch = async (url, init) => {
    if (url.endsWith('/catalog')) return Response.json({ speech: catalog });
    calls++;
    const selection = JSON.parse(init.body);
    if (selection.tts.voice === 'F4' && selection.language === 'en') await new Promise(resolve => { release = resolve; });
    return new Response(Buffer.alloc(48), { headers: { 'content-type': 'audio/wav' } });
  };
  const seed = { stt: { engine: 'nemotron', model: '3.5-560ms', language: 'auto' }, tts: { engine: 'supertonic', model: 'supertonic-3', voice: 'F5', language: 'auto', steps: 6 } };
  const editor = createSpeechEditor(view.document, seed);
  view.document.querySelector('main').append(editor.panel);
  try {
    const find = () => editor.panel.querySelector('[aria-label="Listen to Female 5 · multilingual in English"]');
    for (let i = 0; i < 30 && (!release || !find() || find().disabled); i++) await new Promise(resolve => setTimeout(resolve, 10));
    const audition = find(); assert.ok(audition && !audition.disabled); audition.focus();
    release(); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(audition.isConnected, true, 'A ready control must survive another voice becoming ready');
    assert.equal(view.document.activeElement, audition, 'Background preparation must preserve keyboard focus');
    const preparedCalls = calls; audition.click(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(plays, 1); assert.equal(calls, preparedCalls, 'Audition uses its prepared sample without another request');
    assert.deepEqual(editor.value(), seed);
  } finally { release?.(); editor.dispose(); dom.window.close(); }
});

test('character voice editor cannot change engines or language and keeps voice previews',async()=>{
 const dom=new JSDOM('<main></main>',{url:'https://hub.test',pretendToBeVisual:true}),view=dom.window;
 view.HTMLMediaElement.prototype.load=()=>{};view.HTMLMediaElement.prototype.pause=()=>{};view.URL.createObjectURL=()=> 'blob:fixture';view.URL.revokeObjectURL=()=>{};
 view.fetch=async url=>url.endsWith('/catalog')?Response.json({speech:{stt:[{engine:'nemotron',model:'3.5-560ms',available:true,reason:null}],tts:[{engine:'supertonic',model:'supertonic-3',available:true,reason:null,voices:['F2','F5']}]}}):new Response(Buffer.alloc(48));
 const seed={stt:{engine:'nemotron',model:'3.5-560ms',language:'auto'},tts:{engine:'supertonic',model:'supertonic-3',voice:'F5',language:'auto',steps:6}},editor=createSpeechEditor(view.document,seed,{voiceOnly:true});view.document.querySelector('main').append(editor.panel);
 try{await new Promise(r=>setTimeout(r,30));assert.equal(editor.panel.tagName,'SECTION','A voice tab must not contain a redundant collapsible Voice panel');assert.equal(editor.panel.querySelectorAll('select').length,0);assert.equal(editor.panel.querySelectorAll('input[type=checkbox]').length,0);const choose=[...editor.panel.querySelectorAll('button')].find(b=>b.textContent==='Female 2 · multilingual');choose.click();assert.equal(editor.value().tts.voice,'F2');assert.deepEqual(editor.value().stt,seed.stt);assert.equal(editor.value().tts.steps,6);assert.ok(editor.panel.querySelector('[aria-label="Listen to Female 2 · multilingual in English"]'));}finally{editor.dispose();view.close();}
});
