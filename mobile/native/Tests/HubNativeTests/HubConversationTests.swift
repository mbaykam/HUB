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

    func testFollowTimelineCombinesPackedAndLiveTextAndSettlesOnEnd() throws {
        let decoder = JSONDecoder()
        var timeline = HubChatTimeline()
        let opening = try decoder.decode(HubChatStreamFrame.self, from: Data(#"""
        {"type":"item","value":{"type":"snapshot","hasMore":true,"records":[
          {"event":{"type":"turn/start","seq":1,"data":{}}},
          {"event":{"type":"user/message","seq":2,"data":{"source":{"kind":"user"},"content":[{"type":"text","text":"Fixture"}]}}},
          {"event":{"type":"chunkrow/text-chunks","seq":3,"data":{"index":0,"texts":["Hello"," "]}}}
        ]}}
        """#.utf8))
        timeline.start(try XCTUnwrap(opening.value))
        XCTAssertEqual(timeline.snapshot.messages.map(\.text), ["Fixture"])
        XCTAssertTrue(timeline.snapshot.running)
        XCTAssertTrue(timeline.snapshot.hasMore)
        let updates = [
            #"{"type":"assistant/chunk","seq":5,"data":{"chunk":{"type":"text-delta","index":0,"text":"world"}}}"#,
            #"{"type":"tool/result","seq":6,"data":{"turn":1,"meta":{"kind":"hub-screenshot"}}}"#,
            #"{"type":"assistant/message","seq":7,"data":{"turn":1,"message":{"content":[{"type":"text","text":"Hello world"}]}}}"#,
            #"{"type":"turn/end","seq":8,"data":{"reason":{"kind":"completed"}}}"#,
        ]
        for (index, source) in updates.enumerated() {
            let event = try decoder.decode(HubChatStreamFrame.Entry.Event.self, from: Data(source.utf8))
            timeline.apply(event)
            if index == 0 { XCTAssertEqual(timeline.snapshot.partial, "Hello world") }
            if index == 1 {
                XCTAssertEqual(timeline.snapshot.latestScreenshotSequence, 6)
                XCTAssertTrue(timeline.snapshot.running)
            }
        }
        XCTAssertEqual(timeline.snapshot.messages.map(\.text), ["Fixture", "Hello world"])
        XCTAssertFalse(timeline.snapshot.running)
        XCTAssertTrue(timeline.snapshot.partial.isEmpty)
    }

    func testScreenshotCatalogUsesBoundedConversationRoute() async throws {
        let api = try client()
        let id = String(repeating: "a", count: 64)
        CatalogFixture.reply = """
        {"screenshots":[{"id":"\(id)","name":"Fixture.png","turn":2}]}
        """
        let screenshots = try await api.chatScreenshots(sessionID: "owned-chat")
        XCTAssertEqual(screenshots.first?.id, id)
        XCTAssertEqual(CatalogFixture.request?.url?.path, "/api/hub/artifacts")
        XCTAssertEqual(CatalogFixture.request?.value(forHTTPHeaderField: "x-hub-session"), "owned-chat")
        XCTAssertEqual(CatalogFixture.request?.value(forHTTPHeaderField: "Cookie"), "session=fixture")
        do {
            _ = try await api.chatScreenshot(sessionID: "owned-chat", id: "../other")
            XCTFail("Invalid image IDs should never reach the host")
        } catch {}
        XCTAssertEqual(CatalogFixture.requests.count, 1)
    }

    func testCanvasReadsOnlyTheSelectedChatAndCurrentDocument() async throws {
        let api = try client()
        let id = "850b7c3a-6376-4606-8d29-54080503fdaa"
        let document = "<!doctype html><html><head></head><body>Fixture</body></html>"
        CatalogFixture.responder = { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "session=fixture")
            XCTAssertEqual(request.value(forHTTPHeaderField: "x-hub-session"), "owned-chat")
            if request.url?.path == "/api/hub/presentation" {
                return (200, Data("""
                {"presentation":{"id":"\(id)","title":"Fixture","kind":"vega","createdAt":42}}
                """.utf8))
            }
            XCTAssertEqual(request.url?.path, "/api/hub/presentation-document")
            XCTAssertEqual(request.value(forHTTPHeaderField: "x-hub-presentation"), id)
            return (200, try JSONSerialization.data(withJSONObject: ["document": document]))
        }
        let presentation = try await api.chatPresentation(sessionID: "owned-chat")
        let selected = try XCTUnwrap(presentation)
        XCTAssertEqual(selected.kind, .vega)
        let html = try await api.chatPresentationDocument(sessionID: "owned-chat", id: selected.id)
        XCTAssertEqual(html, document)
        CatalogFixture.responder = nil
        CatalogFixture.reply = #"{"presentation":null}"#
        let empty = try await api.chatPresentation(sessionID: "owned-chat")
        XCTAssertNil(empty)
        do {
            _ = try await api.chatPresentation(sessionID: "../other")
            XCTFail("Invalid conversation IDs should never reach the host")
        } catch {}
        XCTAssertEqual(CatalogFixture.requests.count, 3)
    }

    func testBrowserPreviewRejectsAFrameFromAnotherConversation() async throws {
        let api = try client()
        let tab: [String: String] = [
            "sessionId": "browser-a", "ownerSessionId": "chat-a",
            "title": "Fixture", "url": "https://example.com", "status": "ready", "owner": "agent",
        ]
        CatalogFixture.responder = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/hub/browser-view")
            XCTAssertEqual(request.value(forHTTPHeaderField: "x-hub-browser-view"), "1")
            let command = try XCTUnwrap(JSONSerialization.jsonObject(with: Self.requestBody(request)) as? [String: String])
            if command == ["type": "list"] { return (200, try JSONSerialization.data(withJSONObject: [tab])) }
            XCTAssertEqual(command, ["type": "frame", "sessionId": "browser-a", "ownerSessionId": "chat-a"])
            var foreign = tab
            foreign["ownerSessionId"] = "chat-b"
            return (200, try JSONSerialization.data(withJSONObject: [
                "tab": foreign, "capturedAt": 42, "width": 12, "height": 8,
                "mimeType": "image/jpeg", "data": "/9j/",
            ]))
        }
        let tabs = try await api.browserTabs()
        let selected = try XCTUnwrap(tabs.first)
        do {
            _ = try await api.browserFrame(for: selected)
            XCTFail("The frame must match both the tab and its owner")
        } catch HubAttachmentError.invalidResponse {}
    }

    func testChatPreferencesUpdateOnlyTheSelectedFieldAndObservedRevision() async throws {
        let api = try client()
        CatalogFixture.responder = { request in
            let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: Self.requestBody(request)) as? [String: Any])
            let rpcID = try XCTUnwrap(envelope["rpcId"] as? String)
            let payload = try XCTUnwrap(envelope["payload"] as? [String: Any])
            let arguments = try XCTUnwrap(payload["args"] as? [String: Any])
            let value: [String: Any]
            if request.url?.path == "/api/settings/describe" {
                XCTAssertTrue(arguments.isEmpty)
                value = ["writable": true, "namespaces": [
                    ["ns": "ui-theme", "revision": 7, "value": ["fontSize": 16, "preference": "dark"]],
                    ["ns": "ui-conversation", "revision": 3, "value": ["busyEnter": "steer"]],
                    ["ns": "ui-chat", "revision": 2, "value": ["transcriptView": "normal"]],
                ]]
            } else {
                XCTAssertEqual(request.url?.path, "/api/settings/update")
                XCTAssertEqual(arguments["ns"] as? String, "ui-theme")
                XCTAssertEqual(arguments["patch"] as? [String: Int], ["fontSize": 16])
                XCTAssertEqual(arguments["expectedRevision"] as? Int, 7)
                value = ["ns": "ui-theme"]
            }
            return (200, try JSONSerialization.data(withJSONObject: [
                "type": "server-response", "rpcId": rpcID, "result": ["ok": true, "value": value],
            ]))
        }
        let preferences = try await api.chatPreferences()
        XCTAssertEqual(preferences.busyEnter, .steer)
        XCTAssertEqual(preferences.transcript, .normal)
        let updated = try await api.updateChatPreferences(.fontSize(16), from: preferences)
        XCTAssertEqual(updated.fontSize, 16)
        XCTAssertEqual(CatalogFixture.requests.map { $0.url?.path },
                       ["/api/settings/describe", "/api/settings/update", "/api/settings/describe"])
    }

    func testCreatingAChatUsesTheSelectedWorkspaceAndDoesNotUseItsPath() async throws {
        let api = try client()
        CatalogFixture.responder = { request in
            XCTAssertEqual(request.url?.path, "/api/session/create")
            let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: Self.requestBody(request)) as? [String: Any])
            let payload = try XCTUnwrap(envelope["payload"] as? [String: Any])
            let arguments = try XCTUnwrap(payload["args"] as? [String: Any])
            let command = try XCTUnwrap(arguments["request"] as? [String: String])
            XCTAssertEqual(command["workspaceId"], "owned-workspace")
            XCTAssertNil(command["cwd"])
            let session = try XCTUnwrap(command["sessionId"])
            let rpcID = try XCTUnwrap(envelope["rpcId"] as? String)
            return (200, try JSONSerialization.data(withJSONObject: [
                "type": "server-response", "rpcId": rpcID, "result": ["ok": true, "value": ["sessionId": session]],
            ]))
        }
        let id = try await api.createChat(workspaceID: "owned-workspace")
        XCTAssertTrue(id.hasPrefix("session-"))
    }

    func testChatKeepsAPendingModelThroughThePreviousModelsRequest() throws {
        let decoder = JSONDecoder()
        let start = try decoder.decode(HubChatStreamFrame.Value.self, from: Data(#"""
        {"type":"snapshot","records":[],"projections":{"values":{"title":"Previous","modelSelection":{
          "next":{"provider":"fixture","model":"new","reasoningEffort":"high"},
          "lastUsed":{"provider":"fixture","model":"old"}
        }}}}
        """#.utf8))
        var timeline = HubChatTimeline()
        timeline.start(start)
        let changes = [
            #"{"type":"request/header","seq":1,"data":{"header":{"config":{"provider":"fixture","model":"old"}}}}"#,
            #"{"type":"session/title","seq":2,"data":{"title":"Renamed"}}"#,
        ]
        for source in changes {
            timeline.apply(try decoder.decode(HubChatStreamFrame.Entry.Event.self, from: Data(source.utf8)))
        }
        XCTAssertEqual(timeline.snapshot.title, "Renamed")
        XCTAssertEqual(timeline.snapshot.model?.model, "new")
        XCTAssertEqual(timeline.snapshot.model?.reasoningEffort, "high")
    }

    func testEarlierChatPageUsesTheOriginalCursorAndExclusiveBoundary() async throws {
        let api = try client()
        CatalogFixture.responder = { request in
            XCTAssertEqual(request.url?.path, "/api/session/page")
            let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: Self.requestBody(request)) as? [String: Any])
            let payload = try XCTUnwrap(envelope["payload"] as? [String: Any])
            let args = try XCTUnwrap(payload["args"] as? [String: Any])
            let query = try XCTUnwrap(args["request"] as? [String: Any])
            XCTAssertEqual(query["address"] as? [String: String], ["kind": "session", "sessionId": "owned-chat"])
            XCTAssertEqual(query["throughSeq"] as? Int, 100)
            XCTAssertEqual(query["beforeSeq"] as? Int, 80)
            let record: [String: Any] = [
                "type": "event", "event": ["seq": 74, "type": "user/message", "data": [
                    "source": ["kind": "user"], "content": [["type": "text", "text": "Earlier fixture"]],
                ]],
            ]
            let rpcID = try XCTUnwrap(envelope["rpcId"] as? String)
            return (200, try JSONSerialization.data(withJSONObject: [
                "type": "server-response", "rpcId": rpcID, "result": [
                    "ok": true, "value": ["records": [record], "hasMore": false],
                ],
            ]))
        }
        let page = try await api.chatHistory(sessionID: "owned-chat", through: 100, before: 80)
        XCTAssertEqual(page.firstSequence, 74)
        XCTAssertEqual(page.messages.map(\.text), ["Earlier fixture"])
        XCTAssertFalse(page.hasMore)
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
            let action = try XCTUnwrap(command["action"] as? String)
            if action == "complete" || action == "reopen" {
                XCTAssertEqual(command["id"] as? String, key)
                XCTAssertEqual(command["version"] as? Int, 3)
            } else {
                XCTAssertEqual(command["action"] as? String, "save")
                let item = try XCTUnwrap(command["item"] as? [String: Any])
                XCTAssertEqual(item["id"] as? String, key)
                XCTAssertEqual(item["version"] as? Int, 0)
                XCTAssertEqual(item["title"] as? String, "Read notes")
                XCTAssertEqual(item["horizon"] as? String, "later")
            }
            let state = action == "complete" ? "done" : "open"
            return (200, Data("""
                {"revision":5,"items":[{"id":"\(key)","title":"Read notes","kind":"todo","state":"\(state)","deleted":false,"version":3}]}
                """.utf8))
        }
        let created = try await api.addTodo(id: id, title: " Read notes ", horizon: .later)
        let item = try XCTUnwrap(created.items.first)
        let completed = try await api.completeTodo(item)
        XCTAssertEqual(completed.items.first?.state, "done")
        let reopened = try await api.restorePlannerItem(XCTUnwrap(completed.items.first))
        XCTAssertEqual(reopened.items.first?.state, "open")
        XCTAssertEqual(CatalogFixture.requests.count, 3)
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
