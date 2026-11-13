import Foundation

public struct HubToolCatalog: Decodable {
    public struct Tool: Decodable, Identifiable {
        public let name: String
        public let description: String
        public let parameters: HubTaskArgument?
        public let hostRegistered: Bool
        public let contexts: Int
        public let characterContexts: [String]
        public var id: String { name }
        public var isRetired: Bool { name.hasPrefix("mcp__hub_memory__") }
        public var isRegistered: Bool { hostRegistered || contexts > 0 }
    }

    public struct Character: Decodable, Identifiable {
        public let id: String
        public let name: String
        public let configured: Bool
        public let policy: HubCharacterSettings.Character.ToolPolicy

        public func allows(_ tool: Tool) -> Bool {
            !tool.isRetired && (policy.mode == "inherit" || policy.names?.contains(tool.name) == true)
        }
    }

    public struct Services: Decodable {
        public struct Browser: Decodable {
            public let ready: Bool
            public let installed: Bool
            public let version: String?
        }
        public let browser: Browser?
    }

    public let tools: [Tool]
    public let characters: [Character]
    public let services: Services?
    public let meaning: String
}

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
        public let outputLimitFallback: Bool?
        public let created: Double?
        public let input: [String]
        public let tools: Bool
        public let reasoning: Bool
        public let pricing: Pricing?
        public let efforts: [Effort]?
        public let defaultEffort: String?
        public let supportedParameters: [String]?
        public let editableParameters: [String]?
        public let available: Bool?
        public let enabled: Bool
        public let favorite: Bool?

        public var id: String { provider + "/" + modelID }
        public var outputLimit: Int {
            outputLimitFallback == true ? min(8192, contextWindow ?? 8192) : (maxTokens ?? contextWindow ?? 1_000_000)
        }

        enum CodingKeys: String, CodingKey {
            case provider, modelID = "id", name, description, contextWindow, maxTokens, outputLimitFallback, created
            case input, tools, reasoning, pricing, efforts, defaultEffort, supportedParameters, editableParameters, available, enabled, favorite
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

public struct HubCharacterSettings: Decodable {
    public struct Tool: Decodable, Identifiable {
        public let name: String
        public let description: String
        public var id: String { name }
    }

    public struct Character: Codable, Identifiable {
        public struct Route: Codable, Equatable {
            public var provider: String
            public var model: String
            public var reasoningEffort: String?
            public var temperature: Double?
            public var maxTokens: Int?

            public init(provider: String, model: String, reasoningEffort: String? = nil,
                        temperature: Double? = nil, maxTokens: Int? = nil) {
                self.provider = provider
                self.model = model
                self.reasoningEffort = reasoningEffort
                self.temperature = temperature
                self.maxTokens = maxTokens
            }
        }

        public struct ToolPolicy: Codable {
            public var mode: String
            public var names: [String]?
            public init(mode: String, names: [String]? = nil) {
                self.mode = mode
                self.names = names
            }
        }

        public struct Speech: Codable {
            public struct Engine: Codable {
                public let engine: String
                public let model: String
                public var voice: String?
                public var language: String?
                public let steps: Int?
                public let turkishVoice: String?
                public var id: String { engine + ":" + model }

                public init(engine: String, model: String, voice: String? = nil, language: String? = nil,
                            steps: Int? = nil, turkishVoice: String? = nil) {
                    self.engine = engine
                    self.model = model
                    self.voice = voice
                    self.language = language
                    self.steps = steps
                    self.turkishVoice = turkishVoice
                }
            }
            public struct Attention: Codable {
                public var idleSeconds: Int
                public var wakePhrases: [String]
                public var contextSeconds: Int
                public init(idleSeconds: Int, wakePhrases: [String], contextSeconds: Int) {
                    self.idleSeconds = idleSeconds
                    self.wakePhrases = wakePhrases
                    self.contextSeconds = contextSeconds
                }
            }
            public var stt: Engine
            public var tts: Engine
            public var attention: Attention?
        }

        public let id: String
        public var name: String
        public var avatar: String
        public var description: String
        public var instructions: String
        public var route: Route?
        public var tools: ToolPolicy
        public var speech: Speech?
        public var delegateTo: String?

        public init(delegateTo: String?) {
            id = UUID().uuidString.lowercased()
            name = ""
            avatar = "mint"
            description = ""
            instructions = ""
            tools = ToolPolicy(mode: "inherit")
            self.delegateTo = delegateTo
        }
    }

    public let revision: Int
    public let mainId: String
    public let voiceId: String
    public let characters: [Character]
    public let tools: [Tool]?
    public let warning: String?
}

public struct HubSpeechSettings: Codable {
    public let revision: Int
    public var speech: HubCharacterSettings.Character.Speech
}

public struct HubSpeechCatalog: Decodable {
    public struct Option: Decodable, Identifiable {
        public let engine: String
        public let model: String
        public let available: Bool
        public let downloadable: Bool?
        public let voices: [String]?
        public let reason: String?
        public var id: String { engine + ":" + model }
    }
    public let stt: [Option]
    public let tts: [Option]
}

public struct HubSpeechDownload: Decodable {
    public let model: String
    public let phase: String
}

public enum HubCharacterRoleAction: String {
    case main, voice, delete
}

public struct HubKnowledgeSettings: Codable, Equatable {
    public var enabled: Bool
    public var provider: String
    public var model: String
    public var reasoningEffort: String
    public var dailyBudget: Double
    public var monthlyBudget: Double
    public var inputPrice: Double
    public var outputPrice: Double
    public var idleSeconds: Int
    public var mode: String
    public var channels: [String]
    public var categories: [String]
    public var detail: String
    public var language: String
    public var assistantEvidence: String
    public var linking: String
    public var maxLinks: Int
    public var duplicatePolicy: String
    public var instructions: String
    public var reflections: Bool?
    public var profileSuggestions: Bool?
    public var extractMemories: Bool?
}

public struct HubKnowledgeStatus: Decodable {
    public let enabled: Bool
    public let status: String
    public let settings: HubKnowledgeSettings
    public let todayEstimatedCost: Double
    public let monthEstimatedCost: Double?
    public let counts: [String: Int]
    public let notes: Int
    public let embedding: String
}

public struct HubTelegramStatus: Decodable {
    public struct Pairing: Decodable {
        public let requestId: String
        public let code: String
        public let senderLabel: String
        public let expiresAt: Double?
    }
    public let state: String
    public let accountLabel: String?
    public let issue: String?
    public let request: Pairing?
}
