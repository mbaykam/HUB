import Foundation

/// Additional helper metadata is optional so old hosts remain readable.
public struct HubHelperTransparency: Decodable, Equatable {
    public struct Routing: Decodable, Equatable {
        public let preset: String
        public let provider: String
        public let model: String
        public let billingBasis: String
        public let reason: String
        public let taskKind: String?
    }
    public struct ActualRoute: Decodable, Equatable {
        public let provider: String
        public let model: String
        public let billingBasis: String
        public let evidence: String
    }
    public struct RouteChange: Decodable, Equatable {
        public let provider: String
        public let model: String
        public let billingBasis: String
        public let at: Double
    }
    public struct Entry: Decodable, Equatable {
        public let kind: String
        public let title: String?
        public let detail: String?
        public let result: String?
        public let status: String?
        public let failed: Bool?
        public let text: String?
        public let at: Double
    }
    public let sessionId: String
    public let title: String
    public let brief: String
    public let running: Bool
    public let outcome: String
    public let currentOperation: String?
    public let findings: String?
    public let result: String?
    public let blocker: String?
    public let routing: Routing?
    public let actualRoute: ActualRoute?
    public let routeChanges: [RouteChange]?
    public let entries: [Entry]

    public var statusLabel: String {
        switch outcome {
        case "running": return "Working"
        case "waiting": return "Waiting"
        case "retrying": return "Retrying"
        case "done": return "Completed"
        case "stopped": return "Stopped"
        case "failed": return "Failed"
        default: return "Status unknown"
        }
    }
    public static func billingLabel(_ basis: String?) -> String {
        switch basis {
        case "subscription": return "Subscription"
        case "api": return "Metered API"
        default: return "Billing unknown"
        }
    }
}

extension HubConversationAPI {
    public func helperTransparency(sessionID: String) async throws -> HubHelperTransparency {
        guard HubVoiceAPI.validID(sessionID) else { throw HubAttachmentError.invalidResponse }
        let data = try await requestData("api/hub/helper", headers: ["x-hub-daily-use": "1", "x-hub-session": sessionID])
        return try JSONDecoder().decode(HubHelperTransparency.self, from: data)
    }
}
