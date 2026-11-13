import Foundation
import XCTest
@testable import HubNative

private final class CatalogFixture: URLProtocol {
    static var reply = ""
    static var code = 200
    static var request: URLRequest?
    static var requests: [URLRequest] = []
    static var responder: ((URLRequest) throws -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.request = request
        Self.requests.append(request)
        do {
            let (code, data) = try Self.responder?(request) ?? (Self.code, Data(Self.reply.utf8))
            let response = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: ["Content-Type":"application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}
}
final class HubConversationTests: XCTestCase {
    override func setUp() {
        CatalogFixture.code = 200
        CatalogFixture.request = nil
        CatalogFixture.requests = []
        CatalogFixture.responder = nil
    }

    func testHomeReadsUseExistingAuthenticatedRoutes() async throws {
        let api = try client()
        CatalogFixture.reply = #"{"nodes":[{"id":"note","kind":"note"}],"edges":[]}"#
        let graph = try await api.knowledge()
        XCTAssertEqual(graph.nodes.first?.id, "note")
        XCTAssertEqual(CatalogFixture.request?.url?.query, "view=graph")
        XCTAssertEqual(CatalogFixture.request?.value(forHTTPHeaderField: "x-hub-memory"), "1")
        CatalogFixture.reply = #"{"items":[{"id":"todo","title":"Fixture","kind":"todo","state":"open","deleted":false}]}"#
        let planner = try await api.planner()
        XCTAssertEqual(planner.items.first?.title, "Fixture")
        XCTAssertEqual(CatalogFixture.request?.url?.path, "/api/hub/planner")
        XCTAssertTrue(CatalogFixture.requests.allSatisfy { $0.httpMethod == "GET" })
    }

    func testPlannerWritesUseStableDraftIDAndServerItemVersion() async throws {
        let api = try client()
        let id = UUID()
        let key = id.uuidString.lowercased()
        CatalogFixture.responder = { request in
            XCTAssertEqual(request.url?.path, "/api/hub/planner")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "x-hub-planner"), "1")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "session=fixture")
            let body = try Self.requestBody(request)
            let command = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            let complete = command["action"] as? String == "complete"
            if complete {
                XCTAssertEqual(command["id"] as? String, key)
                XCTAssertEqual(command["version"] as? Int, 3)
            } else {
                XCTAssertEqual(command["action"] as? String, "save")
                let item = try XCTUnwrap(command["item"] as? [String: Any])
                XCTAssertEqual(item["id"] as? String, key)
                XCTAssertEqual(item["version"] as? Int, 0)
                XCTAssertEqual(item["title"] as? String, "Read notes")
            }
            let state = complete ? "done" : "open"
            return (200, Data("""
                {"revision":5,"items":[{"id":"\(key)","title":"Read notes","kind":"todo","state":"\(state)","deleted":false,"version":3}]}
                """.utf8))
        }
        let created = try await api.addTodo(id: id, title: " Read notes ")
        let item = try XCTUnwrap(created.items.first)
        let completed = try await api.completeTodo(item)
        XCTAssertEqual(completed.items.first?.state, "done")
        XCTAssertEqual(CatalogFixture.requests.count, 2)
    }

    func testNewChatPostsOneCorrelatedPromptAndDoesNotReplayAnUncertainDelivery() async throws {
        let api = try client()
        var accepted = false
        var createdID = ""
        CatalogFixture.responder = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "session=fixture")
            XCTAssertEqual(request.url?.host, "hub.example.com")
            let body = try Self.requestBody(request)
            let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            let rpcID = try XCTUnwrap(envelope["rpcId"] as? String)
            let method = try XCTUnwrap(envelope["method"] as? String)
            XCTAssertEqual(request.url?.path, "/api/" + method)
            let args = try XCTUnwrap((envelope["payload"] as? [String: Any])?["args"] as? [String: Any])
            let payload = try XCTUnwrap(args["request"] as? [String: Any])
            let id = try XCTUnwrap(payload["sessionId"] as? String)
            var value: [String: Any]
            if method == "session/create" {
                createdID = id
                value = ["sessionId": id]
            } else {
                XCTAssertEqual(method, "session/prompt")
                XCTAssertEqual(id, createdID)
                XCTAssertEqual(payload["mode"] as? String, "queue")
                XCTAssertEqual(payload["content"] as? [[String: String]], [["type": "text", "text": "Test draft"]])
                if !accepted { throw URLError(.networkConnectionLost) }
                value = ["accepted": true]
            }
            return (200, try JSONSerialization.data(withJSONObject: [
                "type": "server-response", "rpcId": rpcID, "result": ["ok": true, "value": value],
            ]))
        }
        do {
            _ = try await api.sendNewChat(" Test draft ")
            XCTFail("A lost prompt receipt cannot be counted as accepted")
        } catch {
            XCTAssertEqual(error as? HubChatSendError, .unknownDelivery(sessionID: createdID))
        }
        XCTAssertEqual(CatalogFixture.requests.map { $0.url?.path }, ["/api/session/create", "/api/session/prompt"])
        accepted = true
        let sent = try await api.sendNewChat("Test draft")
        XCTAssertEqual(sent, createdID)
        XCTAssertEqual(CatalogFixture.requests.count, 4)
    }

    private static func requestBody(_ request: URLRequest) throws -> Data {
        if let body = request.httpBody { return body }
        let stream = try XCTUnwrap(request.httpBodyStream)
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while true {
            let read = stream.read(&buffer, maxLength: buffer.count)
            guard read >= 0 else { throw URLError(.cannotDecodeContentData) }
            if read == 0 { return data }
            data.append(contentsOf: buffer.prefix(read))
        }
    }

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
