import Foundation
import XCTest
@testable import HubNative

final class HubRTVITests: XCTestCase {
    func testReadyUsesStandardEnvelopeAndFreshReceipt() throws {
        let first = try XCTUnwrap(JSONSerialization.jsonObject(with: HubRTVI.ready()) as? [String: Any])
        let second = try XCTUnwrap(JSONSerialization.jsonObject(with: HubRTVI.ready()) as? [String: Any])
        XCTAssertEqual(first["label"] as? String, "rtvi-ai")
        XCTAssertEqual(first["type"] as? String, "client-ready")
        XCTAssertEqual((first["data"] as? [String: Any])?["version"] as? String, "2.0.0")
        XCTAssertNotEqual(first["id"] as? String, second["id"] as? String)
    }
    func testTranscriptFinalityAndUntrustedMessages() {
        let message = Data(#"{"label":"rtvi-ai","type":"user-transcription","data":{"text":"hello","final":false}}"#.utf8)
        XCTAssertEqual(HubRTVI.event(message)?.text, "hello")
        XCTAssertEqual(HubRTVI.event(message)?.final, false)
        XCTAssertNil(HubRTVI.event(Data(#"{"label":"other","type":"bot-ready"}"#.utf8)))
        XCTAssertNil(HubRTVI.event(Data("not-json".utf8)))
    }
    func testRecoverableErrorDoesNotBecomeASuccessOrFatalEvent() {
        let message = Data(#"{"label":"rtvi-ai","type":"error","data":{"fatal":false,"message":"fixture failure"}}"#.utf8)
        XCTAssertEqual(HubRTVI.event(message)?.type, "error")
        XCTAssertEqual(HubRTVI.event(message)?.fatal, false)
    }
}
