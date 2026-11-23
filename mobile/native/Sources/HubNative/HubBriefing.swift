import Foundation

/// Home's daily briefing: the latest headlines on the topics the user follows
/// (some added by the assistant), fetched on the PC from news feeds.
public struct HubBriefing: Decodable, Equatable, Sendable {
    public struct Topic: Decodable, Identifiable, Equatable, Hashable, Sendable {
        public let id: String
        public let title: String
        public let by: String
        public let at: Double
        /// Added by the assistant from what the user talks about.
        public var addedByAssistant: Bool { by == "assistant" }
    }

    public struct Item: Decodable, Identifiable, Equatable, Hashable, Sendable {
        public let title: String
        public let source: String
        public let url: String
        public let at: Double
        public var id: String { url + "|" + title }
        public var date: Date? { at > 0 ? Date(timeIntervalSince1970: at / 1000) : nil }
        public var link: URL? { URL(string: url).flatMap { $0.scheme == "https" ? $0 : nil } }
    }

    public struct Section: Decodable, Identifiable, Equatable, Sendable {
        public let topicId: String
        public let title: String
        public let items: [Item]
        public let failed: Bool?
        public var id: String { topicId }
    }

    public struct Edition: Decodable, Equatable, Sendable {
        public let at: Double
        public let sections: [Section]
        public var date: Date { Date(timeIntervalSince1970: at / 1000) }
    }

    public let topics: [Topic]
    public let briefing: Edition?
    public let refreshing: Bool
    public let stale: Bool
}

extension HubConversationAPI {
    private static let briefingHeaders = ["x-hub-briefing": "1"]

    public func briefing() async throws -> HubBriefing {
        let data = try await requestData("api/hub/briefing", headers: Self.briefingHeaders, maxBytes: 2_000_000)
        return try JSONDecoder().decode(HubBriefing.self, from: data)
    }

    private func briefingPost(_ value: [String: Any], timeout: TimeInterval? = nil) async throws -> HubBriefing {
        let data = try await requestData("api/hub/briefing", headers: Self.briefingHeaders,
                                         body: JSONSerialization.data(withJSONObject: value), maxBytes: 2_000_000,
                                         operationTimeout: timeout)
        return try JSONDecoder().decode(HubBriefing.self, from: data)
    }

    public func addBriefingTopic(_ title: String) async throws -> HubBriefing {
        try await briefingPost(["action": "add", "title": title])
    }

    public func removeBriefingTopic(id: String) async throws -> HubBriefing {
        try await briefingPost(["action": "remove", "id": id])
    }

    public func moveBriefingTopic(id: String, to index: Int) async throws -> HubBriefing {
        try await briefingPost(["action": "move", "id": id, "to": index])
    }

    /// Fetches fresh headlines for every topic now (a few seconds).
    public func refreshBriefing() async throws -> HubBriefing {
        try await briefingPost(["action": "refresh"], timeout: 30)
    }
}
