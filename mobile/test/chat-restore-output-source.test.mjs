import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const load = path => readFile(new URL(path, import.meta.url), 'utf8');
const view = await load('../ios/App/App/HubLiveChatView.swift');
const api = await load('../native/Sources/HubNative/HubConversationAPI.swift');
const outputs = await load('../ios/App/App/HubConversationAppsView.swift');

// Windows source-wiring checks, not substitutes for native XCTest or layout tests.
test('sparse top windows can load earlier even while reading latest', () => {
  const auto = view.slice(view.indexOf('private func autoLoadEarlier()'), view.indexOf('private func loadEarlierMessages()'));
  assert.ok(!auto.includes('!readingLatest'));
  assert.ok(auto.includes('historyTopVisible || history.restoring'));
  assert.ok(view.includes('onPreferenceChange(EarlierChatOffset.self)'));
  assert.ok(view.includes('Button(historyAutoPaused ? "Continue loading earlier messages" : "Load earlier messages")'));
  assert.ok(view.includes('Button("Cancel") { historyRequest = 0 }'));
  assert.ok(view.includes('.id(message.id)'));
  assert.ok(view.includes('for _ in 0..<4'));
  assert.ok(api.includes('loading == request, cursor == request.cursor, firstSequence == request.before'));
  assert.ok(api.includes('generation += 1\n        let request = Request'));
});

test('persistent output cards use successful versioned receipts and direct navigation', () => {
  assert.ok(!view.includes('private func sentFiles(in snapshot:'));
  assert.ok(view.includes('let sentFiles = history.sentFiles + snapshot.sentFiles'));
  assert.ok(view.includes('HubChatSentFile.anchor(of:'));
  assert.ok(view.includes('.hubPage(item: $openedOutput)'));
  assert.ok(view.includes('initialFile: receipt.file'));
  assert.ok(api.includes('result.isError == false'));
  assert.ok(api.includes('HubAttachmentStore.digest(Data(("sent:" + callID).utf8))'));
  assert.ok(api.includes('HubAttachmentStore.digest(bytes) == file.sha256'));
  assert.ok(api.includes('case 410 where path == "api/hub/artifacts"'));
});

test('verified PDF bytes open natively with export, share, and a normal back to chat', () => {
  assert.ok(outputs.includes('import PDFKit'));
  assert.ok(outputs.includes('PDFDocument(data: fileBytes)'));
  assert.ok(outputs.includes('view.displayMode = .singlePageContinuous'));
  assert.ok(outputs.includes('view.autoScales = true'));
  assert.ok(outputs.includes('pushed && !directFile'));
  assert.ok(outputs.includes('Button("Save to Files")'));
  assert.ok(outputs.includes('label: "Share output"'));
  assert.ok(outputs.includes('case HubConversationFileError.versionUnavailable:'));
  assert.ok(outputs.includes('A newer file will not be substituted.'));
  assert.ok(outputs.includes('Button("Retry download")'));
});
