import AppIntents

@available(iOS 18.0, *)
struct StartHUBVoiceIntent: AudioRecordingIntent {
    static var title: LocalizedStringResource = "Talk to HUB"
    static var description = IntentDescription("Start the configured voice assistant. Connect and allow the microphone in HUB first.")
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed
    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        do {
            try await HubAssistantCoordinator.shared.startFromSystem()
            return .result(dialog: "Your HUB voice assistant is connecting. You can continue speaking when it is ready.")
        } catch HubAssistantCoordinator.ActionError.microphone {
            return .result(dialog: "Open HUB and start Voice once to allow microphone access, then try again.")
        } catch HubAssistantCoordinator.ActionError.signIn {
            return .result(dialog: "Unlock your iPhone, open HUB and connect before trying again.")
        } catch HubVoiceActivity.ActivityError.disabled {
            return .result(dialog: "Enable Live Activities for HUB in iPhone Settings to start voice through Siri.")
        } catch {
            return .result(dialog: "HUB could not start voice. Open the app to check the connection or recover interrupted startup.")
        }
    }
}

@available(iOS 18.0, *)
struct EndHUBVoiceIntent: AudioRecordingIntent {
    static var title: LocalizedStringResource = "End HUB voice"
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed
    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        do {
            if try await HubAssistantCoordinator.shared.endFromSystem() {
                return .result(dialog: "HUB is stopping this iPhone’s voice conversation.")
            }
            return .result(dialog: "There is no active HUB voice conversation owned by this iPhone.")
        } catch {
            return .result(dialog: "Open HUB to check the voice conversation. Another device’s call has not been changed.")
        }
    }
}

@available(iOS 18.0, *)
struct HUBVoiceShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: StartHUBVoiceIntent(), phrases: ["Talk to \(.applicationName)", "Start voice in \(.applicationName)"], shortTitle: "Talk to HUB", systemImageName: "waveform")
        AppShortcut(intent: EndHUBVoiceIntent(), phrases: ["End voice in \(.applicationName)"], shortTitle: "End HUB voice", systemImageName: "stop.circle")
    }
}
