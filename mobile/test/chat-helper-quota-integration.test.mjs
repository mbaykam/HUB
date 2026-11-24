import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const load = path => readFile(new URL(path, import.meta.url), 'utf8');
const chat = await load('../ios/App/App/HubLiveChatView.swift');
const helpers = await load('../ios/App/App/HubHelperTransparencyView.swift');
const quota = await load('../native/Sources/HubNative/HubChatQuotaResume.swift');
const project = await load('../ios/App/App.xcodeproj/project.pbxproj');

// Wiring checks only; native XCTest and simulator compilation remain mandatory.
test('helper routes and recorded progress are reachable even before a helper starts', () => {
  assert.ok(chat.includes('Label("Helpers", systemImage: "person.2")'));
  assert.ok(chat.includes('HubHelperTransparencyCard(api: api, helper: helper)'));
  assert.ok(chat.includes('HubHelperTransparencyView(api: api, helper: helper)'));
  assert.ok(chat.includes('HubHelperRoutingPolicySection()'));
  assert.ok(helpers.includes('work?.actualRoute'));
  assert.ok(helpers.includes('work.routing'));
  assert.ok(helpers.includes('Stop requested'));
  assert.ok(helpers.includes('private reasoning'));
  assert.equal((project.match(/HubHelperTransparencyView.swift in Sources/g) ?? []).length, 2);
  assert.ok(project.includes('path = HubHelperTransparencyView.swift'));
});

test('per-chat menu toggle uses server preference, real save, status and explicit cancellation', () => {
  assert.ok(chat.includes('Toggle("Resume when limit resets"'));
  assert.ok(chat.includes('get: { quotaResume?.enabled ?? false }'));
  assert.ok(chat.includes('await setQuotaResume(enabled)'));
  assert.ok(chat.includes('await api.setChatQuotaResume(sessionID: current.sessionId, revision: current.revision, enabled: enabled)'));
  assert.ok(chat.includes('await api.cancelChatQuotaResume(sessionID: id, revision: current.revision)'));
  assert.ok(chat.includes('quotaResumeUnavailable || quotaResume == nil'));
  assert.ok(chat.includes('HubChatQuotaResumeView(api: api, sessionID: chat.sessionId).id(chat.sessionId)'));
  assert.ok(quota.includes('no absolute reset') || quota.includes('only when actually reported'));
  assert.ok(quota.includes('new message, model change or Stop cancels'));
});
