import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import { createSpeechEditor } from '@minke/harness-overlay/client/host/mobile-speech-editor.ts';

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
