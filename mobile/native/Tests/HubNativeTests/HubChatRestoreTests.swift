import Foundation
import XCTest
@testable import HubNative

final class HubChatRestoreTests: XCTestCase {
    private func event(_ type: String, _ seq: Int, _ data: [String: Any]) throws -> HubChatStreamFrame.Entry.Event {
        try JSONDecoder().decode(HubChatStreamFrame.Entry.Event.self, from:
            JSONSerialization.data(withJSONObject: ["type": type, "seq": seq, "data": data]))
    }

    private func opening(cursor: Int, first: Int) throws -> HubChatSnapshot {
        let value: [String: Any] = ["type": "snapshot", "cursor": cursor, "hasMore": true,
            "records": [["event": ["type": "assistant/message", "seq": first,
                "data": ["turn": 1, "message": ["content": [["type": "text", "text": "Latest response"]]]]]]]]
        var timeline = HubChatTimeline()
        timeline.start(try JSONDecoder().decode(HubChatStreamFrame.Value.self, from: JSONSerialization.data(withJSONObject: value)))
        return timeline.snapshot
    }

    private func page(_ first: Int?, more: Bool = true) -> HubChatHistoryPage {
        HubChatHistoryPage(messages: [], hasMore: more, firstSequence: first, activity: [], usageByTurn: [:], sentFiles: [])
    }

    private func receipt(call: String, seq: Int, failed: Bool = false, name: String = "report.pdf") throws -> HubChatStreamFrame.Entry.Event {
        try event("tool/result", seq, ["turn": 1,
            "message": ["content": [["type": "tool-result", "toolCallId": call, "isError": failed]]],
            "meta": ["kind": "hub-file", "name": name, "bytes": 7, "sha256": String(repeating: "a", count: 64)]])
    }

    func testSingleResponseOpeningCanPageWithoutAnyReadingLatestGate() throws {
        var history = HubChatHistoryWindow()
        let snapshot = try opening(cursor: 100, first: 90)
        XCTAssertEqual(snapshot.messages.count, 1)
        history.follow(snapshot)
        let request = try XCTUnwrap(history.begin())
        XCTAssertEqual(request.cursor, 100)
        XCTAssertEqual(request.before, 90)
        XCTAssertTrue(history.receive(page(60), for: request))
        XCTAssertEqual(history.begin()?.before, 60)
    }

    func testReconnectRejectsOldPagesAndRestoresPriorExtentWithNewCut() throws {
        var history = HubChatHistoryWindow()
        history.follow(try opening(cursor: 100, first: 90))
        let first = try XCTUnwrap(history.begin())
        XCTAssertTrue(history.receive(page(60), for: first))
        let stale = try XCTUnwrap(history.begin())
        history.follow(try opening(cursor: 150, first: 120))
        XCTAssertTrue(history.restoring)
        XCTAssertFalse(history.receive(page(30), for: stale))
        let current = try XCTUnwrap(history.begin())
        XCTAssertEqual(current.cursor, 150)
        XCTAssertEqual(current.before, 120)
        XCTAssertTrue(history.receive(page(60), for: current))
        XCTAssertFalse(history.restoring)
        XCTAssertFalse(history.receive(page(60), for: current))
    }

    func testSameCutLiveUpdatesPreservePendingPagesAndEmptyTerminalPageStops() throws {
        var history = HubChatHistoryWindow()
        let snapshot = try opening(cursor: 100, first: 90)
        history.follow(snapshot)
        let request = try XCTUnwrap(history.begin())
        history.follow(snapshot)
        XCTAssertEqual(history.loading, request)
        XCTAssertTrue(history.receive(page(nil, more: false), for: request))
        XCTAssertNil(history.begin())
        XCTAssertFalse(history.hasMore)
    }

    func testNonProgressingPageFailsAndCancelledRetryCannotCompleteNewRequest() throws {
        var history = HubChatHistoryWindow()
        history.follow(try opening(cursor: 100, first: 90))
        let first = try XCTUnwrap(history.begin())
        XCTAssertFalse(history.receive(page(90), for: first))
        XCTAssertTrue(history.failed)
        let retry = try XCTUnwrap(history.begin())
        history.cancel(retry)
        let replacement = try XCTUnwrap(history.begin())
        XCTAssertNotEqual(retry, replacement)
        XCTAssertFalse(history.receive(page(60), for: retry))
        XCTAssertEqual(history.loading, replacement)
        history.fail(replacement)
        XCTAssertTrue(history.failed)
        XCTAssertNil(HubChatHistoryWindow().loading)
    }

    func testSuccessfulReceiptsKeepExactHostIDsAndSameNameVersionsAfterNextPrompt() throws {
        var timeline = HubChatTimeline()
        timeline.apply(try event("assistant/message", 2, ["turn": 1, "message": ["content": [["type": "text", "text": "Preparing"]]]]))
        let firstCall = "call_one|fc_one"
        timeline.apply(try receipt(call: firstCall, seq: 3))
        timeline.apply(try receipt(call: "call_two|fc_two", seq: 4))
        timeline.apply(try event("user/message", 5, ["source": ["kind": "user"], "content": [["type": "text", "text": "Next prompt"]]]))
        timeline.apply(try event("assistant/message", 6, ["turn": 2, "message": ["content": [["type": "text", "text": "Next response"]]]]))
        let snapshot = timeline.snapshot
        XCTAssertEqual(snapshot.sentFiles.count, 2)
        XCTAssertNotEqual(snapshot.sentFiles[0].id, snapshot.sentFiles[1].id)
        XCTAssertEqual(snapshot.sentFiles[0].id, HubAttachmentStore.digest(Data(("sent:" + firstCall).utf8)))
        XCTAssertEqual(snapshot.sentFiles.map(\.file.name), ["report.pdf", "report.pdf"])
        XCTAssertEqual(HubChatSentFile.anchor(of: snapshot.sentFiles[0], in: snapshot.messages), "2")
    }

    func testCallsFailedResultsAndUnsafeReceiptNamesNeverCreateCards() throws {
        var timeline = HubChatTimeline()
        timeline.apply(try event("tool/call", 1, ["name": "hub_send_file", "arguments": "{\"path\":\"report.pdf\"}"]))
        timeline.apply(try receipt(call: "failed", seq: 2, failed: true))
        timeline.apply(try receipt(call: "unsafe", seq: 3, name: "../secret.pdf"))
        XCTAssertTrue(timeline.snapshot.sentFiles.isEmpty)
    }

    func testOlderPagesRetainReceiptsOnceAndCanAnchorBeforeFirstVisibleReply() throws {
        var timeline = HubChatTimeline()
        timeline.apply(try receipt(call: "early", seq: 30))
        timeline.apply(try event("assistant/message", 40, ["turn": 1, "message": ["content": [["type": "text", "text": "Here it is"]]]]))
        let fileReceipt = try XCTUnwrap(timeline.snapshot.sentFiles.first)
        XCTAssertEqual(HubChatSentFile.anchor(of: fileReceipt, in: timeline.snapshot.messages), "40")
        var history = HubChatHistoryWindow()
        history.follow(try opening(cursor: 100, first: 90))
        let request = try XCTUnwrap(history.begin())
        let older = HubChatHistoryPage(messages: timeline.snapshot.messages, hasMore: true, firstSequence: 30,
                                      activity: [], usageByTurn: [:], sentFiles: [fileReceipt])
        XCTAssertTrue(history.receive(older, for: request))
        XCTAssertFalse(history.receive(older, for: request))
        XCTAssertEqual(history.sentFiles, [fileReceipt])
    }

    func testReconnectRetainsReadingRowsThenReplacesCoveredRangeIncludingDeletions() throws {
        var history = HubChatHistoryWindow()
        let old = try opening(cursor: 100, first: 90)
        history.follow(old)
        let request = try XCTUnwrap(history.begin())
        let rows = [10, 30, 60].map { HubChatMessage(id: String($0), role: "assistant", text: "Old", turn: 1, photos: []) }
        XCTAssertTrue(history.receive(HubChatHistoryPage(messages: rows, hasMore: true, firstSequence: 10,
            activity: [], usageByTurn: [:], sentFiles: []), for: request))
        let live = try opening(cursor: 200, first: 120)
        history.follow(live, previous: old)
        XCTAssertEqual(history.messages.map(\.id), ["10", "30", "60", "90"])
        let reconcile = try XCTUnwrap(history.begin())
        let changed = HubChatMessage(id: "60", role: "assistant", text: "Authoritative", turn: 1, photos: [])
        XCTAssertTrue(history.receive(HubChatHistoryPage(messages: [changed], hasMore: true, firstSequence: 30,
            activity: [], usageByTurn: [:], sentFiles: []), for: reconcile))
        XCTAssertEqual(history.messages.map(\.id), ["10", "60"])
        XCTAssertEqual(history.messages.last?.text, "Authoritative")
        XCTAssertEqual(history.transcript(live).messages.map(\.id), ["10", "60", "120"])
        let terminal = try XCTUnwrap(history.begin())
        XCTAssertTrue(history.receive(page(nil, more: false), for: terminal))
        XCTAssertEqual(history.messages.map(\.id), ["60"])
        XCTAssertFalse(history.hasMore)
    }

    func testFullAuthoritativeSnapshotRemovesStaleRowsAndCancellationKeepsReadingSurface() throws {
        var history = HubChatHistoryWindow()
        let old = try opening(cursor: 100, first: 90)
        history.follow(old)
        let pending = try XCTUnwrap(history.begin())
        history.cancel(pending)
        XCTAssertNil(history.loading)
        XCTAssertEqual(history.transcript(old).messages.map(\.id), ["90"])
        let empty = HubChatTimeline().snapshot
        history.follow(empty, previous: old)
        XCTAssertTrue(history.messages.isEmpty)
        XCTAssertFalse(history.hasMore)
        XCTAssertFalse(history.receive(page(60), for: pending))
    }

    func testLiveReplacementDeletesPagedRowsReceiptsAndLatePageCannotResurrectThem() throws {
        let openingValue: [String: Any] = ["type": "snapshot", "cursor": 100, "hasMore": true,
            "records": [["event": ["type": "assistant/message", "seq": 90,
                "data": ["turn": 1, "message": ["content": [["type": "text", "text": "Latest"]]]]]]]]
        var timeline = HubChatTimeline()
        timeline.start(try JSONDecoder().decode(HubChatStreamFrame.Value.self,
            from: JSONSerialization.data(withJSONObject: openingValue)))
        let opening = timeline.snapshot
        var history = HubChatHistoryWindow()
        history.follow(opening)
        let request = try XCTUnwrap(history.begin())
        var older = HubChatTimeline()
        older.apply(try event("assistant/message", 30, ["turn": 1, "message": ["content": [["type": "text", "text": "Deleted text"]]]]))
        older.apply(try receipt(call: "deleted-file", seq: 35))
        XCTAssertTrue(history.receive(HubChatHistoryPage(messages: older.snapshot.messages, hasMore: true, firstSequence: 30,
            activity: older.snapshot.activity, usageByTurn: [:], sentFiles: older.snapshot.sentFiles), for: request))
        let pending = try XCTUnwrap(history.begin())
        let replacement: [String: Any] = ["type": "assistant/message", "seq": 101,
            "surfaceOp": ["op": "replace", "start": 20, "end": 50],
            "data": ["turn": 1, "message": ["content": [["type": "text", "text": "Corrected answer"]]]]]
        timeline.apply(try JSONDecoder().decode(HubChatStreamFrame.Entry.Event.self,
            from: JSONSerialization.data(withJSONObject: replacement)))
        let live = timeline.snapshot
        XCTAssertEqual(live.invalidations, [HubChatInvalidation(start: 20, end: 50)])
        XCTAssertEqual(live.historyCursor, opening.historyCursor)
        history.follow(live, previous: opening)
        XCTAssertTrue(history.messages.isEmpty)
        XCTAssertTrue(history.sentFiles.isEmpty)
        XCTAssertTrue(history.activity.isEmpty)
        XCTAssertEqual(history.loading, pending)
        let stale = HubChatMessage(id: "25", role: "assistant", text: "Must not return", turn: 1, photos: [])
        XCTAssertTrue(history.receive(HubChatHistoryPage(messages: [stale], hasMore: true, firstSequence: 20,
            activity: [], usageByTurn: [:], sentFiles: []), for: pending))
        XCTAssertTrue(history.messages.isEmpty)
        let cached = history.transcript(live)
        XCTAssertEqual(cached.messages.map(\.text), ["Latest", "Corrected answer"])
        XCTAssertEqual(try JSONDecoder().decode(HubChatSnapshot.self, from: JSONEncoder().encode(cached)).invalidations,
                       live.invalidations)
    }

    func testPageReplacementAlsoInvalidatesRetainedRowsBelowItsSequenceBoundary() throws {
        var history = HubChatHistoryWindow()
        let old = try opening(cursor: 100, first: 90)
        history.follow(old)
        let request = try XCTUnwrap(history.begin())
        let row = HubChatMessage(id: "10", role: "assistant", text: "Old cached text", turn: 1, photos: [])
        XCTAssertTrue(history.receive(HubChatHistoryPage(messages: [row], hasMore: true, firstSequence: 10,
            activity: [], usageByTurn: [:], sentFiles: []), for: request))
        history.follow(try opening(cursor: 200, first: 120), previous: old)
        let next = try XCTUnwrap(history.begin())
        XCTAssertTrue(history.receive(HubChatHistoryPage(messages: [], hasMore: true, firstSequence: 60,
            activity: [], usageByTurn: [:], sentFiles: [], invalidations: [HubChatInvalidation(start: 10, end: 11)]), for: next))
        XCTAssertFalse(history.messages.contains { $0.id == "10" })
    }

    func testCacheIsolatesChatAndServerAndRetainsOfflineReadingPosition() throws {
        let first = HubConversationAPI(server: try HubServer(address: "https://history-cache.test")) { [] }
        let foreign = HubConversationAPI(server: try HubServer(address: "https://other-history-cache.test")) { [] }
        let a = "fixture-a-" + UUID().uuidString.lowercased()
        let b = "fixture-b-" + UUID().uuidString.lowercased()
        defer {
            for (origin, id) in [("https://history-cache.test", a), ("https://history-cache.test", b)] {
                let server = try? HubServer(address: origin)
                var hash: UInt64 = 1_469_598_103_934_665_603
                for byte in ((server?.origin.absoluteString ?? "") + "\n" + id).utf8 { hash = (hash ^ UInt64(byte)) &* 1_099_511_628_211 }
                let folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("hub-chats")
                try? FileManager.default.removeItem(at: folder.appendingPathComponent(String(hash, radix: 16) + ".json"))
            }
        }
        let snapshotA = try opening(cursor: 100, first: 90)
        let snapshotB = try opening(cursor: 200, first: 180)
        first.cacheTranscript(snapshotA, sessionID: a, readingMessageID: "90", readingLatest: false, readingOffset: -73)
        first.cacheTranscript(snapshotB, sessionID: b, readingMessageID: nil, readingLatest: true)
        HubConversationAPI.chatCacheQueue.sync { }
        XCTAssertEqual(first.cachedTranscript(sessionID: a)?.snapshot.messages.map(\.id), ["90"])
        XCTAssertEqual(first.cachedTranscript(sessionID: a)?.readingOffset, -73)
        XCTAssertEqual(first.cachedTranscript(sessionID: a)?.readingLatest, false)
        XCTAssertEqual(first.cachedTranscript(sessionID: b)?.snapshot.messages.map(\.id), ["180"])
        XCTAssertNil(foreign.cachedTranscript(sessionID: a))
        XCTAssertEqual(HubChatHistoryWindow().transcript(snapshotA).hasMore, snapshotA.hasMore)
    }

    func testToolHeavyCachedTranscriptRoundTripsReceiptsAndReadingPositionWithoutRawJournal() throws {
        var timeline = HubChatTimeline()
        timeline.apply(try event("assistant/message", 1, ["turn": 1, "message": ["content": [["type": "text", "text": "Visible answer"]]]]))
        for sequence in 2...1001 {
            timeline.apply(try event("tool/call", sequence, ["turn": 1, "name": "fixture", "arguments": "{}"] ))
        }
        timeline.apply(try receipt(call: "cached-file", seq: 1002))
        var file = HubChatCacheFile(savedAt: Date(), messages: [])
        file.transcript = timeline.snapshot
        file.readingMessageID = "1"
        file.readingLatest = false
        file.readingOffset = -128.5
        let encoded = try JSONEncoder().encode(file)
        let restored = try JSONDecoder().decode(HubChatCacheFile.self, from: encoded)
        XCTAssertEqual(restored.transcript?.messages.map(\.text), ["Visible answer"])
        XCTAssertEqual(restored.transcript?.activity.count, 1001)
        XCTAssertEqual(restored.transcript?.sentFiles.count, 1)
        XCTAssertEqual(restored.readingMessageID, "1")
        XCTAssertEqual(restored.readingOffset, -128.5)
        XCTAssertLessThan(encoded.count, 8 * 1_024 * 1_024)
        let legacy = try JSONDecoder().decode(HubChatCacheFile.self, from: Data("{\"savedAt\":0,\"messages\":[]}".utf8))
        XCTAssertNil(legacy.transcript)
    }
}
