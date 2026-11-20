import SwiftUI
import UIKit
import HubNative
import UniformTypeIdentifiers

@MainActor
final class HubHomeModel: ObservableObject {
    @Published var connection: HubHomeConnection = .needsSetup
    @Published var draft = ""
    @Published var sending = false
    @Published var refreshing = false
    @Published var incomplete = false
    @Published var uncertainChat: String?
    @Published var sendError: String?
    @Published var knowledge: HubHomeKnowledge?
    @Published var planner: HubHomePlanner?
    @Published var plannerSaving = false
    @Published var plannerError: String?
    @Published var conversations: [HubConversationChoice]?
    @Published var work: HubHomeWork?
    @Published var workUnavailable = false
    @Published var hasActiveVoice = false
    @Published var voiceCall: HubVoiceCallSummary?
    @Published var openNativeChat: HubNativeChatRequest?
    /// Set by a reminder or the morning brief: show today's agenda.
    @Published var openAgenda = false
}

/// What the chat's voice bar shows while a call is running.
struct HubVoiceCallSummary: Equatable {
    var sessionID: String?
    var status: String
    var muted: Bool
    /// The user's words, live, while they speak.
    var hearing = ""
}

enum HubVoiceCallControl {
    case open, mute, end, camera, screen
}

/// The running call, at the bottom within thumb reach: what HUB is doing, the
/// user's own words as they are recognised, and the call's controls,
/// including the camera and screen sharing.
struct HubVoiceCallBar: View {
    let call: HubVoiceCallSummary
    let inThisChat: Bool
    var canShareScreen = HubVoiceCallBar.screenSharingAvailable
    let control: (HubVoiceCallControl) -> Void

    static var screenSharingAvailable: Bool {
        #if canImport(ScreenCaptureKit)
        if #available(iOS 27.0, *) { return true }
        #endif
        return false
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !call.hearing.isEmpty && !call.muted {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "waveform").font(.caption2.weight(.bold)).foregroundStyle(.green)
                        .accessibilityHidden(true)
                    Text(call.hearing)
                        .font(.subheadline)
                        .lineLimit(2)
                        .truncationMode(.head)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .animation(nil, value: call.hearing)
                }
                .padding(.horizontal, 6)
                .padding(.top, 4)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .accessibilityElement(children: .combine)
                .accessibilityLabel("You said: \(call.hearing)")
                .accessibilityIdentifier("hub.voice.hearing")
            }
            HStack(spacing: 6) {
                Button { control(.open) } label: {
                    HStack(spacing: 10) {
                        Image(systemName: call.muted ? "mic.slash.fill" : "waveform")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(HubWorkspacePalette.onAccent)
                            .frame(width: 32, height: 32)
                            .background(Circle().fill(call.muted ? Color.orange : Color.green))
                        VStack(alignment: .leading, spacing: 1) {
                            Text(inThisChat ? "Call · this chat" : "Voice call")
                                .font(.subheadline.weight(.semibold))
                                .lineLimit(1)
                            Text(call.muted ? "Muted" : call.status)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .accessibilityLabel("Open voice controls")
                .accessibilityIdentifier("hub.voice.bar")
                Button { control(.mute) } label: {
                    Image(systemName: call.muted ? "mic.slash" : "mic")
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel(call.muted ? "Unmute" : "Mute")
                Button { control(.camera) } label: {
                    Image(systemName: "video.fill")
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("Camera")
                .accessibilityHint("Shows HUB your camera, with pointers placed in the room.")
                .accessibilityIdentifier("hub.voice.video")
                if canShareScreen {
                    Button { control(.screen) } label: {
                        Image(systemName: "rectangle.inset.filled.and.person.filled")
                            .frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Share screen")
                    .accessibilityHint("Lets HUB see your iPhone screen while you use other apps.")
                    .accessibilityIdentifier("hub.voice.screen")
                }
                Button { control(.end) } label: {
                    Image(systemName: "phone.down.fill")
                        .foregroundStyle(.white)
                        .frame(width: 38, height: 38)
                        .background(Circle().fill(Color.red))
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("End voice call")
            }
        }
        .buttonStyle(.plain)
        .padding(.leading, 8)
        .padding(.trailing, 4)
        .padding(.vertical, 4)
        .hubGlass(RoundedRectangle(cornerRadius: 26, style: .continuous), tint: Color.green.opacity(0.3))
        .animation(.easeOut(duration: 0.2), value: call.hearing.isEmpty)
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
    }
}

struct HubNativeChatRequest: Equatable {
    enum ComposerAction: Equatable {
        case commands, files, photos, characters, research, researchTasks, instructions
    }

    let id = UUID()
    let choice: HubConversationChoice
    var initialDraft = ""
    var composerAction: ComposerAction?
}

enum HubWorkspacePalette {
    /// A plain modern charcoal in dark mode, a cool off-white in light mode.
    static let background = dynamic(light: 0xF2F3F8, dark: 0x0B0C0F)
    /// Solid surfaces: list rows, sheets, chips.
    static let panel = Color(uiColor: dynamic(light: 0xFFFFFF, dark: 0x16181D))
    /// Home cards: one step lighter than the background.
    static let card = Color(uiColor: dynamic(light: 0xFFFFFF, dark: 0x14161B, lightAlpha: 0.9, darkAlpha: 0.96))
    static let accentUIColor = dynamic(light: 0x3D4FD6, dark: 0xA3B1FF)
    static let accent = Color(uiColor: accentUIColor)
    static let onAccent = Color(uiColor: dynamic(light: 0xFFFFFF, dark: 0x0A0D1F))
    static let muted = Color(uiColor: dynamic(light: 0x5A6275, dark: 0x8D94A7))
    static let border = Color(uiColor: dynamic(light: 0x172233, dark: 0xFFFFFF))

    private static func dynamic(light: UInt32, dark: UInt32, lightAlpha: CGFloat = 1, darkAlpha: CGFloat = 1) -> UIColor {
        UIColor { traits in
            let isDark = traits.userInterfaceStyle == .dark
            let rgb = isDark ? dark : light
            return UIColor(red: CGFloat((rgb >> 16) & 255) / 255,
                           green: CGFloat((rgb >> 8) & 255) / 255, blue: CGFloat(rgb & 255) / 255,
                           alpha: isDark ? darkAlpha : lightAlpha)
        }
    }
}

/// System forms and lists drawn in the HUB workspace colors, so settings and
/// editors match Home instead of the neutral system gray.
struct HubForm<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        Form { Group(content: content).listRowBackground(HubWorkspacePalette.panel) }
            .hubGroupedBackground()
    }
}

struct HubList<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        List { Group(content: content).listRowBackground(HubWorkspacePalette.panel) }
            .hubGroupedBackground()
    }
}

/// "needs-approval" from HUB reads as "Needs approval".
func hubTaskStatusLabel(_ status: String) -> String {
    let words = status.replacingOccurrences(of: "-", with: " ")
    return words.prefix(1).uppercased() + words.dropFirst()
}

/// A small status color: working, waiting on the owner, failed, finished.
func hubTaskStatusColor(_ status: String) -> Color {
    switch status {
    case "working", "running", "checking": return HubWorkspacePalette.accent
    case "needs-approval", "waiting-credit", "blocked": return .orange
    case "failed", "error": return .red
    case "completed", "done": return .green
    default: return HubWorkspacePalette.muted
    }
}

/// A form field with its name shown above the value, so a filled field
/// still says what it is.
struct HubLabeledField<Content: View>: View {
    let title: LocalizedStringKey
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.caption).foregroundStyle(.secondary).accessibilityHidden(true)
            content()
        }
    }
}

extension View {
    @ViewBuilder func hubGroupedBackground() -> some View {
        if #available(iOS 16.0, *) {
            scrollContentBackground(.hidden)
                .hubBackdrop()
        } else {
            self
        }
    }

    /// A quiet filled search field. The system bordered style turns pure
    /// black in the dark workspace.
    func hubSearchField() -> some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary).accessibilityHidden(true)
            textFieldStyle(.plain)
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 44)
        .background(HubWorkspacePalette.border.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct HomeScrollOffset: PreferenceKey {
    static let defaultValue: CGFloat? = nil
    static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) { value = nextValue() ?? value }
}

extension View {
    /// The composer is a UIKit text view outside the scroll view, which the
    /// system's scroll dismissal does not always reach, so a drag on the page
    /// also clears its focus directly.
    @ViewBuilder func hubDismissesKeyboardOnScroll(_ hide: @escaping () -> Void) -> some View {
        let drag = DragGesture(minimumDistance: 12).onChanged { value in
            if abs(value.translation.height) > abs(value.translation.width) { hide() }
        }
        if #available(iOS 16.0, *) {
            scrollDismissesKeyboard(.immediately).simultaneousGesture(drag)
        } else {
            simultaneousGesture(drag)
        }
    }
}

extension HubChatPreferences.Appearance {
    var colorScheme: ColorScheme? {
        switch self {
        case .light: .light
        case .dark: .dark
        case .system: nil
        }
    }
}

@MainActor
struct HubHomeView: View {
    static let backgroundColor = HubWorkspacePalette.background

    @ObservedObject var model: HubHomeModel
    var connect: () -> Void
    var voice: () -> Void
    var options: () -> Void
    var openChat: (String) -> Void
    var send: () -> Void
    var addTodo: (UUID, String, HubHomePlanner.Horizon) async -> Bool
    var completeTodo: (HubHomePlanner.Item) -> Void
    var restorePlannerItem: (HubHomePlanner.Item) -> Void
    var savePlannerItem: (HubPlannerDraft) async -> Bool
    var removePlannerItem: (HubHomePlanner.Item) async -> Bool
    var readKnowledgeNote: (String) async throws -> HubKnowledgeNote
    var attachments: () -> HubChatAttachmentContext?
    var chatAPI: () -> HubConversationAPI?
    var readTasks: () async throws -> HubWorkspaceTasks
    var appearanceChanged: (HubChatPreferences.Appearance) -> Void
    var voiceControl: (HubVoiceCallControl) -> Void = { _ in }

    private enum Panel {
        case history
        case tools

        var edge: Edge { self == .history ? .leading : .trailing }
    }

    @State private var panel: Panel?
    @State private var draggingPanel: Panel?
    @State private var homeScrollOffset: CGFloat?
    @State private var keyboardShownAt = Date.distantPast
    @State private var panelDrag: CGFloat = 0
    @StateObject private var dictation = HubDictation()
    @State private var dictationBase = ""
    @State private var knowledgeOpen = false
    @State private var knowledgeDomainsOpen = false
    @State private var knowledgeBackupsOpen = false
    @State private var knowledgeArchivesOpen = false
    @State private var knowledgeSkillsOpen = false
    @State private var knowledgeAssetsOpen = false
    @State private var openedNoteFile: HubOpenedKnowledgeFile?
    @State private var noteFileBusy: String?
    @State private var noteFileFailed = false
    @State private var knowledgeConnectionsOpen = false
    @State private var knowledgeRefreshError = false
    @State private var selectedNoteID: String?
    @State private var activityDestination: ActivityDestination?
    @State private var selectedNote: HubKnowledgeNote?
    @State private var selectedKnowledgeSource: HubKnowledgeNote.Source?
    @State private var knowledgeForgetOpen = false
    @State private var noteLoadFailed = false
    @State private var noteAttempt = 0
    @State private var noteEditing = false
    @State private var noteDraft = ""
    @State private var noteSaving = false
    @State private var noteSaveFailed = false
    @State private var knowledgeScope = HubKnowledgeGraphView.Scope.all
    @State private var knowledgeSpatial = false
    @State private var knowledgeLiving = true
    @State private var knowledgeLocalCenter: String?
    @State private var knowledgeFocusedDomain: String?
    @State private var knowledgeGraphReset = 0
    @State private var knowledgeTab = KnowledgeTab.graph
    @State private var knowledgeQuery = ""
    @State private var knowledgeSearchResponse: KnowledgeSearchResponse?
    @State private var knowledgeSearchRetry = 0
    @State private var selectedChat: (request: HubNativeChatRequest, api: HubConversationAPI)?
    @State private var tasksOpen = false
    @State private var usageOpen = false
    @State private var settingsOpen = false
    @State private var chatPreferences = HubChatPreferences.defaults
    @State private var openPhoneOptions = false
    @State private var knowledgeActivityOpen = false
    @State private var historyQuery = ""
    @State private var historyResults: HubConversationCatalog?
    @State private var historyFailed = false
    @State private var historyAttempt = 0
    @State private var bookmarks: HubChatBookmarks?
    @State private var bookmarksError = false
    @State private var bookmarksBusy = false
    @State private var creatingChat = false
    @State private var workspaces: [HubWorkspaceItem]?
    @State private var archivedSessions: Set<String> = []
    @State private var sessionToArchive: HubConversationChoice?
    @State private var workspaceChats: [String: HubConversationChoice] = [:]
    @State private var workspaceAttempt = 0
    @State private var workspaceError: String?
    @State private var workspaceBusy = false
    @State private var projects: [HubProject]?
    @State private var projectsExpanded = true
    @State private var expandedProjects: Set<String> = []
    @State private var projectsAttempt = 0
    @State private var projectError: String?
    @State private var projectBusy = false
    @State private var newProjectOpen = false
    @State private var newProjectName = ""
    @State private var projectToEdit: HubProject?
    @State private var projectToRemove: HubProject?
    @State private var voiceHistoryOpen = false
    @State private var todoDraft = ""
    @State private var todoDraftID = UUID()
    @State private var todoHorizon = HubHomePlanner.Horizon.near
    @State private var agendaDate = Date()
    @State private var plannerTab = PlannerTab.todos
    @State private var plannerOpen = false
    @State private var calendarExpanded = false
    @State private var plannerEditor: PlannerEdit?
    @State private var knowledgeApps: [HubKnowledgeAsset]?
    @State private var storeApps: [HubApp] = []
    @State private var appOpenError: String?
    @State private var chatBackdropEnergy: Double = 0
    @State private var runningStoreApp: HubAppRun?
    @State private var knowledgeAppsOpen = false
    @State private var openingApp: String?
    @State private var runningApp: HubOpenedKnowledgeFile?
    @State private var completingTodos: Set<String> = []
    @Namespace private var plannerNamespace
    @FocusState private var composerFocused: Bool
    @FocusState private var todoFocused: Bool
    private let card = HubWorkspacePalette.panel
    private let accent = HubWorkspacePalette.accent

    private enum PlannerTab: CaseIterable {
        case agenda, todos
        var title: LocalizedStringKey { self == .agenda ? "Agenda" : "To-dos" }
    }

    private struct PlannerEdit: Identifiable {
        let id = UUID()
        let item: HubHomePlanner.Item?
        let kind: HubPlannerDraft.Kind
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                mainLayers
                panelLayer(width: min(geometry.size.width * 0.85, 380))
            }
            .simultaneousGesture(edgeSwipe(size: geometry.size))
        }
        .foregroundStyle(.primary)
        .tint(accent)
        .preferredColorScheme(chatPreferences.appearance.colorScheme)
        .environment(\.locale, chatPreferences.interfaceLanguage.map(Locale.init(identifier:)) ?? .autoupdatingCurrent)
    }

    /// Home's layers, sheets and listeners, built in type-erased stages. As one
    /// modifier chain its SwiftUI type nests so deeply that resolving it at
    /// launch overflowed the iPhone's 1 MB main-thread stack (build 13).
    private var mainLayers: some View {
        presentationsAndListeners(sheets(AnyView(callLayers)))
    }

    private var callLayers: some View {
        ZStack {
            workspaceContent
                .opacity(selectedChat == nil ? 1 : 0)
                .allowsHitTesting(selectedChat == nil && panel == nil)
                .accessibilityHidden(selectedChat != nil || panel != nil)
            if let selectedChat {
                HubLiveChatView(chat: selectedChat.request.choice, api: selectedChat.api,
                                back: { unsent in
                                    if selectedChat.request.composerAction != nil, model.draft.isEmpty { model.draft = unsent }
                                    self.selectedChat = nil
                                }, voice: voice, videoCall: { voiceControl(.camera) }, openChat: showChat, attachments: attachments,
                                requestID: selectedChat.request.id, initialDraft: selectedChat.request.initialDraft,
                                composerAction: selectedChat.request.composerAction, preferences: chatPreferences,
                                callActive: model.voiceCall != nil) { name in
                    if chatAPI() === selectedChat.api { updateChatTitle(selectedChat.request.choice.sessionId, name: name) }
                }
                    .id(selectedChat.request.choice.sessionId)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if let call = model.voiceCall {
                HubVoiceCallBar(call: call, inThisChat: call.sessionID != nil && call.sessionID == selectedChat?.request.choice.sessionId) { control in
                    composerFocused = false
                    todoFocused = false
                    voiceControl(control)
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: model.voiceCall == nil)
        .foregroundStyle(.primary)
        .tint(accent)
        .hubBackdrop()
        .environment(\.hubBackdropEnergy, composerFocused || model.voiceCall != nil ? 1 : chatBackdropEnergy)
        .onPreferenceChange(HubBackdropEnergyPreference.self) { chatBackdropEnergy = $0 }
        .preferredColorScheme(chatPreferences.appearance.colorScheme)
        .environment(\.locale, chatPreferences.interfaceLanguage.map(Locale.init(identifier:)) ?? .autoupdatingCurrent)
    }

    private func sheets(_ content: AnyView) -> AnyView {
        AnyView(content
        .sheet(isPresented: $knowledgeOpen, onDismiss: {
            clearKnowledgeSelection()
            knowledgeLocalCenter = nil
            knowledgeFocusedDomain = nil
        }) { knowledgeScreen }
        .sheet(isPresented: $tasksOpen) {
            if let api = chatAPI() { HubTasksView(load: readTasks, api: api, openChat: showChat) }
        }
        .sheet(isPresented: $plannerOpen) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Your day").font(.title2.bold())
                    Spacer()
                    Button("Done") { plannerOpen = false }.hubGlassButton()
                }
                ScrollView {
                    if let planner = model.planner { personalPlanner(planner) }
                    else { connectionRow }
                }
            }
            .padding(18)
            .foregroundStyle(.primary)
            .hubBackdrop()
            .sheet(item: $plannerEditor, content: plannerEditorView)
        }
        .sheet(item: Binding(get: { plannerOpen ? nil : plannerEditor }, set: { plannerEditor = $0 }), content: plannerEditorView)
        .sheet(isPresented: $usageOpen) {
            if let api = chatAPI() { HubUsageView(api: api) }
        }
        .sheet(isPresented: $settingsOpen, onDismiss: {
            if openPhoneOptions {
                openPhoneOptions = false
                options()
            }
        }) {
            let api = chatAPI()
            HubWorkspaceSettingsView(api: api, preferencesChanged: {
                if let api, api === chatAPI() {
                    chatPreferences = $0
                    appearanceChanged($0.appearance)
                }
            }) {
                openPhoneOptions = true
                settingsOpen = false
            }
        }
        .sheet(isPresented: $knowledgeActivityOpen, onDismiss: openActivityDestination) {
            if let api = chatAPI() {
                HubKnowledgeActivityView(api: api, openRecord: { id in
                    activityDestination = .record(id)
                    knowledgeActivityOpen = false
                }, openConversation: { id in
                    activityDestination = .conversation(id)
                    knowledgeActivityOpen = false
                })
            }
        }
        .sheet(isPresented: $knowledgeAppsOpen) {
            if let api = chatAPI() { HubAppsView(api: api, webPage: attachments()?.server.origin.appendingPathComponent("apps")) }
        }
        .fullScreenCover(item: $runningApp) { HubKnowledgeAppRunner(file: $0) }
        .fullScreenCover(item: $runningStoreApp) { HubAppRunner(run: $0) })
    }

    private func presentationsAndListeners(_ content: AnyView) -> some View {
        content
        .task(id: KnowledgeAppsRequest(connected: model.connection == .connected, notes: model.knowledge?.nodes.count ?? -1)) {
            await loadKnowledgeApps()
        }
        .sheet(isPresented: $voiceHistoryOpen) {
            if let api = chatAPI() { HubVoiceHistoryView(api: api, recent: model.conversations ?? [], open: showChat) }
        }
        .sheet(item: $projectToEdit) { project in
            HubProjectSettingsView(project: project) { change in
                try await changeProjects(change)
            }
        }
        .erased()
        .alert("New project", isPresented: $newProjectOpen) {
            TextField("Project name", text: $newProjectName)
            Button("Create") {
                let name = newProjectName
                Task { await createProject(name) }
            }
            .disabled(newProjectName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("HUB makes a folder for it on your PC and keeps a shared note every chat in the project can use.")
        }
        .alert("Remove project?", isPresented: Binding(
            get: { projectToRemove != nil }, set: { if !$0 { projectToRemove = nil } }), presenting: projectToRemove) { project in
            Button("Remove", role: .destructive) { Task { try? await changeProjects(.remove(id: project.id)) } }
            Button("Cancel", role: .cancel) {}
        } message: { project in
            Text("\(project.name) leaves the list. Its chats go back to your history, and its folder and note stay on your PC.")
        }
        .alert("Archive conversation?", isPresented: Binding(
            get: { sessionToArchive != nil }, set: { if !$0 { sessionToArchive = nil } }), presenting: sessionToArchive) { chat in
            Button("Archive", role: .destructive) { Task { await archiveSession(chat.sessionId) } }
            Button("Cancel", role: .cancel) {}
        } message: { chat in
            Text("\(chat.title) will be hidden from the conversation lists. Its messages are kept on HUB.")
        }
        .task(id: model.connection == .connected ? chatAPI().map { ObjectIdentifier($0) } : nil) {
            guard model.connection == .connected, let api = chatAPI(),
                  let value = try? await api.chatPreferences(), !Task.isCancelled else { return }
            chatPreferences = value
            appearanceChanged(value.appearance)
        }
        .onChange(of: model.openNativeChat) { request in
            if let request { showChat(request); model.openNativeChat = nil }
        }
        .onChange(of: model.openAgenda) { open in
            guard open else { return }
            model.openAgenda = false
            selectedChat = nil
            closePanel()
            agendaDate = Date()
            plannerTab = .agenda
            plannerOpen = true
        }
        .onChange(of: selectedChat?.request.choice.sessionId) { id in
            HubNotifications.shared.visibleSessionID = id
        }
        .onChange(of: model.connection) { connection in
            if connection == .needsSetup || connection == .signInRequired {
                chatPreferences = .defaults
                knowledgeOpen = false
                knowledgeDomainsOpen = false
                knowledgeBackupsOpen = false
                knowledgeArchivesOpen = false
                knowledgeSkillsOpen = false
                knowledgeAssetsOpen = false
                knowledgeConnectionsOpen = false
                knowledgeLocalCenter = nil
                knowledgeFocusedDomain = nil
                knowledgeQuery = ""
                knowledgeSearchResponse = nil
                knowledgeRefreshError = false
                clearKnowledgeSelection()
                tasksOpen = false
                usageOpen = false
                knowledgeActivityOpen = false
                selectedChat = nil
                bookmarks = nil
                voiceHistoryOpen = false
                settingsOpen = false
                plannerOpen = false
                plannerEditor = nil
                workspaces = nil
                archivedSessions = []
                sessionToArchive = nil
                workspaceChats = [:]
                projects = nil
                expandedProjects = []
                newProjectOpen = false
                projectToEdit = nil
                projectToRemove = nil
                knowledgeApps = nil
                knowledgeAppsOpen = false
                runningApp = nil
            }
        }
    }

    private var workspaceContent: some View { AnyView(homeContent) }

    private static let panelSpring = Animation.spring(response: 0.34, dampingFraction: 0.86)
    private static let edgeWidth: CGFloat = 30

    /// The side panels float above Home and an open chat alike. While a
    /// finger drags from the screen edge the panel follows it.
    @ViewBuilder private func panelLayer(width: CGFloat) -> some View {
        if let shown = panel ?? draggingPanel {
            let offset = panelOffset(shown, width: width)
            let progress = max(0, min(1, 1 - abs(offset) / width))
            ZStack(alignment: shown.edge == .trailing ? .trailing : .leading) {
                Color.black.opacity(0.46 * progress)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { closePanel() }
                    .accessibilityHidden(true)
                panelContent(shown)
                    .frame(width: width)
                    .offset(x: offset)
                    .shadow(color: .black.opacity(0.25 * progress), radius: 18)
                    .transition(.move(edge: shown.edge))
            }
        }
    }

    private func panelOffset(_ shown: Panel, width: CGFloat) -> CGFloat {
        if panel == nil {
            // Opening from the edge: the panel slides in with the finger.
            return shown == .history ? -width + min(max(panelDrag, 0), width) : width - min(max(-panelDrag, 0), width)
        }
        // Closing: dragging back toward its own edge.
        return shown == .history ? min(0, panelDrag) : max(0, panelDrag)
    }

    /// Left edge: chat history. Right edge: workspace tools, in a chat too.
    /// With history open over a chat, a left-edge swipe goes back Home.
    private func edgeSwipe(size: CGSize) -> some Gesture {
        let width = min(size.width * 0.85, 380)
        return DragGesture(minimumDistance: 10)
            .onChanged { value in
                let dx = value.translation.width, dy = value.translation.height
                if panel == nil && draggingPanel == nil {
                    guard abs(dx) > abs(dy) * 1.2 else { return }
                    if value.startLocation.x < Self.edgeWidth && dx > 0 { beginPanelDrag(.history) }
                    else if value.startLocation.x > size.width - Self.edgeWidth && dx < 0 { beginPanelDrag(.tools) }
                    else { return }
                }
                if draggingPanel != nil || (panel != nil && abs(dx) > 12 && abs(dx) > abs(dy) * 1.5) { panelDrag = dx }
                else if panel != nil && panelDrag != 0 && abs(dy) > abs(dx) { panelDrag = 0 }
            }
            .onEnded { value in
                let dx = value.translation.width, predicted = value.predictedEndTranslation.width
                if let opening = draggingPanel {
                    let travel = opening == .history ? max(dx, predicted) : -min(dx, predicted)
                    withAnimation(Self.panelSpring) {
                        if travel > width * 0.3 { panel = opening }
                        draggingPanel = nil
                        panelDrag = 0
                    }
                    return
                }
                guard let open = panel else { panelDrag = 0; return }
                // Scrolling the panel's list is a vertical drag; only a mostly
                // sideways drag of real length may close the panel.
                let dy = value.translation.height
                guard abs(dx) > 30, abs(dx) > abs(dy) * 1.5 else {
                    withAnimation(Self.panelSpring) { panelDrag = 0 }
                    return
                }
                if open == .history, selectedChat != nil, value.startLocation.x < Self.edgeWidth, dx > 50, abs(dx) > abs(value.translation.height) {
                    // Second swipe from the left edge: leave the chat for Home.
                    selectedChat = nil
                    closePanel()
                    return
                }
                let travel = open == .history ? -min(dx, predicted) : max(dx, predicted)
                if travel > width * 0.3 { closePanel() }
                else { withAnimation(Self.panelSpring) { panelDrag = 0 } }
            }
    }

    private func beginPanelDrag(_ destination: Panel) {
        hideKeyboard()
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        draggingPanel = destination
    }

    private var homeContent: some View {
        VStack(spacing: 0) {
            HubGlassGroup(spacing: 20) {
                HStack {
                    Button { showPanel(.history) } label: {
                        Image(systemName: "sidebar.left").font(.body.weight(.medium))
                            .frame(width: 44, height: 44)
                            .hubGlassCircle()
                    }
                    .accessibilityLabel("Chat history")
                    Spacer(minLength: 4)
                    greeting
                    Spacer(minLength: 4)
                    Button { showPanel(.tools) } label: {
                        Image(systemName: "square.grid.2x2").font(.body.weight(.medium))
                            .frame(width: 44, height: 44)
                            .hubGlassCircle()
                    }
                    .accessibilityLabel("Workspace tools")
                }
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 14)
            .padding(.bottom, 4)
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 14) {
                    connectionRow
                    section("Knowledge", icon: "brain.head.profile", actionLabel: "Explore knowledge", open: showKnowledge) {
                        if let value = model.knowledge {
                            let notes = value.nodes.filter { $0.kind != "conversation" }
                            if value.nodes.isEmpty {
                                Text("Notes appear here as HUB learns from your chats.")
                                    .font(.caption).foregroundStyle(.secondary)
                            } else {
                                HubLivingBrainView(graph: value, height: 300, active: homeVisible, openRecord: selectKnowledgeNode,
                                                   openDomain: { id in
                                                       showKnowledge()
                                                       focusKnowledgeDomain(id)
                                                   }, openExplorer: showKnowledge)
                                    .background(Color(uiColor: HubWorkspacePalette.background).opacity(0.7), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                                    .padding(.horizontal, -6)
                                    .accessibilityIdentifier("hub.home.brain")
                            }
                            knowledgeSummary(value, notes: notes.count)
                            let domains = HubKnowledgeLayout.summary(value)
                            if !domains.isEmpty {
                                HubChipRow(items: Array(domains.prefix(8)), extra: max(0, domains.count - 8)) { domain in
                                    Button {
                                        showKnowledge()
                                        focusKnowledgeDomain(domain.id)
                                    } label: {
                                        HStack(spacing: 6) {
                                            Circle().fill(HubKnowledgeGraphView.tone(domain.hue, id: domain.id)).frame(width: 8, height: 8)
                                            Text(domain.title).font(.caption).lineLimit(1)
                                            Text(domain.count, format: .number).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                        }
                                        .padding(.horizontal, 10)
                                        .frame(minHeight: 32)
                                        .background(HubWorkspacePalette.border.opacity(0.07), in: Capsule())
                                    }
                                    .buttonStyle(.plain)
                                    .disabled(domain.id == HubKnowledgeLayout.unassignedID)
                                    .accessibilityLabel("\(domain.title), \(domain.count) notes")
                                    .accessibilityIdentifier("hub.knowledge.chip.\(domain.id)")
                                }
                            }
                            knowledgeAppsRow
                        }
                    }
                    section("Your day", icon: "calendar", actionLabel: "Open ↗", open: {
                        hideKeyboard()
                        plannerOpen = true
                    }) {
                        if let planner = model.planner {
                            personalPlanner(planner)
                        }

                    }
                    if let work = model.work {
                        section("Your work", icon: "bolt.fill") { workSummary(work) }
                    } else if model.workUnavailable {
                        section("Your work") {
                            Button("Retry loading work", action: connect)
                        }
                    }
                    if model.connection == .connected, let api = chatAPI() {
                        HubBrowserPreviewView(api: api, conversations: model.conversations ?? [], visible: homeVisible)
                            .id(ObjectIdentifier(api))
                    }
                }
                .padding(.top, 5)
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
                .background(GeometryReader { geometry in
                    Color.clear.preference(key: HomeScrollOffset.self, value: geometry.frame(in: .named("homeScroll")).minY)
                })
                .erased()
            }
            .coordinateSpace(name: "homeScroll")
            // Scrolling the page puts the keyboard away, like Messages. The
            // scroll position is the signal: it moves whichever way the page
            // is dragged, and iOS's own scroll as the keyboard appears is
            // ignored for a moment after focus.
            .onPreferenceChange(HomeScrollOffset.self) { offset in
                defer { homeScrollOffset = offset }
                guard composerFocused || todoFocused, let offset, let last = homeScrollOffset, abs(offset - last) > 4,
                      Date().timeIntervalSince(keyboardShownAt) > 0.7 else { return }
                hideKeyboard()
            }
            .onChange(of: composerFocused || todoFocused) { focused in
                if focused { keyboardShownAt = Date() }
            }
            .hubDismissesKeyboardOnScroll(hideKeyboard)
            composer
        }
    }

    /// "Good evening" with today's date and a small connection dot.
    private var greeting: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let hour = Calendar.current.component(.hour, from: context.date)
            let salutation: LocalizedStringKey = hour < 5 ? "Good night" : hour < 12 ? "Good morning"
                : hour < 18 ? "Good afternoon" : "Good evening"
            VStack(spacing: 1) {
                Text(salutation).font(.headline.weight(.semibold))
                HStack(spacing: 5) {
                    Circle()
                        .fill(model.connection == .connected ? Color.green
                              : model.connection == .connecting ? Color.orange : HubWorkspacePalette.muted)
                        .frame(width: 6, height: 6)
                    Text(context.date.formatted(.dateTime.weekday(.wide).day().month(.wide)))
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            .lineLimit(1)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(Text(salutation) + Text(model.connection == .connected ? ", connected" : ", not connected"))
        }
    }

    /// Home is on screen with nothing covering it.
    private var homeVisible: Bool {
        selectedChat == nil && panel == nil && !knowledgeOpen && !plannerOpen && !tasksOpen &&
            !settingsOpen && !usageOpen && !knowledgeActivityOpen && !knowledgeAppsOpen && runningApp == nil
    }

    /// The web apps Knowledge has saved, one tap from running.
    @ViewBuilder private var knowledgeAppsRow: some View {
        let apps = knowledgeApps ?? []
        if !apps.isEmpty || !storeApps.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Apps").font(.subheadline.weight(.semibold))
                    Text(apps.count + storeApps.count, format: .number).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Spacer()
                    Button("See all") { knowledgeAppsOpen = true }
                        .font(.footnote).buttonStyle(.plain).foregroundStyle(accent).frame(minHeight: 36)
                        .accessibilityIdentifier("hub.home.apps.all")
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: 14) {
                        ForEach(storeApps.prefix(12)) { app in
                            Button { Task { await runStoreApp(app) } } label: {
                                VStack(spacing: 6) {
                                    ZStack {
                                        HubAppTile(app: app, size: 52)
                                        if openingApp == app.id { ProgressView().tint(.white) }
                                    }
                                    Text(app.title).font(.caption2).lineLimit(1).frame(width: 64)
                                }
                            }
                            .buttonStyle(.plain)
                            .disabled(openingApp != nil)
                            .accessibilityLabel("Open \(app.title)")
                        }
                        ForEach(apps.prefix(max(0, 12 - storeApps.count))) { app in
                            Button { Task { await runApp(app) } } label: {
                                VStack(spacing: 6) {
                                    ZStack {
                                        HubKnowledgeAppIcon(asset: app, size: 52)
                                        if openingApp == app.id { ProgressView().tint(.white) }
                                    }
                                    Text(HubKnowledgeApps.title(app)).font(.caption2).lineLimit(1).frame(width: 64)
                                }
                            }
                            .buttonStyle(.plain)
                            .disabled(openingApp != nil)
                            .accessibilityLabel("Run \(HubKnowledgeApps.title(app))")
                        }
                    }
                    .padding(.vertical, 4)
                }
                if let appOpenError {
                    Label(appOpenError, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
                }
            }
            .padding(.top, 4)
        }
    }

    private func loadKnowledgeApps() async {
        guard model.connection == .connected, let api = chatAPI() else { return }
        if let assets = try? await api.knowledgeAssets(), !Task.isCancelled, chatAPI() === api {
            knowledgeApps = HubKnowledgeApps.apps(in: assets)
        }
        if let snapshot = try? await api.apps(), !Task.isCancelled, chatAPI() === api { storeApps = snapshot.apps }
    }

    private func runStoreApp(_ app: HubApp) async {
        guard openingApp == nil, let api = chatAPI() else { return }
        openingApp = app.id
        appOpenError = nil
        defer { openingApp = nil }
        do { runningStoreApp = HubAppRun(title: app.title, html: try await api.appHTML(app)) }
        catch { appOpenError = "Could not open \(app.title). Check that HUB is online and try again." }
    }

    private func runApp(_ app: HubKnowledgeAsset) async {
        guard openingApp == nil, let api = chatAPI() else { return }
        openingApp = app.id
        appOpenError = nil
        defer { openingApp = nil }
        do { runningStoreApp = try await api.runnableKnowledgeApp(app) }
        catch { appOpenError = "Could not open \(HubKnowledgeApps.title(app)). Check that HUB is online and try again." }
    }

    private func knowledgeSummary(_ graph: HubHomeKnowledge, notes: Int) -> some View {
        let domains = graph.domains?.filter { $0.status == "active" && $0.parentId == nil }.count ?? 0
        let stats = [(notes, "Brain notes"), (domains, "Domains"), (graph.edges.count, "Connections"),
                     (graph.nodes.count - notes, "Chat archive")]
        return Group {
            if #available(iOS 16.0, *) {
                ViewThatFits(in: .horizontal) {
                    knowledgeStatsLine(stats)
                    knowledgeStatsRows(stats)
                }
            } else {
                knowledgeStatsRows(stats)
            }
        }
        .font(.caption2)
    }

    private func knowledgeStatsLine(_ stats: [(Int, String)]) -> some View {
        HStack(spacing: 7) {
            ForEach(stats.indices, id: \.self) { index in
                knowledgeStat(stats[index].0, label: stats[index].1).fixedSize()
            }
        }
    }

    private func knowledgeStatsRows(_ stats: [(Int, String)]) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach([0, 2], id: \.self) { index in
                HStack(spacing: 12) {
                    knowledgeStat(stats[index].0, label: stats[index].1)
                    knowledgeStat(stats[index + 1].0, label: stats[index + 1].1)
                }
            }
        }
    }

    private func knowledgeStat(_ value: Int, label: String) -> some View {
        (Text(value, format: .number).fontWeight(.semibold) + Text(" \(label)").foregroundColor(HubWorkspacePalette.muted))
            .accessibilityElement(children: .combine)
    }

    private func workSummary(_ work: HubHomeWork) -> some View {
        let entries = work.byId.filter { _, item in
            item.origin != "subagent" && (item.running || item.completed || item.failed || item.stopped)
        }.sorted { $0.value.updatedAt > $1.value.updatedAt }
        return VStack(alignment: .leading, spacing: 8) {
            let stale = model.connection != .connected || model.workUnavailable
            if stale {
                Text("Status unavailable. Showing last observed work.").font(.footnote).foregroundStyle(.secondary)
            }
            if entries.isEmpty { Text("No recent work").foregroundStyle(.secondary) }
            ForEach([true, false], id: \.self) { running in
                let matches = entries.filter { $0.value.running == running }
                if !matches.isEmpty {
                    Text(running ? "In progress" : "Recently ended").font(.caption.bold()).foregroundStyle(.secondary)
                }
                ForEach(matches.prefix(4).map { $0.key }, id: \.self) { id in
                    if let item = work.byId[id] {
                    Button {
                        showChat(HubConversationChoice(sessionId: id, title: item.title ?? "Conversation",
                                                       updatedAt: item.updatedAt))
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.title ?? "Conversation").lineLimit(2)
                            if !stale {
                                Text(running ? "Working" : (item.completed ? "Completed" : (item.stopped ? "Stopped" : "Failed")))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .frame(minHeight: 44, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    .disabled(model.connection != .connected)
                    }
                }
            }
        }
    }

    private func showPanel(_ destination: Panel) {
        hideKeyboard()
        withAnimation(Self.panelSpring) { panelDrag = 0; panel = destination }
    }

    private func closePanel() {
        historyQuery = ""
        historyResults = nil
        historyFailed = false
        withAnimation(Self.panelSpring) { panel = nil; panelDrag = 0; draggingPanel = nil }
    }

    private func dismissKeyboard(then action: () -> Void) {
        hideKeyboard()
        action()
    }

    private func hideKeyboard() {
        composerFocused = false
        todoFocused = false
    }

    private func panelContent(_ destination: Panel) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                if destination == .history {
                    Text("Chats").font(.title3.bold()).accessibilityAddTraits(.isHeader)
                } else {
                    Button {
                        closePanel()
                        settingsOpen = true
                    } label: {
                        Label("Settings", systemImage: "gearshape")
                            .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                    }
                    .hubGlassButton()
                }
                Spacer()
                Button(action: closePanel) {
                    Image(systemName: "xmark").font(.subheadline.weight(.semibold))
                        .frame(width: 40, height: 40)
                        .hubGlassCircle()
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("Close panel")
            }
            if destination == .history {
                historyPanel
            } else {
                workspaceTools
                .disabled(model.connection != .connected)
                Spacer()
            }
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .frame(maxHeight: .infinity, alignment: .topLeading)
        // A floating glass sheet, inset from the screen edges like the
        // system's own sidebars, darkened enough to read long lists on.
        .background(RoundedRectangle(cornerRadius: 34, style: .continuous).fill(HubWorkspacePalette.panel.opacity(0.62)))
        .hubGlass(RoundedRectangle(cornerRadius: 34, style: .continuous))
        .padding(.vertical, 6)
        .padding(.horizontal, 6)
    }

    private var workspaceTools: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 8) {
                    section("Knowledge", actionLabel: "Explore", open: showKnowledge) {
                        if let graph = model.knowledge {
                            HubLivingBrainView(graph: graph, height: 130, active: panel == .tools, openRecord: selectKnowledgeNode,
                                               openExplorer: showKnowledge)
                            let chats = graph.nodes.filter { $0.kind == "conversation" }.count
                            Text("\(graph.nodes.count - chats) brain notes · \(chats) chats")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    VStack(spacing: 8) {
                        toolTile("Activity", icon: "clock.arrow.circlepath") {
                            closePanel()
                            knowledgeActivityOpen = true
                        }
                        toolTile("Usage", icon: "chart.bar.xaxis") {
                            closePanel()
                            usageOpen = true
                        }
                        toolTile("Apps", icon: "square.grid.2x2") {
                            closePanel()
                            knowledgeAppsOpen = true
                        }
                    }
                    .frame(width: 78)
                    .disabled(model.connection != .connected)
                }
                Button {
                    closePanel()
                    tasksOpen = true
                } label: {
                    section("Tasks") {
                        Text("Goals, schedules & conditions").font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.plain)
                .disabled(model.connection != .connected)
            }
        }
    }

    private func toolTile(_ title: LocalizedStringKey, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 8) {
                Image(systemName: icon).font(.title3)
                Text(title).font(.caption)
            }
            .frame(maxWidth: .infinity, minHeight: 72)
            .background(card, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(HubWorkspacePalette.border.opacity(0.08)))
        }
        .buttonStyle(.plain)
    }

    private var historyPanel: some View {
        let query = String(historyQuery.trimmingCharacters(in: .whitespacesAndNewlines).prefix(120))
        return VStack(alignment: .leading, spacing: 10) {
            TextField("Search chats", text: $historyQuery)
                .hubSearchField()
                .submitLabel(.search)
                .disabled(model.connection != .connected)
            Button { Task { await newChat() } } label: {
                Label("New chat", systemImage: "square.and.pencil")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 36)
            }
            .hubGlassButton(prominent: true)
            .disabled(creatingChat || model.connection != .connected)
            .opacity(creatingChat || model.connection != .connected ? 0.5 : 1)
            ScrollView(showsIndicators: false) {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if query.isEmpty {
                        projectsSection
                        pinnedHistory
                    }
                    if let results = query.isEmpty ? model.conversations : historyResults?.conversations {
                        let pinnedIDs = query.isEmpty ? Set(bookmarks?.sessionIds ?? []) : []
                        // Chats in a project are listed under it, not twice.
                        let projectIDs = query.isEmpty ? Set((projects ?? []).flatMap(\.sessionIds)) : []
                        let conversations = results.filter {
                            !archivedSessions.contains($0.sessionId) && !pinnedIDs.contains($0.sessionId) && !projectIDs.contains($0.sessionId)
                        }
                        if conversations.isEmpty && pinnedIDs.isEmpty {
                            Text(query.isEmpty ? "No conversations yet" : "No matching conversations")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .padding(.vertical, 12)
                        }
                        if query.isEmpty {
                            ForEach(historyGroups(conversations)) { group in
                                historySectionLabel(group.title)
                                ForEach(group.chats, id: \.sessionId) { chat in historyRow(chat) }
                            }
                        } else {
                            ForEach(conversations, id: \.sessionId) { chat in
                                historyRow(chat)
                            }
                        }
                        if !query.isEmpty, historyResults?.hasMore == true {
                            Text("Narrow your search to see more matches.").font(.footnote).foregroundStyle(.secondary)
                        }
                    } else if model.connection != .connected || (query.isEmpty && model.incomplete) {
                        connectionRow
                    } else if historyFailed {
                        Button("Retry search") { historyAttempt += 1 }.frame(minHeight: 44)
                    } else {
                        ProgressView(query.isEmpty ? "Loading conversations…" : "Searching…").padding(.vertical, 8)
                    }
                }
            }
            Divider()
            HStack(spacing: 8) {
                historyFooterButton("Voice calls", icon: "waveform") {
                    closePanel()
                    voiceHistoryOpen = true
                }
            }
            .disabled(model.connection != .connected)
            .padding(.bottom, 4)
        }
        .task(id: model.connection == .connected) { await loadBookmarks() }
        .task(id: WorkspaceRequest(connected: model.connection == .connected, attempt: workspaceAttempt)) {
            if model.connection == .connected { await loadWorkspaces() }
        }
        .task(id: WorkspaceRequest(connected: model.connection == .connected, attempt: projectsAttempt)) {
            if model.connection == .connected { await loadProjects() }
        }
        .task(id: HistoryRequest(query: query, attempt: historyAttempt, connected: model.connection == .connected)) {
            historyResults = nil
            historyFailed = false
            guard !query.isEmpty, let api = chatAPI() else { return }
            do {
                try await Task.sleep(nanoseconds: 250_000_000)
                let result = try await api.list(search: query)
                if !Task.isCancelled { historyResults = result }
            } catch {
                if !Task.isCancelled { historyFailed = true }
            }
        }
    }

    private struct KnowledgeAppsRequest: Equatable {
        let connected: Bool
        let notes: Int
    }

    private struct WorkspaceRequest: Equatable {
        let connected: Bool
        let attempt: Int
    }

    /// Projects sit at the top of the panel: a collapsible list, each project
    /// opening to its chats. Creating one only asks for a name.
    private var projectsSection: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { projectsExpanded.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Text("Projects").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .rotationEffect(.degrees(projectsExpanded ? 90 : 0))
                        Spacer()
                    }
                    .padding(.horizontal, 10)
                    .frame(minHeight: 36)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("hub.projects.toggle")
                .accessibilityLabel(projectsExpanded ? "Projects, expanded" : "Projects, collapsed")
                Button {
                    newProjectName = ""
                    newProjectOpen = true
                } label: {
                    Image(systemName: "plus").font(.footnote.weight(.semibold)).frame(width: 44, height: 36)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("hub.projects.new")
                .accessibilityLabel("New project")
                .disabled(projectBusy || model.connection != .connected)
            }
            .padding(.top, 8)
            if projectsExpanded {
                if let projectError {
                    Text(projectError).font(.footnote).foregroundStyle(.secondary).padding(.horizontal, 10)
                    Button("Retry") { projectsAttempt += 1 }.font(.footnote).frame(minHeight: 44).padding(.horizontal, 10)
                }
                if let projects {
                    if projects.isEmpty {
                        Button {
                            newProjectName = ""
                            newProjectOpen = true
                        } label: {
                            Label("New project", systemImage: "folder.badge.plus")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 10)
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        }
                        .buttonStyle(.plain)
                    }
                    ForEach(projects) { project in projectRow(project) }
                } else if projectError == nil && model.connection == .connected {
                    ProgressView().padding(.horizontal, 10).frame(minHeight: 44)
                }
            }
        }
    }

    private func projectRow(_ project: HubProject) -> some View {
        let open = expandedProjects.contains(project.id)
        let chats = project.sessionIds.filter { !archivedSessions.contains($0) }
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4) {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        if open { expandedProjects.remove(project.id) } else { expandedProjects.insert(project.id) }
                    }
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: open ? "folder.fill" : "folder")
                            .font(.caption)
                            .foregroundStyle(accent)
                            .frame(width: 18)
                        Text(project.name).font(.subheadline.weight(.medium)).lineLimit(1)
                        Spacer()
                        if !chats.isEmpty {
                            Text("\(chats.count)").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.horizontal, 10)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("hub.project.\(project.id)")
                .accessibilityLabel("\(project.name), \(chats.count) chats")
                Menu {
                    Button { Task { await newChat(projectID: project.id) } } label: {
                        Label("New chat in project", systemImage: "square.and.pencil")
                    }
                    Button { projectToEdit = project } label: {
                        Label("Instructions and note", systemImage: "doc.text")
                    }
                    Button(role: .destructive) { projectToRemove = project } label: {
                        Label("Remove project", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis").frame(width: 44, height: 44)
                }
                .disabled(projectBusy)
                .accessibilityLabel("Options for \(project.name)")
            }
            if open {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(chats, id: \.self) { id in
                        historyRow(workspaceChats[id] ?? HubConversationChoice(sessionId: id, title: "Untitled conversation", updatedAt: 0))
                    }
                    Button { Task { await newChat(projectID: project.id) } } label: {
                        Label("New chat in project", systemImage: "plus")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 10)
                            .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    .disabled(creatingChat || projectBusy)
                }
                .padding(.leading, 14)
            }
        }
    }

    private func loadProjects() async {
        guard let api = chatAPI() else { if projects == nil { projects = [] }; return }
        do {
            let snapshot = try await api.projects()
            guard !Task.isCancelled, chatAPI() === api else { return }
            projects = snapshot.projects
            projectError = nil
            // Chats only listed under a project still need their titles.
            let missing = snapshot.projects.flatMap(\.sessionIds).filter { workspaceChats[$0] == nil }
            if !missing.isEmpty, let titles = try? await api.workspaceChatTitles(), chatAPI() === api {
                workspaceChats.merge(titles) { cached, _ in cached }
            }
        } catch {
            if !Task.isCancelled && chatAPI() === api {
                projectError = "Projects need HUB 1.10.18 or newer on your PC."
            }
        }
    }

    @discardableResult
    private func changeProjects(_ change: HubProjectChange) async throws -> HubProjectsSnapshot? {
        guard !projectBusy, let api = chatAPI() else { return nil }
        projectBusy = true
        defer { projectBusy = false }
        do {
            let snapshot = try await api.changeProject(change)
            guard chatAPI() === api else { return nil }
            projects = snapshot.projects
            projectError = nil
            return snapshot
        } catch {
            if chatAPI() === api { projectError = "Could not update projects. Check the connection and try again." }
            throw error
        }
    }

    private func createProject(_ name: String) async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let snapshot = try? await changeProjects(.create(name: trimmed)),
              let created = snapshot.projects.first else { return }
        projectsExpanded = true
        expandedProjects.insert(created.id)
    }

    private func loadWorkspaces() async {
        guard let api = chatAPI() else { return }
        workspaceError = nil
        do {
            let snapshot = try await api.workspaces()
            let items = snapshot.items
            guard !Task.isCancelled, chatAPI() === api, !workspaceBusy else { return }
            workspaces = items
            archivedSessions = Set(snapshot.archivedSessionIds)
            // Titles are a nicety: the workspaces stay listed if they fail.
            var known = Dictionary(model.conversations?.map { ($0.sessionId, $0) } ?? [], uniquingKeysWith: { a, _ in a })
            known.merge(workspaceChats) { _, cached in cached }
            workspaceChats = known
            if items.contains(where: { $0.sessionIds.contains { known[$0] == nil } }),
               let titles = try? await api.workspaceChatTitles() {
                guard !Task.isCancelled, chatAPI() === api else { return }
                workspaceChats = titles
            }
        } catch {
            if !Task.isCancelled && chatAPI() === api { workspaceError = "Could not refresh workspaces." }
        }
    }

    private func archiveSession(_ id: String) async {
        guard !workspaceBusy, let api = chatAPI() else { return }
        workspaceBusy = true
        defer { workspaceBusy = false }
        do {
            let archived = try await api.archiveWorkspaceSession(id)
            guard chatAPI() === api else { return }
            archivedSessions = archived
            workspaceAttempt += 1
        } catch {
            if chatAPI() === api { workspaceError = "Could not confirm the archive. Refresh workspaces to check." }
        }
    }

    /// Pinned chats sit on top only when there are some; pin and unpin from a row's long-press menu.
    @ViewBuilder private var pinnedHistory: some View {
        if let bookmarks {
            let byID = Dictionary((model.conversations ?? []).map { ($0.sessionId, $0) }, uniquingKeysWith: { first, _ in first })
            let visible = bookmarks.sessionIds.filter { !archivedSessions.contains($0) }
            if !visible.isEmpty {
                historySectionLabel("Pinned")
                ForEach(visible, id: \.self) { id in
                    historyRow(byID[id] ?? HubConversationChoice(sessionId: id, title: "Pinned conversation", updatedAt: 0))
                }
            }
        }
        if bookmarksError {
            Button("Retry loading pinned chats") { Task { await loadBookmarks() } }
                .font(.footnote)
                .frame(minHeight: 44)
        }
    }

    private struct HistoryGroup: Identifiable {
        let title: String
        let chats: [HubConversationChoice]
        var id: String { title }
    }

    private func historyGroups(_ chats: [HubConversationChoice]) -> [HistoryGroup] {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        let yesterday = calendar.date(byAdding: .day, value: -1, to: today) ?? today
        let week = calendar.date(byAdding: .day, value: -7, to: today) ?? today
        var buckets: [[HubConversationChoice]] = [[], [], [], []]
        for chat in chats {
            let date = Date(timeIntervalSince1970: chat.updatedAt / 1_000)
            let index = chat.updatedAt <= 0 ? 3 : date >= today ? 0 : date >= yesterday ? 1 : date >= week ? 2 : 3
            buckets[index].append(chat)
        }
        let titles = ["Today", "Yesterday", "Previous 7 days", "Earlier"]
        return titles.indices.compactMap { index in
            buckets[index].isEmpty ? nil : HistoryGroup(title: titles[index], chats: buckets[index])
        }
    }

    private func historySectionLabel(_ title: String) -> some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.top, 14)
            .padding(.bottom, 4)
            .accessibilityAddTraits(.isHeader)
    }

    private func historyFooterButton(_ title: LocalizedStringKey, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(.footnote.weight(.medium))
                .lineLimit(1)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(HubWorkspacePalette.border.opacity(0.06), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private func historyTime(_ updatedAt: Double) -> String? {
        guard updatedAt > 0 else { return nil }
        let date = Date(timeIntervalSince1970: updatedAt / 1_000)
        if Calendar.current.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
        if Calendar.current.isDateInYesterday(date) { return String(localized: "Yesterday") }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }

    private func historyRow(_ chat: HubConversationChoice) -> some View {
        let pinned = bookmarks?.sessionIds.contains(chat.sessionId) == true
        return HStack(spacing: 6) {
            Button { showChat(chat) } label: {
                HStack(spacing: 10) {
                    Image(systemName: pinned ? "pin.fill" : "bubble.left")
                        .font(.caption)
                        .foregroundStyle(pinned ? accent : HubWorkspacePalette.muted)
                        .frame(width: 18)
                    Text(chat.title)
                        .font(.subheadline)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let time = historyTime(chat.updatedAt) {
                        Text(time).font(.caption2).foregroundStyle(.secondary).fixedSize()
                    }
                }
                .padding(.horizontal, 10)
                .frame(maxWidth: .infinity, minHeight: 46, alignment: .leading)
                .contentShape(Rectangle())
            }
            .accessibilityIdentifier("hub.history.\(chat.sessionId)")
            .accessibilityLabel(pinned ? "\(chat.title), pinned" : chat.title)
            .accessibilityAction(named: pinned ? "Unpin" : "Pin") {
                Task { await setPinned(chat.sessionId, pinned: !pinned) }
            }
            .contextMenu {
                if bookmarks != nil {
                    Button { Task { await setPinned(chat.sessionId, pinned: !pinned) } } label: {
                        Label(pinned ? "Unpin" : "Pin to top", systemImage: pinned ? "pin.slash" : "pin")
                    }
                    .disabled(bookmarksBusy)
                }
                if let projects, !projects.isEmpty {
                    let current = projects.first { $0.sessionIds.contains(chat.sessionId) }
                    Menu {
                        ForEach(projects.filter { $0.id != current?.id }) { project in
                            Button(project.name) { Task { try? await changeProjects(.add(id: project.id, sessionID: chat.sessionId)) } }
                        }
                    } label: {
                        Label(current == nil ? "Add to project" : "Move to project", systemImage: "folder")
                    }
                    .disabled(projectBusy)
                    if current != nil {
                        Button { Task { try? await changeProjects(.detach(sessionID: chat.sessionId)) } } label: {
                            Label("Remove from project", systemImage: "folder.badge.minus")
                        }
                        .disabled(projectBusy)
                    }
                }
                Button(role: .destructive) { sessionToArchive = chat } label: {
                    Label("Archive conversation", systemImage: "archivebox")
                }
                .disabled(workspaceBusy)
            }
        }
        .buttonStyle(.plain)
        .disabled(model.connection != .connected)
    }

    private func loadBookmarks() async {
        guard !bookmarksBusy, let api = chatAPI() else { return }
        bookmarksBusy = true
        defer { bookmarksBusy = false }
        do {
            let value = try await api.chatBookmarks()
            if !Task.isCancelled { bookmarks = value; bookmarksError = false }
        } catch {
            if !Task.isCancelled { bookmarksError = true }
        }
    }

    private func setPinned(_ id: String, pinned: Bool) async {
        guard !bookmarksBusy, let api = chatAPI() else { return }
        bookmarksBusy = true
        defer { bookmarksBusy = false }
        do {
            let value = try await api.setChatPinned(sessionID: id, pinned: pinned)
            guard chatAPI() === api else { return }
            bookmarks = value
            bookmarksError = false
        } catch {
            if chatAPI() === api { bookmarksError = true }
        }
    }

    private func newChat(projectID: String? = nil, action: HubNativeChatRequest.ComposerAction? = nil) async {
        guard !model.sending, !creatingChat, let api = chatAPI() else { return }
        // Started from Home or from the drawer over a chat; give up if the user opens another chat meanwhile.
        let startedIn = selectedChat?.request.id
        creatingChat = true
        let initialDraft = action == nil ? "" : model.draft
        defer { creatingChat = false }
        do {
            let id = try await api.createChat()
            guard chatAPI() === api else { return }
            if let projectID {
                // The chat joins the project before its first message, so its
                // first reply already sees the project's instructions and note.
                let snapshot = try await api.changeProject(.add(id: projectID, sessionID: id))
                guard chatAPI() === api else { return }
                projects = snapshot.projects
                workspaceChats[id] = HubConversationChoice(sessionId: id, title: "New chat", updatedAt: Date().timeIntervalSince1970 * 1_000)
            }
            guard selectedChat?.request.id == startedIn else { return }
            if action != nil, model.draft == initialDraft { model.draft = "" }
            showChat(HubNativeChatRequest(choice: HubConversationChoice(sessionId: id, title: "New chat", updatedAt: 0),
                                          initialDraft: initialDraft, composerAction: action))
        } catch {
            if chatAPI() === api {
                if projectID != nil { projectError = "Could not open a chat in this project." }
                else { model.sendError = "Could not open a new conversation. Try again when connected." }
            }
        }
    }

    private func updateChatTitle(_ id: String, name: String) {
        let choice = HubConversationChoice(sessionId: id, title: name, updatedAt: Date().timeIntervalSince1970 * 1_000)
        if let recent = model.conversations, recent.contains(where: { $0.sessionId == id }) {
            model.conversations = recent.map { $0.sessionId == id ? choice : $0 }
        }
        workspaceChats[id] = choice
    }

    private struct HistoryRequest: Equatable {
        let query: String
        let attempt: Int
        let connected: Bool
    }

    private func showKnowledge() {
        dismissKeyboard {
            closePanel()
            knowledgeOpen = true
        }
    }

    private enum ActivityDestination {
        case record(String)
        case conversation(String)
    }

    private func openActivityDestination() {
        let destination = activityDestination
        activityDestination = nil
        switch destination {
        case .record(let id): selectKnowledgeNode(id)
        case .conversation(let id): openChat(id)
        case nil: break
        }
    }

    private func showChat(_ chat: HubConversationChoice) {
        showChat(HubNativeChatRequest(choice: chat))
    }

    private func showChat(_ request: HubNativeChatRequest) {
        guard let api = chatAPI() else { return }
        dismissKeyboard {
            closePanel()
            knowledgeOpen = false
            tasksOpen = false
            usageOpen = false
            settingsOpen = false
            voiceHistoryOpen = false
            plannerOpen = false
            plannerEditor = nil
            knowledgeActivityOpen = false
            selectedChat = (request, api)
        }
    }

    private func clearKnowledgeSelection() {
        selectedNoteID = nil
        selectedNote = nil
        selectedKnowledgeSource = nil
        knowledgeForgetOpen = false
        noteLoadFailed = false
        noteEditing = false
        noteDraft = ""
        noteSaveFailed = false
    }

    private func selectKnowledgeNode(_ id: String) {
        showKnowledge()
        selectedNoteID = id
        selectedNote = nil
        noteLoadFailed = false
        noteAttempt += 1
    }

    private var knowledgeScreen: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                if selectedNoteID != nil {
                    Button(action: clearKnowledgeSelection) { Label("Knowledge", systemImage: "chevron.left") }
                        .disabled(noteSaving || noteEditing)
                } else {
                    Text("Knowledge").font(.headline).accessibilityAddTraits(.isHeader)
                    Menu {
                        Button("Domains") { knowledgeDomainsOpen = true }
                        Button("Backups") { knowledgeBackupsOpen = true }
                        Button("Conversation archives") { knowledgeArchivesOpen = true }
                        Button("Skills") { knowledgeSkillsOpen = true }
                        Button("Attachments") { knowledgeAssetsOpen = true }
                    } label: {
                        Image(systemName: "ellipsis").frame(width: 44, height: 36)
                    }
                    .accessibilityLabel("Manage Knowledge")
                    .disabled(model.connection != .connected)
                }
                Spacer()
                Button("Done") { knowledgeOpen = false }.disabled(noteSaving || noteEditing)
            }
            if let id = selectedNoteID {
                Group {
                    if let note = selectedNote {
                        knowledgeNote(note)
                    } else if noteLoadFailed {
                        Button("Retry loading note") { noteLoadFailed = false; noteAttempt += 1 }
                    } else {
                        ProgressView("Loading note…")
                    }
                }
                .task(id: noteAttempt) {
                    do {
                        let note = try await readKnowledgeNote(id)
                        if !Task.isCancelled, selectedNoteID == id { selectedNote = note }
                    } catch {
                        if !Task.isCancelled, selectedNoteID == id { noteLoadFailed = true }
                    }
                }
            } else if let graph = model.knowledge {
                knowledgeOverview(graph)
            } else {
                connectionRow
                if model.connection == .connected && !model.refreshing && !model.incomplete {
                    Button("Load Knowledge", action: connect)
                }
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .foregroundStyle(.primary)
        .tint(accent)
        .hubBackdrop()
        .interactiveDismissDisabled(noteSaving || noteEditing)
        .sheet(isPresented: $knowledgeDomainsOpen) {
            if let api = chatAPI() {
                HubKnowledgeDomainsView(api: api, changed: refreshKnowledgeGraph, openNote: { id in
                    knowledgeDomainsOpen = false
                    selectKnowledgeNode(id)
                })
            }
        }
        .sheet(isPresented: $knowledgeBackupsOpen) {
            if let api = chatAPI() { HubKnowledgeBackupsView(api: api) }
        }
        .sheet(isPresented: $knowledgeArchivesOpen) {
            if let api = chatAPI() { HubKnowledgeArchivesView(api: api, changed: refreshKnowledgeGraph) }
        }
        .sheet(isPresented: $knowledgeSkillsOpen) {
            if let api = chatAPI() { HubKnowledgeSkillsView(api: api, changed: refreshKnowledgeGraph) }
        }
        .sheet(isPresented: $knowledgeAssetsOpen) {
            if let api = chatAPI() {
                HubKnowledgeAssetsView(api: api, note: selectedNote) { updated in
                    if let updated, selectedNoteID == updated.id { selectedNote = updated }
                    await refreshKnowledgeGraph()
                }
            }
        }
        .sheet(isPresented: $knowledgeConnectionsOpen) {
            if let api = chatAPI(), let note = selectedNote {
                HubKnowledgeConnectionsView(api: api, note: note) { id in
                    knowledgeConnectionsOpen = false
                    selectKnowledgeNode(id)
                }
            }
        }
        .sheet(item: $selectedKnowledgeSource) { source in
            if let api = chatAPI() { HubKnowledgeOriginalSourceView(api: api, source: source) }
        }
        .sheet(isPresented: $knowledgeForgetOpen) {
            if let api = chatAPI(), let note = selectedNote {
                HubKnowledgeForgetView(api: api, note: note) { updated in
                    if selectedNoteID == updated.id, chatAPI() === api { selectedNote = updated }
                    await refreshKnowledgeGraph()
                }
            }
        }
    }

    private func refreshKnowledgeGraph() async {
        guard let api = chatAPI() else { return }
        do {
            let graph = try await api.knowledge()
            guard chatAPI() === api else { return }
            model.knowledge = graph
            knowledgeRefreshError = false
        } catch {
            if chatAPI() === api { knowledgeRefreshError = true }
        }
    }

    private func knowledgeNote(_ note: HubKnowledgeNote) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(note.title).font(.title2.bold()).accessibilityAddTraits(.isHeader)
                Spacer()
                if noteEditing {
                    Button("Cancel") { noteEditing = false; noteSaveFailed = false }.disabled(noteSaving)
                    Button("Save") { Task { await saveNote(note) } }.disabled(noteSaving || noteDraft == note.content || noteSaveFailed)
                } else if note.kind != "conversation", note.protected != true, note.hash != nil {
                    Button("Edit") { noteDraft = note.content; noteEditing = true }
                    Button { knowledgeAssetsOpen = true } label: { Image(systemName: "paperclip").frame(minWidth: 44, minHeight: 44) }
                        .accessibilityLabel("Attach file to note")
                        .disabled(model.connection != .connected)
                    Menu {
                        Button("Forget a passage", role: .destructive) { knowledgeForgetOpen = true }
                    } label: { Image(systemName: "ellipsis").frame(minWidth: 44, minHeight: 44) }
                    .accessibilityLabel("Note actions")
                    .disabled(model.connection != .connected)
                }
            }
            if noteEditing {
                TextEditor(text: $noteDraft).disabled(noteSaving).accessibilityLabel("Note content")
                if noteSaving { ProgressView("Saving…") }
                if noteSaveFailed {
                    Text("Could not confirm the save. Copy your draft before reopening this note to check the saved version.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        HubMarkdownText(source: note.content)
                        noteFiles(note.content)
                        Button {
                            knowledgeConnectionsOpen = true
                        } label: {
                            Label("Connections and sources", systemImage: "point.3.connected.trianglepath.dotted")
                        }
                        .frame(minHeight: 44)
                        if model.knowledge?.nodes.contains(where: { $0.id == note.id }) == true {
                            Button {
                                knowledgeLocalCenter = note.id
                                knowledgeFocusedDomain = nil
                                knowledgeTab = .graph
                                clearKnowledgeSelection()
                            } label: { Label("Local graph", systemImage: "point.3.connected.trianglepath.dotted") }
                            .frame(minHeight: 44)
                        }
                        knowledgeLinks("Links", nodes: note.links ?? [])
                        knowledgeLinks("Backlinks", nodes: note.backlinks ?? [])
                        knowledgeSources(note.sources ?? [])
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    /// Files a note links to (an HTML game, a document, an image), opened inside HUB.
    @ViewBuilder private func noteFiles(_ content: String) -> some View {
        let files = HubKnowledgeAttachmentLink.find(in: content)
        if !files.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Files").font(.subheadline.bold()).foregroundStyle(.secondary)
                ForEach(files) { file in
                    Button { Task { await openNoteFile(file) } } label: {
                        HStack(spacing: 12) {
                            Image(systemName: file.isHTML ? "play.rectangle.fill" : "doc.fill")
                                .font(.title3).foregroundStyle(accent)
                                .frame(width: 40, height: 40)
                                .background(accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(file.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                                Text(file.isHTML ? "Open and run in HUB" : "Open in HUB").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 4)
                            if noteFileBusy == file.id { ProgressView() } else { Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary) }
                        }
                        .padding(10)
                        .background(card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(noteFileBusy != nil || model.connection != .connected)
                    .accessibilityIdentifier("hub.knowledge.file.\(file.fileName)")
                }
                if noteFileFailed {
                    Text("Could not open this file. Check the connection and try again.").font(.footnote).foregroundStyle(.secondary)
                }
            }
            .sheet(item: $openedNoteFile) { file in
                NavigationView {
                    HubKnowledgeFilePreview(name: file.asset.name, mediaType: file.asset.mediaType, data: file.data)
                        .navigationTitle(file.asset.name)
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) { Button("Done") { openedNoteFile = nil } }
                            ToolbarItem(placement: .primaryAction) { HubShareFileButton(bytes: file.data, name: file.asset.name, label: "Share or save file") }
                        }
                }
                .navigationViewStyle(.stack)
            }
        }
    }

    private func openNoteFile(_ file: HubKnowledgeAttachmentLink) async {
        guard noteFileBusy == nil, let api = chatAPI() else { return }
        noteFileBusy = file.id
        noteFileFailed = false
        defer { noteFileBusy = nil }
        do {
            guard let asset = file.asset(in: try await api.knowledgeAssets()) else { throw HubAttachmentError.invalidResponse }
            let data = try await api.knowledgeAssetBytes(asset)
            openedNoteFile = HubOpenedKnowledgeFile(asset: asset, data: data)
        } catch {
            noteFileFailed = true
        }
    }

    @ViewBuilder private func knowledgeLinks(_ title: String, nodes: [HubHomeKnowledge.Node]) -> some View {
        if !nodes.isEmpty {
            DisclosureGroup(title) {
                ForEach(nodes, id: \.id) { node in
                    Button(node.title ?? "Knowledge record") { selectKnowledgeNode(node.id) }
                        .frame(minHeight: 44)
                }
            }
        }
    }

    @ViewBuilder private func knowledgeSources(_ sources: [HubKnowledgeNote.Source]) -> some View {
        if !sources.isEmpty {
            DisclosureGroup("Sources") {
                ForEach(sources.indices, id: \.self) { index in
                    let source = sources[index]
                    VStack(alignment: .leading, spacing: 5) {
                        Button {
                            if let id = source.conversationId { selectKnowledgeNode(id) }
                            else { selectedKnowledgeSource = source }
                        } label: {
                            Label(source.channel.capitalized, systemImage: "doc.text.magnifyingglass").frame(minHeight: 44)
                        }
                        let time = source.evidence?.occurredAt ?? source.completedAt
                        if time.isFinite, time > 0 {
                            Text(Date(timeIntervalSince1970: time / 1000).formatted()).font(.caption).foregroundStyle(.secondary)
                        }
                        if let reason = source.reason { Text(reason).font(.footnote) }
                        if let quote = source.evidence?.quote { Text(quote).italic().font(.footnote).textSelection(.enabled) }
                    }
                }
            }
        }
    }

    private func saveNote(_ note: HubKnowledgeNote) async {
        guard !noteSaving, let api = chatAPI() else { return }
        noteSaving = true
        defer { noteSaving = false }
        do {
            let saved = try await api.saveKnowledgeNote(note, content: noteDraft)
            guard selectedNoteID == note.id else { return }
            selectedNote = saved
            noteEditing = false
            noteSaveFailed = false
        } catch {
            if selectedNoteID == note.id { noteSaveFailed = true }
        }
    }

    private func knowledgeOverview(_ graph: HubHomeKnowledge) -> some View {
        let query = knowledgeQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        let api = chatAPI()
        let neighborhood = knowledgeLocalCenter.flatMap { graph.neighborhood(of: $0) }
        let domainGraph = knowledgeFocusedDomain.flatMap { graph.graphForDomain($0) }
        let graphToShow = neighborhood ?? domainGraph ?? graph
        let graphScope: HubKnowledgeGraphView.Scope = knowledgeFocusedDomain == HubKnowledgeLayout.archiveID && domainGraph != nil
            ? .archive : neighborhood != nil || domainGraph != nil ? .all : knowledgeScope
        let search = KnowledgeSearch(query: query, scope: knowledgeScope, retry: knowledgeSearchRetry, apiID: api.map { ObjectIdentifier($0) })
        let response = knowledgeSearchResponse.flatMap { $0.request == search ? $0 : nil }
        let records = (query.isEmpty ? (knowledgeTab == .graph ? graphToShow.nodes : graph.nodes) : response?.nodes ?? [])
            .filter { (query.isEmpty && knowledgeTab == .graph ? graphScope : knowledgeScope).includes($0) }
        return ScrollView(.vertical, showsIndicators: true) {
            LazyVStack(alignment: .leading, spacing: 8) {
                if knowledgeRefreshError {
                    Button("Retry refreshing Knowledge") { Task { await refreshKnowledgeGraph() } }
                        .font(.footnote).frame(minHeight: 44)
                }
                Picker("Knowledge view", selection: $knowledgeTab) {
                    Text("Graph").tag(KnowledgeTab.graph)
                    Text("Records").tag(KnowledgeTab.records)
                }
                .pickerStyle(.segmented)
                Picker("Knowledge scope", selection: $knowledgeScope) {
                    ForEach(HubKnowledgeGraphView.Scope.allCases) { scope in Text(scope.rawValue).tag(scope) }
                }
                .pickerStyle(.segmented)
                if knowledgeTab == .graph {
                    knowledgeGraphSection(graph, displayed: graphToShow, neighborhood: neighborhood,
                                          domainGraph: domainGraph, scope: graphScope)
                }
                TextField("Find records", text: $knowledgeQuery).hubSearchField().submitLabel(.search)
                if query.utf16.count > 200 {
                    Text("Use 200 characters or fewer.").foregroundStyle(.secondary)
                } else if !query.isEmpty, let response, response.nodes == nil {
                    Button("Retry searching Knowledge") { knowledgeSearchRetry += 1 }
                } else if response == nil && !query.isEmpty {
                    ProgressView("Searching Knowledge…")
                } else if records.isEmpty {
                    Text("No matching records").foregroundStyle(.secondary)
                }
                ForEach(records, id: \.id) { node in
                    Button { selectKnowledgeNode(node.id) } label: {
                        HStack {
                            Text(node.title ?? "Untitled").lineLimit(2)
                            Spacer()
                            Image(systemName: "chevron.right").font(.caption)
                        }
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("hub.knowledge.record.\(node.id)")
                    Divider()
                }
            }
        }
        .task(id: search) { await searchKnowledge(search, api: api) }
    }

    private func knowledgeGraphSection(
        _ graph: HubHomeKnowledge, displayed: HubHomeKnowledge, neighborhood: HubHomeKnowledge?,
        domainGraph: HubHomeKnowledge?, scope: HubKnowledgeGraphView.Scope
    ) -> some View {
        let canFocus = neighborhood == nil && domainGraph == nil
        let domains = canFocus ? (graph.domains ?? []).filter { $0.status != "merged" } : []
        let onDomain: ((String) -> Void)? = canFocus ? { id in self.focusKnowledgeDomain(id) } : nil
        let canvas = HubKnowledgeGraphView(graph: displayed, height: 400, scope: scope, spatial: knowledgeSpatial,
                                           focusID: neighborhood == nil ? nil : knowledgeLocalCenter,
                                           selectDomain: onDomain, select: selectKnowledgeNode)
        let identity = [scope.rawValue, String(knowledgeSpatial), String(knowledgeLiving), knowledgeLocalCenter ?? "",
                        knowledgeFocusedDomain ?? "", String(knowledgeGraphReset)].joined(separator: "/")
        return VStack(alignment: .leading, spacing: 8) {
            knowledgeGraphHeader(graph, neighborhood: neighborhood, domainGraph: domainGraph)
            Group {
                if knowledgeLiving {
                    HubLivingBrainView(graph: displayed, height: 460, interactive: true, scope: scope,
                                       active: knowledgeOpen && !knowledgeDomainsOpen, nodeLimit: 420,
                                       openRecord: selectKnowledgeNode, openDomain: onDomain)
                        .background(Color(uiColor: HubWorkspacePalette.background).opacity(0.7), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                } else {
                    canvas
                }
            }
            .id(identity).overlay(alignment: .topTrailing) {
                knowledgeGraphMenu(domains: domains, canFocus: canFocus)
            }
            if canFocus, scope != .archive {
                // A legend that doubles as navigation: tap a domain to look inside it.
                let summary = HubKnowledgeLayout.summary(graph)
                if !summary.isEmpty {
                    HubKnowledgeDomainStrip(domains: summary, limit: 12) { id in focusKnowledgeDomain(id) }
                }
            }
        }
    }

    @ViewBuilder private func knowledgeGraphHeader(_ graph: HubHomeKnowledge, neighborhood: HubHomeKnowledge?,
                                                  domainGraph: HubHomeKnowledge?) -> some View {
        if let center = knowledgeLocalCenter, let neighborhood {
            let title = neighborhood.nodes.first { $0.id == center }?.title ?? "Local graph"
            knowledgeScopeHeader(title: title, identifier: "hub.knowledge.leave-local-graph") { knowledgeLocalCenter = nil }
            if neighborhood.edges.isEmpty {
                Text("This record has no connections yet.").font(.footnote).foregroundStyle(.secondary)
            }
        }
        if let domain = knowledgeFocusedDomain, let domainGraph {
            knowledgeScopeHeader(title: domainTitle(domain, in: graph), identifier: "hub.knowledge.leave-domain") { knowledgeFocusedDomain = nil }
            if domainGraph.nodes.isEmpty {
                Text("No records in this domain.").font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    private func knowledgeScopeHeader(title: String, identifier: String, close: @escaping () -> Void) -> some View {
        HStack {
            Button(action: close) { Label("All knowledge", systemImage: "chevron.left") }
                .accessibilityIdentifier(identifier)
            Spacer()
            Text(title).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
    }

    private var knowledgeGraphModeName: String {
        knowledgeLiving ? "Brain" : knowledgeSpatial ? "3D" : "2D"
    }

    private func knowledgeGraphMenu(domains: [HubHomeKnowledge.Domain], canFocus: Bool) -> some View {
        Menu {
            Button("Brain") { knowledgeLiving = true }
            Button("2D") { knowledgeLiving = false; knowledgeSpatial = false }
            Button("3D") { knowledgeLiving = false; knowledgeSpatial = true }
            Button("Reset view") { knowledgeGraphReset += 1 }
            Button("Refresh graph") { Task { await refreshKnowledgeGraph() } }
            if canFocus {
                Section("Focus domain") {
                    ForEach(domains) { domain in Button(domain.title) { focusKnowledgeDomain(domain.id) } }
                    Button("Chat archive") { focusKnowledgeDomain(HubKnowledgeLayout.archiveID) }
                }
            }
        } label: {
            Text(knowledgeGraphModeName).font(.caption.weight(.semibold))
                .padding(.horizontal, 12)
                .frame(minWidth: 44, minHeight: 36)
                .hubGlass(Capsule(), interactive: true)
                .frame(minHeight: 44)
        }
        .padding(6)
        .accessibilityLabel("Graph view")
        .accessibilityValue(knowledgeGraphModeName)
    }

    private func domainTitle(_ id: String, in graph: HubHomeKnowledge) -> String {
        if id == HubKnowledgeLayout.archiveID { return "Chat archive" }
        return graph.domains?.first { $0.id == id }?.title ?? "Domain"
    }

    private func focusKnowledgeDomain(_ id: String) {
        knowledgeLocalCenter = nil
        knowledgeFocusedDomain = id
    }

    private enum KnowledgeTab { case graph, records }

    private struct KnowledgeSearch: Equatable {
        let query: String
        let scope: HubKnowledgeGraphView.Scope
        let retry: Int
        let apiID: ObjectIdentifier?
    }

    private struct KnowledgeSearchResponse {
        let request: KnowledgeSearch
        let nodes: [HubHomeKnowledge.Node]?
    }

    private func searchKnowledge(_ search: KnowledgeSearch, api: HubConversationAPI?) async {
        guard !Task.isCancelled, !search.query.isEmpty, search.query.utf16.count <= 200 else { return }
        guard let api else {
            knowledgeSearchResponse = KnowledgeSearchResponse(request: search, nodes: nil)
            return
        }
        let scope: HubHomeKnowledge.SearchScope = search.scope == .all ? .all : search.scope == .notes ? .brain : .archive
        do {
            try await Task.sleep(nanoseconds: 250_000_000)
            let records = try await api.searchKnowledge(search.query, scope: scope)
            if !Task.isCancelled, chatAPI() === api {
                knowledgeSearchResponse = KnowledgeSearchResponse(request: search, nodes: records)
            }
        } catch {
            if !Task.isCancelled, chatAPI() === api {
                knowledgeSearchResponse = KnowledgeSearchResponse(request: search, nodes: nil)
            }
        }
    }

    @ViewBuilder private var connectionRow: some View {
        switch model.connection {
        case .connected:
            if model.refreshing {
                Text("Updating your workspace…").font(.footnote).foregroundStyle(.secondary)
            } else if model.incomplete {
                Button("Retry loading workspace data", action: connect).font(.footnote)
            }
        case .connecting:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Connecting to HUB…")
            }
            .font(.footnote).foregroundStyle(.secondary)
            .accessibilityIdentifier("hub.home.connecting")
        case .needsSetup, .signInRequired, .unavailable:
            let title = model.connection == .needsSetup ? "Connect to HUB"
                : model.connection == .signInRequired ? "Sign in to HUB" : "Reconnect"
            Button(action: connect) { Label(title, systemImage: "arrow.clockwise") }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("hub.home.connection")
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let error = model.sendError {
                Text(error).font(.footnote).foregroundStyle(.secondary)
            }
            if let notice = dictation.notice {
                Text(notice).font(.footnote).foregroundStyle(.secondary)
                    .accessibilityIdentifier("hub.home.dictation.notice")
            }
            if let id = model.uncertainChat {
                Button("Open conversation to check") { dismissKeyboard { openChat(id) } }
                    .font(.footnote)
                    .disabled(model.connection != .connected)
            }
            HStack(alignment: .bottom, spacing: 3) {
                HubComposerField(text: $model.draft, focus: $composerFocused, identifier: "hub.home.draft") {
                    if canSend {
                        dictation.cancel()
                        dismissKeyboard(then: send)
                    }
                }
                .submitLabel(.send)
                .disabled(model.sending || creatingChat)
                .padding(.leading, 12)
                Menu {
                    startChatAction("Commands & skills", icon: "terminal", action: .commands)
                    startChatAction("Files", icon: "paperclip", action: .files)
                    startChatAction("Photos", icon: "photo", action: .photos)
                    startChatAction("Choose character", icon: "person.crop.circle", action: .characters)
                    startChatAction("Research…", icon: "magnifyingglass", action: .research)
                    startChatAction("Research tasks", icon: "list.bullet.rectangle", action: .researchTasks)
                    startChatAction("Instructions", icon: "doc.text", action: .instructions)
                } label: {
                    Image(systemName: "plus").frame(width: 44, height: 44)
                }
                .accessibilityLabel("More actions")
                .disabled(model.connection != .connected || model.sending || creatingChat || model.uncertainChat != nil)
                HubDictationButton(dictation: dictation, identifier: "hub.home.dictate") {
                    if !dictation.isActive { dictationBase = model.draft }
                    dictation.toggle(api: chatAPI())
                }
                .disabled(!dictation.isActive && (model.sending || creatingChat || model.hasActiveVoice))
                Button {
                    dictation.cancel()
                    dismissKeyboard(then: voice)
                } label: {
                    Image(systemName: "waveform").frame(width: 44, height: 44)
                }
                .accessibilityLabel(model.hasActiveVoice ? "Open voice controls" : "Speak")
                Button {
                    dictation.cancel()
                    dismissKeyboard(then: send)
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.body.weight(.bold))
                        .foregroundColor(canSend ? HubWorkspacePalette.onAccent : HubWorkspacePalette.muted)
                        .frame(width: 40, height: 40)
                        .background(Circle().fill(canSend ? accent : accent.opacity(0.10)))
                        .frame(width: 44, height: 44)
                        .animation(.easeOut(duration: 0.15), value: canSend)
                }
                .accessibilityLabel("Send")
                .accessibilityIdentifier("hub.home.send")
                .disabled(!canSend)
            }
            .buttonStyle(.plain)
            .padding(5)
            .hubGlass(RoundedRectangle(cornerRadius: 26, style: .continuous))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .onReceive(dictation.$text) { spoken in
            if dictation.isActive { model.draft = HubDictationTranscript.join(dictationBase, spoken) }
        }
        .onDisappear { dictation.cancel() }
    }

    private func startChatAction(_ title: LocalizedStringKey, icon: String, action: HubNativeChatRequest.ComposerAction) -> some View {
        Button {
            hideKeyboard()
            Task { await newChat(action: action) }
        } label: { Label(title, systemImage: icon) }
    }

    private var canSend: Bool {
        model.connection == .connected && !model.sending && !creatingChat && model.uncertainChat == nil
            && !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var canEditPlanner: Bool {
        model.connection == .connected && !model.plannerSaving
    }

    private func plannerEditorView(_ selection: PlannerEdit) -> some View {
        HubPlannerEditor(item: selection.item, kind: selection.kind, day: agendaDate, horizon: todoHorizon,
                         save: savePlannerItem, remove: removePlannerItem, openSource: { id in
                             plannerEditor = nil
                             plannerOpen = false
                             openChat(id)
                         })
    }

    private func personalPlanner(_ planner: HubHomePlanner) -> some View {
        let openTodos = planner.items.filter { !$0.deleted && $0.state == "open" && $0.kind == "todo" }
        let nearCount = openTodos.filter { ($0.horizon ?? "near") == "near" }.count
        let laterCount = openTodos.filter { $0.horizon == "later" }.count
        let todayEvents = planner.items.filter { !$0.deleted && $0.state == "open" && $0.kind == "event" && $0.occurs(on: Date()) }.count
        return VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                plannerSwitcher(todos: openTodos.count, events: todayEvents)
                Spacer(minLength: 0)
                Button {
                    hideKeyboard()
                    plannerEditor = PlannerEdit(item: nil, kind: plannerTab == .agenda ? .event : .todo)
                } label: {
                    Image(systemName: "plus").font(.body.weight(.semibold)).frame(width: 40, height: 40)
                        .hubGlassCircle()
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(plannerTab == .agenda ? "Add event" : "Add to-do with details")
                .disabled(!canEditPlanner)
            }
            if plannerTab == .agenda {
                agendaView(planner)
            } else {
                todoList(planner, nearCount: nearCount, laterCount: laterCount)
            }
            if model.plannerSaving { ProgressView().accessibilityLabel("Saving to planner") }
            if let error = model.plannerError {
                Label(error, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.orange)
            }
        }
    }

    /// Agenda | To-dos as a pill switcher, with what each holds today.
    private func plannerSwitcher(todos: Int, events: Int) -> some View {
        HStack(spacing: 2) {
            ForEach(PlannerTab.allCases, id: \.self) { tab in
                let selected = plannerTab == tab
                Button {
                    hideKeyboard()
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { plannerTab = tab }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: tab == .agenda ? "calendar" : "checklist").font(.footnote.weight(.semibold))
                        Text(tab.title).font(.subheadline.weight(.semibold))
                        let count = tab == .agenda ? events : todos
                        if count > 0 {
                            Text(count.formatted()).font(.caption2.weight(.bold).monospacedDigit())
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(Capsule().fill(selected ? HubWorkspacePalette.onAccent.opacity(0.18) : HubWorkspacePalette.border.opacity(0.1)))
                        }
                    }
                    .foregroundStyle(selected ? HubWorkspacePalette.onAccent : Color.primary.opacity(0.75))
                    .padding(.horizontal, 14)
                    .frame(minHeight: 40)
                    .background {
                        if selected {
                            Capsule().fill(accent).matchedGeometryEffect(id: "plannerTab", in: plannerNamespace)
                        }
                    }
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier(tab == .agenda ? "hub.planner.agenda" : "hub.planner.todos")
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(3)
        .background(Capsule().fill(HubWorkspacePalette.border.opacity(0.07)))
        .frame(minHeight: 44)
    }

    private func agendaView(_ planner: HubHomePlanner) -> some View {
        let calendar = Calendar.current
        let open = planner.items.filter { !$0.deleted && $0.state == "open" && $0.kind == "event" }
        let events = open.filter { $0.occurs(on: agendaDate) }.sorted { ($0.start ?? "") < ($1.start ?? "") }
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 4) {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { calendarExpanded.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Text(agendaDate.formatted(.dateTime.month(.wide).year())).font(.headline)
                        Image(systemName: "chevron.down").font(.caption.weight(.bold))
                            .rotationEffect(.degrees(calendarExpanded ? 180 : 0))
                            .foregroundStyle(accent)
                    }
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(calendarExpanded ? "Collapse calendar" : "Expand calendar")
                Spacer()
                if !calendar.isDateInToday(agendaDate) {
                    Button("Today") { withAnimation { agendaDate = Date() } }
                        .font(.footnote.weight(.semibold)).buttonStyle(.plain).foregroundStyle(accent)
                        .padding(.horizontal, 8).frame(minHeight: 44)
                }
                if !calendarExpanded {
                    weekStep(-7, icon: "chevron.left", label: "Previous week")
                    weekStep(7, icon: "chevron.right", label: "Next week")
                }
            }
            if calendarExpanded {
                DatePicker("Choose a day", selection: $agendaDate, displayedComponents: .date)
                    .datePickerStyle(.graphical).labelsHidden()
            } else {
                agendaWeek(busyDays: open)
            }
            Text(agendaDate.formatted(.dateTime.weekday(.wide).day().month(.wide)))
                .font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                .padding(.top, 2)
            if events.isEmpty {
                HStack(spacing: 12) {
                    Image(systemName: "sun.max").font(.title3).foregroundStyle(accent.opacity(0.8))
                        .frame(width: 40, height: 40).background(Circle().fill(accent.opacity(0.12)))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("No plans for this day.").font(.subheadline)
                        Text("Tap + to add an event.").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            } else {
                VStack(spacing: 8) {
                    ForEach(events) { item in eventRow(item) }
                }
            }
        }
    }

    private func weekStep(_ days: Int, icon: String, label: LocalizedStringKey) -> some View {
        Button {
            withAnimation(.easeInOut(duration: 0.2)) {
                agendaDate = Calendar.current.date(byAdding: .day, value: days, to: agendaDate) ?? agendaDate
            }
        } label: {
            Image(systemName: icon).font(.footnote.weight(.semibold)).frame(width: 34, height: 34)
                .hubGlassCircle().frame(width: 44, height: 44)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private func eventRow(_ item: HubHomePlanner.Item) -> some View {
        let zone = item.timeZone.flatMap(TimeZone.init(identifier:)) ?? .current
        let start = HubPlannerDraft.parseInstant(item.start)
        let end = HubPlannerDraft.parseInstant(item.end)
        let tone = Color(hue: HubBrainSimulation.unit(item.id) * 0.25 + 0.55, saturation: 0.55, brightness: 0.95)
        return Button {
            plannerEditor = PlannerEdit(item: item, kind: .event)
        } label: {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .trailing, spacing: 2) {
                    if let start {
                        Text(start, style: .time).font(.subheadline.weight(.semibold).monospacedDigit())
                        if let end { Text(end, style: .time).font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
                    } else {
                        Text("All day").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    }
                }
                .environment(\.timeZone, zone)
                .frame(width: 58, alignment: .trailing)
                Capsule().fill(tone).frame(width: 4).frame(minHeight: 34)
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.title).font(.subheadline.weight(.medium)).lineLimit(2).multilineTextAlignment(.leading)
                    if let details = item.details?.trimmingCharacters(in: .whitespacesAndNewlines), !details.isEmpty {
                        Text(details).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(10)
            .frame(minHeight: 44)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(tone.opacity(0.08)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!canEditPlanner || item.version == nil)
    }

    private func agendaWeek(busyDays events: [HubHomePlanner.Item]) -> some View {
        let calendar = Calendar.current
        let offset = ((calendar.dateComponents([.weekday], from: agendaDate).weekday ?? 2) + 5) % 7
        let first = calendar.date(byAdding: .day, value: -offset, to: agendaDate) ?? agendaDate
        let days = (0..<7).compactMap { calendar.date(byAdding: .day, value: $0, to: first) }
        return HStack(spacing: 4) {
            ForEach(days, id: \.self) { day in
                let selected = calendar.isDate(day, inSameDayAs: agendaDate)
                let today = calendar.isDateInToday(day)
                let busy = events.contains { $0.occurs(on: day) }
                Button {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { agendaDate = day }
                } label: {
                    VStack(spacing: 5) {
                        Text(day.formatted(.dateTime.weekday(.narrow))).font(.caption2.weight(.medium))
                            .foregroundStyle(selected ? HubWorkspacePalette.onAccent.opacity(0.8) : .secondary)
                        Text(day.formatted(.dateTime.day())).font(.callout.weight(selected || today ? .bold : .regular).monospacedDigit())
                            .foregroundStyle(selected ? HubWorkspacePalette.onAccent : today ? accent : .primary)
                        Circle().fill(selected ? HubWorkspacePalette.onAccent : accent).frame(width: 4, height: 4).opacity(busy ? 1 : 0)
                    }
                    .frame(maxWidth: .infinity, minHeight: 58)
                    .background {
                        if selected {
                            RoundedRectangle(cornerRadius: 14, style: .continuous).fill(accent)
                                .matchedGeometryEffect(id: "agendaDay", in: plannerNamespace)
                        } else if today {
                            RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(accent.opacity(0.5), lineWidth: 1)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(day.formatted(date: .complete, time: .omitted) + (busy ? ", has plans" : ""))
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
    }

    private func todoList(_ planner: HubHomePlanner, nearCount: Int, laterCount: Int) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                horizonChip(.near, count: nearCount)
                horizonChip(.later, count: laterCount)
                Spacer()
            }
            .onChange(of: todoHorizon) { _ in todoDraftID = UUID() }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("To-do list")
            quickTodo
            let items = planner.items.filter {
                !$0.deleted && $0.state == "open" && $0.kind == "todo" && ($0.horizon ?? "near") == todoHorizon.rawValue
            }.sorted { ($0.date ?? "9999") < ($1.date ?? "9999") }
            if items.isEmpty {
                HStack(spacing: 12) {
                    Image(systemName: todoHorizon == .near ? "checkmark.seal" : "sparkles").font(.title3)
                        .foregroundStyle(accent.opacity(0.8))
                        .frame(width: 40, height: 40).background(Circle().fill(accent.opacity(0.12)))
                    Text(todoHorizon == .near ? "All clear. Add something you want to get done." : "Keep your longer-term plans here.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                        if index > 0 { Divider().padding(.leading, 48) }
                        todoRow(item)
                    }
                }
            }
            let past = planner.items.filter { $0.deleted || $0.state == "done" }
                .sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
            if !past.isEmpty {
                DisclosureGroup {
                    ForEach(past.prefix(50)) { item in
                        HStack(spacing: 10) {
                            Image(systemName: item.deleted ? "trash" : "checkmark.circle.fill")
                                .foregroundStyle(item.deleted ? Color.secondary : Color.green.opacity(0.8))
                            Text(item.title).lineLimit(2).hubStrikethrough(!item.deleted).foregroundStyle(.secondary)
                            Spacer()
                            Button(item.deleted ? "Restore" : "Reopen") { restorePlannerItem(item) }
                                .font(.footnote.weight(.semibold))
                                .disabled(!canEditPlanner || item.version == nil)
                                .frame(minHeight: 44)
                        }
                    }
                } label: {
                    Text("Completed & removed · \(past.count)").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func horizonChip(_ horizon: HubHomePlanner.Horizon, count: Int) -> some View {
        let selected = todoHorizon == horizon
        return Button {
            withAnimation(.easeInOut(duration: 0.18)) { todoHorizon = horizon }
        } label: {
            HStack(spacing: 5) {
                Text(horizon == .near ? "Soon" : "Later").font(.footnote.weight(.semibold))
                if count > 0 { Text(count.formatted()).font(.caption2.weight(.bold).monospacedDigit()).opacity(0.7) }
            }
            .foregroundStyle(selected ? accent : Color.secondary)
            .padding(.horizontal, 12)
            .frame(minHeight: 32)
            .background(Capsule().fill(selected ? accent.opacity(0.16) : HubWorkspacePalette.border.opacity(0.05)))
            .overlay(Capsule().strokeBorder(selected ? accent.opacity(0.35) : .clear, lineWidth: 0.8))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(model.plannerSaving)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func todoRow(_ item: HubHomePlanner.Item) -> some View {
        let done = completingTodos.contains(item.id)
        return HStack(spacing: 6) {
            Button {
                guard !done else { return }
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                withAnimation(.spring(response: 0.3, dampingFraction: 0.6)) { _ = completingTodos.insert(item.id) }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
                    completeTodo(item)
                    completingTodos.remove(item.id)
                }
            } label: {
                Image(systemName: done ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(done ? Color.green : HubWorkspacePalette.muted)
                    .scaleEffect(done ? 1.12 : 1)
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Complete \(item.title)")
            Button {
                plannerEditor = PlannerEdit(item: item, kind: .todo)
            } label: {
                HStack(spacing: 8) {
                    Text(item.title).font(.subheadline).lineLimit(2).multilineTextAlignment(.leading)
                        .hubStrikethrough(done).foregroundStyle(done ? Color.secondary : Color.primary)
                    Spacer(minLength: 4)
                    if let due = item.date { dueChip(due) }
                    if item.sourceSessionId != nil {
                        Image(systemName: "bubble.left").font(.caption2).foregroundStyle(.secondary)
                            .accessibilityLabel("From a chat")
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .accessibilityIdentifier("hub.planner.todo.\(item.id)")
        }
        .buttonStyle(.plain)
        .disabled(!canEditPlanner || item.version == nil)
        .contextMenu {
            Button { plannerEditor = PlannerEdit(item: item, kind: .todo) } label: { Label("Edit", systemImage: "pencil") }
            Button { completeTodo(item) } label: { Label("Mark done", systemImage: "checkmark.circle") }
            Button(role: .destructive) { Task { _ = await removePlannerItem(item) } } label: { Label("Delete", systemImage: "trash") }
        }
    }

    /// "Today", "Tomorrow", "Overdue" or a short date for a to-do's day.
    private func dueChip(_ day: String) -> some View {
        let parser = DateFormatter()
        parser.calendar = Calendar(identifier: .gregorian)
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.dateFormat = "yyyy-MM-dd"
        let date = parser.date(from: day)
        let calendar = Calendar.current
        let label: String, tone: Color
        if let date {
            if calendar.isDateInToday(date) { label = NSLocalizedString("Today", comment: "To-do due today"); tone = accent }
            else if calendar.isDateInTomorrow(date) { label = NSLocalizedString("Tomorrow", comment: "To-do due tomorrow"); tone = .secondary }
            else if date < calendar.startOfDay(for: Date()) { label = NSLocalizedString("Overdue", comment: "To-do past its day"); tone = .red }
            else { label = date.formatted(.dateTime.day().month(.abbreviated)); tone = .secondary }
        } else {
            label = day; tone = .secondary
        }
        return Text(label).font(.caption2.weight(.semibold)).foregroundStyle(tone)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(Capsule().fill(tone.opacity(0.12)))
    }

    private var quickTodo: some View {
        let empty = todoDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return HStack(spacing: 8) {
            Image(systemName: "plus.circle.fill").font(.title3).foregroundStyle(accent.opacity(0.85))
                .accessibilityHidden(true)
            TextField("What needs doing?", text: $todoDraft,
                      prompt: Text(todoHorizon == .near ? "Add a to-do" : "Add something for later").foregroundColor(HubWorkspacePalette.muted))
                .focused($todoFocused)
                .frame(minHeight: 44)
                .submitLabel(.done)
                .onSubmit(submitTodo)
                .onChange(of: todoDraft) { _ in todoDraftID = UUID() }
                .accessibilityLabel("What needs doing?")
            Button {
                if empty {
                    hideKeyboard()
                    plannerEditor = PlannerEdit(item: nil, kind: .todo)
                } else { submitTodo() }
            } label: {
                Image(systemName: empty ? "slider.horizontal.3" : "arrow.up")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(empty ? HubWorkspacePalette.muted : HubWorkspacePalette.onAccent)
                    .frame(width: 34, height: 34)
                    .background(Circle().fill(empty ? HubWorkspacePalette.border.opacity(0.08) : accent))
                    .frame(width: 44, height: 44)
                    .animation(.easeOut(duration: 0.15), value: empty)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(empty ? "Add with details" : "Add")
        }
        .padding(.leading, 12)
        .padding(.trailing, 2)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(HubWorkspacePalette.border.opacity(0.06)))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(
            todoFocused ? accent.opacity(0.5) : HubWorkspacePalette.border.opacity(0.08), lineWidth: 0.8))
        .disabled(!canEditPlanner)
    }

    private func submitTodo() {
        let title = todoDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canEditPlanner, !title.isEmpty else { return }
        let id = todoDraftID
        let horizon = todoHorizon
        todoFocused = false
        Task {
            if await addTodo(id, title, horizon), id == todoDraftID { todoDraft = "" }
        }
    }

    private func section<Content: View>(_ title: LocalizedStringKey, icon: String? = nil, actionLabel: LocalizedStringKey = "Open", open: (() -> Void)? = nil,
                                        @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if let icon {
                    Image(systemName: icon)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(accent)
                        .frame(width: 26, height: 26)
                        .background(accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .accessibilityHidden(true)
                }
                Text(title)
                    .font(.headline)
                    .accessibilityAddTraits(.isHeader)
                if let open {
                    Spacer()
                    Button(action: open) { Text(actionLabel).font(.footnote).foregroundStyle(accent).frame(minHeight: 40) }
                        .buttonStyle(.plain)
                        .accessibilityLabel(Text(actionLabel))
                }
            }
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .hubCard()
    }

}

@MainActor
private struct HubVoiceHistoryView: View {
    let api: HubConversationAPI
    let recent: [HubConversationChoice]
    let open: (HubConversationChoice) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var items: [HubVoiceHistoryItem]?
    @State private var busy = false
    @State private var failed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Voice History").font(.headline)
                Spacer()
                Button("Done") { dismiss() }
            }
            .padding(.horizontal, 16)
            if failed {
                Button("Retry voice history") { Task { await load() } }.padding(.horizontal, 16)
            }
            if let items {
                if items.isEmpty {
                    Text("No voice conversations yet.").foregroundStyle(.secondary).padding(.horizontal, 16)
                    Spacer()
                } else {
                    List(items) { item in
                        row(item)
                    }
                    .listStyle(.plain)
                }
            } else if !failed {
                ProgressView("Loading voice conversations…").padding(.horizontal, 16)
                Spacer()
            }
        }
        .padding(.top, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .hubBackdrop()
        .task { await load() }
    }

    private func row(_ item: HubVoiceHistoryItem) -> some View {
        let choice = recent.first(where: { $0.sessionId == item.sessionId })
            ?? HubConversationChoice(sessionId: item.sessionId, title: "Voice conversation", updatedAt: item.createdAt)
        return HStack {
            Button {
                open(choice)
            } label: {
                VStack(alignment: .leading, spacing: 4) {
                    Text(choice.title).lineLimit(2)
                    Text(Date(timeIntervalSince1970: item.createdAt / 1000).formatted()).font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            }
            .buttonStyle(.borderless)
            if !item.saved {
                Button("Save") { Task { await save(item.sessionId) } }
                    .buttonStyle(.borderless)
                    .disabled(busy)
            }
        }
    }

    private func load() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do { items = try await api.voiceHistory(); failed = false }
        catch { if !Task.isCancelled { failed = true } }
    }

    private func save(_ id: String) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            try await api.saveVoiceConversation(sessionID: id)
            items = try await api.voiceHistory()
            failed = false
        } catch { failed = true }
    }
}

@MainActor
private struct HubTasksView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var tasks: HubWorkspaceTasks?
    @State private var failed = false
    @State private var attempt = 0
    @State private var changing = false
    @State private var changeError = false
    @State private var pending: PendingAction?
    @State private var taskEditor: TaskEdit?
    @State private var exportingOutput = false
    @State private var output: HubWorkspaceTask.OutputFile?
    @State private var outputError: String?
    @State private var loadingOutput: String?
    var load: () async throws -> HubWorkspaceTasks
    let api: HubConversationAPI
    let openChat: (HubConversationChoice) -> Void

    private struct PendingAction {
        let action: HubWorkspaceTaskAction
        let label: String
        let task: HubWorkspaceTask
        let routine: Bool
        var approvalID: String?
        var approvalDescription: String?
    }

    private struct TaskEdit: Identifiable {
        let id = UUID()
        let taskID: String?
        let routine: Bool
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Tasks").font(.headline).accessibilityAddTraits(.isHeader)
                Spacer()
                Button("Done") { dismiss() }
            }
            if let tasks {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        taskSection("Goals", tasks.goals, routine: false)
                        taskSection("Routines", tasks.routines, routine: true)
                    }
                }
                Button("Refresh") { attempt += 1 }
                if let outputError { Text(outputError).font(.footnote).foregroundStyle(.secondary) }
                if changeError { Text("Could not confirm the change. Refresh the task before trying again.").font(.footnote) }
            } else if failed {
                Button("Retry loading tasks") { failed = false; attempt += 1 }
            } else {
                ProgressView("Loading tasks…")
            }
        }
        .task(id: attempt) {
            do {
                let result = try await load()
                if !Task.isCancelled { tasks = result; failed = false }
            } catch {
                if !Task.isCancelled { tasks = nil; failed = true }
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .foregroundStyle(.primary)
        .hubBackdrop()
        .sheet(item: $taskEditor) { edit in
            if edit.routine {
                HubRoutineEditorView(api: api, id: edit.taskID, goals: tasks?.goals ?? []) { attempt += 1 }
            } else {
                HubGoalEditorView(api: api, id: edit.taskID) { attempt += 1 }
            }
        }
        .fileExporter(isPresented: $exportingOutput, document: output.map { HubFileDocument(bytes: $0.data) },
                      contentType: output.flatMap { UTType(filenameExtension: ($0.name as NSString).pathExtension) } ?? .data,
                      defaultFilename: output?.name, onCompletion: { result in
            output = nil
            if case .failure = result { outputError = "Could not save the file to the chosen location." }
        })
        .confirmationDialog(pending?.label ?? "Confirm task action",
                            isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
                            titleVisibility: .visible, presenting: pending) { command in
            Button(command.label, role: destructive(command.action) ? .destructive : nil) {
                Task { await change(command) }
            }
        } message: { command in
            Text(command.approvalDescription ?? command.task.title)
        }
    }

    private func taskSection(_ title: String, _ items: [HubWorkspaceTask], routine: Bool) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(title).font(.headline).accessibilityAddTraits(.isHeader)
                Spacer()
                Button { taskEditor = TaskEdit(taskID: nil, routine: routine) } label: {
                    Label(routine ? "New routine" : "New goal", systemImage: "plus").frame(minHeight: 44)
                }
            }
            let visible = items.filter { $0.state != "archived" }.sorted { $0.updatedAt > $1.updatedAt }
            if visible.isEmpty { Text("No \(title.lowercased())").foregroundStyle(.secondary) }
            ForEach(visible) { task in
                DisclosureGroup {
                    if let detail = task.objective ?? task.prompt { Text(detail).textSelection(.enabled) }
                    if let reason = task.reason ?? task.lastError { Text(reason).font(.footnote).foregroundStyle(.secondary) }
                    if let nextAt = task.nextAt, task.state == "active" {
                        Text(Date(timeIntervalSince1970: nextAt / 1_000).formatted()).foregroundStyle(.secondary)
                    }
                    taskDetails(task, routine: routine)
                    taskActions(task, routine: routine)
                    if (routine ? !["running", "checking"].contains(task.status) : !["stopped", "archived"].contains(task.state)) {
                        Button(routine ? "Edit routine" : "Edit goal") {
                            taskEditor = TaskEdit(taskID: task.id, routine: routine)
                        }
                        .frame(minHeight: 44)
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(task.title).font(.body.weight(.medium))
                        HStack(spacing: 6) {
                            Circle().fill(hubTaskStatusColor(task.status)).frame(width: 7, height: 7).accessibilityHidden(true)
                            Text(hubTaskStatusLabel(task.status)).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .frame(minHeight: 44, alignment: .leading)
                }
                Divider()
            }
        }
    }

    @ViewBuilder private func taskDetails(_ task: HubWorkspaceTask, routine: Bool) -> some View {
        if let checkpoint = task.checkpoint {
            DisclosureGroup("Checkpoint") {
                Text(checkpoint.summary).textSelection(.enabled)
                Text(checkpoint.nextAction).font(.footnote)
                if let result = checkpoint.result { Text(result).textSelection(.enabled) }
            }
        }
        if let plan = task.plan, !plan.isEmpty {
            DisclosureGroup("Milestones") {
                ForEach(plan) { step in
                    Label(step.title, systemImage: step.status == "done" ? "checkmark.circle" : "circle")
                }
            }
        }
        if let evidence = task.evidence, !evidence.isEmpty {
            DisclosureGroup("Evidence & output") {
                ForEach(evidence.reversed()) { entry in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(entry.label).font(.subheadline.weight(.semibold))
                        Text(Date(timeIntervalSince1970: entry.at / 1_000).formatted()).font(.caption).foregroundStyle(.secondary)
                        Text(entry.detail).textSelection(.enabled)
                        if entry.kind == "file", entry.sha256 != nil {
                            Button(loadingOutput == entry.id ? "Preparing file…" : "Save to Files") {
                                Task { await saveOutput(task, evidence: entry) }
                            }
                            .disabled(loadingOutput != nil || exportingOutput)
                        }
                    }
                    .padding(.vertical, 5)
                }
            }
        }
        if let runs = task.runs ?? task.rounds, !runs.isEmpty {
            DisclosureGroup("Runs") {
                ForEach(Array(runs.suffix(20).reversed())) { run in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(run.status.capitalized).font(.subheadline.bold())
                        Text(Date(timeIntervalSince1970: run.at / 1000).formatted()).font(.caption)
                        Text("Estimated cost $\(run.estimatedCost, specifier: "%.4f")").font(.caption)
                        if let detail = run.result ?? run.summary ?? run.error {
                            Text(detail).lineLimit(4)
                        }
                        Button("Open work session") {
                            openChat(HubConversationChoice(sessionId: run.sessionId, title: task.title, updatedAt: run.at))
                        }
                    }
                    .padding(.vertical, 6)
                }
            }
        }
        if !routine, let approvals = task.approvals?.filter({ $0.status == "pending" }), !approvals.isEmpty {
            DisclosureGroup("Pending approvals") {
                ForEach(approvals) { approval in
                    Text(approval.description)
                    Text(approval.tool).font(.caption)
                    if let arguments = approval.arguments, !arguments.displayText.isEmpty {
                        Text(arguments.displayText).font(.footnote.monospaced()).textSelection(.enabled)
                        taskAction("Approve once", action: .approve, task: task, routine: false, approval: approval)
                    }
                    taskAction("Deny request", action: .deny, task: task, routine: false, approval: approval)
                }
            }
        }
    }

    private func saveOutput(_ task: HubWorkspaceTask, evidence: HubWorkspaceTask.Evidence) async {
        guard loadingOutput == nil, !exportingOutput else { return }
        output = nil
        loadingOutput = evidence.id
        outputError = nil
        defer { loadingOutput = nil }
        do {
            output = try await api.workspaceTaskOutput(goalID: task.id, evidence: evidence)
            exportingOutput = true
        } catch {
            outputError = "Could not retrieve the verified file. Refresh the goal and try again."
        }
    }

    @ViewBuilder private func taskActions(_ task: HubWorkspaceTask, routine: Bool) -> some View {
        if task.state == "active" { taskAction("Pause", action: .pause, task: task, routine: routine) }
        if task.state == "paused" { taskAction("Resume", action: .resume, task: task, routine: routine) }
        if task.status == "waiting-credit" {
            taskAction("Credits restored", action: .resumeCredit, task: task, routine: routine)
        }
        if routine {
            if task.state != "cancelled" {
                taskAction("Run once", action: .runOnce, task: task, routine: true)
                taskAction("Cancel routine", action: .cancel, task: task, routine: true)
            }
        } else {
            if task.state == "draft" { taskAction("Start goal", action: .start, task: task, routine: false) }
            if ["active", "paused", "draft"].contains(task.state) {
                taskAction("Stop goal", action: .stop, task: task, routine: false)
            }
            if ["completed", "stopped"].contains(task.state) {
                taskAction("Archive goal", action: .archive, task: task, routine: false)
            }
            if task.status == "needs-approval", task.approvals?.contains(where: { $0.status == "pending" }) != true {
                taskAction("Accept result", action: .acceptResult, task: task, routine: false)
            }
        }
    }

    private func taskAction(_ label: String, action: HubWorkspaceTaskAction, task: HubWorkspaceTask,
                            routine: Bool, approval: HubWorkspaceTask.Approval? = nil) -> some View {
        Button(label) {
            let command = PendingAction(action: action, label: label, task: task, routine: routine,
                                        approvalID: approval?.id, approvalDescription: approval?.description)
            if action == .pause { Task { await change(command) } }
            else { pending = command }
        }
        .disabled(changing || (routine ? tasks?.routinesRevision : task.revision) == nil)
    }

    private func destructive(_ action: HubWorkspaceTaskAction) -> Bool {
        [.stop, .archive, .cancel, .deny].contains(action)
    }

    private func change(_ command: PendingAction) async {
        guard !changing, let revision = command.routine ? tasks?.routinesRevision : command.task.revision else { return }
        changing = true
        changeError = false
        defer { changing = false }
        do {
            try await api.changeWorkspaceTask(command.action, id: command.task.id, revision: revision,
                                              routine: command.routine, approvalID: command.approvalID)
        }
        catch { changeError = true }
        attempt += 1
    }
}

struct HubFileDocument: FileDocument {
    static let readableContentTypes: [UTType] = [.data]
    let bytes: Data

    init(bytes: Data) { self.bytes = bytes }
    init(configuration: ReadConfiguration) throws {
        guard let bytes = configuration.file.regularFileContents else { throw CocoaError(.fileReadCorruptFile) }
        self.bytes = bytes
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: bytes) }
}

/// A project's name, instructions and shared note. Every chat in the project
/// reads the instructions and note; HUB keeps the note up to date as you work.
struct HubProjectSettingsView: View {
    let project: HubProject
    let save: (HubProjectChange) async throws -> HubProjectsSnapshot?
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var instructions: String
    @State private var note: String
    @State private var saving = false
    @State private var failure: String?

    init(project: HubProject, save: @escaping (HubProjectChange) async throws -> HubProjectsSnapshot?) {
        self.project = project
        self.save = save
        _name = State(initialValue: project.name)
        _instructions = State(initialValue: project.instructions)
        _note = State(initialValue: project.note)
    }

    private var changed: Bool {
        name.trimmingCharacters(in: .whitespacesAndNewlines) != project.name || instructions != project.instructions || note != project.note
    }

    var body: some View {
        NavigationView {
            HubForm {
                Section("Name") {
                    TextField("Project name", text: $name).accessibilityIdentifier("hub.project.name")
                }
                Section {
                    TextEditor(text: $instructions)
                        .frame(minHeight: 120)
                        .accessibilityIdentifier("hub.project.instructions")
                } header: { Text("Instructions") } footer: {
                    Text("How HUB should work in this project, for example \"Answer in Turkish, be formal, the deadline is 1 March.\"")
                }
                Section {
                    TextEditor(text: $note)
                        .font(.callout.monospaced())
                        .frame(minHeight: 220)
                        .accessibilityIdentifier("hub.project.note")
                } header: { Text("Project note") } footer: {
                    Text("Shared memory for every chat in this project. HUB updates it as decisions and progress come up.")
                }
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Folder on your PC").font(.subheadline)
                        Text(project.folder).font(.footnote).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                    HStack {
                        Text("Chats")
                        Spacer()
                        Text("\(project.sessionIds.count)").foregroundStyle(.secondary)
                    }
                }
                if let failure {
                    Section { Text(failure).foregroundStyle(.red).font(.footnote) }
                }
            }
            .navigationTitle(project.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await commit() } }
                        .disabled(!changed || saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .interactiveDismissDisabled(changed)
        }
        .navigationViewStyle(.stack)
    }

    private func commit() async {
        saving = true
        defer { saving = false }
        failure = nil
        do {
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed != project.name { _ = try await save(.rename(id: project.id, name: trimmed)) }
            if instructions != project.instructions { _ = try await save(.instructions(id: project.id, text: instructions)) }
            if note != project.note { _ = try await save(.note(id: project.id, text: note)) }
            dismiss()
        } catch {
            failure = "Could not save. Check the connection and try again; your text is still here."
        }
    }
}