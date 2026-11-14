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

    func testKnowledgeArchiveStagingPreservesBytesAndDoesNotAdmit() async throws {
        let api = try client()
        let source = Data(#"{"fixture":true}"#.utf8)
        CatalogFixture.responder = { request in
            XCTAssertEqual(request.url?.path, "/api/hub/memory")
            XCTAssertEqual(request.url?.query, "action=preview-import")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/octet-stream")
            XCTAssertEqual(request.value(forHTTPHeaderField: "x-hub-filename"), "Turkish%20archive%2Ejson")
            XCTAssertEqual(try Self.requestBody(request), source)
            return (200, Data(#"""
            {"id":"12345678-1234-1234-1234-123456789abc","filename":"Turkish archive.json","state":"previewed",
             "conversations":0,"admitted":0,"records":[],"previewHash":"fixture","warnings":[],"nextOffset":null}
            """#.utf8))
        }
        let preview = try await api.stageKnowledgeArchive(source, filename: "Turkish archive.json")
        XCTAssertEqual(preview.admitted, 0)
        XCTAssertEqual(CatalogFixture.requests.count, 1)
    }

    func testQueueOnlyDisplaysSelectedSessionAndNeverEditsAttachmentsAsText() async throws {
        let baseline = Data(#"""
        {"type":"item","value":{"type":"baseline","value":{"queues":{
          "owned-chat":[
            {"id":"text-1","placement":"queued","message":{"content":[{"type":"text","text":"Original"}]}},
            {"id":"image-1","placement":"queued","message":{"content":[{"type":"image"}]}},
            {"id":"context-1","placement":"context","message":{"content":[{"type":"text","text":"Hidden"}]}}
          ],
          "other-chat":[{"id":"private-1","placement":"queued","message":{"content":[{"type":"text","text":"Other chat"}]}}]
        }}}}
        """#.utf8)
        let update = try XCTUnwrap(HubConversationAPI.chatQueueUpdate(baseline, sessionID: "owned-chat"))
        let items = try XCTUnwrap(update.items)
        XCTAssertEqual(items.map(\.id), ["text-1", "image-1"])
        XCTAssertTrue(items[0].canEdit)
        XCTAssertFalse(items[1].canEdit)
        let unrelated = Data(#"{"type":"item","value":{"type":"queue","sessionId":"other-chat","items":[]}}"#.utf8)
        XCTAssertNil(try HubConversationAPI.chatQueueUpdate(unrelated, sessionID: "owned-chat"))

        let api = try client()
        CatalogFixture.responder = { request in
            XCTAssertEqual(request.url?.path, "/api/session/updateQueue")
            let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: Self.requestBody(request)) as? [String: Any])
            let rpcID = try XCTUnwrap(envelope["rpcId"] as? String)
            let payload = try XCTUnwrap(envelope["payload"] as? [String: Any])
            let arguments = try XCTUnwrap(payload["args"] as? [String: Any])
            let command = try XCTUnwrap(arguments["request"] as? [String: Any])
            XCTAssertEqual(command["sessionId"] as? String, "owned-chat")
            XCTAssertEqual(command["itemId"] as? String, "text-1")
            let action = try XCTUnwrap(command["action"] as? [String: Any])
            XCTAssertEqual(action["kind"] as? String, "edit")
            XCTAssertEqual(action["content"] as? [[String: String]], [["type": "text", "text": "Revised"]])
            return (200, try JSONSerialization.data(withJSONObject: [
                "type": "server-response", "rpcId": rpcID, "result": ["ok": true, "value": ["accepted": true]],
            ]))
        }
        try await api.updateChatQueue(sessionID: "owned-chat", item: items[0], action: .edit("Revised"))
        do {
            try await api.updateChatQueue(sessionID: "owned-chat", item: items[1], action: .edit("Would lose attachment"))
            XCTFail("Editing a queued image as text must be refused locally")
        } catch HubChatSendError.invalidDraft {}
        XCTAssertEqual(CatalogFixture.requests.count, 1)
    }

    func testSlashCommandUsesSessionCatalogAndCommandEndpointWithoutPrompting() async throws {
        let api = try client()
        CatalogFixture.responder = { request in
            let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: Self.requestBody(request)) as? [String: Any])
            let rpcID = try XCTUnwrap(envelope["rpcId"] as? String)
            let payload = try XCTUnwrap(envelope["payload"] as? [String: Any])
            let arguments = try XCTUnwrap(payload["args"] as? [String: Any])
            XCTAssertEqual(arguments["agentId"] as? String, "owned-chat")
            var result: [String: Any] = ["ok": true]
            switch request.url?.path {
            case "/api/commands/list":
                result["value"] = [["name": "echo", "description": "Display text", "input": ["hint": "Text"]]]
            case "/api/commands/execute":
                XCTAssertEqual(arguments["line"] as? String, "/echo  keep spacing")
                XCTAssertEqual((arguments["images"] as? [Any])?.count, 0)
                if CatalogFixture.requests.count == 2 {
                    result["value"] = ["commandId": "fixture-command", "result": ["kind": "success", "text": "keep spacing"]]
                }
            default:
                XCTFail("A command must not enter the model prompt route")
            }
            return (200, try JSONSerialization.data(withJSONObject: [
                "type": "server-response", "rpcId": rpcID, "result": result,
            ]))
        }
        let list = try await api.chatCommands(sessionID: "owned-chat")
        XCTAssertEqual(list.map(\.name), ["echo"])
        let receipt = try await api.runChatCommand("/echo  keep spacing", sessionID: "owned-chat", photos: [])
        XCTAssertEqual(receipt?.commandId, "fixture-command")
        let removed = try await api.runChatCommand("/echo  keep spacing", sessionID: "owned-chat", photos: [])
        XCTAssertNil(removed)
        XCTAssertNil(HubChatCommand.leadingName(in: "Read /echo"))
        XCTAssertNil(HubChatCommand.leadingName(in: "/echo.txt"))
        XCTAssertEqual(HubChatCommand.leadingName(in: "/echo\r\narguments"), "echo")
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

    func testKnowledgeConnectionsDistinguishARecordedPathAndItsPrivateEvidence() async throws {
        let api = try client()
        let node = #"{"id":"target","title":"Fixture target"}"#
        let quote = #"{"sourceId":"source","quote":"Fixture excerpt","role":"user"}"#
        CatalogFixture.responder = { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/hub/memory")
            XCTAssertEqual(request.value(forHTTPHeaderField: "x-hub-memory"), "1")
            let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
            let query = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
            let relation = #"""
            "id":"relation","scope":"short","interpretation":true,"predicate":"explains","evidence":[\#(quote)]
            """#
            let response: String
            switch query["view"] {
            case "neighbors":
                XCTAssertEqual(query["id"], "source")
                XCTAssertEqual(query["cursor"], "older+&ß")
                XCTAssertTrue(components.percentEncodedQuery?.contains("cursor=older%2B%26") == true)
                response = #"{"recordId":"source","total":2,"items":[{\#(relation),"node":\#(node)}],"nextCursor":"relation"}"#
            case "search":
                XCTAssertEqual(query["q"], "İki & bir")
                response = #"{"nodes":[\#(node)]}"#
            case "path":
                XCTAssertEqual(query["target"], "target")
                response = #"{"sourceId":"source","targetId":"target","found":true,"complete":true,"meaning":"Sourced path","nodes":[{"id":"source"},\#(node)],"relations":[{\#(relation)}]}"#
            case "evidence":
                XCTAssertEqual(query["relation"], "relation")
                XCTAssertEqual(query["index"], "0")
                response = #"{"citation":\#(quote),"sourceTitle":"Fixture source","version":"archived","excerpt":{"text":"More context"}}"#
            default:
                XCTFail("Unexpected Knowledge query \(query)")
                return (400, Data())
            }
            return (200, Data(response.utf8))
        }
        let page = try await api.knowledgeNeighbors(id: "source", cursor: "older+&ß")
        XCTAssertEqual(page.items.first?.node?.id, "target")
        let matches = try await api.searchKnowledgeRecords(" İki & bir ")
        XCTAssertEqual(matches.first?.title, "Fixture target")
        let path = try await api.knowledgeConnectionPath(from: "source", to: "target")
        XCTAssertTrue(path.found)
        XCTAssertEqual(path.relations.first?.evidence.first?.quote, "Fixture excerpt")
        let source = try await api.knowledgeSourceEvidence(relation: "relation", index: 0)
        XCTAssertEqual(source.version, "archived")
        XCTAssertEqual(source.excerpt?.text, "More context")
    }

    func testKnowledgeDomainApprovalUsesReviewedRevisionAndSplitUsesHostReferences() async throws {
        let api = try client()
        let hash = String(repeating: "a", count: 64)
        CatalogFixture.responder = { request in
            XCTAssertEqual(request.url?.path, "/api/hub/memory")
            if request.httpMethod == "GET" {
                XCTAssertEqual(request.url?.query, "view=domain-preview&id=proposal")
                let response = #"{"revision":7,"previewHash":"\#(hash)","proposal":{"id":"proposal","status":"pending","operation":{"type":"merge"},"evidence":"Fixture source"},"stale":false,"affectedRecords":2,"before":[],"after":[]}"#
                return (200, Data(response.utf8))
            }
            let command = try XCTUnwrap(JSONSerialization.jsonObject(with: Self.requestBody(request)) as? [String: Any])
            if command["action"] as? String == "domain-review" {
                XCTAssertEqual(command["revision"] as? Int, 7)
                XCTAssertEqual(command["id"] as? String, "proposal")
                if command["approve"] as? Bool == true { XCTAssertEqual(command["previewHash"] as? String, hash) }
                else { XCTAssertNil(command["previewHash"]) }
            } else {
                XCTAssertEqual(command["action"] as? String, "domains")
                XCTAssertEqual(command["revision"] as? Int, 8)
                let operations = try XCTUnwrap(command["operations"] as? [[String: Any]])
                let operation = try XCTUnwrap(operations.first)
                XCTAssertEqual(operation["type"] as? String, "split")
                let groups = try XCTUnwrap(operation["groups"] as? [[String: Any]])
                XCTAssertEqual(groups.compactMap { $0["ref"] as? String }, ["new-split-0", "new-split-1"])
                XCTAssertEqual(groups[0]["nodeIds"] as? [String], ["note-a"])
                XCTAssertEqual(operation["deactivateSource"] as? Bool, true)
            }
            return (200, Data("{}".utf8))
        }
        let preview = try await api.knowledgeDomainPreview("proposal")
        XCTAssertEqual(preview.affectedRecords, 2)
        try await api.reviewKnowledgeDomain(preview, approve: true)
        try await api.reviewKnowledgeDomain(preview, approve: false)
        try await api.changeKnowledgeDomains([.split(id: "domain", groups: [
            .init(title: "First", noteIDs: ["note-a"]), .init(title: "Second", noteIDs: ["note-b"]),
        ], deactivateSource: true)], revision: 8)
    }

    func testKnowledgeOrganizationSendsOnlyReviewedWindowCoordinates() async throws {
        let api = try client()
        let hash = String(repeating: "b", count: 64)
        CatalogFixture.responder = { request in
            XCTAssertEqual(request.url?.path, "/api/hub/memory")
            if request.httpMethod == "GET" {
                let query = request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems }
                XCTAssertEqual(query?.first(where: { $0.name == "offset" })?.value, "100")
                let response = #"{"nodeId":"note","title":"Fixture","hash":"\#(hash)","start":100,"end":104,"totalChars":110,"content":"A🌿B","nextOffset":104}"#
                return (200, Data(response.utf8))
            }
            let command = try XCTUnwrap(JSONSerialization.jsonObject(with: Self.requestBody(request)) as? [String: Any])
            XCTAssertEqual(command["action"] as? String, "reorganize")
            XCTAssertEqual(command["nodeIds"] as? [String], ["note"])
            let window = try XCTUnwrap((command["windows"] as? [[String: Any]])?.first)
            XCTAssertEqual(window["hash"] as? String, hash)
            XCTAssertEqual(window["start"] as? Int, 100)
            XCTAssertEqual(window["end"] as? Int, 104)
            XCTAssertNil(window["content"])
            return (200, Data(#"{"queued":1,"automatic":false}"#.utf8))
        }
        let excerpt = try await api.knowledgeOrganizationExcerpt("note", offset: 100)
        let receipt = try await api.queueKnowledgeOrganization(notes: ["note"], excerpts: [excerpt])
        XCTAssertFalse(receipt.automatic)
    }

    func testWorkspaceGoalOutputVerifiesArtifactDigestAndSafeName() async throws {
        let api = try client()
        let bytes = Data("Verified fixture".utf8)
        let hash = HubAttachmentStore.digest(bytes)
        let evidence = try JSONDecoder().decode(HubWorkspaceTask.Evidence.self, from: JSONSerialization.data(withJSONObject: [
            "id": "file-evidence", "kind": "file", "label": "Fixture", "detail": "Verified", "at": 1, "sha256": hash,
        ]))
        CatalogFixture.responder = { request in
            XCTAssertEqual(request.url?.query, "view=artifact&id=fixture-goal&evidenceId=file-evidence")
            XCTAssertEqual(request.value(forHTTPHeaderField: "x-hub-goals"), "1")
            let name = CatalogFixture.requests.count == 2 ? "../fixture.txt" : "fixture.txt"
            let value = ["name": name, "data": bytes.base64EncodedString(), "sha256": hash]
            return (200, try JSONSerialization.data(withJSONObject: value))
        }
        let file = try await api.workspaceTaskOutput(goalID: "fixture-goal", evidence: evidence)
        XCTAssertEqual(file.name, "fixture.txt")
        XCTAssertEqual(file.data, bytes)
        do {
            _ = try await api.workspaceTaskOutput(goalID: "fixture-goal", evidence: evidence)
            XCTFail("A file path cannot be used as the exported file name")
        } catch HubAttachmentError.invalidResponse {}
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
            #"{"type":"command/done","seq":8,"data":{"kind":"text","text":"Command output"}}"#,
            #"{"type":"turn/end","seq":9,"data":{"reason":{"kind":"completed"}}}"#,
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
        XCTAssertEqual(timeline.snapshot.messages.map(\.text), ["Fixture", "Hello world", "Command output"])
        XCTAssertEqual(timeline.snapshot.latestUserMessageID, "2")
        XCTAssertEqual(timeline.snapshot.latestMessageTurn, 1)
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
                    ["ns": "ui-theme", "revision": 7, "value": ["fontSize": 16, "preference": CatalogFixture.requests.count >= 5 ? "light" : "dark"]],
                    ["ns": "ui-conversation", "revision": 3, "value": ["busyEnter": "steer"]],
                    ["ns": "ui-chat", "revision": 2, "value": ["transcriptView": "normal"]],
                ]]
            } else {
                XCTAssertEqual(request.url?.path, "/api/settings/update")
                XCTAssertEqual(arguments["ns"] as? String, "ui-theme")
                if CatalogFixture.requests.count == 2 { XCTAssertEqual(arguments["patch"] as? [String: Int], ["fontSize": 16]) }
                else { XCTAssertEqual(arguments["patch"] as? [String: String], ["preference": "light"]) }
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
        XCTAssertEqual(preferences.appearance, .dark)
        let updated = try await api.updateChatPreferences(.fontSize(16), from: preferences)
        XCTAssertEqual(updated.fontSize, 16)
        XCTAssertEqual(CatalogFixture.requests.map { $0.url?.path },
                       ["/api/settings/describe", "/api/settings/update", "/api/settings/describe"])
        let themed = try await api.updateChatPreferences(.appearance(.light), from: updated)
        XCTAssertEqual(themed.appearance, .light)
        XCTAssertEqual(themed.fontSize, updated.fontSize)
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

    func testRecordedTurnTokensExcludeMissingReceiptsAndReplacedEvents() throws {
        let decoder = JSONDecoder()
        var timeline = HubChatTimeline()
        let events = [
            #"{"type":"assistant/message","seq":1,"data":{"turn":3,"usage":{"inputTokens":30,"outputTokens":10}}}"#,
            #"{"type":"assistant/message","seq":2,"data":{"turn":3,"usage":{"inputTokens":2}}}"#,
            #"{"type":"assistant/message","seq":3,"surfaceOp":{"op":"replace","start":1,"end":2},"data":{"turn":3,"usage":{"inputTokens":5,"outputTokens":4,"cacheReadTokens":12}}}"#,
        ]
        for source in events {
            timeline.apply(try decoder.decode(HubChatStreamFrame.Entry.Event.self, from: Data(source.utf8)))
        }
        let usage = try XCTUnwrap(timeline.snapshot.usageByTurn[3])
        XCTAssertEqual(usage.recordedResponses, 1)
        XCTAssertEqual(usage.input, 5)
        XCTAssertEqual(usage.output, 4)
        XCTAssertEqual(usage.cacheRead, 12)
    }

    func testKnowledgeMembershipWritesOnlyTheRequestedOperationAndRevision() async throws {
        let api = try client()
        CatalogFixture.responder = { request in
            XCTAssertEqual(request.url?.path, "/api/hub/memory")
            XCTAssertEqual(request.value(forHTTPHeaderField: "x-hub-memory"), "1")
            if request.httpMethod == "GET" {
                XCTAssertEqual(request.url?.query, "view=domains")
                return (200, Data(#"{"revision":12,"maxActiveDomains":7,"domains":[],"memberships":[],"nodes":[]}"#.utf8))
            }
            let command = try XCTUnwrap(JSONSerialization.jsonObject(with: Self.requestBody(request)) as? [String: Any])
            XCTAssertEqual(command["action"] as? String, "domains")
            XCTAssertEqual(command["revision"] as? Int, 12)
            XCTAssertEqual(command["operations"] as? [[String: String]], [
                ["type": "unassign", "nodeId": "note-id", "domainId": "domain-id"],
            ])
            return (200, Data(#"{"revision":13}"#.utf8))
        }
        let registry = try await api.knowledgeDomains()
        try await api.changeKnowledgeDomains([.membership(note: "note-id", domain: "domain-id", assigned: false)],
                                             revision: registry.revision)
        XCTAssertEqual(CatalogFixture.requests.count, 2)
    }

    func testGoalEditPreservesPermissionsScheduleAndUneditedAllowance() async throws {
        let api = try client()
        let original = #"""
        {"characters":[{"id":"hub","name":"HUB","route":null}],"goals":[{
          "id":"saved-goal","state":"paused","revision":7,"title":"Original","objective":"Outcome",
          "criteria":["Verify result"],"characterId":"hub","approach":"balanced","instructions":"",
          "resources":{"knowledge":true,"browser":false,"folders":["C:/Fixture"],"writeFolders":[],
                       "tools":["read"],"files":[],"knowledgeOutput":false},
          "limits":{"activeMinutes":30,"dailyBudget":0.2,"totalBudget":1,
                    "workingHours":{"start":540,"end":1080,"days":[1,3,5],"timezone":"Europe/Istanbul"}},
          "schedule":{"trigger":{"kind":"interval","seconds":1800},"repeat":"continue","missed":"skip"},
          "recovery":"ask","humanApproval":true,"notification":"pwa",
          "sourceSessionId":"minke-im-telegram-0123456789abcdef0123456789abcdef",
          "plan":[{"id":"milestone","title":"Original step","dependsOn":[],"status":"pending","evidence":["ref-1"]}]
        }]}
        """#
        CatalogFixture.responder = { request in
            XCTAssertEqual(request.url?.path, "/api/hub/goals")
            if request.httpMethod == "GET" { return (200, Data(original.utf8)) }
            let command = try XCTUnwrap(JSONSerialization.jsonObject(with: Self.requestBody(request)) as? [String: Any])
            XCTAssertEqual(command["action"] as? String, "save")
            XCTAssertEqual(command["id"] as? String, "saved-goal")
            XCTAssertEqual(command["revision"] as? Int, 7)
            if CatalogFixture.requests.count == 2 {
                XCTAssertNil(command["plan"])
            } else {
                let milestones = try XCTUnwrap(command["plan"] as? [[String: Any]])
                XCTAssertEqual(milestones.first?["id"] as? String, "milestone")
                XCTAssertEqual(milestones.first?["status"] as? String, "working")
                XCTAssertEqual(milestones.first?["evidence"] as? [String], ["ref-1"])
                XCTAssertEqual(milestones.last?["dependsOn"] as? [String], ["milestone"])
            }
            let goal = try XCTUnwrap(command["goal"] as? [String: Any])
            XCTAssertEqual(goal["title"] as? String, "Renamed")
            XCTAssertEqual((goal["resources"] as? [String: Any])?["folders"] as? [String], ["C:/Fixture"])
            XCTAssertEqual((goal["limits"] as? [String: Any])?["dailyBudget"] as? Double, 0.25)
            XCTAssertEqual((goal["limits"] as? [String: Any])?["totalBudget"] as? Double, 1)
            let hours = (goal["limits"] as? [String: Any])?["workingHours"] as? [String: Any]
            XCTAssertEqual(hours?["start"] as? Int, CatalogFixture.requests.count == 2 ? 540 : 630)
            XCTAssertEqual(hours?["days"] as? [Int], [1, 3, 5])
            XCTAssertEqual(hours?["timezone"] as? String, "Europe/Istanbul")
            let schedule = try XCTUnwrap(goal["schedule"] as? [String: Any])
            let trigger = try XCTUnwrap(schedule["trigger"] as? [String: Any])
            if CatalogFixture.requests.count == 2 {
                XCTAssertEqual(schedule["missed"] as? String, "skip")
                XCTAssertEqual(trigger["seconds"] as? Int, 1_800)
                XCTAssertEqual(goal["notification"] as? String, "pwa")
            } else {
                XCTAssertEqual(schedule["missed"] as? String, "catch-up")
                XCTAssertEqual(schedule["repeat"] as? String, "fresh")
                XCTAssertEqual(trigger["kind"] as? String, "event")
                XCTAssertEqual(trigger["event"] as? String, "task.completed")
                XCTAssertNil(trigger["operator"])
                XCTAssertEqual(goal["notification"] as? String, "telegram")
            }
            XCTAssertNil(goal["state"])
            return (200, Data(#"{"changedId":"saved-goal"}"#.utf8))
        }
        let editor = try await api.goalEditor(id: "saved-goal")
        var draft = editor.draft
        draft.title = "Renamed"
        draft.dailyBudget = 0.25
        let id = try await api.saveGoal(draft, from: editor)
        XCTAssertEqual(id, "saved-goal")
        var milestones = try XCTUnwrap(draft.milestones)
        milestones[0].status = .working
        var followUp = HubGoalEditorData.Milestone(title: "Follow up")
        followUp.dependsOn = [milestones[0].id]
        milestones.append(followUp)
        draft.milestones = milestones
        XCTAssertTrue(draft.workingHours?.isValid == true)
        draft.workingHours?.start = 630
        XCTAssertTrue(editor.canNotifyTelegram)
        var event = HubRoutineEditorData.Trigger(kind: .event)
        event.event = "task.completed"
        event.operatorName = ""
        draft.schedule?.trigger = event
        draft.schedule?.missed = .catchUp
        draft.schedule?.recurrence = .fresh
        draft.notification = "telegram"
        let editedID = try await api.saveGoal(draft, from: editor)
        XCTAssertEqual(editedID, id)
    }

    func testRoutineEditorUsesTheRegistryRevisionAndPreservesEventCondition() async throws {
        let api = try client()
        let source = #"""
        {"revision":14,"characters":[{"id":"hub","name":"HUB","route":{"provider":"fixture","model":"local"}}],
         "automations":[{"id":"routine-id","revision":2,"status":"paused","title":"Original","prompt":"Read",
            "characterId":"hub","trigger":{"kind":"event","event":"task.completed","operator":"equals","path":"status","value":"done"},
            "missed":"skip","tools":["web_fetch"],"allowWrites":false,"maxOutputTokens":2048,"maxSteps":3,
            "dailyMaxRuns":6,"dailyBudget":0.2,"inputPrice":0.1,"outputPrice":0.5,"notification":"pwa"}]}
        """#
        CatalogFixture.responder = { request in
            XCTAssertEqual(request.url?.path, "/api/hub/automations")
            if request.httpMethod == "GET" { return (200, Data(source.utf8)) }
            let command = try XCTUnwrap(JSONSerialization.jsonObject(with: Self.requestBody(request)) as? [String: Any])
            XCTAssertEqual(command["action"] as? String, "save")
            XCTAssertEqual(command["id"] as? String, "routine-id")
            XCTAssertEqual(command["revision"] as? Int, 14)
            let routine = try XCTUnwrap(command["automation"] as? [String: Any])
            XCTAssertEqual(routine["title"] as? String, "Renamed")
            XCTAssertEqual((routine["trigger"] as? [String: String])?["operator"], "equals")
            XCTAssertNil(routine["status"])
            return (200, Data(#"{"revision":15}"#.utf8))
        }
        let loaded = try await api.routineEditor(id: "routine-id")
        var draft = loaded.draft
        draft.title = "Renamed"
        try await api.saveRoutine(draft, from: loaded)
        XCTAssertEqual(CatalogFixture.requests.count, 2)
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
