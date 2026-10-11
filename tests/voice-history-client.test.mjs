import test from "node:test";
import assert from "node:assert/strict";
import { VoiceHistoryClient, parseVoiceHistory } from "@minke/harness-overlay/client/host/voice-history.ts";
import { installMobileVoiceHistory } from "@minke/harness-overlay/client/host/mobile-voice-history.ts";
import { JSDOM } from "../vendor/deepseek-harness/node_modules/jsdom/lib/api.js";

const record = { sessionId: "voice-one", saved: false, createdAt: 1000 };
const response = (conversations = [record]) => Response.json({ conversations });
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

test("history validates identities and retains last known metadata on refresh failure", async () => {
  assert.throws(() => parseVoiceHistory({ conversations: [record, record] }));
  assert.throws(() => parseVoiceHistory({ conversations: [{ ...record, sessionId: '../outside' }] }));
  assert.throws(() => parseVoiceHistory({ conversations: [{ ...record, saved: 'false' }] }));
  let fail = false;
  const client = new VoiceHistoryClient(async () => fail ? new Response('unavailable', { status: 503 }) : response());
  await client.refresh(); assert.equal(client.getSnapshot().phase, 'ready');
  fail = true; await client.refresh();
  assert.equal(client.getSnapshot().phase, 'error'); assert.deepEqual(client.getSnapshot().records, [record]);
  client.dispose();
});

test("promotion requires a matching host acknowledgement, deduplicates clicks and outranks an older GET", async () => {
  let post, stale, posts = 0, delay = false;
  const client = new VoiceHistoryClient(async (_url, init) => {
    if (init.method === 'POST') { posts++; assert.equal(init.headers['x-hub-voice-history'], '1'); return new Promise(resolve => { post = resolve; }); }
    return delay ? new Promise(resolve => { stale = resolve; }) : response();
  });
  await client.refresh(); delay = true; const get = client.refresh();
  const save = client.save(record.sessionId); assert.equal(client.save(record.sessionId), save); assert.equal(posts, 1);
  post(Response.json({ sessionId: record.sessionId, kind: 'voice', saved: true })); await save;
  stale(response()); await get; assert.equal(client.getSnapshot().records[0].saved, true);
  await assert.rejects(client.save('unknown'));
  client.dispose();
  const invalid = new VoiceHistoryClient(async (_url, init) => init.method === 'POST' ? Response.json({ sessionId: 'wrong', kind: 'voice', saved: true }) : response());
  await invalid.refresh(); await assert.rejects(invalid.save(record.sessionId)); assert.equal(invalid.getSnapshot().records[0].saved, false); invalid.dispose();
});

test("tucked-away history loads on expansion, safely opens by ID and confirms Save", async () => {
  const dom = new JSDOM('<main></main>', { url: 'http://localhost', pretendToBeVisual: true });
  let gets = 0, saved = false, closeCount = 0; const opened = [];
  dom.window.fetch = async (_url, init) => {
    if (init.method === 'POST') { saved = true; return Response.json({ sessionId: record.sessionId, kind: 'voice', saved }); }
    gets++; return response([{ ...record, saved }]);
  };
  const doc = dom.window.document;
  const dispose = installMobileVoiceHistory(doc.querySelector('main'), doc, { list: { getSnapshot: () => ({ byId: { [record.sessionId]: { title: '<img src=x> Title' } } }), subscribe: () => () => {} }, open: id => opened.push(id) }, () => closeCount++);
  assert.equal(gets, 0);
  doc.querySelector('details').open = true; await tick();
  assert.equal(gets, 1); assert.equal(doc.querySelector('img'), null);
  doc.querySelector('[data-voice-history-open]').click(); assert.deepEqual(opened, [record.sessionId]); assert.equal(closeCount, 1);
  doc.querySelector('article button:last-child').click(); await tick();
  assert.equal(saved, true); assert.equal(doc.querySelector('article button:last-child').textContent, 'Saved');
  dispose(); assert.equal(doc.querySelector('details'), null); dom.window.close();
});

test('invalidation during a GET performs one trailing refresh so a new voice session is not missed', async () => {
  let first, calls = 0;
  const client = new VoiceHistoryClient(async () => {
    calls++;
    return calls === 1 ? new Promise(resolve => { first = resolve; }) : response();
  });
  const pending = client.refresh(); client.invalidate(); client.invalidate();
  first(response([])); await pending; await tick();
  assert.equal(calls, 2); assert.deepEqual(client.getSnapshot().records, [record]);
  client.dispose();
});

test('history touch release opens once without a compatibility click, but scrolling and cancellation do not open', async () => {
  const dom = new JSDOM('<main></main>', { url: 'http://localhost', pretendToBeVisual: true });
  dom.window.fetch = async () => response();
  const doc = dom.window.document, opened = [];
  let closed = 0;
  const dispose = installMobileVoiceHistory(doc.querySelector('main'), doc, { list: { getSnapshot: () => ({ byId: { [record.sessionId]: { title: 'Synthetic voice' } } }), subscribe: () => () => {} }, open: id => opened.push(id) }, () => closed++);
  try {
    doc.querySelector('details').open = true; await tick();
    const button = doc.querySelector('[data-voice-history-open]');
    const pointer = (type, props = {}) => {
      const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, clientX: 40, clientY: 100, ...props });
      button.dispatchEvent(event);
    };
    pointer('pointerdown'); pointer('pointerup');
    assert.deepEqual(opened, [record.sessionId]); assert.equal(closed, 1);
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    assert.equal(opened.length, 1, 'delayed compatibility click must not navigate twice');
    pointer('pointerdown'); pointer('pointermove', { clientY: 130 }); pointer('pointerup');
    pointer('pointerdown'); pointer('pointercancel'); pointer('pointerup');
    pointer('pointerdown'); pointer('pointerup', { clientX: 60 });
    assert.equal(opened.length, 1, 'scroll, cancellation and moved release must not navigate');
    pointer('pointerdown', { pointerType: 'mouse' }); pointer('pointerup', { pointerType: 'mouse' });
    assert.equal(opened.length, 1, 'mouse retains ordinary click behavior');
    button.click(); assert.equal(opened.length, 2, 'keyboard activation remains usable');
    pointer('pointerdown'); pointer('pointerup'); assert.equal(opened.length, 3, 'a new intentional tap is not suppressed');
  } finally { dispose(); dom.window.close(); }
});
