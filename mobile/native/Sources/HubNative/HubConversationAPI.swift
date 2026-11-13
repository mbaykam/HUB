import Foundation

public struct HubConversationChoice: Decodable, Equatable {
    public let sessionId: String
    public let title: String
    public let updatedAt: Double

    public init(sessionId: String, title: String, updatedAt: Double) {
        self.sessionId = sessionId
        self.title = title
        self.updatedAt = updatedAt
    }
}
public struct HubConversationCatalog: Decodable {
    public let conversations: [HubConversationChoice]
    public let hasMore: Bool
}

public struct HubChatCharacterPicker: Decodable {
    public struct Character: Decodable, Identifiable {
        public let id: String
        public let name: String
        public let role: String
        public let model: String?
    }
    public let revision: Int
    public let selectedId: String
    public let pending: Bool
    public let canSelect: Bool
    public let characters: [Character]
}

public struct HubHomeWork: Decodable {
    public struct Item: Decodable {
        public let title: String?
        public let running: Bool
        public let completed: Bool
        public let failed: Bool
        public let stopped: Bool
        public let origin: String?
        public let updatedAt: Double
    }
    public let byId: [String: Item]
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
    public struct Domain: Decodable, Identifiable {
        public let id: String
        public let title: String
        public let parentId: String?
        public let status: String
    }
    public struct Membership: Decodable {
        public let nodeId: String
        public let domainId: String
    }
    public let nodes: [Node]
    public let edges: [Edge]
    public let domains: [Domain]?
    public let memberships: [Membership]?
}

public struct HubKnowledgeActivity: Decodable {
    public struct Entry: Decodable, Identifiable {
        public struct Change: Decodable {
            public let action: String
            public let title: String
        }
        public struct Failure: Decodable { public let message: String }
        public let id: String
        public let status: String
        public let outcome: String?
        public let updatedAt: Double
        public let retryAt: Double?
        public let reason: String?
        public let error: Failure?
        public let changes: [Change]
        public let warnings: [String]
    }
    public let state: String
    public let enabled: Bool
    public let entries: [Entry]
    public let nextOffset: Int?
    public let historyNotice: String
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
    public let turn: Int?
}

public struct HubChatSnapshot {
    public let messages: [HubChatMessage]
    public let hasMore: Bool
    public let running: Bool
    public let partial: String
    public let failure: String?
    public let latestScreenshotSequence: Int?
    public let historyCursor: Int?
    public let firstSequence: Int?
}

public struct HubChatHistoryPage {
    public let messages: [HubChatMessage]
    public let hasMore: Bool
    public let firstSequence: Int?
}

public struct HubChatScreenshot: Decodable, Identifiable {
    public let id: String
    public let name: String
    public let turn: Int
}

public struct HubUsageSnapshot: Decodable {
    public struct Provider: Decodable {
        public struct RateLimit: Decodable, Identifiable {
            public struct Window: Decodable {
                public let remainingPercent: Double
                public let windowSeconds: Double
            }
            public let id: String
            public let name: String?
            public let windows: [Window]
        }
        public struct Credits: Decodable {
            public let unlimited: Bool
            public let balance: String?
        }
        public struct IndividualLimit: Decodable {
            public let limit: String
            public let used: String
            public let remaining: String
            public let remainingPercent: Double
        }
        public struct Account: Decodable {
            public let totalCredits: Double
            public let totalUsage: Double
        }
        public struct SpendingLimit: Decodable {
            public let amount: Double
            public let remaining: Double
            public let reset: String?
        }
        public struct SpeechPeriod: Decodable {
            public let costUsd: Double
            public let requests: Int
            public let inputAudioMs: Double
            public let outputAudioMs: Double
        }
        public struct SpeechModel: Decodable, Identifiable {
            public let id: String
            public let month: SpeechPeriod
        }
        public let state: String
        public let message: String?
        public let warning: String?
        public let rateLimits: [RateLimit]?
        public let credits: Credits?
        public let individualLimit: IndividualLimit?
        public let usage: Double?
        public let usageDaily: Double?
        public let usageWeekly: Double?
        public let usageMonthly: Double?
        public let limit: SpendingLimit?
        public let account: Account?
        public let isFreeTier: Bool?
        public let balance: Double?
        public let held: Double?
        public let available: Double?
        public let today: SpeechPeriod?
        public let last7Days: SpeechPeriod?
        public let month: SpeechPeriod?
        public let models: [SpeechModel]?
    }
    public let updatedAt: String
    public let codex: Provider
    public let openRouter: Provider
    public let unlid: Provider
    public let soniox: Provider
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
    public let revision: Int?
}

public struct HubWorkspaceTasks {
    public let goals: [HubWorkspaceTask]
    public let routines: [HubWorkspaceTask]
    public let routinesRevision: Int?
}

struct HubChatStreamFrame: Decodable {
    struct Entry: Decodable {
        struct Event: Decodable {
            struct Payload: Decodable {
                struct Block: Decodable { let type: String; let text: String? }
                struct Message: Decodable { let content: [Block]? }
                struct Source: Decodable { let kind: String }
                struct Metadata: Decodable { let kind: String? }
                struct Chunk: Decodable {
                    let type: String
                    let index: Int?
                    let text: String?
                }
                struct Reason: Decodable {
                    let kind: String
                    let message: String?
                }
                let message: Message?
                let content: [Block]?
                let source: Source?
                let chunk: Chunk?
                let texts: [String]?
                let index: Int?
                let reason: Reason?
                let turn: Int?
                let meta: Metadata?
            }
            let type: String
            let seq: Int
            let message: HubChatMessage?
            let delta: (index: Int, text: String)?
            let failure: String?
            let announcesScreenshot: Bool

            private enum CodingKeys: String, CodingKey { case type, seq, data }

            init(from decoder: Decoder) throws {
                let values = try decoder.container(keyedBy: CodingKeys.self)
                type = try values.decode(String.self, forKey: .type)
                seq = try values.decode(Int.self, forKey: .seq)
                let payload = try? values.decode(Payload.self, forKey: .data)
                if let chunk = payload?.chunk, chunk.type == "text-delta", let index = chunk.index, let text = chunk.text {
                    delta = (index, text)
                } else if type == "chunkrow/text-chunks", let index = payload?.index, let texts = payload?.texts {
                    delta = (index, texts.joined())
                } else {
                    delta = nil
                }
                failure = type == "turn/end" && payload?.reason?.kind == "error"
                    ? (payload?.reason?.message ?? "This turn failed.") : nil
                announcesScreenshot = type == "tool/result" && payload?.meta?.kind == "hub-screenshot"
                guard type == "user/message" || type == "assistant/message",
                      let payload,
                      type != "user/message" || payload.source?.kind == "user" else {
                    message = nil
                    return
                }
                let text = (payload.message?.content ?? payload.content ?? [])
                    .filter { $0.type == "text" }.compactMap(\.text).joined(separator: "\n")
                message = text.isEmpty ? nil : HubChatMessage(id: String(seq), role: type == "user/message" ? "user" : "assistant",
                                                              text: text, turn: payload.turn)
            }
        }
        let event: Event
    }
    struct Value: Decodable {
        let type: String
        let records: [Entry]?
        let hasMore: Bool?
        let event: Entry.Event?
        let cursor: Int?
    }
    let streamId: String?
    let type: String
    let value: Value?
}

struct HubChatTimeline {
    private var messages: [HubChatMessage] = []
    private var blocks: [Int: String] = [:]
    private var running = false
    private var failure: String?
    private var hasMore = false
    private var lastSequence = -1
    private var latestScreenshotSequence: Int?
    private var historyCursor: Int?
    private var firstSequence: Int?

    mutating func start(_ frame: HubChatStreamFrame.Value) {
        hasMore = frame.hasMore ?? false
        historyCursor = frame.cursor
        firstSequence = frame.records?.first?.event.seq
        for record in frame.records ?? [] { apply(record.event) }
    }

    mutating func apply(_ event: HubChatStreamFrame.Entry.Event) {
        guard event.seq > lastSequence else { return }
        lastSequence = event.seq
        if event.announcesScreenshot { latestScreenshotSequence = event.seq }
        switch event.type {
        case "turn/start":
            running = true
            failure = nil
            blocks.removeAll()
        case "step/start", "assistant/message":
            blocks.removeAll()
        case "turn/end":
            running = false
            failure = event.failure
            blocks.removeAll()
        default: break
        }
        if let message = event.message { messages.append(message) }
        if let delta = event.delta, (0..<256).contains(delta.index) {
            let current = blocks[delta.index, default: ""]
            if current.utf8.count + delta.text.utf8.count <= 512_000 {
                blocks[delta.index] = current + delta.text
            }
        }
    }

    var snapshot: HubChatSnapshot {
        HubChatSnapshot(messages: messages, hasMore: hasMore, running: running,
                        partial: blocks.keys.sorted().compactMap { blocks[$0] }.joined(), failure: failure,
                        latestScreenshotSequence: latestScreenshotSequence, historyCursor: historyCursor,
                        firstSequence: firstSequence)
    }
}

public struct HubHomePlanner: Decodable {
    public enum Horizon: String {
        case near, later
    }

    public struct Item: Decodable, Identifiable {
        public let id: String
        public let title: String
        public let kind: String
        public let state: String
        public let deleted: Bool
        public let date: String?
        public let start: String?
        public let version: Int?
        public let timeZone: String?
        public let horizon: String?
        public let updatedAt: Double?

        public func occurs(on date: Date) -> Bool {
            var calendar = Calendar(identifier: .gregorian)
            let selected = calendar.dateComponents([.year, .month, .day], from: date)
            if let day = self.date {
                return day == String(format: "%04d-%02d-%02d", selected.year ?? 0, selected.month ?? 0, selected.day ?? 0)
            }
            guard let start else { return false }
            let parser = ISO8601DateFormatter()
            parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let fractional = parser.date(from: start)
            parser.formatOptions = [.withInternetDateTime]
            guard let instant = fractional ?? parser.date(from: start) else { return false }
            if let timeZone, let zone = TimeZone(identifier: timeZone) { calendar.timeZone = zone }
            return calendar.dateComponents([.year, .month, .day], from: instant) == selected
        }
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
    private func requestData(_ path: String, headers: [String: String], query: [URLQueryItem] = [], body: Data? = nil,
                             mediaTypes: Set<String> = ["application/json"], maxBytes: Int = 1_048_576) async throws -> Data {
        var components = URLComponents(url: server.origin.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw HubAttachmentError.invalidResponse }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.allHTTPHeaderFields = HTTPCookie.requestHeaderFields(with: server.cookies(await cookies(), for: url))
        request.setValue(mediaTypes.sorted().joined(separator: ", "), forHTTPHeaderField: "Accept")
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
        guard let mimeType = response.mimeType, mediaTypes.contains(mimeType), data.count <= maxBytes else {
            throw HubAttachmentError.invalidResponse
        }
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
    public func workActivity() async throws -> HubHomeWork {
        let data = try await requestData("api/hub/activity", headers: ["x-hub-daily-use": "1"])
        let work = try JSONDecoder().decode(HubHomeWork.self, from: data)
        guard work.byId.keys.allSatisfy(HubVoiceAPI.validID) else { throw HubAttachmentError.invalidResponse }
        return work
    }

    public func chatCharacters(sessionID: String) async throws -> HubChatCharacterPicker {
        guard HubVoiceAPI.validID(sessionID) else { throw HubAttachmentError.invalidResponse }
        let data = try await requestData("api/hub/characters", headers: ["x-hub-characters": "1"], query: [
            URLQueryItem(name: "view", value: "picker"), URLQueryItem(name: "sessionId", value: sessionID),
        ])
        return try JSONDecoder().decode(HubChatCharacterPicker.self, from: data)
    }

    public func selectChatCharacter(sessionID: String, id: String, revision: Int) async throws -> Bool {
        guard HubVoiceAPI.validID(sessionID), HubVoiceAPI.validID(id), revision >= 0 else {
            throw HubAttachmentError.invalidResponse
        }
        struct Receipt: Decodable { let pending: Bool }
        let body = try JSONSerialization.data(withJSONObject: [
            "action": "select", "id": id, "sessionId": sessionID, "revision": revision,
        ])
        let data = try await requestData("api/hub/characters", headers: ["x-hub-characters": "1"], body: body)
        return try JSONDecoder().decode(Receipt.self, from: data).pending
    }

    public func researchCatalog(sessionID: String) async throws -> HubResearchCatalog {
        try await researchRequest(sessionID: sessionID)
    }

    public func researchJob(sessionID: String, id: String) async throws -> HubResearchJob {
        guard HubVoiceAPI.validID(id) else { throw HubAttachmentError.invalidResponse }
        let job: HubResearchJob = try await researchRequest(sessionID: sessionID, id: id)
        guard job.id == id else { throw HubAttachmentError.invalidResponse }
        return job
    }

    public func startResearch(sessionID: String, draft: HubResearchDraft, requestID: UUID) async throws -> HubResearchJob {
        let query = draft.question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty, query.utf16.count <= 12_000, HubVoiceAPI.validID(draft.characterID) else {
            throw HubAttachmentError.invalidResponse
        }
        return try await researchRequest(sessionID: sessionID, command: [
            "action": "start", "query": query, "requestId": requestID.uuidString.lowercased(),
            "depth": draft.depth.rawValue, "sources": draft.sources.rawValue,
            "freshness": draft.freshness.rawValue, "characterId": draft.characterID,
        ])
    }

    public func changeResearch(sessionID: String, job: HubResearchJob, action: HubResearchAction) async throws -> HubResearchJob {
        guard HubVoiceAPI.validID(job.id), job.revision >= 0 else { throw HubAttachmentError.invalidResponse }
        let result: HubResearchJob = try await researchRequest(sessionID: sessionID, command: [
            "action": action.rawValue, "id": job.id, "revision": job.revision,
        ])
        guard result.id == job.id else { throw HubAttachmentError.invalidResponse }
        return result
    }

    private func researchRequest<Value: Decodable>(sessionID: String, id: String? = nil, command: [String: Any]? = nil) async throws -> Value {
        guard HubVoiceAPI.validID(sessionID) else { throw HubAttachmentError.invalidResponse }
        var query = [URLQueryItem(name: "sessionId", value: sessionID)]
        if let id { query.append(URLQueryItem(name: "id", value: id)) }
        var body: Data?
        if var command {
            command["sessionId"] = sessionID
            body = try JSONSerialization.data(withJSONObject: command)
            query = []
        }
        let data = try await requestData("api/hub/research", headers: ["x-hub-research": "1"], query: query, body: body)
        return try JSONDecoder().decode(Value.self, from: data)
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
        struct Routines: Decodable {
            let automations: [HubWorkspaceTask]
            let revision: Int?
        }
        async let goals = requestData("api/hub/goals", headers: ["x-hub-goals": "1"])
        async let routines = requestData("api/hub/automations", headers: ["x-hub-automations": "1"])
        let (goalData, routineData) = try await (goals, routines)
        let decoder = JSONDecoder()
        let routineCatalog = try decoder.decode(Routines.self, from: routineData)
        return try HubWorkspaceTasks(goals: decoder.decode(Goals.self, from: goalData).goals,
                                     routines: routineCatalog.automations, routinesRevision: routineCatalog.revision)
    }

    public func setWorkspaceTaskPaused(_ paused: Bool, id: String, revision: Int, routine: Bool) async throws {
        guard HubVoiceAPI.validID(id), revision >= 0 else { throw HubAttachmentError.invalidResponse }
        let resource = routine ? "automations" : "goals"
        let data = try JSONSerialization.data(withJSONObject: [
            "action": paused ? "pause" : "resume", "id": id, "revision": revision,
        ])
        _ = try await requestData("api/hub/" + resource, headers: ["x-hub-" + resource: "1"], body: data)
    }

    public func usage() async throws -> HubUsageSnapshot {
        let data = try await requestData("minke/api/usage", headers: [:])
        return try JSONDecoder().decode(HubUsageSnapshot.self, from: data)
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

    public func knowledgeActivity(offset: Int = 0) async throws -> HubKnowledgeActivity {
        guard offset >= 0 else { throw HubAttachmentError.invalidResponse }
        let data = try await requestData("api/hub/memory", headers: ["x-hub-memory": "1"], query: [
            URLQueryItem(name: "view", value: "activity"), URLQueryItem(name: "offset", value: String(offset)),
        ])
        let page = try JSONDecoder().decode(HubKnowledgeActivity.self, from: data)
        guard page.nextOffset.map({ $0 > offset }) ?? true else { throw HubAttachmentError.invalidResponse }
        return page
    }

    public func addTodo(id: UUID, title: String, horizon: HubHomePlanner.Horizon = .near) async throws -> HubHomePlanner {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title.utf16.count <= 180 else { throw HubAttachmentError.invalidResponse }
        return try await changePlanner([
            "action": "save", "item": [
                "id": id.uuidString.lowercased(), "version": 0, "kind": "todo", "title": title,
                "details": "", "horizon": horizon.rawValue, "timeZone": TimeZone.current.identifier,
            ],
        ])
    }

    public func completeTodo(_ item: HubHomePlanner.Item) async throws -> HubHomePlanner {
        guard HubVoiceAPI.validID(item.id), item.kind == "todo", item.state == "open",
              !item.deleted, let version = item.version, version >= 0 else { throw HubAttachmentError.invalidResponse }
        return try await changePlanner(["action": "complete", "id": item.id, "version": version])
    }

    public func restorePlannerItem(_ item: HubHomePlanner.Item) async throws -> HubHomePlanner {
        guard HubVoiceAPI.validID(item.id), item.deleted || item.state == "done",
              let version = item.version, version >= 0 else { throw HubAttachmentError.invalidResponse }
        return try await changePlanner(["action": item.deleted ? "restore" : "reopen", "id": item.id, "version": version])
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

    public func cancelChat(sessionID: String) async throws {
        guard HubVoiceAPI.validID(sessionID) else { throw HubChatSendError.rejected }
        let receipt = try await rpc("session/cancel", request: ["sessionId": sessionID])
        guard receipt["accepted"] as? Bool == true else { throw HubChatSendError.rejected }
    }

    public func chatScreenshots(sessionID: String) async throws -> [HubChatScreenshot] {
        guard HubVoiceAPI.validID(sessionID) else { throw HubAttachmentError.invalidResponse }
        struct Catalog: Decodable { let screenshots: [HubChatScreenshot] }
        let data = try await requestData("api/hub/artifacts", headers: ["x-hub-daily-use": "1", "x-hub-session": sessionID])
        let catalog = try JSONDecoder().decode(Catalog.self, from: data)
        guard catalog.screenshots.allSatisfy({ Self.isScreenshotID($0.id) }),
              Set(catalog.screenshots.map(\.id)).count == catalog.screenshots.count else {
            throw HubAttachmentError.invalidResponse
        }
        return catalog.screenshots
    }

    public func chatScreenshot(sessionID: String, id: String) async throws -> Data {
        guard HubVoiceAPI.validID(sessionID), Self.isScreenshotID(id) else { throw HubAttachmentError.invalidResponse }
        return try await requestData("api/hub/artifacts", headers: [
            "x-hub-daily-use": "1", "x-hub-session": sessionID, "x-hub-screenshot": id,
        ], mediaTypes: ["image/png", "image/jpeg", "image/webp"], maxBytes: 8 * 1024 * 1024)
    }

    private static func isScreenshotID(_ id: String) -> Bool {
        id.utf8.count == 64 && id.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    public func followChat(sessionID: String, update: @MainActor (HubChatSnapshot) async -> Void) async throws {
        guard HubVoiceAPI.validID(sessionID) else { throw HubChatSendError.rejected }
        let httpsURL = server.origin.appendingPathComponent("api/remote.mux")
        guard var components = URLComponents(url: httpsURL, resolvingAgainstBaseURL: false) else {
            throw HubAttachmentError.invalidResponse
        }
        components.scheme = "wss"
        guard let url = components.url else { throw HubAttachmentError.invalidResponse }
        var request = URLRequest(url: url, timeoutInterval: 12)
        request.allHTTPHeaderFields = HTTPCookie.requestHeaderFields(with: server.cookies(await cookies(), for: httpsURL))
        let streamConfiguration = session.configuration
        streamConfiguration.timeoutIntervalForResource = 604_800
        let streamSession = URLSession(configuration: streamConfiguration, delegate: HubNoRedirects(), delegateQueue: nil)
        defer { streamSession.invalidateAndCancel() }
        let socket = streamSession.webSocketTask(with: request)
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
        try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            socket.resume()
            try await socket.send(.string(message))
            var timeline = HubChatTimeline()
            var opened = false
            while !Task.isCancelled {
                guard case .string(let text) = try await socket.receive() else { throw HubAttachmentError.invalidResponse }
                let frame = try JSONDecoder().decode(HubChatStreamFrame.self, from: Data(text.utf8))
                guard frame.streamId == streamID else { continue }
                if frame.type == "error" || frame.type == "end" { throw HubAttachmentError.unavailable }
                guard frame.type == "item", let value = frame.value else { continue }
                if !opened, value.type == "snapshot", value.records != nil {
                    timeline.start(value)
                    opened = true
                    deadline.cancel()
                } else if opened, value.type == "event", let event = value.event {
                    timeline.apply(event)
                } else {
                    continue
                }
                await update(timeline.snapshot)
            }
            throw CancellationError()
        }, onCancel: { socket.cancel(with: .goingAway, reason: nil) })
    }

    public func chatHistory(sessionID: String, through cursor: Int, before sequence: Int) async throws -> HubChatHistoryPage {
        guard HubVoiceAPI.validID(sessionID), sequence > 0, cursor >= sequence else {
            throw HubAttachmentError.invalidResponse
        }
        struct Page: Decodable {
            let records: [HubChatStreamFrame.Entry]
            let hasMore: Bool
        }
        let value = try await rpc("session/page", request: [
            "address": ["kind": "session", "sessionId": sessionID], "throughSeq": cursor,
            "beforeSeq": sequence, "maxMessages": 20,
        ], maxBytes: 4 * 1_024 * 1_024)
        let page = try JSONDecoder().decode(Page.self, from: JSONSerialization.data(withJSONObject: value))
        let events = page.records.map(\.event)
        guard events.allSatisfy({ (0..<sequence).contains($0.seq) }),
              zip(events, events.dropFirst()).allSatisfy({ $0.0.seq < $0.1.seq }),
              !page.hasMore || !events.isEmpty else { throw HubAttachmentError.invalidResponse }
        return HubChatHistoryPage(messages: events.compactMap(\.message), hasMore: page.hasMore,
                                  firstSequence: events.first?.seq)
    }

    private func rpc(_ method: String, request payload: [String: Any], maxBytes: Int = 65_536) async throws -> [String: Any] {
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
        guard http.statusCode == 200, http.mimeType == "application/json", data.count <= maxBytes,
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
