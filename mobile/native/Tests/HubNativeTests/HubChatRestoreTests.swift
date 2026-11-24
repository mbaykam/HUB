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
}
