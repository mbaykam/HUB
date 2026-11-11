import Foundation
import XCTest
@testable import HubNative

final class HubVoiceNavigationTests: XCTestCase {
    func testOptionsOnlyOpenAnOwnedMainFramePanelAndCannotCarryCommands() throws {
        let server = try HubServer(address: "https://hub.example.com"), source = server.origin
        func allowed(_ value: String, sourceIsMain: Bool = true, targetIsMain: Bool = true, isLink: Bool = true) -> Bool {
            HubVoiceNavigation.requestsOptions(url: URL(string: value)!, source: source, server: server, sourceIsMainFrame: sourceIsMain, targetIsMainFrame: targetIsMain, isLink: isLink)
        }
        let target = "https://hub.example.com/?hubNative=options"
        XCTAssertTrue(allowed(target))
        XCTAssertFalse(allowed(target, sourceIsMain: false))
        XCTAssertFalse(allowed(target, targetIsMain: false))
        XCTAssertFalse(allowed(target, isLink: false))
        for value in ["https://foreign.test/?hubNative=options", "http://hub.example.com/?hubNative=options", "https://hub.example.com/frame?hubNative=options", target + "&command=signout", target + "&token=secret", target + "#reload", target + "&hubNative=options"] { XCTAssertFalse(allowed(value)) }
        XCTAssertFalse(HubVoiceNavigation.requestsOptions(url: URL(string: target)!, source: URL(string: "https://hub.example.com/agent.html"), server: server, sourceIsMainFrame: true, targetIsMainFrame: true, isLink: true))
    }
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
