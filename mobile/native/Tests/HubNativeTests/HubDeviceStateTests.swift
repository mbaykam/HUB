import Foundation
import XCTest
@testable import HubNative

private final class PrivateFixture: HubPrivateStore {
    var values: [String: Data] = [:]
    func read(_ key: String) -> Data? { values[key] }
    func write(_ data: Data, for key: String) { values[key] = data }
    func remove(_ key: String) { values.removeValue(forKey: key) }
}

final class HubDeviceStateTests: XCTestCase {
    private let time = Date(timeIntervalSince1970: 1_700_000_000)
    private func cookie(_ name: String, domain: String = "hub.example.com", expires: Date? = nil) -> HTTPCookie {
        var value: [HTTPCookiePropertyKey: Any] = [.name: name, .value: "fixture-only", .domain: domain, .path: "/", .secure: "TRUE"]
        if let expires { value[.expires] = expires }
        return HTTPCookie(properties: value)!
    }
    private func lease() throws -> HubVoiceLease {
        try JSONDecoder().decode(HubVoiceLease.self, from: Data(#"{"callId":"owned-call","sessionId":"original-chat","iceServers":[]}"#.utf8))
    }
    private func status(_ active: String = "", busy: Bool) throws -> HubVoiceStatus {
        let suffix = active.isEmpty ? "" : #", "activeCall":{"callId":"\#(active)","sessionId":"original-chat"}"#
        return try JSONDecoder().decode(HubVoiceStatus.self, from: Data("{\"enabled\":true,\"busy\":\(busy),\"serverTime\":1\(suffix)}".utf8))
    }
    func testSpeakStartsFreshAfterAnEndedCallUnlessResumeWasExplicit() throws {
        let checkpoint = HubVoiceCheckpoint(server: try HubServer(address: "https://hub.example.com"), lease: try lease(), peerID: "peer-fixture")
        XCTAssertNil(checkpoint.forExplicitStart(status: try status(busy: false), resumeEndedConversation: false))
        XCTAssertEqual(checkpoint.forExplicitStart(status: try status(busy: false), resumeEndedConversation: true)?.lease.sessionId, "original-chat")
        XCTAssertEqual(checkpoint.forExplicitStart(status: try status("owned-call", busy: true), resumeEndedConversation: false)?.recovery(status: try status("owned-call", busy: true)), .rejoinOwnedCall)
        XCTAssertEqual(checkpoint.forExplicitStart(status: try status("foreign-call", busy: true), resumeEndedConversation: false)?.recovery(status: try status("foreign-call", busy: true)), .anotherCall)
    }
    func testOnlyVerifiedOriginAuthCookiesSurviveAStoreReopen() throws {
        let server = try HubServer(address: "https://hub.example.com"), store = PrivateFixture()
        let state = HubDeviceState(server: server, store: store, now: { self.time })
        try state.rememberVerifiedSession([cookie("CF_Authorization"), cookie("dsh-auth-fixture"), cookie("irrelevant-personal-cookie"), cookie("dsh-auth-foreign", domain: "elsewhere.test")])
        let restored = HubDeviceState(server: server, store: store, now: { self.time })
        XCTAssertEqual(try restored.cookies().map(\.name), ["CF_Authorization", "dsh-auth-fixture"])
        let data = try XCTUnwrap(store.values.values.first)
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("irrelevant-personal-cookie"))
        let other = HubDeviceState(server: try HubServer(address: "https://other.example.com"), store: store, now: { self.time })
        XCTAssertTrue(try other.cookies().isEmpty)
    }
    func testCookieCacheDoesNotExtendExpiryOrSessionLifetime() throws {
        let server = try HubServer(address: "https://hub.example.com"), store = PrivateFixture()
        try HubDeviceState(server: server, store: store, now: { self.time }).rememberVerifiedSession([cookie("CF_Authorization", expires: time.addingTimeInterval(60)), cookie("dsh-auth-session")])
        XCTAssertEqual(try HubDeviceState(server: server, store: store, now: { self.time.addingTimeInterval(61) }).cookies().map(\.name), ["dsh-auth-session"])
        XCTAssertTrue(try HubDeviceState(server: server, store: store, now: { self.time.addingTimeInterval(86_401) }).cookies().isEmpty)
    }
    func testOwnedReceiptRestoresTheOriginalConversationButNeverAdoptsAnotherCall() throws {
        let server = try HubServer(address: "https://hub.example.com"), store = PrivateFixture()
        let state = HubDeviceState(server: server, store: store, now: { self.time })
        try state.rememberVoice(HubVoiceCheckpoint(server: server, lease: lease(), peerID: "peer-fixture", savedAt: time))
        let restored = try XCTUnwrap(HubDeviceState(server: server, store: store, now: { self.time }).voice())
        XCTAssertEqual(restored.lease.sessionId, "original-chat")
        XCTAssertEqual(restored.recovery(status: try status("owned-call", busy: true)), .rejoinOwnedCall)
        XCTAssertEqual(restored.recovery(status: try status("someone-elses-call", busy: true)), .anotherCall)
        XCTAssertEqual(restored.recovery(status: try status(busy: false)), .resumeEndedConversation)
        let pending = HubVoiceCheckpoint(server: server, lease: try lease(), peerID: nil, savedAt: time)
        XCTAssertEqual(pending.recovery(status: try status("owned-call", busy: true)), .missingPeer)
    }
    func testLogoutClearsOnlyThisServerAndInvalidRecordsFailClosed() throws {
        let server = try HubServer(address: "https://hub.example.com"), store = PrivateFixture()
        let state = HubDeviceState(server: server, store: store, now: { self.time })
        try state.rememberVoice(HubVoiceCheckpoint(server: server, lease: lease(), peerID: nil, savedAt: time))
        try state.rememberVerifiedSession([cookie("dsh-auth-session")])
        store.values["unrelated"] = Data("preserved".utf8)
        try state.clear()
        XCTAssertNil(try state.voice()); XCTAssertTrue(try state.cookies().isEmpty)
        XCTAssertEqual(store.values["unrelated"], Data("preserved".utf8))
        store.values["voice:https://hub.example.com/"] = Data("not-json".utf8)
        XCTAssertThrowsError(try state.voice())
        let foreign = try HubServer(address: "https://foreign.example.com")
        XCTAssertThrowsError(try state.rememberVoice(HubVoiceCheckpoint(server: foreign, lease: lease(), peerID: nil, savedAt: time)))
        XCTAssertThrowsError(try state.rememberVoice(HubVoiceCheckpoint(server: server, lease: lease(), peerID: nil, savedAt: time.addingTimeInterval(120))))
    }
    func testAdmissionSurvivesReopenWithOriginalNonceAndIsClearedOnLogout() throws {
        let server = try HubServer(address: "https://hub.example.com"), store = PrivateFixture()
        let state = HubDeviceState(server: server, store: store, now: { self.time })
        let receipt = HubVoiceAdmission(server: server, requestedAt: 1_700_000_000_000, sessionID: "original-chat", savedAt: time)
        try state.rememberAdmission(receipt)
        let reopened = HubDeviceState(server: server, store: store, now: { self.time })
        XCTAssertEqual(try reopened.admission()?.requestID, receipt.requestID)
        XCTAssertEqual(try reopened.admission()?.requestedAt, receipt.requestedAt)
        XCTAssertEqual(try reopened.admission()?.sessionID, "original-chat")
        try reopened.clear()
        XCTAssertNil(try state.admission())
    }
    func testAdmissionRejectsWrongOriginAndExpiresWithoutInventingANewReceipt() throws {
        let server = try HubServer(address: "https://hub.example.com"), store = PrivateFixture()
        let state = HubDeviceState(server: server, store: store, now: { self.time })
        let foreign = try HubServer(address: "https://other.example.com")
        XCTAssertThrowsError(try state.rememberAdmission(HubVoiceAdmission(server: foreign, requestedAt: 1, savedAt: time)))
        try state.rememberAdmission(HubVoiceAdmission(server: server, requestedAt: 1, savedAt: time))
        XCTAssertNil(try HubDeviceState(server: server, store: store, now: { self.time.addingTimeInterval(601) }).admission())
    }
}
