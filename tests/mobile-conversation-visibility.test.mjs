import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { JSDOM } from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import { patchedNavigation } from '../scripts/voice/patched-navigation.mjs';
import { hiddenVoiceConversationIds, installMobileConversationVisibility } from '@minke/harness-overlay/client/host/mobile-conversation-visibility.ts';
import { VoiceHistoryClient } from '@minke/harness-overlay/client/host/voice-history.ts';
import { installMobileVoiceHistory } from '@minke/harness-overlay/client/host/mobile-voice-history.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 20));
test('staged navigation hook is inert by default, composes sources and preserves native registrations', async () => {
  const source = await patchedNavigation(fileURLToPath(new URL('..', import.meta.url)));
  let registration; runInNewContext(source, { window: { __ModuleLoader__: { load(value) { registration = value; } } } });
  const registrations = [];
  const ctx = {
    remote: { directoryPicker: {}, $host: {} },
    get: () => ({ list: { getSnapshot: () => ({}) } }),
    effect(callback, label) { if (!label.includes('navigation policy')) return callback(); },
    locale: { register: () => () => {} },
    slots: { provideRoot() {}, inject(_name, callback) { callback(); }, register(options, component) { registrations.push({ options, component }); return () => {}; } },
  };
  class Service { constructor(context, name) { this.ctx = context; context[name] = this; } }
  const exports = registration.factory(name => name === '@deepseek-ai/cordis' ? { Service } : name === '@deepseek-ai/dsh-client-store' ? { defineStore: value => value } : {});
  exports.apply(ctx);
  const nav = ctx.uiWorkspace;
  assert.deepEqual([...nav.navigationVisibility.getSnapshot()], []);
  const browser = registrations.find(entry => entry.options.name === 'sidebar.workspaces');
  assert.ok(browser.options.children['sidebar.workspaces.directoryFlow']);
  assert.equal(browser.options.inject().hooks.navigationVisibility, nav.navigationVisibility);
  let ids = ['voice'], change;
  const remove = nav.registerNavigationHiddenSessions({ getSnapshot: () => ids, subscribe(fn) { change = fn; return () => {}; } });
  assert.deepEqual([...nav.navigationVisibility.getSnapshot()], ['voice']);
  ids = []; change(); assert.deepEqual([...nav.navigationVisibility.getSnapshot()], []);
  const second = nav.registerNavigationHiddenSessions({ getSnapshot: () => ['second'], subscribe: () => () => {} });
  remove(); assert.deepEqual([...nav.navigationVisibility.getSnapshot()], ['second']);
  second(); assert.deepEqual([...nav.navigationVisibility.getSnapshot()], []);
  assert.equal(registrations.length, 2, 'Native browser and directory picker registrations remain, not replacements');
});

test('PWA policy uses metadata IDs, keeps tasks/text/saved chats visible, restores wide/teardown view', async () => {
  const records = [
    { sessionId: 'voice', saved: false, createdAt: 1 },
    { sessionId: 'saved', saved: true, createdAt: 2 },
    { sessionId: 'child', saved: false, createdAt: 3 },
  ];
  const byId = { voice: { title: 'Duplicate' }, text: { title: 'Duplicate' }, saved: {}, child: { origin: 'subagent' } };
  assert.deepEqual(hiddenVoiceConversationIds(records, byId), ['voice']);
  const dom = new JSDOM('<html data-minke-mobile-web></html>', { url: 'http://localhost', pretendToBeVisual: true });
  let snapshot, active, removed = false;
  dom.window.fetch = async () => Response.json({ conversations: records });
  const dispose = installMobileConversationVisibility({ connection: {}, sessions: { list: { getSnapshot: () => ({ byId }), subscribe: fn => { snapshot = fn; return () => {}; } } } }, {
    registerNavigationHiddenSessions(value) { active = value; return () => { removed = true; }; },
  }, dom.window.document);
  await tick(); assert.deepEqual(active.getSnapshot(), ['voice']);
  records[0].saved = true; dom.window.document.dispatchEvent(new dom.window.CustomEvent('hub:voice-history-changed')); await tick();
  assert.deepEqual(active.getSnapshot(), []);
  records[0].saved = false; snapshot(); await tick(); assert.deepEqual(active.getSnapshot(), ['voice']);
  dom.window.innerWidth = 1400; dom.window.dispatchEvent(new dom.window.Event('resize')); assert.deepEqual(active.getSnapshot(), []);
  dispose(); assert.equal(removed, true); dom.window.close();
});

test('History and Recents share promotion state without giving the panel ownership of its lifetime', async () => {
  const dom = new JSDOM('<html data-minke-mobile-web><main></main></html>', { url: 'http://localhost', pretendToBeVisual: true });
  const record = { sessionId: 'voice', saved: false, createdAt: 1000 };
  const shared = new VoiceHistoryClient(async (_url, init) => {
    if (init.method === 'POST') { record.saved = true; return Response.json({ sessionId: record.sessionId, kind: 'voice', saved: true }); }
    return Response.json({ conversations: [record] });
  });
  const sessions = { list: { getSnapshot: () => ({ byId: { voice: { title: 'Synthetic voice' } } }), subscribe: () => () => {} }, open() {} };
  let source;
  const offFilter = installMobileConversationVisibility({ connection: {}, sessions }, { registerNavigationHiddenSessions(value) { source = value; return () => {}; } }, dom.window.document, shared);
  const offPanel = installMobileVoiceHistory(dom.window.document.querySelector('main'), dom.window.document, sessions, () => {}, shared);
  dom.window.document.querySelector('details').open = true; await tick();
  assert.deepEqual(source.getSnapshot(), ['voice']);
  dom.window.document.querySelector('article button:last-child').click(); await tick();
  assert.deepEqual(source.getSnapshot(), []);
  offPanel(); await shared.refresh(); assert.equal(shared.getSnapshot().phase, 'ready');
  offFilter(); shared.dispose(); dom.window.close();
});
