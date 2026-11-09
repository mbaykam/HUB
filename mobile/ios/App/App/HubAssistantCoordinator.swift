import UIKit
import AVFAudio
import HubNative

/// Shared by native UI and system intents, never exposed to web content.
@MainActor
final class HubAssistantCoordinator {
    static let shared = HubAssistantCoordinator()
    private(set) var voice: HubNativeVoice?
    private var activityBox: AnyObject?
    private var systemRecording = false
    enum ActionError: Error { case signIn, microphone, unavailable }

    func adopt(_ value: HubNativeVoice?, systemStart: Bool = false) {
        if voice !== value, #available(iOS 18.0, *) { activity().prepareForNewSession() }
        voice = value
        systemRecording = systemStart
        value?.lifecycleChanged = { [weak self, weak value] in
            guard let self, let value, self.voice === value else { return }
            if #available(iOS 18.0, *) {
                if value.isActive { try? self.activity().begin(); self.activity().update(value) }
                else { self.activity().end() }
            }
        }
    }
    @available(iOS 18.0, *)
    private func activity() -> HubVoiceActivity {
        if let value = activityBox as? HubVoiceActivity { return value }
        let value = HubVoiceActivity()
        value.systemEnded = { [weak self] in
            guard let self, self.systemRecording else { return }
            self.voice?.end()
        }
        activityBox = value; return value
    }
    private func connection() throws -> (HubServer, HubDeviceState, HubVoiceAPI) {
        guard let address = UserDefaults.standard.string(forKey: HubClientConfiguration.serverPreferenceKey),
              let server = try? HubServer(address: address) else { throw ActionError.signIn }
        let state = HubDeviceState(server: server, store: HubKeychainStore())
        guard let cookies = try? state.cookies(), !cookies.isEmpty else { throw ActionError.signIn }
        return (server, state, HubVoiceAPI(server: server) { (try? state.cookies()) ?? [] })
    }
    @available(iOS 18.0, *)
    func startFromSystem() async throws {
        guard AVAudioSession.sharedInstance().recordPermission == .granted else { throw ActionError.microphone }
        // AudioRecordingIntent requires an ongoing Live Activity. Do not silently
        // start recording when that visible system surface is disabled.
        if let voice, voice.isActive {
            try activity().begin(userInitiated: true); systemRecording = true
            activity().update(voice); return
        }
        do {
            let (server, state, api) = try connection()
            let model = HubNativeVoice(api: api, server: server, deviceState: state, resume: try? state.voice(), pendingAdmission: try? state.admission())
            adopt(model, systemStart: true)
            try activity().begin(userInitiated: true)
            model.start()
            guard await model.waitForStartup() else { throw ActionError.unavailable }
        } catch { activity().end(); throw error }
    }
    func endFromSystem() async throws -> Bool {
        if let voice, voice.isActive { voice.end(); return true }
        let (_, state, api) = try connection()
        defer { api.invalidate() }
        var stopped = false
        if let saved = try state.voice() {
            let status = try await api.status()
            if let active = status.activeCall, active.callId == saved.lease.callId, active.sessionId == saved.lease.sessionId {
                try await api.close(callId: saved.lease.callId)
                stopped = true
            }
        }
        if #available(iOS 18.0, *) { activity().end() }
        return stopped
    }
}
