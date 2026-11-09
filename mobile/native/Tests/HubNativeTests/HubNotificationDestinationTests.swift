import Foundation
import XCTest
@testable import HubNative

final class HubNotificationDestinationTests: XCTestCase {
    func testConversationLinkIsBoundToTheAlreadyConfiguredAuthority() throws {
        let destination = try HubNotificationDestination(data: Data(#"{"version":1,"kind":"session","origin":"https://hub.example.com","sessionId":"session-hub-eval-push"}"#.utf8))
        let same = try HubServer(address: "https://HUB.example.com:443/")
        XCTAssertEqual(try destination.url(for: same).absoluteString, "https://hub.example.com/?hubSession=session-hub-eval-push")
        XCTAssertThrowsError(try destination.url(for: HubServer(address: "https://other.example.com")))
        XCTAssertThrowsError(try destination.url(for: HubServer(address: "https://hub.example.com:444")))
    }
    func testPayloadCannotBecomeACommandOrAuthenticationURL() {
        for value in [
            #"{"version":1,"kind":"voice-start","origin":"https://hub.example.com","sessionId":"session-1"}"#,
            #"{"version":1,"kind":"session","origin":"https://hub.example.com/?token=secret","sessionId":"session-1"}"#,
            #"{"version":1,"kind":"session","origin":"https://hub.example.com","sessionId":"javascript:alert(1)"}"#,
            #"{"version":1,"kind":"session","origin":"https://hub.example.com","sessionId":"session-1","command":"approve"}"#
        ] { XCTAssertThrowsError(try HubNotificationDestination(data: Data(value.utf8))) }
    }
    func testBooleanVersionAndOversizedPayloadAreRejected() {
        XCTAssertThrowsError(try HubNotificationDestination(data: Data(#"{"version":true,"kind":"session","origin":"https://hub.example.com","sessionId":"session-1"}"#.utf8)))
        XCTAssertThrowsError(try HubNotificationDestination(data: Data(repeating: 32, count: 2049)))
    }
}
