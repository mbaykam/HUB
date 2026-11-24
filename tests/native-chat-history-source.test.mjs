import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const api = read('mobile/native/Sources/HubNative/HubConversationAPI.swift');
const view = read('mobile/ios/App/App/HubLiveChatView.swift');
const home = read('mobile/ios/App/App/HubHomeView.swift');
// Source guards only: executable Swift behavior is covered by HubChatRestoreTests
// and HubConversationTests on an Apple runner, not simulated by these checks.
test('cache is server/chat scoped, serialized, protected and size bounded', () => {
  assert.match(api, /server\.origin\.absoluteString \+ "\\n" \+ sessionID/);
  assert.match(api, /DispatchQueue\(label: "hub\.chat-cache"/);
  assert.match(api, /completeFileProtectionUntilFirstUserAuthentication/);
  assert.match(api, /data\.count <= 8 \* 1_024 \* 1_024/);
  assert.match(api, /retainedBytes \+ bytes > 48 \* 1_024 \* 1_024/);
  assert.match(api, /activity: value\.activity\.filter \{ \$0\.title != "System prompt" \}/);
});
test('same transcript renderer handles cache and authority; stale cache cannot send', () => {
  assert.match(view, /snapshot = cached\.snapshot\s+connectionLost = true\s+reconnecting = true/);
  assert.match(view, /history\.follow\(value, previous: snapshot\)/);
  assert.match(view, /!deliveryUncertain && !connectionLost/);
  assert.match(view, /Checking conversation connection/);
  assert.match(view, /Button\("Retry", action: reconnect\)/);
});
test('reading anchor and intra-row offset survive reopen/prepend without forced bottom', () => {
  assert.match(view, /pendingReadingPosition = \(readingMessageID, readingOffset\)/);
  assert.match(view, /contentOffset\.y \+ frame\.minY - pending\.offset/);
  assert.match(view, /if let offset, readingLatest, !dragging/);
  assert.match(view, /weak var view: UIScrollView\?/);
  assert.match(api, /file\.readingOffset = readingOffset\.isFinite/);
});
test('visible batches are bounded and have cancel/manual continuation, not hidden-record loops', () => {
  assert.match(view, /for _ in 0\.\.<4/);
  assert.match(view, /history\.messages\.count - initialCount >= 24/);
  assert.match(view, /historyAutoPaused = true/);
  assert.match(view, /Button\("Cancel"\) \{ historyRequest = 0 \}/);
  assert.match(view, /Continue loading earlier messages/);
  assert.match(view, /\$0 >= -320/);
  assert.match(api, /"maxMessages": 200/);
  assert.match(api, /request\.timeoutInterval = 15/);
  assert.match(api, /maxRecords: maxRecords \/ 5/);
});
test('sequence ranges replace stale rows and late responses cannot cross windows', () => {
  assert.match(api, /guard loading == request, cursor == request\.cursor, firstSequence == request\.before/);
  assert.match(api, /let lower = page\.hasMore \? \(page\.firstSequence \?\? 0\) : 0/);
  assert.match(api, /!\(lower\.\.<request\.before\)\.contains/);
  assert.doesNotMatch(api, /messages = \[\]; activity = \[\]; usageByTurn = \[:\]; sentFiles = \[\]/);
  assert.match(home, /\.id\(selectedChat\.request\.choice\.sessionId\)/);
});
test('cache saves on background/exit and page tasks cancel when app is inactive', () => {
  assert.match(view, /\.onDisappear \{ saveTranscript\(\) \}/);
  assert.match(view, /if !active \{ saveTranscript\(\) \}/);
  assert.match(view, /\.task\(id: activity\.isActive \? historyRequest : -1\)/);
});
