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

public struct HubChatBookmarks: Decodable {
    public let revision: Int
    public let sessionIds: [String]
}

public struct HubVoiceHistoryItem: Decodable, Identifiable {
    public let sessionId: String
    public let saved: Bool
    public let createdAt: Double
    public var id: String { sessionId }
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

public struct HubHomeKnowledge: Decodable, Equatable, Sendable {
    public struct Node: Decodable, Equatable, Sendable {
        public let id: String
        public let kind: String?
        public let title: String?
    }
    public struct Edge: Decodable, Equatable, Sendable {
        public let source: String
        public let target: String
    }
    public struct Domain: Decodable, Identifiable, Equatable, Sendable {
        public let id: String
        public let title: String
        public let parentId: String?
        public let status: String
        public let createdAt: Double?
    }
    public struct Membership: Decodable, Equatable, Sendable {
        public let nodeId: String
        public let domainId: String
    }
    public struct Similarity: Decodable, Equatable, Sendable {
        public let source: String
        public let target: String
        public let score: Double
    }
    public struct Communities: Decodable, Equatable, Sendable {
        public struct Group: Decodable, Equatable, Sendable {
            public let id: String
            public let label: String
            public let memberIds: [String]
        }
        public let groups: [Group]
    }
    public let nodes: [Node]
    public let edges: [Edge]
    public let domains: [Domain]?
    public let memberships: [Membership]?
    public let similarities: [Similarity]?
    public let communityCandidates: Communities?
}

public struct HubKnowledgeDomains: Decodable {
    public struct Domain: Decodable, Identifiable {
        public let id: String
        public let title: String
        public let parentId: String?
        public let aliases: [String]
        public let status: String
    }
    public struct Note: Decodable, Identifiable {
        public let id: String
        public let title: String
    }
    public let revision: Int
    public let maxActiveDomains: Int
    public let domains: [Domain]
    public let memberships: [HubHomeKnowledge.Membership]
    public let nodes: [Note]

    public enum Change {
        case create(title: String, aliases: [String], parent: String?)
        case edit(id: String, title: String, aliases: [String], parent: String?)
        case activate(id: String, active: Bool)
        case membership(note: String, domain: String, assigned: Bool)

        fileprivate var operations: [[String: Any]] {
            switch self {
            case .create(let title, let aliases, let parent):
                var operation: [String: Any] = ["type": "create", "ref": "new-domain", "title": title, "aliases": aliases]
                if let parent { operation["parentId"] = parent }
                return [operation]
            case .edit(let id, let title, let aliases, let parent):
                var reparent = ["type": "reparent", "id": id]
                if let parent { reparent["parentId"] = parent }
                return [["type": "rename", "id": id, "title": title, "aliases": aliases], reparent]
            case .activate(let id, let active):
                return [["type": "status", "id": id, "status": active ? "active" : "inactive"]]
            case .membership(let note, let domain, let assigned):
                return [["type": assigned ? "assign" : "unassign", "nodeId": note, "domainId": domain]]
            }
        }
    }
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
    public let hash: String?
    public let kind: String?
    public let protected: Bool?
    public let backlinks: [HubHomeKnowledge.Node]?
    public let links: [HubHomeKnowledge.Node]?
}

public struct HubChatMessage: Identifiable {
    public struct Photo: Decodable, Identifiable {
        public let attachmentId: String
        public let name: String?
        public let bytes: Int
        public let mediaType: String
        public var id: String { attachmentId }
    }
    public let id: String
    public let role: String
    public let text: String
    public let turn: Int?
    public let photos: [Photo]
}

public struct HubChatCommand: Decodable, Identifiable {
    public struct Input: Decodable {
        public let hint: String
        public let images: Bool?
    }
    public let name: String
    public let description: String
    public let input: Input?
    public var id: String { name }

    public static func leadingName(in text: String) -> String? {
        guard let token = text.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" || $0 == "\r" || $0 == "\r\n" }).first,
              text.hasPrefix("/"), token.hasPrefix("/") else { return nil }
        let name = String(token.dropFirst())
        return name.range(of: #"^[a-z][a-z0-9_-]*\z"#, options: .regularExpression) == nil ? nil : name
    }
}

public struct HubChatSkill: Decodable, Identifiable {
    public let name: String
    public let description: String
    public var id: String { name }
}

public struct HubChatCommandReceipt: Decodable {
    public struct Outcome: Decodable {
        public enum Kind: String, Decodable { case success, error }
        public let kind: Kind
        public let text: String?
    }
    public let commandId: String
    public let result: Outcome
}

public struct HubQueuedChatMessage: Decodable, Equatable, Identifiable {
    public enum Placement: String, Decodable { case queued, steering, context }
    private struct Message: Decodable, Equatable {
        struct Block: Decodable, Equatable {
            let type: String
            let text: String?
        }
        let content: [Block]
    }
    public let id: String
    public let placement: Placement
    private let message: Message

    public var text: String {
        message.content.filter { $0.type == "text" }.compactMap(\.text).joined(separator: "\n")
    }
    public var canEdit: Bool {
        !message.content.isEmpty && message.content.allSatisfy { $0.type == "text" && $0.text != nil }
    }
}

public enum HubChatQueueAction {
    case edit(String)
    case remove
    case steer
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
    public let activity: [HubChatActivity]
    public let title: String?
    public let model: HubChatModelSelection?
    public let usageByTurn: [Int: HubChatTurnUsage]
}

public struct HubChatTurnUsage {
    public private(set) var recordedResponses = 0
    public private(set) var input = 0
    public private(set) var output = 0
    public private(set) var cacheRead = 0
    public private(set) var cacheWrite = 0

    fileprivate mutating func add(_ receipt: HubChatStreamFrame.Entry.Event.Payload.Usage) {
        guard let input = receipt.inputTokens, let output = receipt.outputTokens,
              (0...1_000_000_000).contains(input), (0...1_000_000_000).contains(output) else { return }
        recordedResponses += 1
        self.input += input
        self.output += output
        if let value = receipt.cacheReadTokens, (0...1_000_000_000).contains(value) { cacheRead += value }
        if let value = receipt.cacheWriteTokens, (0...1_000_000_000).contains(value) { cacheWrite += value }
    }

    public func combining(_ other: HubChatTurnUsage) -> HubChatTurnUsage {
        var combined = self
        combined.recordedResponses += other.recordedResponses
        combined.input += other.input
        combined.output += other.output
        combined.cacheRead += other.cacheRead
        combined.cacheWrite += other.cacheWrite
        return combined
    }
}

public struct HubChatModelSelection: Decodable, Equatable {
    public let provider: String
    public let model: String
    public let reasoningEffort: String?
}

public struct HubChatModels: Decodable {
    public struct Provider: Decodable, Identifiable {
        public struct Model: Decodable, Identifiable {
            public struct Reasoning: Decodable {
                public struct Effort: Decodable, Identifiable {
                    public let id: String
                    public let name: String
                    public let description: String?
                }
                public let efforts: [Effort]
                public let defaultEffort: String?
            }
            public let id: String
            public let name: String
            public let description: String?
            public let reasoning: Reasoning?
        }
        public let id: String
        public let name: String
        public let models: [Model]
    }
    public struct Failure: Decodable, Identifiable {
        public let id: String
        public let name: String
    }
    public let groups: [Provider]
    public let failures: [Failure]
}

public struct HubChatHistoryPage {
    public let messages: [HubChatMessage]
    public let hasMore: Bool
    public let firstSequence: Int?
    public let activity: [HubChatActivity]
    public let usageByTurn: [Int: HubChatTurnUsage]
}

public struct HubChatActivity: Identifiable {
    public let sequence: Int
    public let title: String
    public let detail: String?
    public let turn: Int?
    public let failed: Bool
    public var id: Int { sequence }
}

public struct HubChatScreenshot: Decodable, Identifiable {
    public let id: String
    public let name: String
    public let turn: Int
}

public struct HubConversationApp: Decodable, Identifiable {
    public let id: String
    public let name: String
    public let at: Double
}

public struct HubConversationAppDocument: Decodable {
    public let name: String
    public let document: String
}

public struct HubChatPresentation: Decodable, Equatable, Identifiable {
    public enum Kind: String, Decodable { case html, vega, app }
    public let id: UUID
    public let title: String
    public let kind: Kind
    public let createdAt: Int64

    fileprivate var isValid: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            title.utf16.count <= 120 && (0...9_007_199_254_740_991).contains(createdAt)
    }
}

public struct HubBrowserTab: Decodable, Equatable, Identifiable {
    public enum Owner: String, Decodable { case agent, human }
    public let sessionId: String
    public let ownerSessionId: String
    public let title: String
    public let url: String
    public let status: String
    public let owner: Owner
    public var id: String { "\(ownerSessionId)/\(sessionId)" }

    fileprivate var isValid: Bool {
        HubVoiceAPI.validID(sessionId) && HubVoiceAPI.validID(ownerSessionId) &&
            [title, url, status].allSatisfy { $0.utf16.count <= 8_192 }
    }
}

public struct HubBrowserFrame {
    public let tab: HubBrowserTab
    public let width: Int
    public let height: Int
    public let jpeg: Data
}

public struct HubChatPreferences {
    public enum Delivery: String, CaseIterable { case queue, steer }
    public enum Transcript: String, CaseIterable { case normal, compact }

    public let fontSize: Int
    public let busyEnter: Delivery
    public let transcript: Transcript
    public let writable: Bool
    fileprivate let revisions: [String: Int]

    public static let defaults = HubChatPreferences(fontSize: 14, busyEnter: .queue, transcript: .compact,
                                                     writable: false, revisions: [:])

    public enum Change {
        case fontSize(Int)
        case busyEnter(Delivery)
        case transcript(Transcript)

        fileprivate var field: (namespace: String, key: String, value: Any) {
            switch self {
            case .fontSize(let size): return ("ui-theme", "fontSize", size)
            case .busyEnter(let mode): return ("ui-conversation", "busyEnter", mode.rawValue)
            case .transcript(let mode): return ("ui-chat", "transcriptView", mode.rawValue)
            }
        }
    }
}

public struct HubWorkspaceItem: Decodable, Identifiable {
    public let workspaceId: String
    public let path: String
    public let title: String
    public let sessionIds: [String]
    public var id: String { workspaceId }

    fileprivate var isValid: Bool {
        HubVoiceAPI.validID(id) && !path.isEmpty && path.utf8.count <= 32_768 &&
            !title.isEmpty && title.utf8.count <= 4_096 &&
            sessionIds.allSatisfy(HubVoiceAPI.validID) && Set(sessionIds).count == sessionIds.count
    }
}

public struct HubWorkspaceDirectory: Decodable {
    public struct Entry: Decodable, Identifiable {
        public let name: String
        public let path: String
        public let hidden: Bool
        public var id: String { path }
    }
    public let path: String
    public let crumbs: [Entry]
    public let entries: [Entry]
    public let truncated: Bool
}

public struct HubChatArtifacts: Decodable {
    public let screenshots: [HubChatScreenshot]
    public let artifacts: [HubConversationApp]?
}

public struct HubChatPhoto {
    public let name: String
    public let mediaType: String
    public let data: Data

    public init(name: String, mediaType: String, data: Data) {
        self.name = name
        self.mediaType = mediaType
        self.data = data
    }
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
    public struct Run: Decodable, Identifiable {
        public let id: String
        public let sessionId: String
        public let at: Double
        public let status: String
        public let estimatedCost: Double
        public let summary: String?
        public let result: String?
        public let error: String?
    }
    public struct Approval: Decodable, Identifiable {
        public let id: String
        public let description: String
        public let tool: String
        public let status: String
        public let arguments: HubTaskArgument?
    }
    public struct Milestone: Decodable, Identifiable {
        public let id: String
        public let title: String
        public let status: String
    }
    public struct Checkpoint: Decodable {
        public let summary: String
        public let nextAction: String
    }
    public let id: String
    public let title: String
    public let state: String
    public let status: String
    public let updatedAt: Double
    public let nextAt: Double?
    public let objective: String?
    public let prompt: String?
    public let revision: Int?
    public let reason: String?
    public let lastError: String?
    public let rounds: [Run]?
    public let runs: [Run]?
    public let plan: [Milestone]?
    public let approvals: [Approval]?
    public let checkpoint: Checkpoint?
}

public enum HubTaskArgument: Decodable {
    case text(String), number(Double), boolean(Bool), object([String: HubTaskArgument]), array([HubTaskArgument]), null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(String.self) { self = .text(value) }
        else if let value = try? container.decode(Bool.self) { self = .boolean(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode([String: HubTaskArgument].self) { self = .object(value) }
        else { self = .array(try container.decode([HubTaskArgument].self)) }
    }

    public var displayText: String {
        guard let data = try? JSONSerialization.data(withJSONObject: json, options: [.fragmentsAllowed, .prettyPrinted, .sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { return "" }
        return text
    }

    private var json: Any {
        switch self {
        case .text(let value): return value
        case .number(let value): return value
        case .boolean(let value): return value
        case .object(let value): return value.mapValues(\.json)
        case .array(let value): return value.map(\.json)
        case .null: return NSNull()
        }
    }
}

public enum HubWorkspaceTaskAction: String {
    case start, pause, resume, stop, archive, approve, deny, cancel
    case runOnce = "run-once"
    case resumeCredit = "resume-credit"
    case acceptResult = "accept-result"
}

public struct HubWorkspaceTasks {
    public let goals: [HubWorkspaceTask]
    public let routines: [HubWorkspaceTask]
    public let routinesRevision: Int?
}

public struct HubGoalEditorData {
    public struct Character: Decodable, Identifiable {
        public let id: String
        public let name: String
        public let route: HubChatModelSelection?
    }
    public struct Draft {
        public var title: String
        public var objective: String
        public var criteria: [String]
        public var characterID: String
        public var approach: String
        public var instructions: String
        public var humanApproval: Bool
        public var activeMinutes: Int
        public var knowledge: Bool
        public var browser: Bool
    }
    public let draft: Draft
    public let characters: [Character]
    public let isResearch: Bool
    fileprivate let original: [String: Any]
    fileprivate let id: String?
    fileprivate let revision: Int
}

public struct HubRoutineEditorData {
    public struct Trigger: Codable {
        public enum Kind: String, Codable, CaseIterable { case once, interval, calendar, watch, event }
        public var kind: Kind = .once
        public var at: Int64?
        public var seconds: Int?
        public var hour: Int?
        public var minute: Int?
        public var days: [Int]?
        public var timezone: String?
        public var url: String?
        public var rule: String?
        public var value: String?
        public var jsonPath: String?
        public var fireOnFirst: Bool?
        public var event: String?
        public var path: String?
        public var operatorName: String?

        private enum CodingKeys: String, CodingKey {
            case kind, at, seconds, hour, minute, days, timezone, url, rule, value, jsonPath, fireOnFirst, event, path
            case operatorName = "operator"
        }
        public init(kind: Kind) { self.kind = kind }
    }

    public struct Draft: Codable {
        public var title: String
        public var prompt: String
        public var characterId: String
        public var trigger: Trigger
        public var missed: String
        public var tools: [String]
        public var allowWrites: Bool
        public var maxOutputTokens: Int
        public var maxSteps: Int
        public var dailyMaxRuns: Int
        public var dailyBudget: Double
        public var inputPrice: Double
        public var outputPrice: Double
        public var notification: String
        public var sourceSessionId: String?
        public var goalId: String?

        fileprivate static func new(character: String) -> Self {
            var trigger = Trigger(kind: .once)
            trigger.at = Int64(Date().addingTimeInterval(3_600).timeIntervalSince1970 * 1_000)
            return Self(title: "", prompt: "", characterId: character, trigger: trigger, missed: "catch-up",
                        tools: ["web_search", "web_fetch", "camofox_search", "camofox_open", "camofox_snapshot", "camofox_close",
                                "hub_knowledge_search", "hub_knowledge_read"],
                        allowWrites: false, maxOutputTokens: 2_048, maxSteps: 3, dailyMaxRuns: 6,
                        dailyBudget: 0.2, inputPrice: 0.1, outputPrice: 0.5, notification: "pwa")
        }
    }

    public let draft: Draft
    public let characters: [HubGoalEditorData.Character]
    fileprivate let revision: Int
    fileprivate let id: String?
}

struct HubChatStreamFrame: Decodable {
    struct Entry: Decodable {
        struct Event: Decodable {
            struct Payload: Decodable {
                struct Block: Decodable {
                    let type: String
                    let text: String?
                    let attachment: HubChatMessage.Photo?
                }
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
                struct RequestHeader: Decodable {
                    let system: String?
                    let config: HubChatModelSelection?
                }
                struct ToolError: Decodable { let name: String?; let code: String? }
                struct Usage: Decodable {
                    let inputTokens: Int?
                    let outputTokens: Int?
                    let cacheReadTokens: Int?
                    let cacheWriteTokens: Int?
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
                let header: RequestHeader?
                let name: String?
                let arguments: String?
                let error: ToolError?
                let title: String?
                let usage: Usage?
                let args: String?
                let kind: String?
                let text: String?
            }
            let type: String
            let seq: Int
            let message: HubChatMessage?
            let delta: (index: Int, text: String)?
            let failure: String?
            let announcesScreenshot: Bool
            let activity: HubChatActivity?
            let replacement: Replacement?
            let title: String?
            let modelSelection: HubChatModelSelection?
            let modelRequest: HubChatModelSelection?
            let usage: (turn: Int, receipt: Payload.Usage)?

            struct Replacement: Decodable { let op: String; let start: Int; let end: Int }
            private enum CodingKeys: String, CodingKey { case type, seq, data, surfaceOp }

            init(from decoder: Decoder) throws {
                let values = try decoder.container(keyedBy: CodingKeys.self)
                type = try values.decode(String.self, forKey: .type)
                seq = try values.decode(Int.self, forKey: .seq)
                let payload = try? values.decode(Payload.self, forKey: .data)
                title = type == "session/title" ? payload?.title : nil
                modelSelection = type == "model/selection" ? (try? values.decode(HubChatModelSelection.self, forKey: .data)) : nil
                modelRequest = type == "request/header" ? payload?.header?.config : nil
                if type == "assistant/message", let turn = payload?.turn, let receipt = payload?.usage {
                    usage = (turn, receipt)
                } else {
                    usage = nil
                }
                replacement = try? values.decode(Replacement.self, forKey: .surfaceOp)
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
                let activityTitle: String?
                let detail: String?
                switch type {
                case "request/header":
                    activityTitle = payload?.header?.system?.isEmpty == false ? "System prompt" : nil
                    detail = payload?.header?.system
                case "tool/call":
                    activityTitle = payload?.name ?? "Tool call"
                    detail = payload?.arguments
                case "tool/result":
                    activityTitle = payload?.error == nil ? "Tool result" : "Tool failed"
                    detail = payload?.error?.code
                case "request/context":
                    activityTitle = "Context updated"
                    detail = nil
                case "command/run":
                    activityTitle = "Command started"
                    detail = (payload?.name).map { "/" + $0 + (payload?.args ?? "") }
                case "command/done":
                    activityTitle = payload?.kind == "error" ? "Command failed" : "Command finished"
                    detail = payload?.text
                case "turn/end":
                    activityTitle = failure == nil ? nil : "This turn failed"
                    detail = failure
                default:
                    activityTitle = nil
                    detail = nil
                }
                if let activityTitle {
                    activity = HubChatActivity(sequence: seq, title: activityTitle, detail: detail,
                                               turn: payload?.turn, failed: failure != nil || payload?.error != nil ||
                                                (type == "command/done" && payload?.kind == "error"))
                } else {
                    activity = nil
                }
                if type == "command/run" || type == "command/done" {
                    let role = payload?.kind == "error" ? "command-error" : "command"
                    message = HubChatMessage(id: String(seq), role: role,
                                             text: detail ?? (activityTitle ?? ""), turn: nil, photos: [])
                    return
                }
                guard type == "user/message" || type == "assistant/message",
                      let payload,
                      type != "user/message" || payload.source?.kind == "user" else {
                    message = nil
                    return
                }
                let content = payload.message?.content ?? payload.content ?? []
                let text = content.filter { $0.type == "text" }.compactMap(\.text).joined(separator: "\n")
                var seen: Set<String> = []
                let photos = content.filter { $0.type == "image" }.compactMap(\.attachment)
                    .filter { seen.insert($0.attachmentId).inserted }
                message = text.isEmpty && photos.isEmpty ? nil : HubChatMessage(
                    id: String(seq), role: type == "user/message" ? "user" : "assistant",
                    text: text, turn: payload.turn, photos: photos)
            }
        }
        let event: Event
    }
    struct Value: Decodable {
        struct Projections: Decodable {
            struct Values: Decodable {
                struct ModelProjection: Decodable {
                    let next: HubChatModelSelection?
                    let lastUsed: HubChatModelSelection?
                }
                let title: String?
                let modelSelection: ModelProjection?
            }
            let values: Values
        }
        let type: String
        let records: [Entry]?
        let hasMore: Bool?
        let event: Entry.Event?
        let cursor: Int?
        let projections: Projections?
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
    private var activity: [HubChatActivity] = []
    private var title: String?
    private var model: HubChatModelSelection?
    private var pendingModel: HubChatModelSelection?
    private var usageReceipts: [Int: (turn: Int, receipt: HubChatStreamFrame.Entry.Event.Payload.Usage)] = [:]

    mutating func start(_ frame: HubChatStreamFrame.Value) {
        hasMore = frame.hasMore ?? false
        historyCursor = frame.cursor
        firstSequence = frame.records?.first?.event.seq
        for record in frame.records ?? [] { apply(record.event) }
        title = frame.projections?.values.title ?? title
        if let projection = frame.projections?.values.modelSelection {
            model = projection.next
            pendingModel = projection.next == projection.lastUsed ? nil : projection.next
        }
    }

    mutating func apply(_ event: HubChatStreamFrame.Entry.Event) {
        guard event.seq > lastSequence else { return }
        lastSequence = event.seq
        if let replace = event.replacement, replace.op == "replace", replace.start <= replace.end {
            messages.removeAll {
                guard let sequence = Int($0.id) else { return false }
                return sequence >= replace.start && sequence < replace.end
            }
            activity.removeAll { $0.sequence >= replace.start && $0.sequence < replace.end }
            usageReceipts = usageReceipts.filter { !(replace.start..<replace.end).contains($0.key) }
            blocks.removeAll()
        }
        if event.announcesScreenshot { latestScreenshotSequence = event.seq }
        if let entry = event.activity { activity.append(entry) }
        if let usage = event.usage { usageReceipts[event.seq] = usage }
        if let title = event.title { self.title = title }
        if let selection = event.modelSelection { pendingModel = selection; model = selection }
        if let used = event.modelRequest {
            if pendingModel == used { pendingModel = nil }
            model = pendingModel ?? used
        }
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
        var totals: [Int: HubChatTurnUsage] = [:]
        for record in usageReceipts.values {
            totals[record.turn, default: HubChatTurnUsage()].add(record.receipt)
        }
        return HubChatSnapshot(messages: messages, hasMore: hasMore, running: running,
                        partial: blocks.keys.sorted().compactMap { blocks[$0] }.joined(), failure: failure,
                        latestScreenshotSequence: latestScreenshotSequence, historyCursor: historyCursor,
                        firstSequence: firstSequence, activity: activity, title: title, model: model, usageByTurn: totals)
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
        public let end: String?
        public let details: String?
        public let sourceSessionId: String?
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
            guard let instant = HubPlannerDraft.parseInstant(start) else { return false }
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

    public func chatBookmarks() async throws -> HubChatBookmarks {
        try await bookmarksRequest()
    }

    public func voiceHistory() async throws -> [HubVoiceHistoryItem] {
        struct History: Decodable { let conversations: [HubVoiceHistoryItem] }
        let data = try await requestData("api/hub/voice/history", headers: [:], maxBytes: 5_242_880)
        let records = try JSONDecoder().decode(History.self, from: data).conversations
        guard records.count <= 20_000, Set(records.map(\.sessionId)).count == records.count,
              records.allSatisfy({ HubVoiceAPI.validID($0.sessionId) && $0.createdAt >= 0 }) else {
            throw HubAttachmentError.invalidResponse
        }
        return records.sorted { $0.createdAt > $1.createdAt }
    }

    public func saveVoiceConversation(sessionID: String) async throws {
        guard HubVoiceAPI.validID(sessionID) else { throw HubAttachmentError.invalidResponse }
        struct Receipt: Decodable { let sessionId: String; let saved: Bool; let kind: String }
        let data = try await requestData("api/hub/voice/history", headers: ["x-hub-voice-history": "1"],
                                         body: JSONEncoder().encode(["sessionId": sessionID]))
        let receipt = try JSONDecoder().decode(Receipt.self, from: data)
        guard receipt.sessionId == sessionID, receipt.saved, receipt.kind == "voice" else {
            throw HubAttachmentError.invalidResponse
        }
    }

    public func setChatPinned(sessionID: String, pinned: Bool) async throws -> HubChatBookmarks {
        guard Self.validBookmarkID(sessionID) else { throw HubAttachmentError.invalidResponse }
        let body = try JSONSerialization.data(withJSONObject: [
            "changes": [["sessionId": sessionID, "pinned": pinned]],
        ])
        return try await bookmarksRequest(body)
    }

    private func bookmarksRequest(_ body: Data? = nil) async throws -> HubChatBookmarks {
        let data = try await requestData("hub/bookmarks", headers: ["x-hub-bookmarks": "1"], body: body, maxBytes: 6_000_000)
        let value = try JSONDecoder().decode(HubChatBookmarks.self, from: data)
        guard value.revision >= 0, value.sessionIds.count <= 20_000,
              value.sessionIds.allSatisfy(Self.validBookmarkID) else { throw HubAttachmentError.invalidResponse }
        return value
    }

    private static func validBookmarkID(_ id: String) -> Bool {
        !id.isEmpty && id.utf8.count <= 256 && id.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95
        }
    }

    public func modelCatalog(refresh: Bool = false) async throws -> HubModelCatalog {
        try await modelRequest(refresh ? ["action": "refresh"] : nil)
    }

    public func toolCatalog() async throws -> HubToolCatalog {
        let data = try await requestData("api/hub/tools", headers: ["x-hub-tools": "1"], maxBytes: 4_194_304)
        return try JSONDecoder().decode(HubToolCatalog.self, from: data)
    }

    public func speechSettings() async throws -> HubSpeechSettings {
        try await speechSettingsRequest(nil)
    }

    public func saveSpeechSettings(_ value: HubSpeechSettings) async throws -> HubSpeechSettings {
        try await speechSettingsRequest(JSONEncoder().encode(value))
    }

    private func speechSettingsRequest(_ body: Data?) async throws -> HubSpeechSettings {
        let data = try await requestData("api/hub/voice/settings", headers: ["x-hub-speech-settings": "1"], body: body)
        return try JSONDecoder().decode(HubSpeechSettings.self, from: data)
    }

    public func speechCatalog() async throws -> HubSpeechCatalog {
        struct Catalog: Decodable { let speech: HubSpeechCatalog }
        let data = try await requestData("api/hub/voice/catalog", headers: [:])
        return try JSONDecoder().decode(Catalog.self, from: data).speech
    }

    public func speechDownload(_ option: HubSpeechCatalog.Option? = nil) async throws -> HubSpeechDownload? {
        struct Status: Decodable { let download: HubSpeechDownload? }
        let body = try option.map { try JSONEncoder().encode(["engine": $0.engine, "model": $0.model]) }
        let data = try await requestData("api/hub/voice/speech-models", headers: ["x-hub-speech-models": "1"], body: body)
        return try JSONDecoder().decode(Status.self, from: data).download
    }

    public func speechPreview(_ voice: HubCharacterSettings.Character.Speech.Engine, language: String) async throws -> Data {
        struct Sample: Encodable { let tts: HubCharacterSettings.Character.Speech.Engine; let language: String }
        guard ["en", "tr"].contains(language) else { throw HubAttachmentError.invalidResponse }
        return try await requestData("api/hub/voice/preview", headers: ["x-hub-speech-preview": "1"],
                                     body: JSONEncoder().encode(Sample(tts: voice, language: language)),
                                     mediaTypes: ["audio/wav"], maxBytes: 4_194_304)
    }

    public func sonioxConnection(key: String? = nil) async throws -> Bool {
        struct Connection: Decodable { let configured: Bool }
        if let key, !(16...512).contains(key.utf8.count) { throw HubAttachmentError.invalidResponse }
        let body = try key.map { try JSONEncoder().encode(["apiKey": $0]) }
        let data = try await requestData("api/hub/voice/soniox", headers: ["x-hub-speech-settings": "1"], body: body)
        return try JSONDecoder().decode(Connection.self, from: data).configured
    }

    public func setModelFavorite(_ model: HubModelCatalog.Model, selected: Bool) async throws -> HubModelCatalog {
        try await modelRequest(["action": "favorite", "provider": model.provider, "model": model.modelID, "selected": selected])
    }

    public func enableCatalogModel(_ model: HubModelCatalog.Model) async throws {
        struct Availability: Decodable {
            struct Selection: Decodable { let provider: String; let model: String }
            let available: Selection
        }
        let body = try JSONSerialization.data(withJSONObject: [
            "action": "enable", "provider": model.provider, "model": model.modelID,
        ])
        let data = try await requestData("api/hub/models", headers: ["x-hub-models": "1"], body: body)
        let receipt = try JSONDecoder().decode(Availability.self, from: data)
        guard receipt.available.provider == model.provider, receipt.available.model == model.modelID else {
            throw HubAttachmentError.invalidResponse
        }
    }

    private func modelRequest(_ command: [String: Any]?) async throws -> HubModelCatalog {
        let body = try command.map { try JSONSerialization.data(withJSONObject: $0) }
        let data = try await requestData("api/hub/models", headers: ["x-hub-models": "1"], body: body, maxBytes: 4_194_304)
        return try JSONDecoder().decode(HubModelCatalog.self, from: data)
    }

    public func instructions(sessionID: String? = nil) async throws -> HubInstructionCatalog {
        var query: [URLQueryItem] = []
        if let sessionID {
            guard HubVoiceAPI.validID(sessionID) else { throw HubAttachmentError.invalidResponse }
            query.append(URLQueryItem(name: "sessionId", value: sessionID))
        }
        let data = try await requestData("api/hub/instructions", headers: ["x-hub-instructions": "1"], query: query)
        return try JSONDecoder().decode(HubInstructionCatalog.self, from: data)
    }

    public func saveInstruction(_ file: HubInstructionCatalog.File, content: String) async throws -> HubInstructionCatalog {
        guard file.editable, let hash = file.hash, Self.isScreenshotID(hash),
              file.id == "SOUL.md" || file.id == "USER.md" || file.id.hasPrefix("character:") else {
            throw HubAttachmentError.invalidResponse
        }
        let body = try JSONSerialization.data(withJSONObject: ["id": file.id, "hash": hash, "content": content])
        guard body.count <= 80_000 else { throw HubAttachmentError.tooLarge }
        let data = try await requestData("api/hub/instructions", headers: ["x-hub-instructions": "1"], body: body)
        return try JSONDecoder().decode(HubInstructionCatalog.self, from: data)
    }

    public func telegramStatus() async throws -> HubTelegramStatus {
        try await telegramRequest(nil)
    }

    public func reconnectTelegram() async throws -> HubTelegramStatus {
        try await telegramRequest(["action": "reconnect"])
    }

    public func connectTelegram(token: String) async throws -> HubTelegramStatus {
        guard token.range(of: #"^\d{6,16}:[A-Za-z0-9_-]{30,100}$"#, options: .regularExpression) != nil else {
            throw HubAttachmentError.invalidResponse
        }
        return try await telegramRequest(["action": "connect", "token": token])
    }

    public func approveTelegram(requestID: String) async throws -> HubTelegramStatus {
        guard requestID.range(of: #"^[A-Za-z0-9_-]{1,128}$"#, options: .regularExpression) != nil else {
            throw HubAttachmentError.invalidResponse
        }
        return try await telegramRequest(["action": "approve", "requestId": requestID])
    }

    private func telegramRequest(_ command: [String: String]?) async throws -> HubTelegramStatus {
        let body = try command.map { try JSONEncoder().encode($0) }
        let data = try await requestData("api/hub/telegram", headers: ["x-hub-telegram": "1"], body: body)
        return try JSONDecoder().decode(HubTelegramStatus.self, from: data)
    }

    public func chatCharacters(sessionID: String) async throws -> HubChatCharacterPicker {
        guard HubVoiceAPI.validID(sessionID) else { throw HubAttachmentError.invalidResponse }
        let data = try await requestData("api/hub/characters", headers: ["x-hub-characters": "1"], query: [
            URLQueryItem(name: "view", value: "picker"), URLQueryItem(name: "sessionId", value: sessionID),
        ])
        return try JSONDecoder().decode(HubChatCharacterPicker.self, from: data)
    }

    public func characterSettings() async throws -> HubCharacterSettings {
        let data = try await requestData("api/hub/characters", headers: ["x-hub-characters": "1"])
        return try JSONDecoder().decode(HubCharacterSettings.self, from: data)
    }

    public func saveCharacter(_ character: HubCharacterSettings.Character, revision: Int, creating: Bool) async throws -> HubCharacterSettings {
        guard UUID(uuidString: character.id) != nil, revision >= 0 else { throw HubAttachmentError.invalidResponse }
        let encoded = try JSONEncoder().encode(character)
        guard var value = try JSONSerialization.jsonObject(with: encoded) as? [String: Any] else {
            throw HubAttachmentError.invalidResponse
        }
        for key in ["route", "speech", "delegateTo"] where value[key] == nil { value[key] = NSNull() }
        if creating { value.removeValue(forKey: "id") }
        return try await characterCommand([
            "action": creating ? "create" : "save", "revision": revision, "character": value,
        ])
    }

    public func changeCharacterRole(_ action: HubCharacterRoleAction, id: String, revision: Int) async throws -> HubCharacterSettings {
        guard UUID(uuidString: id) != nil, revision >= 0 else { throw HubAttachmentError.invalidResponse }
        return try await characterCommand(["action": action.rawValue, "id": id, "revision": revision])
    }

    private func characterCommand(_ command: [String: Any]) async throws -> HubCharacterSettings {
        let body = try JSONSerialization.data(withJSONObject: command)
        let data = try await requestData("api/hub/characters", headers: ["x-hub-characters": "1"], body: body)
        return try JSONDecoder().decode(HubCharacterSettings.self, from: data)
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
        async let goals = requestData("api/hub/goals", headers: ["x-hub-goals": "1"], maxBytes: 8_388_608)
        async let routines = requestData("api/hub/automations", headers: ["x-hub-automations": "1"], maxBytes: 8_388_608)
        let (goalData, routineData) = try await (goals, routines)
        let decoder = JSONDecoder()
        let routineCatalog = try decoder.decode(Routines.self, from: routineData)
        return try HubWorkspaceTasks(goals: decoder.decode(Goals.self, from: goalData).goals,
                                     routines: routineCatalog.automations, routinesRevision: routineCatalog.revision)
    }

    public func goalEditor(id: String? = nil) async throws -> HubGoalEditorData {
        if let id, !HubVoiceAPI.validID(id) { throw HubAttachmentError.invalidResponse }
        let data = try await requestData("api/hub/goals", headers: ["x-hub-goals": "1"], maxBytes: 8_388_608)
        guard let snapshot = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let choices = snapshot["characters"] as? [[String: Any]] else { throw HubAttachmentError.invalidResponse }
        let characters = try JSONDecoder().decode([HubGoalEditorData.Character].self, from: JSONSerialization.data(withJSONObject: choices))
        let definition: [String: Any]
        let revision: Int
        if let id {
            guard let value = (snapshot["goals"] as? [[String: Any]])?.first(where: { $0["id"] as? String == id }),
                  let current = value["revision"] as? Int,
                  !["stopped", "archived"].contains(value["state"] as? String ?? "") else {
                throw HubAttachmentError.unavailable
            }
            definition = value
            revision = current
        } else {
            guard let defaults = snapshot["defaults"] as? [String: Any], let current = snapshot["revision"] as? Int else {
                throw HubAttachmentError.invalidResponse
            }
            definition = defaults
            revision = current
        }
        guard revision >= 0, let limits = definition["limits"] as? [String: Any], let active = limits["activeMinutes"] as? Int,
              let resources = definition["resources"] as? [String: Any], let knowledge = resources["knowledge"] as? Bool,
              let browser = resources["browser"] as? Bool, let approach = definition["approach"] as? String,
              let approval = definition["humanApproval"] as? Bool else { throw HubAttachmentError.invalidResponse }
        let defaultCharacter = characters.first { $0.name == "HUB" && $0.route != nil } ?? characters.first { $0.route != nil }
        let draft = HubGoalEditorData.Draft(title: definition["title"] as? String ?? "", objective: definition["objective"] as? String ?? "",
            criteria: definition["criteria"] as? [String] ?? [], characterID: definition["characterId"] as? String ?? defaultCharacter?.id ?? "",
            approach: approach, instructions: definition["instructions"] as? String ?? "", humanApproval: approval,
            activeMinutes: active, knowledge: knowledge, browser: browser)
        let fields: Set<String> = ["research", "title", "objective", "criteria", "characterId", "approach",
            "instructions", "helpers", "verifierId", "fallbacks", "resources", "limits", "schedule", "recovery",
            "humanApproval", "notification", "sourceSessionId"]
        return HubGoalEditorData(draft: draft, characters: characters, isResearch: definition["research"] is [String: Any],
            original: definition.filter { fields.contains($0.key) }, id: id, revision: revision)
    }

    public func saveGoal(_ draft: HubGoalEditorData.Draft, from loaded: HubGoalEditorData) async throws -> String {
        let title = draft.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let objective = draft.objective.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title.utf16.count <= 160, !objective.isEmpty, objective.utf16.count <= 12_000,
              (1...20).contains(draft.criteria.count), draft.criteria.allSatisfy({ !$0.isEmpty && $0.utf16.count <= 2_000 }),
              ["quick", "balanced", "thorough", "custom"].contains(draft.approach), draft.instructions.utf16.count <= 12_000,
              !draft.characterID.isEmpty, (1...10_080).contains(draft.activeMinutes),
              var resources = loaded.original["resources"] as? [String: Any],
              var limits = loaded.original["limits"] as? [String: Any] else { throw HubAttachmentError.invalidResponse }
        var value = loaded.original
        value["title"] = title
        value["objective"] = draft.objective
        value["criteria"] = draft.criteria
        value["characterId"] = draft.characterID
        value["approach"] = draft.approach
        value["instructions"] = draft.instructions
        value["humanApproval"] = draft.humanApproval
        if !loaded.isResearch {
            resources["knowledge"] = draft.knowledge
            resources["browser"] = draft.browser
            limits["activeMinutes"] = draft.activeMinutes
        }
        value["resources"] = resources
        value["limits"] = limits
        var command: [String: Any] = ["action": "save", "revision": loaded.revision, "goal": value]
        if let id = loaded.id { command["id"] = id }
        let body = try JSONSerialization.data(withJSONObject: command)
        guard body.count <= 100_000 else { throw HubAttachmentError.tooLarge }
        let data = try await requestData("api/hub/goals", headers: ["x-hub-goals": "1"], body: body, maxBytes: 8_388_608)
        struct Receipt: Decodable { let changedId: String }
        let receipt = try JSONDecoder().decode(Receipt.self, from: data)
        guard HubVoiceAPI.validID(receipt.changedId), loaded.id == nil || loaded.id == receipt.changedId else {
            throw HubAttachmentError.invalidResponse
        }
        return receipt.changedId
    }

    public func routineEditor(id: String? = nil) async throws -> HubRoutineEditorData {
        struct Catalog: Decodable {
            struct Record: Decodable {
                let id: String
                let status: String
                let draft: HubRoutineEditorData.Draft

                init(from decoder: Decoder) throws {
                    let box = try decoder.container(keyedBy: CodingKeys.self)
                    id = try box.decode(String.self, forKey: .id)
                    status = try box.decode(String.self, forKey: .status)
                    draft = try HubRoutineEditorData.Draft(from: decoder)
                }
                private enum CodingKeys: String, CodingKey { case id, status }
            }
            let revision: Int
            let characters: [HubGoalEditorData.Character]
            let automations: [Record]
        }
        if let id, !HubVoiceAPI.validID(id) { throw HubAttachmentError.invalidResponse }
        let data = try await requestData("api/hub/automations", headers: ["x-hub-automations": "1"], maxBytes: 8_388_608)
        let catalog = try JSONDecoder().decode(Catalog.self, from: data)
        guard catalog.revision >= 0 else { throw HubAttachmentError.invalidResponse }
        let draft: HubRoutineEditorData.Draft
        if let id {
            guard let job = catalog.automations.first(where: { $0.id == id }),
                  !["running", "checking"].contains(job.status) else { throw HubAttachmentError.unavailable }
            draft = job.draft
        } else {
            draft = .new(character: catalog.characters.first(where: { $0.route != nil })?.id ?? "")
        }
        return HubRoutineEditorData(draft: draft, characters: catalog.characters, revision: catalog.revision, id: id)
    }

    public func saveRoutine(_ draft: HubRoutineEditorData.Draft, from loaded: HubRoutineEditorData) async throws {
        struct Command: Encodable {
            let action = "save"
            let id: String?
            let revision: Int
            let automation: HubRoutineEditorData.Draft
        }
        struct Receipt: Decodable { let revision: Int }
        guard !draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, draft.title.utf16.count <= 160,
              !draft.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, draft.prompt.utf16.count <= 12_000,
              loaded.characters.contains(where: { $0.id == draft.characterId && $0.route != nil }),
              draft.sourceSessionId == loaded.draft.sourceSessionId else { throw HubAttachmentError.invalidResponse }
        let body = try JSONEncoder().encode(Command(id: loaded.id, revision: loaded.revision, automation: draft))
        guard body.count <= 50_000 else { throw HubAttachmentError.tooLarge }
        let response = try await requestData("api/hub/automations", headers: ["x-hub-automations": "1"],
                                             body: body, maxBytes: 8_388_608)
        let receipt = try JSONDecoder().decode(Receipt.self, from: response)
        guard receipt.revision > loaded.revision else { throw HubAttachmentError.invalidResponse }
    }

    public func changeWorkspaceTask(_ action: HubWorkspaceTaskAction, id: String, revision: Int,
                                    routine: Bool, approvalID: String? = nil) async throws {
        guard HubVoiceAPI.validID(id), revision >= 0 else { throw HubAttachmentError.invalidResponse }
        if let approvalID {
            guard !routine, action == .approve || action == .deny, HubVoiceAPI.validID(approvalID) else {
                throw HubAttachmentError.invalidResponse
            }
        }
        let resource = routine ? "automations" : "goals"
        var command: [String: Any] = ["action": action.rawValue, "id": id, "revision": revision]
        if let approvalID { command["approvalId"] = approvalID }
        let data = try JSONSerialization.data(withJSONObject: command)
        _ = try await requestData("api/hub/" + resource, headers: ["x-hub-" + resource: "1"], body: data, maxBytes: 8_388_608)
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

    public func saveKnowledgeNote(_ note: HubKnowledgeNote, content: String) async throws -> HubKnowledgeNote {
        guard !note.id.isEmpty, note.id.utf8.count <= 1_024, note.kind != "conversation", note.protected != true,
              let hash = note.hash, Self.isScreenshotID(hash) else { throw HubAttachmentError.invalidResponse }
        let body = try JSONSerialization.data(withJSONObject: [
            "action": "save-note", "id": note.id, "hash": hash, "content": content,
        ])
        guard body.count <= 200_000 else { throw HubAttachmentError.tooLarge }
        let data = try await requestData("api/hub/memory", headers: ["x-hub-memory": "1"], body: body)
        let saved = try JSONDecoder().decode(HubKnowledgeNote.self, from: data)
        guard saved.id == note.id else { throw HubAttachmentError.invalidResponse }
        return saved
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

    public func knowledgeStatus() async throws -> HubKnowledgeStatus {
        let data = try await requestData("api/hub/memory", headers: ["x-hub-memory": "1"])
        return try JSONDecoder().decode(HubKnowledgeStatus.self, from: data)
    }

    public func knowledgeDomains() async throws -> HubKnowledgeDomains {
        let data = try await requestData("api/hub/memory", headers: ["x-hub-memory": "1"], query: [
            URLQueryItem(name: "view", value: "domains"),
        ], maxBytes: 12_000_000)
        let value = try JSONDecoder().decode(HubKnowledgeDomains.self, from: data)
        guard value.revision >= 0, Set(value.domains.map(\.id)).count == value.domains.count,
              Set(value.nodes.map(\.id)).count == value.nodes.count else { throw HubAttachmentError.invalidResponse }
        return value
    }

    public func changeKnowledgeDomains(_ changes: [HubKnowledgeDomains.Change], revision: Int) async throws {
        let operations = changes.flatMap(\.operations)
        guard revision >= 0, !operations.isEmpty else { throw HubAttachmentError.invalidResponse }
        let command: [String: Any] = ["action": "domains", "revision": revision, "operations": operations]
        let body = try JSONSerialization.data(withJSONObject: command)
        guard body.count <= 200_000 else { throw HubAttachmentError.invalidResponse }
        _ = try await requestData("api/hub/memory", headers: ["x-hub-memory": "1"], body: body, maxBytes: 12_000_000)
    }

    public func saveKnowledgeSettings(_ settings: HubKnowledgeSettings) async throws -> HubKnowledgeStatus {
        struct Command: Encodable { let action = "settings"; let settings: HubKnowledgeSettings }
        let data = try await requestData("api/hub/memory", headers: ["x-hub-memory": "1"],
                                         body: JSONEncoder().encode(Command(settings: settings)))
        return try JSONDecoder().decode(HubKnowledgeStatus.self, from: data)
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

    public func removePlannerItem(_ item: HubHomePlanner.Item) async throws -> HubHomePlanner {
        guard UUID(uuidString: item.id) != nil, !item.deleted, let version = item.version, version >= 0 else {
            throw HubAttachmentError.invalidResponse
        }
        return try await changePlanner(["action": "remove", "id": item.id, "version": version])
    }

    public func savePlannerItem(_ draft: HubPlannerDraft) async throws -> HubHomePlanner {
        let title = draft.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard UUID(uuidString: draft.id) != nil, draft.version >= 0, !title.isEmpty, title.utf16.count <= 180,
              draft.details.utf16.count <= 4_000, let zone = TimeZone(identifier: draft.timeZone),
              draft.kind != .event || draft.date != nil || draft.start != nil else {
            throw HubAttachmentError.invalidResponse
        }
        if let end = draft.end {
            guard let start = draft.start, end > start else { throw HubAttachmentError.invalidResponse }
        }
        var value: [String: Any] = ["id": draft.id, "version": draft.version, "kind": draft.kind.rawValue,
                                    "title": title, "details": draft.details, "horizon": draft.horizon.rawValue, "timeZone": zone.identifier]
        let formatter = ISO8601DateFormatter()
        if let start = draft.start {
            value["start"] = formatter.string(from: start)
            if let end = draft.end { value["end"] = formatter.string(from: end) }
        } else if let date = draft.date {
            let dateOnly = DateFormatter()
            dateOnly.calendar = Calendar(identifier: .gregorian)
            dateOnly.locale = Locale(identifier: "en_US_POSIX")
            dateOnly.timeZone = zone
            dateOnly.dateFormat = "yyyy-MM-dd"
            value["date"] = dateOnly.string(from: date)
        }
        return try await changePlanner(["action": "save", "item": value])
    }

    private func changePlanner(_ command: [String: Any]) async throws -> HubHomePlanner {
        let body = try JSONSerialization.data(withJSONObject: command)
        let data = try await requestData("api/hub/planner", headers: ["x-hub-planner": "1"], body: body)
        return try JSONDecoder().decode(HubHomePlanner.self, from: data)
    }

    public func sendNewChat(_ draft: String) async throws -> String {
        _ = try promptText(draft)
        let sessionID = try await createChat()
        try Task.checkCancellation()
        try await sendChat(draft, sessionID: sessionID)
        return sessionID
    }

    public func createChat(workspaceID: String? = nil) async throws -> String {
        let sessionID = "session-" + UUID().uuidString.lowercased()
        var request = ["sessionId": sessionID]
        if let workspaceID {
            guard HubVoiceAPI.validID(workspaceID) else { throw HubChatSendError.rejected }
            request["workspaceId"] = workspaceID
        }
        let created = try await rpc("session/create", request: request)
        guard created["sessionId"] as? String == sessionID else { throw HubChatSendError.rejected }
        return sessionID
    }

    public func chatModels() async throws -> HubChatModels {
        let response = try await rpc("session/modelCatalog", arguments: [:], maxBytes: 8_388_608)
        return try JSONDecoder().decode(HubChatModels.self, from: JSONSerialization.data(withJSONObject: response))
    }

    public func selectChatModel(sessionID: String, provider: String, model: String, effort: String?) async throws -> HubChatModelSelection {
        guard HubVoiceAPI.validID(sessionID), !provider.isEmpty, provider.utf8.count <= 200,
              !model.isEmpty, model.utf8.count <= 512, (effort?.utf8.count ?? 0) <= 200 else { throw HubChatSendError.rejected }
        var request = ["sessionId": sessionID, "provider": provider, "model": model]
        if let effort, !effort.isEmpty { request["reasoningEffort"] = effort }
        let response = try await rpc("session/selectModel", request: request)
        guard let selected = response["selected"] as? [String: Any] else { throw HubAttachmentError.invalidResponse }
        return try JSONDecoder().decode(HubChatModelSelection.self, from: JSONSerialization.data(withJSONObject: selected))
    }

    public func renameChat(sessionID: String, title: String) async throws -> String {
        let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard HubVoiceAPI.validID(sessionID), !name.isEmpty, name.utf8.count <= 960 else { throw HubChatSendError.rejected }
        let response = try await rpc("session/rename", request: ["sessionId": sessionID, "title": name])
        guard let saved = response["title"] as? String, !saved.isEmpty else { throw HubAttachmentError.invalidResponse }
        return saved
    }

    public func branchChat(sessionID: String, at sequence: Int) async throws -> String {
        guard HubVoiceAPI.validID(sessionID), (0...9_007_199_254_740_991).contains(sequence) else {
            throw HubChatSendError.rejected
        }
        let result = try await rpc("session/fork", request: ["sessionId": sessionID, "atSeq": sequence])
        guard let branch = result["sessionId"] as? String, HubVoiceAPI.validID(branch), branch != sessionID else {
            throw HubAttachmentError.invalidResponse
        }
        return branch
    }

    private func promptText(_ draft: String) throws -> String {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.utf8.count <= 32_768 else { throw HubChatSendError.invalidDraft }
        return text
    }

    public func chatCommands(sessionID: String) async throws -> [HubChatCommand] {
        guard HubVoiceAPI.validID(sessionID),
              let value = try await rpcValue("commands/list", arguments: ["agentId": sessionID], maxBytes: 524_288) as? [Any] else {
            throw HubAttachmentError.invalidResponse
        }
        return try JSONDecoder().decode([HubChatCommand].self, from: JSONSerialization.data(withJSONObject: value))
    }

    public func chatSkills(sessionID: String) async throws -> [HubChatSkill] {
        struct Catalog: Decodable { let skills: [HubChatSkill] }
        guard HubVoiceAPI.validID(sessionID) else { throw HubAttachmentError.invalidResponse }
        let value = try await rpc("skills/list", request: ["sessionId": sessionID], maxBytes: 524_288)
        return try JSONDecoder().decode(Catalog.self, from: JSONSerialization.data(withJSONObject: value)).skills
    }

    public func runChatCommand(_ line: String, sessionID: String, photos: [HubChatPhoto]) async throws -> HubChatCommandReceipt? {
        guard HubVoiceAPI.validID(sessionID), HubChatCommand.leadingName(in: line) != nil,
              line.utf8.count <= 32_768, photos.count <= 8,
              photos.allSatisfy(Self.validChatPhoto) else { throw HubChatSendError.invalidDraft }
        let images = photos.map { ["mediaType": $0.mediaType, "name": $0.name, "data": $0.data.base64EncodedString()] }
        do {
            let value = try await rpcValue("commands/execute", arguments: ["agentId": sessionID, "line": line, "images": images],
                                           maxBytes: 524_288)
            if value == nil || value is NSNull { return nil }
            guard let receipt = value as? [String: Any] else { throw HubAttachmentError.invalidResponse }
            return try JSONDecoder().decode(HubChatCommandReceipt.self, from: JSONSerialization.data(withJSONObject: receipt))
        } catch HubChatSendError.signInRequired {
            throw HubChatSendError.signInRequired
        } catch {
            throw HubChatSendError.unknownDelivery(sessionID: sessionID)
        }
    }

    private static func validChatPhoto(_ photo: HubChatPhoto) -> Bool {
        ["image/png", "image/jpeg", "image/webp", "image/gif"].contains(photo.mediaType) &&
            !photo.data.isEmpty && photo.data.count <= 20 * 1_024 * 1_024 && photo.name.utf8.count <= 240
    }

    public func sendChat(_ draft: String, sessionID: String, files: [String] = [], photos: [HubChatPhoto] = [],
                         delivery: HubChatPreferences.Delivery = .queue) async throws {
        guard HubVoiceAPI.validID(sessionID) else { throw HubChatSendError.rejected }
        let input = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard input.utf8.count <= 32_768, !input.isEmpty || !files.isEmpty || !photos.isEmpty,
              files.count + photos.count <= 8, files.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 262_144 }),
              photos.allSatisfy(Self.validChatPhoto) else { throw HubChatSendError.invalidDraft }
        let text = ([input].filter { !$0.isEmpty } + files).joined(separator: "\n\n")
        var content = text.isEmpty ? [] : [["type": "text", "text": text]]
        content.append(contentsOf: photos.map {
            ["type": "image", "mediaType": $0.mediaType, "name": $0.name, "data": $0.data.base64EncodedString()]
        })
        do {
            let receipt = try await rpc("session/prompt", request: [
                "requestId": UUID().uuidString.lowercased(),
                "sessionId": sessionID,
                "mode": delivery.rawValue,
                "content": content,
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

    public func updateChatQueue(sessionID: String, item: HubQueuedChatMessage, action: HubChatQueueAction) async throws {
        guard HubVoiceAPI.validID(sessionID), !item.id.isEmpty, item.id.utf8.count <= 512,
              item.placement != .context else { throw HubChatSendError.invalidDraft }
        let operation: [String: Any]
        switch action {
        case .edit(let text):
            guard item.canEdit, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  text.utf8.count <= 32_768 else { throw HubChatSendError.invalidDraft }
            operation = ["kind": "edit", "content": [["type": "text", "text": text]]]
        case .remove:
            operation = ["kind": "remove"]
        case .steer:
            guard item.placement == .queued else { throw HubChatSendError.invalidDraft }
            operation = ["kind": "steer"]
        }
        let receipt = try await rpc("session/updateQueue", request: ["sessionId": sessionID, "itemId": item.id, "action": operation])
        guard receipt["accepted"] as? Bool == true else { throw HubAttachmentError.invalidResponse }
    }

    public func chatScreenshots(sessionID: String) async throws -> [HubChatScreenshot] {
        try await chatArtifacts(sessionID: sessionID).screenshots
    }

    public func chatArtifacts(sessionID: String) async throws -> HubChatArtifacts {
        guard HubVoiceAPI.validID(sessionID) else { throw HubAttachmentError.invalidResponse }
        let data = try await requestData("api/hub/artifacts", headers: ["x-hub-daily-use": "1", "x-hub-session": sessionID])
        let catalog = try JSONDecoder().decode(HubChatArtifacts.self, from: data)
        guard catalog.screenshots.allSatisfy({ Self.isScreenshotID($0.id) }),
              Set(catalog.screenshots.map(\.id)).count == catalog.screenshots.count,
              catalog.artifacts?.allSatisfy({ Self.isScreenshotID($0.id) }) != false else {
            throw HubAttachmentError.invalidResponse
        }
        return catalog
    }

    public func chatAppDocument(sessionID: String, id: String) async throws -> HubConversationAppDocument {
        guard HubVoiceAPI.validID(sessionID), Self.isScreenshotID(id) else { throw HubAttachmentError.invalidResponse }
        let data = try await requestData("api/hub/artifacts", headers: [
            "x-hub-daily-use": "1", "x-hub-session": sessionID, "x-hub-artifact": id,
        ], maxBytes: 10_000_000)
        let document = try JSONDecoder().decode(HubConversationAppDocument.self, from: data)
        guard document.document.hasPrefix("<!doctype html><html><head>"), document.document.utf8.count <= 6_000_000 else {
            throw HubAttachmentError.invalidResponse
        }
        return document
    }

    public func chatPresentation(sessionID: String) async throws -> HubChatPresentation? {
        struct Summary: Decodable {
            let presentation: HubChatPresentation?

            init(from decoder: Decoder) throws {
                let box = try decoder.container(keyedBy: CodingKeys.self)
                guard box.contains(.presentation) else { throw HubAttachmentError.invalidResponse }
                presentation = try box.decodeIfPresent(HubChatPresentation.self, forKey: .presentation)
            }

            private enum CodingKeys: String, CodingKey { case presentation }
        }
        guard HubVoiceAPI.validID(sessionID) else { throw HubAttachmentError.invalidResponse }
        let data = try await requestData("api/hub/presentation", headers: ["x-hub-session": sessionID], maxBytes: 4_096)
        let result = try JSONDecoder().decode(Summary.self, from: data).presentation
        guard result?.isValid != false else { throw HubAttachmentError.invalidResponse }
        return result
    }

    public func chatPresentationDocument(sessionID: String, id: UUID) async throws -> String {
        struct Document: Decodable { let document: String }
        guard HubVoiceAPI.validID(sessionID) else { throw HubAttachmentError.invalidResponse }
        let data = try await requestData("api/hub/presentation-document", headers: [
            "x-hub-session": sessionID, "x-hub-presentation": id.uuidString.lowercased(),
        ], maxBytes: 10_000_000)
        let document = try JSONDecoder().decode(Document.self, from: data).document
        guard document.hasPrefix("<!doctype html><html><head>"), document.utf16.count <= 3_000_000 else {
            throw HubAttachmentError.invalidResponse
        }
        return document
    }

    public func browserTabs() async throws -> [HubBrowserTab] {
        let body = Data(#"{"type":"list"}"#.utf8)
        let data = try await requestData("api/hub/browser-view", headers: ["x-hub-browser-view": "1"],
                                         body: body, maxBytes: 5_000_000)
        let tabs = try JSONDecoder().decode([HubBrowserTab].self, from: data)
        guard tabs.count <= 32, tabs.allSatisfy(\.isValid), Set(tabs.map(\.id)).count == tabs.count else {
            throw HubAttachmentError.invalidResponse
        }
        return tabs
    }

    public func browserFrame(for tab: HubBrowserTab) async throws -> HubBrowserFrame {
        struct Frame: Decodable {
            let tab: HubBrowserTab
            let capturedAt: Int64
            let width: Int
            let height: Int
            let mimeType: String
            let data: String
        }
        guard tab.isValid else { throw HubAttachmentError.invalidResponse }
        let body = try JSONEncoder().encode([
            "type": "frame", "sessionId": tab.sessionId, "ownerSessionId": tab.ownerSessionId,
        ])
        let data = try await requestData("api/hub/browser-view", headers: ["x-hub-browser-view": "1"],
                                         body: body, maxBytes: 3_300_000)
        let frame = try JSONDecoder().decode(Frame.self, from: data)
        guard frame.tab.isValid, frame.tab.id == tab.id, frame.mimeType == "image/jpeg",
              (0...9_007_199_254_740_991).contains(frame.capturedAt), (1...1_024).contains(frame.width),
              (1...4_096).contains(frame.height), frame.data.utf8.count <= 3_000_000,
              let jpeg = Data(base64Encoded: frame.data), jpeg.starts(with: [0xff, 0xd8, 0xff]) else {
            throw HubAttachmentError.invalidResponse
        }
        return HubBrowserFrame(tab: frame.tab, width: frame.width, height: frame.height, jpeg: jpeg)
    }

    public func chatPreferences() async throws -> HubChatPreferences {
        let description = try await rpc("settings/describe", arguments: [:], maxBytes: 4_194_304)
        guard let namespaces = description["namespaces"] as? [[String: Any]],
              let writable = description["writable"] as? Bool else { throw HubAttachmentError.invalidResponse }
        var fields: [String: [String: Any]] = [:]
        var revisions: [String: Int] = [:]
        for item in namespaces {
            guard let name = item["ns"] as? String, ["ui-theme", "ui-conversation", "ui-chat"].contains(name),
                  let value = item["value"] as? [String: Any], let revision = item["revision"] as? Int, revision >= 0 else { continue }
            guard revisions[name] == nil else { throw HubAttachmentError.invalidResponse }
            fields[name] = value
            revisions[name] = revision
        }
        guard let size = fields["ui-theme"]?["fontSize"] as? Int, (12...17).contains(size),
              let enter = fields["ui-conversation"]?["busyEnter"] as? String, let delivery = HubChatPreferences.Delivery(rawValue: enter),
              let view = fields["ui-chat"]?["transcriptView"] as? String, let transcript = HubChatPreferences.Transcript(rawValue: view) else {
            throw HubAttachmentError.invalidResponse
        }
        return HubChatPreferences(fontSize: size, busyEnter: delivery, transcript: transcript,
                                  writable: writable, revisions: revisions)
    }

    public func updateChatPreferences(_ change: HubChatPreferences.Change, from preferences: HubChatPreferences) async throws -> HubChatPreferences {
        let field = change.field
        guard preferences.writable, let revision = preferences.revisions[field.namespace] else { throw HubChatSendError.rejected }
        if case .fontSize(let size) = change, !(12...17).contains(size) { throw HubChatSendError.rejected }
        let receipt = try await rpc("settings/update", arguments: [
            "ns": field.namespace, "patch": [field.key: field.value], "expectedRevision": revision,
        ])
        guard receipt["ns"] as? String == field.namespace else { throw HubAttachmentError.invalidResponse }
        return try await chatPreferences()
    }

    public func workspaces() async throws -> [HubWorkspaceItem] {
        struct Baseline: Decodable {
            let type: String
            let value: Value
            struct Value: Decodable { let items: [HubWorkspaceItem] }
        }
        let (socket, streamSession) = try await remoteSocket()
        defer { streamSession.invalidateAndCancel() }
        let streamID = UUID().uuidString.lowercased()
        let frame = try Self.remoteOpen(streamID: streamID, endpoint: "workspace/follow", arguments: [:])
        let deadline = Task {
            try await Task.sleep(nanoseconds: 12_000_000_000)
            socket.cancel(with: .goingAway, reason: nil)
        }
        defer { deadline.cancel(); socket.cancel(with: .normalClosure, reason: nil) }
        return try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            socket.resume()
            try await socket.send(.string(frame))
            while !Task.isCancelled {
                guard case .string(let text) = try await socket.receive(),
                      let envelope = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else {
                    throw HubAttachmentError.invalidResponse
                }
                guard envelope["streamId"] as? String == streamID else { continue }
                guard envelope["type"] as? String == "item", let item = envelope["value"] as? [String: Any] else {
                    throw HubAttachmentError.unavailable
                }
                let baseline = try JSONDecoder().decode(Baseline.self, from: JSONSerialization.data(withJSONObject: item))
                let workspaces = baseline.value.items
                guard baseline.type == "baseline", workspaces.allSatisfy(\.isValid),
                      Set(workspaces.map(\.id)).count == workspaces.count else { throw HubAttachmentError.invalidResponse }
                return workspaces
            }
            throw CancellationError()
        }, onCancel: { socket.cancel(with: .goingAway, reason: nil) })
    }

    public func workspaceDirectory(_ path: String?) async throws -> HubWorkspaceDirectory {
        let arguments: [String: Any]
        if let path { arguments = ["path": path] } else { arguments = [:] }
        let value = try await rpc("directoryPicker/list", arguments: arguments, maxBytes: 4_194_304)
        return try JSONDecoder().decode(HubWorkspaceDirectory.self, from: JSONSerialization.data(withJSONObject: value))
    }

    public func workspaceChatTitles() async throws -> [String: HubConversationChoice] {
        struct Catalog: Decodable {
            let items: [Item]
            struct Item: Decodable {
                let sessionId: String
                let updatedAt: Double
                let projections: Projection?
                struct Projection: Decodable {
                    let values: Values?
                    struct Values: Decodable { let title: String? }
                }
            }
        }
        let result = try await rpc("session/list", request: [:], maxBytes: 8_388_608)
        let catalog = try JSONDecoder().decode(Catalog.self, from: JSONSerialization.data(withJSONObject: result))
        return catalog.items.reduce(into: [:]) { byID, item in
            guard HubVoiceAPI.validID(item.sessionId), item.updatedAt.isFinite, item.updatedAt >= 0 else { return }
            let title = item.projections?.values?.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            byID[item.sessionId] = HubConversationChoice(sessionId: item.sessionId,
                title: title.isEmpty ? "Untitled conversation" : String(title.prefix(240)), updatedAt: item.updatedAt)
        }
    }

    public func createWorkspace(path: String) async throws -> HubWorkspaceItem {
        guard !path.isEmpty, path.utf8.count <= 32_768, !path.contains("\0") else { throw HubChatSendError.rejected }
        let value = try await rpc("workspace/create", request: ["path": path], maxBytes: 4_194_304)
        return try Self.workspaceMutation(value)
    }

    public func renameWorkspace(id: String, title: String) async throws -> HubWorkspaceItem {
        let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard HubVoiceAPI.validID(id), !name.isEmpty, name.utf8.count <= 4_096 else { throw HubChatSendError.rejected }
        let value = try await rpc("workspace/rename", request: ["workspaceId": id, "title": name], maxBytes: 4_194_304)
        let item = try Self.workspaceMutation(value)
        guard item.id == id else { throw HubAttachmentError.invalidResponse }
        return item
    }

    public func removeWorkspace(id: String) async throws {
        guard HubVoiceAPI.validID(id) else { throw HubChatSendError.rejected }
        let value = try await rpc("workspace/delete", request: ["workspaceId": id])
        guard value["deleted"] as? Bool == true else { throw HubAttachmentError.invalidResponse }
    }

    private static func workspaceMutation(_ value: [String: Any]) throws -> HubWorkspaceItem {
        guard let record = value["workspace"] as? [String: Any] else { throw HubAttachmentError.invalidResponse }
        let item = try JSONDecoder().decode(HubWorkspaceItem.self, from: JSONSerialization.data(withJSONObject: record))
        guard item.isValid else { throw HubAttachmentError.invalidResponse }
        return item
    }

    public func chatScreenshot(sessionID: String, id: String) async throws -> Data {
        guard HubVoiceAPI.validID(sessionID), Self.isScreenshotID(id) else { throw HubAttachmentError.invalidResponse }
        return try await requestData("api/hub/artifacts", headers: [
            "x-hub-daily-use": "1", "x-hub-session": sessionID, "x-hub-screenshot": id,
        ], mediaTypes: ["image/png", "image/jpeg", "image/webp"], maxBytes: 8 * 1024 * 1024)
    }

    public func chatPhoto(sessionID: String, photo: HubChatMessage.Photo) async throws -> Data {
        let maxBytes = 20 * 1_024 * 1_024
        guard HubVoiceAPI.validID(sessionID), photo.attachmentId.hasPrefix("sha256:"),
              Self.isScreenshotID(String(photo.attachmentId.dropFirst(7))),
              (1...maxBytes).contains(photo.bytes),
              ["image/png", "image/jpeg", "image/webp", "image/gif"].contains(photo.mediaType) else {
            throw HubAttachmentError.invalidResponse
        }
        let response = try await rpc("session/attachment", request: [
            "sessionId": sessionID, "attachmentId": photo.attachmentId,
        ], maxBytes: maxBytes * 2)
        guard let ref = response["attachment"] as? [String: Any], ref["attachmentId"] as? String == photo.attachmentId,
              ref["mediaType"] as? String == photo.mediaType, ref["bytes"] as? Int == photo.bytes,
              let encoded = response["data"] as? String, let bytes = Data(base64Encoded: encoded),
              bytes.count == photo.bytes else { throw HubAttachmentError.invalidResponse }
        return bytes
    }

    private static func isScreenshotID(_ id: String) -> Bool {
        id.utf8.count == 64 && id.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    private func remoteSocket() async throws -> (URLSessionWebSocketTask, URLSession) {
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
        let socket = streamSession.webSocketTask(with: request)
        socket.maximumMessageSize = 4 * 1_024 * 1_024
        return (socket, streamSession)
    }

    private static func remoteOpen(streamID: String, endpoint: String, arguments: [String: Any]) throws -> String {
        let envelope: [String: Any] = [
            "type": "open", "streamId": streamID, "endpoint": endpoint, "payload": ["args": arguments],
        ]
        return String(decoding: try JSONSerialization.data(withJSONObject: envelope), as: UTF8.self)
    }

    public func followChat(sessionID: String, queue: (@MainActor ([HubQueuedChatMessage]?) -> Void)? = nil,
                           update: @MainActor (HubChatSnapshot) async -> Void) async throws {
        guard HubVoiceAPI.validID(sessionID) else { throw HubChatSendError.rejected }
        let (socket, streamSession) = try await remoteSocket()
        defer { streamSession.invalidateAndCancel() }
        let streamID = UUID().uuidString.lowercased()
        let controlID = UUID().uuidString.lowercased()
        let message = try Self.remoteOpen(streamID: streamID, endpoint: "session/follow", arguments: [
            "request": ["address": ["kind": "session", "sessionId": sessionID], "maxMessages": 40],
        ])
        let deadline = Task {
            try await Task.sleep(nanoseconds: 12_000_000_000)
            socket.cancel(with: .goingAway, reason: nil)
        }
        defer { deadline.cancel(); socket.cancel(with: .normalClosure, reason: nil) }
        try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            socket.resume()
            try await socket.send(.string(message))
            if queue != nil {
                let control = try Self.remoteOpen(streamID: controlID, endpoint: "session/control", arguments: [:])
                try await socket.send(.string(control))
            }
            var timeline = HubChatTimeline()
            var opened = false
            struct Envelope: Decodable { let streamId: String? }
            let decoder = JSONDecoder()
            while !Task.isCancelled {
                guard case .string(let text) = try await socket.receive() else { throw HubAttachmentError.invalidResponse }
                let data = Data(text.utf8)
                if queue != nil, try decoder.decode(Envelope.self, from: data).streamId == controlID {
                    do {
                        if let change = try Self.chatQueueUpdate(data, sessionID: sessionID) { await queue?(change.items) }
                    } catch {
                        await queue?(nil)
                    }
                    continue
                }
                let frame = try decoder.decode(HubChatStreamFrame.self, from: data)
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

    struct ChatQueueUpdate {
        let items: [HubQueuedChatMessage]?
    }

    static func chatQueueUpdate(_ data: Data, sessionID: String) throws -> ChatQueueUpdate? {
        guard let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw HubAttachmentError.invalidResponse
        }
        if let type = envelope["type"] as? String, type == "error" || type == "end" {
            return ChatQueueUpdate(items: nil)
        }
        guard let frame = envelope["value"] as? [String: Any] else { return nil }
        let records: [Any]
        switch frame["type"] as? String {
        case "baseline":
            guard let value = frame["value"] as? [String: Any], let queues = value["queues"] as? [String: Any] else {
                throw HubAttachmentError.invalidResponse
            }
            if let entry = queues[sessionID] {
                guard let items = entry as? [Any] else { throw HubAttachmentError.invalidResponse }
                records = items
            } else {
                records = []
            }
        case "queue":
            guard frame["sessionId"] as? String == sessionID else { return nil }
            guard let items = frame["items"] as? [Any] else { throw HubAttachmentError.invalidResponse }
            records = items
        default: return nil
        }
        let items = try JSONDecoder().decode([HubQueuedChatMessage].self, from: JSONSerialization.data(withJSONObject: records))
        let visible = items.filter { $0.placement != .context }
        guard Set(visible.map(\.id)).count == visible.count else { throw HubAttachmentError.invalidResponse }
        return ChatQueueUpdate(items: visible)
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
        var timeline = HubChatTimeline()
        for event in events { timeline.apply(event) }
        let snapshot = timeline.snapshot
        return HubChatHistoryPage(messages: snapshot.messages, hasMore: page.hasMore,
                                  firstSequence: events.first?.seq, activity: snapshot.activity, usageByTurn: snapshot.usageByTurn)
    }

    private func rpc(_ method: String, request payload: [String: Any], maxBytes: Int = 65_536) async throws -> [String: Any] {
        try await rpc(method, arguments: ["request": payload], maxBytes: maxBytes)
    }

    private func rpc(_ method: String, arguments: [String: Any], maxBytes: Int = 65_536) async throws -> [String: Any] {
        guard let value = try await rpcValue(method, arguments: arguments, maxBytes: maxBytes) as? [String: Any] else {
            throw HubAttachmentError.invalidResponse
        }
        return value
    }

    private func rpcValue(_ method: String, arguments: [String: Any], maxBytes: Int = 65_536) async throws -> Any? {
        let url = server.origin.appendingPathComponent("api/" + method)
        let rpcID = UUID().uuidString.lowercased()
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.allHTTPHeaderFields = HTTPCookie.requestHeaderFields(with: server.cookies(await cookies(), for: url))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "type": "client-request", "rpcId": rpcID, "method": method,
            "payload": ["args": arguments],
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
        return result["value"]
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
