import Foundation

public struct HubConversationChoice: Decodable {
    public let sessionId: String
    public let title: String
    public let updatedAt: Double
}
public struct HubConversationCatalog: Decodable {
    public let conversations: [HubConversationChoice]
    public let hasMore: Bool
}

public struct HubHomeKnowledge: Decodable {
    public struct Node: Decodable {
        public let id: String
        public let kind: String?
        public let title: String?
    }
    public struct Edge: Decodable {
        public let source: String
        public let target: String
    }
    public let nodes: [Node]
    public let edges: [Edge]
}

public struct HubKnowledgeNote: Decodable {
    public let id: String
    public let title: String
    public let content: String
}

public struct HubChatMessage: Identifiable {
    public let id: String
    public let role: String
    public let text: String
}

public struct HubChatSnapshot {
    public let messages: [HubChatMessage]
    public let hasMore: Bool
}

public struct HubWorkspaceTask: Decodable, Identifiable {
    public let id: String
    public let title: String
    public let state: String
    public let status: String
    public let updatedAt: Double
    public let nextAt: Double?
    public let objective: String?
    public let prompt: String?
}

public struct HubWorkspaceTasks {
    public let goals: [HubWorkspaceTask]
    public let routines: [HubWorkspaceTask]
}

private struct HubChatStreamFrame: Decodable {
    struct Entry: Decodable {
        struct Event: Decodable {
            struct Payload: Decodable {
                struct Block: Decodable { let type: String; let text: String? }
                struct Message: Decodable { let content: [Block]? }
                struct Source: Decodable { let kind: String }
                let message: Message?
                let content: [Block]?
                let source: Source?
            }
            let type: String
            let seq: Int
            let message: HubChatMessage?

            private enum CodingKeys: String, CodingKey { case type, seq, data }

            init(from decoder: Decoder) throws {
                let values = try decoder.container(keyedBy: CodingKeys.self)
                type = try values.decode(String.self, forKey: .type)
                seq = try values.decode(Int.self, forKey: .seq)
                guard type == "user/message" || type == "assistant/message",
                      let payload = try? values.decode(Payload.self, forKey: .data),
                      type != "user/message" || payload.source?.kind == "user" else {
                    message = nil
                    return
                }
                let text = (payload.message?.content ?? payload.content ?? [])
                    .filter { $0.type == "text" }.compactMap(\.text).joined(separator: "\n")
                message = text.isEmpty ? nil : HubChatMessage(id: String(seq), role: type == "user/message" ? "user" : "assistant", text: text)
            }
        }
        let event: Event
    }
    struct Value: Decodable {
        let type: String
        let records: [Entry]?
        let hasMore: Bool?
    }
    let streamId: String?
    let type: String
    let value: Value?
}

public struct HubHomePlanner: Decodable {
    public struct Item: Decodable {
        public let id: String
        public let title: String
        public let kind: String
        public let state: String
        public let deleted: Bool
        public let date: String?
        public let start: String?
        public let version: Int?
    }

    public let revision: Int?
    public let items: [Item]
}

public enum HubChatSendError: Error, Equatable {
    case invalidDraft
    case signInRequired
    case rejected
    case unknownDelivery(sessionID: String)
}

/// Fixed, authenticated endpoints. Sending is explicit and never retried by HUB.
public final class HubConversationAPI {
    private let server: HubServer
    private let cookies: () async -> [HTTPCookie]
    private let session: URLSession
    public init(server: HubServer, configuration: URLSessionConfiguration = .ephemeral, cookies: @escaping () async -> [HTTPCookie]) {
        self.server = server; self.cookies = cookies
        let config = configuration.copy() as! URLSessionConfiguration
        config.httpShouldSetCookies = false; config.httpCookieStorage = nil; config.urlCache = nil
        config.timeoutIntervalForRequest = 12
        config.timeoutIntervalForResource = 18
        session = URLSession(configuration: config, delegate: HubNoRedirects(), delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }
    private func requestData(_ path: String, headers: [String: String], query: [URLQueryItem] = [], body: Data? = nil) async throws -> Data {
        var components = URLComponents(url: server.origin.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw HubAttachmentError.invalidResponse }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.allHTTPHeaderFields = HTTPCookie.requestHeaderFields(with: server.cookies(await cookies(), for: url))
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        if let body {
            request.httpMethod = "POST"
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, response.url == url else { throw HubAttachmentError.invalidResponse }
        switch response.statusCode {
        case 200: break
        case 300...399, 401, 403: throw HubAttachmentError.signInRequired
        default: throw HubAttachmentError.unavailable
        }
        guard response.mimeType == "application/json", data.count <= 1_048_576 else { throw HubAttachmentError.invalidResponse }
        return data
    }
    public func list(search: String = "") async throws -> HubConversationCatalog {
        guard search.count <= 120 else { throw HubAttachmentError.invalidResponse }
        let encoded = search.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")) ?? ""
        let data = try await requestData("api/hub/conversations", headers: ["x-hub-daily-use":"1", "x-hub-session-query":encoded])
        let value = try JSONDecoder().decode(HubConversationCatalog.self, from: data)
        guard value.conversations.count <= 50, Set(value.conversations.map(\.sessionId)).count == value.conversations.count,
              value.conversations.allSatisfy({ HubVoiceAPI.validID($0.sessionId) && !$0.title.isEmpty && $0.title.utf8.count <= 960 && $0.updatedAt.isFinite && $0.updatedAt >= 0 }) else { throw HubAttachmentError.invalidResponse }
        return value
    }
    public func knowledge() async throws -> HubHomeKnowledge {
        let data = try await requestData("api/hub/memory", headers: ["x-hub-memory": "1"], query: [URLQueryItem(name: "view", value: "graph")])
        let value = try JSONDecoder().decode(HubHomeKnowledge.self, from: data)
        guard value.nodes.count <= 5_000, value.edges.count <= 15_000,
              Set(value.nodes.map(\.id)).count == value.nodes.count else { throw HubAttachmentError.invalidResponse }
        return value
    }

    public func planner() async throws -> HubHomePlanner {
        let data = try await requestData("api/hub/planner", headers: ["x-hub-planner": "1"])
        return try JSONDecoder().decode(HubHomePlanner.self, from: data)
    }

    public func workspaceTasks() async throws -> HubWorkspaceTasks {
        struct Goals: Decodable { let goals: [HubWorkspaceTask] }
        struct Routines: Decodable { let automations: [HubWorkspaceTask] }
        async let goals = requestData("api/hub/goals", headers: ["x-hub-goals": "1"])
        async let routines = requestData("api/hub/automations", headers: ["x-hub-automations": "1"])
        let (goalData, routineData) = try await (goals, routines)
        let decoder = JSONDecoder()
        return try HubWorkspaceTasks(goals: decoder.decode(Goals.self, from: goalData).goals,
                                     routines: decoder.decode(Routines.self, from: routineData).automations)
    }

    public func knowledgeNote(id: String) async throws -> HubKnowledgeNote {
        guard !id.isEmpty, id.utf8.count <= 1_024 else { throw HubAttachmentError.invalidResponse }
        let data = try await requestData("api/hub/memory", headers: ["x-hub-memory": "1"], query: [
            URLQueryItem(name: "view", value: "note"), URLQueryItem(name: "id", value: id),
        ])
        let note = try JSONDecoder().decode(HubKnowledgeNote.self, from: data)
        guard note.id == id else { throw HubAttachmentError.invalidResponse }
        return note
    }

    public func addTodo(id: UUID, title: String) async throws -> HubHomePlanner {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title.utf16.count <= 180 else { throw HubAttachmentError.invalidResponse }
        return try await changePlanner([
            "action": "save", "item": [
                "id": id.uuidString.lowercased(), "version": 0, "kind": "todo", "title": title,
                "details": "", "horizon": "near", "timeZone": TimeZone.current.identifier,
            ],
        ])
    }

    public func completeTodo(_ item: HubHomePlanner.Item) async throws -> HubHomePlanner {
        guard HubVoiceAPI.validID(item.id), item.kind == "todo", item.state == "open",
              !item.deleted, let version = item.version, version >= 0 else { throw HubAttachmentError.invalidResponse }
        return try await changePlanner(["action": "complete", "id": item.id, "version": version])
    }

    private func changePlanner(_ command: [String: Any]) async throws -> HubHomePlanner {
        let body = try JSONSerialization.data(withJSONObject: command)
        let data = try await requestData("api/hub/planner", headers: ["x-hub-planner": "1"], body: body)
        return try JSONDecoder().decode(HubHomePlanner.self, from: data)
    }

    public func sendNewChat(_ draft: String) async throws -> String {
        _ = try promptText(draft)
        let sessionID = "session-" + UUID().uuidString.lowercased()
        let created = try await rpc("session/create", request: ["sessionId": sessionID])
        guard created["sessionId"] as? String == sessionID else { throw HubChatSendError.rejected }
        try Task.checkCancellation()
        try await sendChat(draft, sessionID: sessionID)
        return sessionID
    }

    private func promptText(_ draft: String) throws -> String {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.utf8.count <= 32_768 else { throw HubChatSendError.invalidDraft }
        return text
    }

    public func sendChat(_ draft: String, sessionID: String) async throws {
        guard HubVoiceAPI.validID(sessionID) else { throw HubChatSendError.rejected }
        let text = try promptText(draft)
        do {
            let receipt = try await rpc("session/prompt", request: [
                "requestId": UUID().uuidString.lowercased(),
                "sessionId": sessionID,
                "mode": "queue",
                "content": [["type": "text", "text": text]],
                "clientTimeZone": TimeZone.current.identifier,
            ])
            guard receipt["accepted"] as? Bool == true else {
                throw HubChatSendError.unknownDelivery(sessionID: sessionID)
            }
        } catch HubChatSendError.signInRequired {
            throw HubChatSendError.signInRequired
        } catch HubChatSendError.rejected {
            throw HubChatSendError.rejected
        } catch {
            throw HubChatSendError.unknownDelivery(sessionID: sessionID)
        }
    }

    public func chatSnapshot(sessionID: String) async throws -> HubChatSnapshot {
        guard HubVoiceAPI.validID(sessionID) else { throw HubChatSendError.rejected }
        let httpsURL = server.origin.appendingPathComponent("api/remote.mux")
        guard var components = URLComponents(url: httpsURL, resolvingAgainstBaseURL: false) else {
            throw HubAttachmentError.invalidResponse
        }
        components.scheme = "wss"
        guard let url = components.url else { throw HubAttachmentError.invalidResponse }
        var request = URLRequest(url: url, timeoutInterval: 12)
        request.allHTTPHeaderFields = HTTPCookie.requestHeaderFields(with: server.cookies(await cookies(), for: httpsURL))
        let socket = session.webSocketTask(with: request)
        socket.maximumMessageSize = 4 * 1_024 * 1_024
        let streamID = UUID().uuidString.lowercased()
        let envelope: [String: Any] = [
            "type": "open", "streamId": streamID, "endpoint": "session/follow",
            "payload": ["args": ["request": ["address": ["kind": "session", "sessionId": sessionID], "maxMessages": 40]]],
        ]
        let message = String(decoding: try JSONSerialization.data(withJSONObject: envelope), as: UTF8.self)
        let deadline = Task {
            try await Task.sleep(nanoseconds: 12_000_000_000)
            socket.cancel(with: .goingAway, reason: nil)
        }
        defer { deadline.cancel(); socket.cancel(with: .normalClosure, reason: nil) }
        return try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            socket.resume()
            try await socket.send(.string(message))
            while !Task.isCancelled {
                guard case .string(let text) = try await socket.receive() else { throw HubAttachmentError.invalidResponse }
                let frame = try JSONDecoder().decode(HubChatStreamFrame.self, from: Data(text.utf8))
                guard frame.streamId == streamID else { continue }
                if frame.type == "error" || frame.type == "end" { throw HubAttachmentError.unavailable }
                if frame.type == "item", frame.value?.type == "snapshot", let records = frame.value?.records {
                    return HubChatSnapshot(messages: records.compactMap(\.event.message), hasMore: frame.value?.hasMore ?? false)
                }
            }
            throw CancellationError()
        }, onCancel: { socket.cancel(with: .goingAway, reason: nil) })
    }

    private func rpc(_ method: String, request payload: [String: Any]) async throws -> [String: Any] {
        let url = server.origin.appendingPathComponent("api/" + method)
        let rpcID = UUID().uuidString.lowercased()
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.allHTTPHeaderFields = HTTPCookie.requestHeaderFields(with: server.cookies(await cookies(), for: url))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "type": "client-request", "rpcId": rpcID, "method": method,
            "payload": ["args": ["request": payload]],
        ])
        try Task.checkCancellation()
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.url == url else { throw HubAttachmentError.invalidResponse }
        if (300...399).contains(http.statusCode) || [401, 403].contains(http.statusCode) {
            throw HubChatSendError.signInRequired
        }
        guard http.statusCode == 200, http.mimeType == "application/json", data.count <= 65_536,
              let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              envelope["type"] as? String == "server-response", envelope["rpcId"] as? String == rpcID,
              let result = envelope["result"] as? [String: Any], let ok = result["ok"] as? Bool else {
            throw HubAttachmentError.invalidResponse
        }
        if !ok {
            let error = result["error"] as? [String: Any]
            let code = error?["code"] as? String
            if method != "session/prompt" || [
                "gateway/input-invalid", "session/invalid-time-zone", "session/model-unavailable",
                "session/attachment-invalid", "session/agent-busy", "session/not-found",
            ].contains(code ?? "") {
                throw HubChatSendError.rejected
            }
            throw HubAttachmentError.invalidResponse
        }
        guard let value = result["value"] as? [String: Any] else { throw HubAttachmentError.invalidResponse }
        return value
    }

    /// Only a draft already bound to this server and text conversation may
    /// become a URL; web content cannot supply a native destination or command.
    public func draftURL(_ draft: HubAttachmentDraft) throws -> URL {
        guard draft.origin == server.origin.absoluteString, draft.callID == "text-composer", HubVoiceAPI.validID(draft.sessionID) else { throw HubAttachmentError.wrongConversation }
        var url = URLComponents(url: server.origin, resolvingAgainstBaseURL: false)!
        url.queryItems = [URLQueryItem(name: "hubSession", value: draft.sessionID), URLQueryItem(name: "hubUpload", value: draft.id.uuidString.lowercased())]
        return url.url!
    }
    public func confirmedDraftURL(_ draft: HubAttachmentDraft) async throws -> URL {
        let url = try draftURL(draft)
        struct Receipt: Decodable { let id: UUID; let sessionId: String; let name: String; let bytes: Int }
        let data = try await requestData("api/hub/uploads/draft", headers: ["x-hub-upload":"1", "x-hub-upload-id":draft.id.uuidString.lowercased(), "x-hub-session":draft.sessionID])
        let receipt = try JSONDecoder().decode(Receipt.self, from: data)
        guard receipt.id == draft.id, receipt.sessionId == draft.sessionID, receipt.name == draft.name, receipt.bytes == draft.bytes else { throw HubAttachmentError.invalidResponse }
        return url
    }
}
