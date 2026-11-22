import Foundation
#if canImport(AppIntents)
import AppIntents
#endif

/// One-tap ways into HUB from outside the app: Home Screen and Lock Screen
/// widgets, Control Center and Lock Screen controls, Siri and Shortcuts.
/// Built into the app and the widget extension.
enum HubQuickAction: String, CaseIterable {
    case newNote = "notes/new"
    case notes = "notes"
    case voice = "voice"
    case newChat = "chat/new"

    static let scheme = "mbhub"
    var url: URL { URL(string: "\(Self.scheme)://\(rawValue)")! }

    init?(url: URL) {
        guard url.scheme == Self.scheme else { return nil }
        let path = ([url.host ?? ""] + url.pathComponents.filter { $0 != "/" }).filter { !$0.isEmpty }.joined(separator: "/")
        self.init(rawValue: path)
    }

    var title: String {
        switch self {
        case .newNote: return String(localized: "New Note")
        case .notes: return String(localized: "Notes")
        case .voice: return String(localized: "Voice Chat")
        case .newChat: return String(localized: "New Chat")
        }
    }

    var symbol: String {
        switch self {
        case .newNote: return "square.and.pencil"
        case .notes: return "note.text"
        case .voice: return "waveform"
        case .newChat: return "bubble.left.and.text.bubble.right"
        }
    }
}

/// Hands an action to the running app; the app takes it when it is ready.
@MainActor
enum HubQuickActions {
    static let arrived = Notification.Name("HubQuickActionArrived")
    private(set) static var pending: HubQuickAction?

    static func request(_ action: HubQuickAction) {
        pending = action
        NotificationCenter.default.post(name: arrived, object: nil)
    }

    static func take() -> HubQuickAction? {
        defer { pending = nil }
        return pending
    }
}

#if canImport(AppIntents)
@available(iOS 18.0, *)
struct HubNewNoteIntent: AppIntent {
    static var title: LocalizedStringResource = "New Note"
    static var description = IntentDescription("Open a new note in HUB.")
    static var openAppWhenRun = true
    @MainActor func perform() async throws -> some IntentResult { HubQuickActions.request(.newNote); return .result() }
}

@available(iOS 18.0, *)
struct HubOpenNotesIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Notes"
    static var description = IntentDescription("Open your notes in HUB.")
    static var openAppWhenRun = true
    @MainActor func perform() async throws -> some IntentResult { HubQuickActions.request(.notes); return .result() }
}

@available(iOS 18.0, *)
struct HubVoiceChatIntent: AppIntent {
    static var title: LocalizedStringResource = "Start Voice Chat"
    static var description = IntentDescription("Open HUB and start a voice chat.")
    static var openAppWhenRun = true
    @MainActor func perform() async throws -> some IntentResult { HubQuickActions.request(.voice); return .result() }
}

@available(iOS 18.0, *)
struct HubNewChatIntent: AppIntent {
    static var title: LocalizedStringResource = "New Chat"
    static var description = IntentDescription("Open HUB ready to write a new chat.")
    static var openAppWhenRun = true
    @MainActor func perform() async throws -> some IntentResult { HubQuickActions.request(.newChat); return .result() }
}
#endif
