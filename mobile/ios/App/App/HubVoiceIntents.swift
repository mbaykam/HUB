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

/// Holds a message spoken to Siri until HUB is connected and can send it.
@MainActor
final class HubSiriInbox {
    static let shared = HubSiriInbox()
    static let arrived = Notification.Name("HubSiriInboxArrived")
    private(set) var pending: String?

    func submit(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        pending = String(trimmed.prefix(4_000))
        NotificationCenter.default.post(name: Self.arrived, object: nil)
    }

    func take() -> String? {
        defer { pending = nil }
        return pending
    }
}

@available(iOS 18.0, *)
struct AskHUBIntent: AppIntent {
    static var title: LocalizedStringResource = "Ask HUB"
    static var description = IntentDescription("Send a message to your main HUB assistant and open the conversation.")
    static var openAppWhenRun = true
    @Parameter(title: "Message", requestValueDialog: "What should I ask HUB?")
    var message: String
    @MainActor
    func perform() async throws -> some IntentResult {
        HubSiriInbox.shared.submit(message)
        return .result()
    }
}
@available(iOS 18.0, *)
struct HUBVoiceShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: StartHUBVoiceIntent(), phrases: ["Talk to \(.applicationName)", "Start voice in \(.applicationName)"], shortTitle: "Talk to HUB", systemImageName: "waveform")
        AppShortcut(intent: AskHUBIntent(), phrases: ["Ask \(.applicationName)", "Message \(.applicationName)", "Send a message to \(.applicationName)"], shortTitle: "Ask HUB", systemImageName: "bubble.left.and.text.bubble.right")
        AppShortcut(intent: EndHUBVoiceIntent(), phrases: ["End voice in \(.applicationName)"], shortTitle: "End HUB voice", systemImageName: "stop.circle")
        AppShortcut(intent: HubNewNoteIntent(), phrases: ["New note in \(.applicationName)", "Take a note in \(.applicationName)"], shortTitle: "New Note", systemImageName: "square.and.pencil")
        AppShortcut(intent: HubOpenNotesIntent(), phrases: ["Open my notes in \(.applicationName)", "Show notes in \(.applicationName)"], shortTitle: "Notes", systemImageName: "note.text")
    }
}
