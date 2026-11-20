import XCTest
@testable import HubNative

final class HubModelSpeedTests: XCTestCase {
    func testFirstTokenAndTokensPerSecondAreMedians() {
        var speed = HubModelSpeed()
        let start = Date(timeIntervalSince1970: 1_000)
        speed.record(model: "glm-5.3-flash", sentAt: start, firstTokenAt: start.addingTimeInterval(0.8), endedAt: start.addingTimeInterval(4.8), outputTokens: 400)
        speed.record(model: "glm-5.3-flash", sentAt: start, firstTokenAt: start.addingTimeInterval(1.2), endedAt: start.addingTimeInterval(3.2), outputTokens: 300)
        speed.record(model: "glm-5.3-flash", sentAt: start, firstTokenAt: start.addingTimeInterval(2.0), endedAt: start.addingTimeInterval(2.1), outputTokens: 5)
        let summary = speed.summaries.first
        XCTAssertEqual(summary?.count, 3)
        XCTAssertEqual(summary?.firstToken ?? 0, 1.2, accuracy: 0.001)
        XCTAssertEqual(summary?.tokensPerSecond ?? 0, 125, accuracy: 0.001)
    }

    func testOnlyTheLatestRepliesAreKept() {
        var speed = HubModelSpeed()
        let start = Date(timeIntervalSince1970: 1_000)
        for i in 0..<30 {
            speed.record(model: "m", sentAt: start, firstTokenAt: start.addingTimeInterval(Double(i)), endedAt: start.addingTimeInterval(Double(i) + 2), outputTokens: 100)
        }
        XCTAssertEqual(speed.summaries.first?.count, HubModelSpeed.keep)
    }
}
