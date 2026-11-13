import Foundation

public struct HubModelCatalog: Decodable {
    public struct Provider: Decodable, Identifiable {
        public let id: String
        public let name: String
    }

    public struct Model: Decodable, Identifiable {
        public struct Pricing: Decodable {
            public let input: Double
            public let output: Double
        }
        public struct Effort: Decodable, Identifiable {
            public let id: String
            public let name: String
        }
        public let provider: String
        public let modelID: String
        public let name: String
        public let description: String?
        public let contextWindow: Int?
        public let maxTokens: Int?
        public let created: Double?
        public let input: [String]
        public let tools: Bool
        public let reasoning: Bool
        public let pricing: Pricing?
        public let efforts: [Effort]?
        public let defaultEffort: String?
        public let supportedParameters: [String]?
        public let available: Bool?
        public let enabled: Bool
        public let favorite: Bool?

        public var id: String { provider + "/" + modelID }

        enum CodingKeys: String, CodingKey {
            case provider, modelID = "id", name, description, contextWindow, maxTokens, created
            case input, tools, reasoning, pricing, efforts, defaultEffort, supportedParameters, available, enabled, favorite
        }
    }

    public let providers: [Provider]
    public let models: [Model]
    public let refreshedAt: String?
    public let stale: Bool
    public let warning: String?
}

public struct HubInstructionCatalog: Decodable {
    public struct File: Decodable, Identifiable {
        public let id: String
        public let name: String
        public let content: String
        public let hash: String?
        public let editable: Bool
        public let scope: String
    }

    public struct Character: Decodable, Identifiable {
        public let id: String
        public let name: String
        public let role: String
        public let instructions: File
    }

    public struct Request: Decodable {
        public let system: String
        public let workspace: [String]
    }

    public let shared: [File]
    public let characters: [Character]
    public let lastRequest: Request?
}
