import Foundation
import XCTest
@testable import HubNative

private final class CatalogFixture: URLProtocol {
    static var reply = ""
    static var code = 200
    static var request: URLRequest?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.request = request
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.code, httpVersion: nil, headerFields: ["Content-Type":"application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.reply.utf8)); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
final class HubConversationTests: XCTestCase {
    override func setUp() { CatalogFixture.code = 200; CatalogFixture.request = nil }
    func testPendingHandoffChecksHostCapabilityAndExactReceiptBeforeOpening() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("hub-eval-confirm-draft-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let server = try HubServer(address: "https://hub.example.com"), store = try HubAttachmentStore(root: root), api = try client()
        let draft = try await store.stage(data: Data("fixture".utf8), name: "File.txt", server: server, sessionID: "owned-chat", callID: "text-composer")
        CatalogFixture.code = 404; CatalogFixture.reply = "{}"
        do { _ = try await api.confirmedDraftURL(draft); XCTFail("An older host cannot silently open an unsupported handoff") } catch {}
        CatalogFixture.code = 200
        CatalogFixture.reply = "{\"id\":\"\(draft.id)\",\"sessionId\":\"other-chat\",\"name\":\"File.txt\",\"bytes\":7}"
        do { _ = try await api.confirmedDraftURL(draft); XCTFail("Wrong receipt owner") } catch {}
        CatalogFixture.reply = "{\"id\":\"\(draft.id)\",\"sessionId\":\"owned-chat\",\"name\":\"File.txt\",\"bytes\":7}"
        let url = try await api.confirmedDraftURL(draft)
        XCTAssertEqual(url, try api.draftURL(draft))
        let request = try XCTUnwrap(CatalogFixture.request)
        XCTAssertEqual(request.url?.path, "/api/hub/uploads/draft"); XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.value(forHTTPHeaderField: "x-hub-session"), "owned-chat")
        XCTAssertEqual(request.value(forHTTPHeaderField: "x-hub-upload-id"), draft.id.uuidString.lowercased())
        XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "session=fixture")
    }
    private func client() throws -> HubConversationAPI {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [CatalogFixture.self]
        return HubConversationAPI(server: try HubServer(address: "https://hub.example.com"), configuration: config) {
            [HTTPCookie(properties: [.name:"session",.value:"fixture",.domain:"hub.example.com",.path:"/"])!,HTTPCookie(properties: [.name:"foreign",.value:"never-send",.domain:"other.test",.path:"/"])!]
        }
    }
    func testCatalogIsReadOnlyOriginScopedAndSearchesWithoutPuttingTitlesInURLs() async throws {
        let api = try client()
        CatalogFixture.reply = #"{"conversations":[{"sessionId":"old-chat","title":"Eski Türkçe sohbet","updatedAt":1}],"hasMore":false}"#
        let result = try await api.list(search: "Türkçe")
        XCTAssertEqual(result.conversations.first?.sessionId, "old-chat")
        let request = try XCTUnwrap(CatalogFixture.request)
        XCTAssertEqual(request.url?.absoluteString, "https://hub.example.com/api/hub/conversations")
        XCTAssertEqual(request.httpMethod, "GET"); XCTAssertNil(request.httpBody)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "session=fixture")
        XCTAssertEqual(request.value(forHTTPHeaderField: "x-hub-session-query")?.removingPercentEncoding, "Türkçe")
    }
    func testCatalogRejectsDuplicateOrUnsafeConversationIDs() async throws {
        let api = try client()
        for reply in [#"{"conversations":[{"sessionId":"../wrong","title":"Wrong","updatedAt":1}],"hasMore":false}"#,
                      #"{"conversations":[{"sessionId":"same","title":"One","updatedAt":1},{"sessionId":"same","title":"Two","updatedAt":2}],"hasMore":false}"#] {
            CatalogFixture.reply = reply
            do { _ = try await api.list(); XCTFail("Unsafe catalog must fail") }
            catch { guard case HubAttachmentError.invalidResponse = error else { return XCTFail("Wrong catalog error") } }
        }
    }
    func testDraftURLCarriesOnlyPinnedConversationAndReceiptNeverAnInstruction() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("hub-eval-handoff-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let server = try HubServer(address: "https://hub.example.com"), store = try HubAttachmentStore(root: root), api = try client()
        let draft = try await store.stage(data: Data("fixture".utf8), name: "Private filename.txt", server: server, sessionID: "owned-chat", callID: "text-composer")
        let url = try api.draftURL(draft), parts = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(parts.host, "hub.example.com")
        XCTAssertEqual(parts.queryItems, [URLQueryItem(name:"hubSession",value:"owned-chat"),URLQueryItem(name:"hubUpload",value:draft.id.uuidString.lowercased())])
        XCTAssertFalse(url.absoluteString.contains("Private"))
        let foreign = HubConversationAPI(server: try HubServer(address: "https://other.test")) { [] }
        XCTAssertThrowsError(try foreign.draftURL(draft))
    }
}
