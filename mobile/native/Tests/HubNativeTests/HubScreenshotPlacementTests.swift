import XCTest
@testable import HubNative

final class HubScreenshotPlacementTests: XCTestCase {
    private func reply(_ seq: Int, turn: Int) -> HubChatMessage {
        HubChatMessage(id: String(seq), role: "assistant", text: "m\(seq)", turn: turn, photos: [])
    }

    func testAScreenshotStaysAfterTheMessageSentJustBeforeIt() {
        let messages = [
            HubChatMessage(id: "1", role: "user", text: "Show my screen", turn: 1, photos: []),
            reply(3, turn: 1), reply(9, turn: 1), reply(15, turn: 1),
        ]
        XCTAssertEqual(HubChatScreenshot.anchor(of: .init(id: "a", name: "a.png", turn: 1, seq: 7), in: messages), "3")
        XCTAssertEqual(HubChatScreenshot.anchor(of: .init(id: "b", name: "b.png", turn: 1, seq: 12), in: messages), "9")
        XCTAssertNil(HubChatScreenshot.anchor(of: .init(id: "c", name: "c.png", turn: 1, seq: 2), in: messages))
    }

    func testWithoutAPositionItFollowsTheTurnsLastMessage() {
        let messages = [reply(3, turn: 1), reply(9, turn: 1), reply(20, turn: 2)]
        XCTAssertEqual(HubChatScreenshot.anchor(of: .init(id: "a", name: "a.png", turn: 1), in: messages), "9")
    }

    func testThePositionIsReadFromHUB() throws {
        let decoded = try JSONDecoder().decode([HubChatScreenshot].self,
            from: Data(#"[{"id":"x","name":"x.png","turn":2,"seq":41},{"id":"y","name":"y.png","turn":3}]"#.utf8))
        XCTAssertEqual(decoded.map(\.seq), [41, nil])
    }
}