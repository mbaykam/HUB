import ActivityKit
import Foundation

@available(iOS 18.0, *)
@MainActor
final class HubVoiceActivity {
    enum ActivityError: Error { case disabled, ended }
    private var activity: Activity<HubVoiceActivityAttributes>?
    private var previous: HubVoiceActivityAttributes.ContentState?
    private var lifetime: Task<Void, Never>?
    private var recreationBlocked = false
    var systemEnded: (() -> Void)?
    func prepareForNewSession() { end(); recreationBlocked = false }
    func requireOngoing() throws {
        guard let activity, activity.activityState == .active || activity.activityState == .stale else { throw ActivityError.ended }
    }
    func begin(userInitiated: Bool = false) throws {
        if userInitiated { recreationBlocked = false }
        guard activity == nil else { return }
        guard !recreationBlocked else { throw ActivityError.ended }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { throw ActivityError.disabled }
        let state = HubVoiceActivityAttributes.ContentState(phase: "Connecting", muted: false)
        activity = try Activity.request(attributes: HubVoiceActivityAttributes(voiceID: UUID()), content: ActivityContent(state: state, staleDate: nil), pushType: nil)
        previous = state
        if let current = activity {
            lifetime = Task { [weak self] in
                for await phase in current.activityStateUpdates {
                    guard !Task.isCancelled else { return }
                    if phase == .ended || phase == .dismissed {
                        guard let self, self.activity?.id == current.id else { return }
                        self.activity = nil; self.previous = nil; self.recreationBlocked = true
                        self.systemEnded?()
                        return
                    }
                }
            }
        }
    }
    func update(_ voice: HubNativeVoice) {
        guard let activity else { return }
        let text = voice.status
        let phase = voice.listeningInBackground ? "Background listening" : text == "Speaking" || text == "Listening" ? text :
            text.hasPrefix("Thinking") ? "Thinking" :
            text.hasPrefix("Ending") ? "Ending" :
            text.hasPrefix("Connecting") || text.hasPrefix("Recovering") || text.hasPrefix("Allow microphone") ? "Connecting" : "Check HUB"
        let state = HubVoiceActivityAttributes.ContentState(phase: phase, muted: voice.muted)
        guard state != previous else { return }
        previous = state
        Task { await activity.update(ActivityContent(state: state, staleDate: nil)) }
    }
    func end() {
        lifetime?.cancel(); lifetime = nil
        guard let current = activity else { return }
        activity = nil; previous = nil
        Task { await current.end(nil, dismissalPolicy: .immediate) }
    }
}
