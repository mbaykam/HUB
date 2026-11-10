import Foundation
import XCTest
@testable import HubNative

private final class VoiceFixture: URLProtocol {
    static var respond: ((URLRequest, Int) throws -> (Int, String, String))!
    static var requests: [URLRequest] = []
    static var bodies: [Data] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream, request.httpBody == nil {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 2048)
            while stream.hasBytesAvailable {
                let size = stream.read(&buffer, maxLength: buffer.count)
                if size <= 0 { break }
                body.append(contentsOf: buffer.prefix(size))
            }
        }
        Self.bodies.append(body)
        do {
            let (code, type, body) = try Self.respond(request, Self.requests.count)
            let response = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": type])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

private final class AdmissionPrivateFixture: HubPrivateStore {
    var data: [String: Data] = [:]
    func read(_ key: String) -> Data? { data[key] }
    func write(_ value: Data, for key: String) { data[key] = value }
    func remove(_ key: String) { data.removeValue(forKey: key) }
}

final class HubVoiceAPITests: XCTestCase {
    override func setUp() { VoiceFixture.requests = []; VoiceFixture.bodies = [] }
    private func client() throws -> HubVoiceAPI {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [VoiceFixture.self]
        return HubVoiceAPI(server: try HubServer(address: "https://hub.example.com"), configuration: config) {
            [HTTPCookie(properties: [.name: "session", .value: "fixture-only", .domain: "hub.example.com", .path: "/"])!,
             HTTPCookie(properties: [.name: "foreign", .value: "do-not-send", .domain: "elsewhere.test", .path: "/"])!]
        }
    }
    func testOwnedHealthAndAttentionKeepExactCallAndConfiguredWakePhrase() async throws {
        let api = try client(); defer { api.invalidate() }
        VoiceFixture.respond = { request, _ in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "session=fixture-only")
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: VoiceFixture.bodies.last!) as? [String: Any])
            XCTAssertEqual(body["callId"] as? String, "owned-call")
            if request.url?.path.hasSuffix("attention") == true {
                XCTAssertEqual(body["mode"] as? String, "active")
                return (200, "application/json", #"{"attention":{"mode":"active","wakePhrases":["Renamed assistant"]}}"#)
            }
            return (200, "application/json", #"{"callId":"owned-call","sessionId":"same-chat","status":"connected","attention":{"mode":"background","wakePhrases":["Renamed assistant"]},"inputPaused":true}"#)
        }
        let health = try await api.ownedHealth(callId: "owned-call", sessionId: "same-chat")
        XCTAssertEqual(health.attention?.mode, .background); XCTAssertEqual(health.inputPaused, true)
        let resumed = try await api.attention(callId: "owned-call", background: false)
        XCTAssertEqual(resumed.mode, .active); XCTAssertEqual(resumed.wakePhrases, ["Renamed assistant"])
        XCTAssertEqual(VoiceFixture.requests.count, 2)
    }
    func testHealthRejectsForeignOwnershipAndAttentionCannotFalselyConfirmResume() async throws {
        let api = try client(); defer { api.invalidate() }
        for reply in [
            #"{"callId":"foreign-call","sessionId":"same-chat","status":"connected"}"#,
            #"{"callId":"owned-call","sessionId":"foreign-chat","status":"connected"}"#,
            #"{"callId":"owned-call","sessionId":"same-chat","status":"connected","attention":{"mode":"background","wakePhrases":[]}}"#
        ] {
            VoiceFixture.respond = { _, _ in (200, "application/json", reply) }
            do { _ = try await api.ownedHealth(callId: "owned-call", sessionId: "same-chat"); XCTFail("Invalid owned health") }
            catch { XCTAssertEqual(error as? HubVoiceAPIError, .invalidResponse) }
        }
        VoiceFixture.respond = { _, _ in (200, "application/json", #"{"attention":{"mode":"background","wakePhrases":["Vera"]}}"#) }
        do { _ = try await api.attention(callId: "owned-call", background: false); XCTFail("Resume was not confirmed") }
        catch { XCTAssertEqual(error as? HubVoiceAPIError, .invalidResponse) }
    }
    func testAuthenticatedStatusNeverAcceptsAnHTMLLoginAsConnected() async throws {
        let api = try client()
        defer { api.invalidate() }
        VoiceFixture.respond = { request, _ in
            XCTAssertEqual(request.url?.absoluteString, "https://hub.example.com/api/hub/voice/status")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "session=fixture-only")
            return (200, "text/html", "<title>Sign in</title>")
        }
        do { _ = try await api.status(); XCTFail("HTML login must not be connected") }
        catch { XCTAssertEqual(error as? HubVoiceAPIError, .invalidResponse) }
    }
    func testLostAdmissionResponseReusesReceiptAndDoesNotStartANewConversation() async throws {
        let api = try client()
        defer { api.invalidate() }
        let receipt = UUID()
        VoiceFixture.respond = { request, index in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Origin"), "https://hub.example.com")
            if index == 1 { throw URLError(.networkConnectionLost) }
            return (200, "application/json", #"{"callId":"owned-call","sessionId":"same-chat","iceServers":[{"urls":"stun:stun.example.com:3478"}]}"#)
        }
        let lease = try await api.open(serverTime: 1_700_000_000_000, sessionId: "same-chat", requestId: receipt)
        XCTAssertEqual(lease.sessionId, "same-chat")
        XCTAssertEqual(lease.iceServers?.first?.urls, ["stun:stun.example.com:3478"])
        XCTAssertEqual(VoiceFixture.requests.count, 2)
        let bodies = VoiceFixture.bodies
        XCTAssertEqual(bodies[0], bodies[1])
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: bodies[0]) as? [String: Any])
        XCTAssertEqual(body["requestId"] as? String, receipt.uuidString.lowercased())
        XCTAssertEqual(body["sessionId"] as? String, "same-chat")
    }
    func testSignInAndBusyErrorsNeverRetryAdmission() async throws {
        for (status, expected) in [(401, HubVoiceAPIError.signInRequired), (403, .signInRequired), (302, .signInRequired), (409, .busy)] {
            VoiceFixture.requests = []
            VoiceFixture.respond = { _, _ in (status, "application/json", "{}") }
            let api = try client()
            do { _ = try await api.open(serverTime: 1); XCTFail("Must report failure") }
            catch { XCTAssertEqual(error as? HubVoiceAPIError, expected) }
            api.invalidate()
            XCTAssertEqual(VoiceFixture.requests.count, 1)
        }
    }
    func testSignalingCannotChooseAProxyDestinationAndCarriesOwnedCall() async throws {
        let api = try client()
        defer { api.invalidate() }
        do { _ = try await api.offer(callId: "call", payload: ["url": "https://elsewhere.test"]); XCTFail("Arbitrary destinations must fail") }
        catch { XCTAssertEqual(error as? HubVoiceAPIError, .invalidResponse) }
        XCTAssertTrue(VoiceFixture.requests.isEmpty)
        do { _ = try await api.offer(callId: "call\r\nInjected: header", payload: [:]); XCTFail("Invalid call headers must fail") }
        catch { XCTAssertEqual(error as? HubVoiceAPIError, .invalidResponse) }
        XCTAssertTrue(VoiceFixture.requests.isEmpty)
        VoiceFixture.respond = { request, _ in
            XCTAssertEqual(request.value(forHTTPHeaderField: "x-hub-voice-call"), "owned-call")
            XCTAssertEqual(request.url?.path, "/api/hub/voice/offer")
            XCTAssertEqual(request.httpMethod, "PATCH")
            return (200, "application/json", "{}")
        }
        _ = try await api.offer(callId: "owned-call", payload: ["candidates": []], trickle: true)
    }
    func testProcessRestartRecoversTheOriginalAdmissionInsteadOfCreatingAnotherConversation() async throws {
        let server = try HubServer(address: "https://hub.example.com"), store = AdmissionPrivateFixture()
        let receipt = HubVoiceAdmission(server: server, requestedAt: 1_700_000_000_000, sessionID: "original-chat")
        try HubDeviceState(server: server, store: store).rememberAdmission(receipt)
        var observedIDs = Set<String>()
        VoiceFixture.respond = { _, index in
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: VoiceFixture.bodies.last!) as? [String: Any])
            observedIDs.insert(try XCTUnwrap(body["requestId"] as? String))
            if index <= 2 { throw URLError(.networkConnectionLost) }
            return (200, "application/json", #"{"callId":"owned-call","sessionId":"original-chat"}"#)
        }
        let first = try client()
        do { _ = try await first.recover(receipt); XCTFail("Both responses were lost") } catch { XCTAssertTrue(error is URLError) }
        first.invalidate()
        let reopened = HubDeviceState(server: server, store: store)
        let recoveredReceipt = try XCTUnwrap(reopened.admission())
        let second = try client()
        defer { second.invalidate() }
        let owned = try await second.recover(recoveredReceipt)
        XCTAssertEqual(owned.sessionId, "original-chat")
        XCTAssertEqual(VoiceFixture.requests.count, 3)
        XCTAssertEqual(Set(VoiceFixture.bodies).count, 1)
        XCTAssertEqual(observedIDs, [receipt.requestID.uuidString.lowercased()])
    }
    func testExpiredAdmissionAndForeignReceiptNeverCreateAnotherRequest() async throws {
        let api = try client(), server = try HubServer(address: "https://hub.example.com")
        defer { api.invalidate() }
        VoiceFixture.respond = { _, _ in (400, "application/json", #"{"error":"expired-admission"}"#) }
        do { _ = try await api.recover(HubVoiceAdmission(server: server, requestedAt: 1)); XCTFail("Must not mint another receipt") }
        catch { XCTAssertEqual(error as? HubVoiceAPIError, .admissionExpired) }
        XCTAssertEqual(VoiceFixture.requests.count, 1)
        let foreign = try HubServer(address: "https://other.example.com")
        do { _ = try await api.recover(HubVoiceAdmission(server: foreign, requestedAt: 1)); XCTFail("Wrong authority") }
        catch { XCTAssertEqual(error as? HubVoiceAPIError, .invalidResponse) }
        XCTAssertEqual(VoiceFixture.requests.count, 1)
    }
}
