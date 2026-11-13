import Foundation

public struct HubResearchCatalog: Decodable {
    public struct Researcher: Decodable, Identifiable {
        public let id: String
        public let name: String
        public let model: String?
    }
    public struct Limit: Decodable {
        public let rounds: Int
        public let minutes: Int
        public let reads: Int
    }
    public let jobs: [HubResearchJob]
    public let characters: [Researcher]
    public let automaticId: String?
    public let limits: [String: Limit]
}

public struct HubResearchJob: Decodable, Identifiable {
    public struct Ledger: Decodable {
        public struct Observation: Decodable, Identifiable {
            public let id: String
            public let title: String
            public let url: String?
            public let text: String
        }
        public struct Failure: Decodable { public let message: String }
        public struct Report: Decodable {
            public struct Claim: Decodable {
                public struct Citation: Decodable { public let sourceId: String }
                public let text: String
                public let uncertain: Bool?
                public let citations: [Citation]
            }
            public let markdown: String
            public let claims: [Claim]
            public let limitations: [String]
            public let conflicts: [String]
        }
        public let observations: [Observation]
        public let failures: [Failure]
        public let report: Report?
    }
    public let id: String
    public let title: String
    public let state: String
    public let status: String
    public let reason: String?
    public let revision: Int
    public let rounds: Int
    public let checkpoint: String?
    public let sessionId: String?
    public let ledger: Ledger?
}

public struct HubResearchDraft: Equatable {
    public enum Depth: String, CaseIterable { case quick, standard, deep }
    public enum Sources: String, CaseIterable {
        case web
        case webAndKnowledge = "web+knowledge"
    }
    public enum Freshness: String, CaseIterable { case current, year, any }

    public var question: String
    public var depth = Depth.standard
    public var sources = Sources.web
    public var freshness = Freshness.current
    public var characterID = "auto"

    public init(question: String) { self.question = question }
}

public enum HubResearchAction: String {
    case pause, resume, stop
    case resumeCredit = "resume-credit"
}
