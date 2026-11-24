import Foundation
import XCTest
@testable import HubNative

final class HubChatQuotaResumeTests: XCTestCase {
    func testDefaultOffServerContract() throws {
        let data = Data(#"{"sessionId":"chat","revision":0,"enabled":false,"eligible":true,"state":"idle"}"#.utf8)
        let value = try JSONDecoder().decode(HubChatQuotaResume.self, from: data)
        XCTAssertFalse(value.enabled)
        XCTAssertNil(value.resetDate)
        XCTAssertEqual(value.statusText, "Off for this chat.")
    }

    func testReportedResetIsMillisecondsAndUnknownStaysUnknown() throws {
        let known = Data(#"{"sessionId":"chat","revision":2,"enabled":true,"eligible":true,"state":"waiting","resetsAt":1795514400000,"provider":"claude-code","model":"opus","endSeq":9}"#.utf8)
        let value = try JSONDecoder().decode(HubChatQuotaResume.self, from: known)
        XCTAssertEqual(value.resetDate?.timeIntervalSince1970, 1795514400)
        let unknown = Data(#"{"sessionId":"chat","revision":2,"enabled":true,"eligible":true,"state":"waiting-unknown","provider":"openai-codex","model":"gpt-5"}"#.utf8)
        let waiting = try JSONDecoder().decode(HubChatQuotaResume.self, from: unknown)
        XCTAssertNil(waiting.resetDate)
        XCTAssertTrue(waiting.statusText.contains("has not reported a reset time"))
    }

    func testUnknownStateRejectedAndConsumedDoesNotClaimCompletion() throws {
        let bad = Data(#"{"sessionId":"chat","revision":0,"enabled":false,"eligible":true,"state":"pretend-success"}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(HubChatQuotaResume.self, from: bad))
        let consumed = Data(#"{"sessionId":"chat","revision":4,"enabled":true,"eligible":true,"state":"consumed"}"#.utf8)
        let value = try JSONDecoder().decode(HubChatQuotaResume.self, from: consumed)
        XCTAssertTrue(value.statusText.contains("not a completion receipt"))
        let review = Data(#"{"sessionId":"chat","revision":4,"enabled":true,"eligible":true,"state":"needs-review","reason":"uncertain-dispatch"}"#.utf8)
        let uncertain = try JSONDecoder().decode(HubChatQuotaResume.self, from: review)
        XCTAssertTrue(uncertain.statusText.contains("will not be repeated automatically"))
    }
}
