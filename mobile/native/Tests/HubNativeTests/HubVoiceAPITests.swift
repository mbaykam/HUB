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
}
