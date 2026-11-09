import Foundation
import ActivityKit

@available(iOS 16.2, *)
struct HubVoiceActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var phase: String
        var muted: Bool
    }
    var voiceID: UUID
}
