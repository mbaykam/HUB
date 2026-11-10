import Foundation
import XCTest
@testable import HubNative

final class HubVoiceNavigationTests: XCTestCase {
    func testOnlyAnOwnedRootMainFrameLinkCanRequestTheUIConfirmation() throws {
        let server = try HubServer(address: "https://hub.example.com"), source = URL(string: "https://hub.example.com/?hubSession=existing")!
        let target = URL(string: "https://hub.example.com/?hubNative=voice")!
        XCTAssertTrue(HubVoiceNavigation.requestsConfirmation(url: target, source: source, server: server, sourceIsMainFrame: true, targetIsMainFrame: true, isLink: true))
        for flags in [(false,true,true),(true,false,true),(true,true,false)] {
            XCTAssertFalse(HubVoiceNavigation.requestsConfirmation(url: target, source: source, server: server, sourceIsMainFrame: flags.0, targetIsMainFrame: flags.1, isLink: flags.2))
        }
        for badSource in [nil,URL(string:"https://foreign.test/"),URL(string:"https://hub.example.com/api/hub/presentation-document")] {
            XCTAssertFalse(HubVoiceNavigation.requestsConfirmation(url: target, source: badSource, server: server, sourceIsMainFrame: true, targetIsMainFrame: true, isLink: true))
        }
    }
    func testNavigationCarriesNoAudioCommandsSessionAuthorityOrAgentFrameParameters() throws {
        let server = try HubServer(address: "https://hub.example.com"), source = server.origin
        for value in ["http://hub.example.com/?hubNative=voice", "https://foreign.test/?hubNative=voice",
                      "https://user:secret@hub.example.com/?hubNative=voice", "https://hub.example.com:444/?hubNative=voice",
                      "https://hub.example.com/api/hub/?hubNative=voice", "https://hub.example.com/?hubNative=end",
                      "https://hub.example.com/?hubNative=voice#start", "https://hub.example.com/?hubNative=voice&callId=other",
                      "https://hub.example.com/?hubNative=voice&sessionId=other", "https://hub.example.com/?hubNative=voice&hubNative=voice",
                      "https://hub.example.com/?hubNative=voice&autoStart=true"] {
            XCTAssertFalse(HubVoiceNavigation.requestsConfirmation(url: URL(string:value)!, source: source, server: server, sourceIsMainFrame: true, targetIsMainFrame: true, isLink: true), value)
        }
    }
}
