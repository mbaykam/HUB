import Foundation
import XCTest
@testable import HubNative

private final class PushPrivateFixture: HubPrivateStore {
    var values: [String: Data] = [:]
    func read(_ key: String) -> Data? { values[key] }
    func write(_ data: Data, for key: String) { values[key] = data }
    func remove(_ key: String) { values.removeValue(forKey: key) }
}
private final class PushHTTPFixture: URLProtocol {
    static var code = 200
    static var mime = "application/json"
    static var body = #"{"version":1,"configured":true,"devices":1,"pending":0}"#
    static var requests: [URLRequest] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.code, httpVersion: nil, headerFields: ["Content-Type": Self.mime])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.body.utf8)); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
final class HubPushTests: XCTestCase {
    func testLogoutAndReopenNeverReuseAnEnabledGeneration() throws {
        let store = PushPrivateFixture(), server = try HubServer(address: "https://hub.example.com")
        let state = HubDeviceState(server: server, store: store)
        let enabled = try state.advancePush(enabled: true)
        let tokenUpdate = try state.advancePush(enabled: true)
        XCTAssertEqual(tokenUpdate.generation, enabled.generation + 1)
        try state.clear()
        let reopened = HubDeviceState(server: server, store: store)
        let revoked = try XCTUnwrap(reopened.pushIdentity())
        XCTAssertFalse(revoked.enabled); XCTAssertEqual(revoked.id, enabled.id)
        XCTAssertGreaterThan(revoked.generation, tokenUpdate.generation)
        let reenabled = try reopened.advancePush(enabled: true)
        XCTAssertGreaterThan(reenabled.generation, revoked.generation)
        let other = HubDeviceState(server: try HubServer(address: "https://other.test"), store: store)
        XCTAssertNil(try other.pushIdentity())
        XCTAssertFalse(store.values.values.contains { String(decoding: $0, as: UTF8.self).contains("token") })
    }
    private func api() throws -> HubPushAPI {
        PushHTTPFixture.requests = []; PushHTTPFixture.code = 200; PushHTTPFixture.mime = "application/json"
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [PushHTTPFixture.self]
        return HubPushAPI(server: try HubServer(address: "https://hub.example.com"), configuration: config) {
            [HTTPCookie(properties: [.name:"session",.value:"fixture",.domain:"hub.example.com",.path:"/"])!,
             HTTPCookie(properties: [.name:"foreign",.value:"secret",.domain:"other.test",.path:"/"])!]
        }
    }
    func testPushRequestsUseOnlyTheFixedAuthenticatedOrigin() async throws {
        let client = try api()
        _ = try await client.register(HubPushIdentity(enabled: true), token: Data(repeating: 9, count: 32), environment: "development")
        let request = try XCTUnwrap(PushHTTPFixture.requests.first)
        XCTAssertEqual(request.url?.absoluteString, "https://hub.example.com/api/hub/notifications")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "session=fixture")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Origin"), "https://hub.example.com")
        XCTAssertEqual(request.value(forHTTPHeaderField: "x-hub-native-push"), "1")
        do { _ = try await client.register(HubPushIdentity(enabled: false), token: Data(repeating: 0, count: 32), environment: "production"); XCTFail("Disabled identities must never register") } catch {}
        XCTAssertEqual(PushHTTPFixture.requests.count, 1)
    }
    func testMissingHostAndHTMLLoginAreNotSuccessfulRegistration() async throws {
        let client = try api()
        PushHTTPFixture.code = 404
        do { _ = try await client.status(); XCTFail("Missing endpoint must require host update") }
        catch { guard case HubPushError.updateHost = error else { return XCTFail("Wrong error") } }
        PushHTTPFixture.code = 200; PushHTTPFixture.mime = "text/html"
        do { _ = try await client.status(); XCTFail("Login HTML must fail") }
        catch { guard case HubPushError.invalidResponse = error else { return XCTFail("Wrong error") } }
    }
}
