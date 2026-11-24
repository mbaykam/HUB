import SwiftUI
import UIKit
import HubNative
import UniformTypeIdentifiers
import PhotosUI
import AVFoundation
import ImageIO

struct HubChatAttachmentContext {
    let server: HubServer
    let store: HubAttachmentStore
    let upload: HubAttachmentAPI
}

@MainActor
struct HubLiveChatView: View {
    let chat: HubConversationChoice
    let api: HubConversationAPI
    let back: (String) -> Void
    let voice: () -> Void
    /// Starts a video call in this chat (a voice call with the live camera).
    let videoCall: () -> Void
    /// Starts a call that speaks into this chat, sharing the screen or camera when asked.
    var voiceInChat: (HubVoiceCallControl?) -> Void = { _ in }
    let openChat: (HubConversationChoice) -> Void
    let attachments: () -> HubChatAttachmentContext?
    let requestID: UUID
    let initialDraft: String
    let composerAction: HubNativeChatRequest.ComposerAction?
    let preferences: HubChatPreferences
    /// A call is running: its bar carries the camera, so the header doesn't.
    var callActive = false
    let renamed: (String) -> Void
    @ObservedObject private var activity = HubAppActivity.shared
    @FocusState private var composerFocused: Bool
    @StateObject private var dictation = HubDictation()
    @State private var dictationBase = ""
    @State private var snapshot: HubChatSnapshot?
    @State private var screenshots: [HubChatScreenshot] = []
    @State private var screenshotListFailed = false
    @State private var screenshotRetry = 0
    @State private var draft = ""
    @State private var openedInitialAction = false
    @State private var connectionLost = false
    @State private var reconnecting = false
    @State private var attempt = 0
    @State private var sending = false
    @State private var awaitingAfter: String?
    @State private var deliveryUncertain = false
    @State private var stopRequest: StopRequest?
    @State private var error: String?
    @State private var history = HubChatHistoryWindow()
    @State private var openedOutput: HubChatSentFile?
    private var olderMessages: [HubChatMessage] { history.messages }
    private var olderActivity: [HubChatActivity] { history.activity }
    private var olderUsage: [Int: HubChatTurnUsage] { history.usageByTurn }
    private var historyLoading: Bool { history.loading != nil }
    private var historyError: Bool { history.failed }
    @State private var historyRequest = 0
    @State private var historyAnchor: String?
    @State private var readingLatest = true
    @State private var historyTopVisible = false
    /// The chat's normal and unrestricted models, for the lock and retry.
    @State private var modelSlots: HubChatCharacterPicker?
    @State private var slotBusy = false
    /// Helpers this chat started, newest first.
    @State private var helpers: [HubHomeWork.Helper] = []
    @State private var helpersOpen = false
    @State private var openHelper: HubHomeWork.Helper?
    /// Emails the assistant wrote for the user to send from their mail app.
    @State private var mailDrafts: [HubMailState.Draft] = []
    @State private var speedSentAt: Date?
    @State private var speedFirstAt: Date?
    @State private var speedModel: String?
    @State private var speedOpen = false
    @State private var latestVisible = false
    /// Height of the chat's content and whether a finger is on it, to catch a
    /// view left scrolled past its end when content gets shorter.
    @State private var contentHeight: CGFloat = 0
    @State private var dragging = false
    @State private var bottomRequest = 0
    @State private var characterPickerOpen = false
    @State private var character: String?
    @State private var researchMode: ResearchMode?
    @State private var filePickerOpen = false
    @State private var photoPickerOpen = false
    @State private var fileDrafts: [HubAttachmentDraft] = []
    @State private var attachmentBusy = false
    @State private var instructionsOpen = false
    @State private var appsOpen = false
    @State private var tab = ChatTab.chat
    @State private var latestVisual: HubChatPresentation?
    @State private var requestedVisual: HubChatPresentation?
    @State private var loadedVisual: LoadedVisual?
    @State private var seenVisualID: UUID?
    @State private var visualExpanded = false
    @State private var followVisuals = true
    @State private var visualLoadFailed = false
    @State private var visualRetry = 0
    @State private var visualReset = UUID()
    @State private var modelPickerOpen = false
    @State private var selectedModel: HubChatModelSelection?
    @State private var renamedTitle: String?
    @State private var renameOpen = false
    @State private var renameDraft = ""
    @State private var renaming = false
    @State private var branching = false
    @State private var commandsOpen = false
    @State private var focusAfterCommandPick = false
    @State private var queuedMessages: [HubQueuedChatMessage]?
    @State private var queueAvailable = true
    @State private var queueEdit: HubQueuedChatMessage?
    @State private var queueDraft = ""
    @State private var queueBusy = false
    /// The message just sent, shown at once until HUB's copy of it arrives,
    /// so a sent message never seems to vanish while HUB gets ready.
    @State private var echo: SentEcho?
    /// This chat as it was last time, shown at once until the live copy arrives.
    @State private var cachedMessages: [HubChatMessage]?
    /// The live PC screen, shown above the chat while the user wants it.
    @State private var screenOpen = false
    @ScaledMetric(relativeTo: .body) private var transcriptScale: CGFloat = 1

    private struct SentEcho: Equatable {
        let text: String
        let attachments: Int
        /// The newest user message before this one was sent.
        let after: String
    }

    private struct LoadedVisual {
        let summary: HubChatPresentation
        let document: String
    }

    private struct VisualLoad: Equatable {
        let id: UUID?
        let retry: Int
    }

    private struct StopRequest: Equatable {
        let id = UUID()
        let priorEnd: Int?
    }

    private struct ScreenshotLoad: Equatable {
        let sequence: Int?
        let retry: Int
    }

    private enum ChatTab: String { case chat = "Chat", trajectory = "Trajectory" }

    private enum ResearchMode: String, Identifiable {
        case new, jobs
        var id: Self { self }
    }

    private let panel = HubWorkspacePalette.panel
    private let accent = HubWorkspacePalette.accent

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 0) {
                chatHeader
                if screenOpen {
                    HubScreenLiveCard(api: api, open: $screenOpen, visible: true)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 6)
                }
                if tab == .chat { transcript }
                else { trajectory }
            }
            .frame(height: visualExpanded ? 0 : nil)
            .clipped()
            .allowsHitTesting(!visualExpanded)
            .accessibilityHidden(visualExpanded)
            if tab == .chat, let requestedVisual {
                visualCard(requestedVisual)
                    .frame(height: composerFocused ? 0 : nil)
                    .clipped()
                    .allowsHitTesting(!composerFocused)
                    .accessibilityHidden(composerFocused)
            }
            if !visualExpanded { composer }
        }
        .task(id: activity.isActive && tab == .chat) {
            if activity.isActive && tab == .chat { await followPresentations() }
        }
        .task(id: VisualLoad(id: activity.isActive ? requestedVisual?.id : nil, retry: visualRetry)) {
            if activity.isActive, let requestedVisual, loadedVisual?.summary.id != requestedVisual.id {
                await loadVisual(requestedVisual)
            }
        }
        .task(id: attempt) { await follow() }
        .onChange(of: activity.isActive) { active in
            if active && connectionLost { reconnect() }
        }
        .task(id: historyRequest) {
            if historyRequest != 0 { await loadEarlierMessages() }
        }
        .task(id: snapshot?.running) { await loadModelSlots() }
        .task { await followHelpers() }
        // Speed meter: first words, then end of the reply.
        .onChange(of: snapshot?.partial.isEmpty == false || snapshot?.messages.last?.role == "assistant") { started in
            if started, speedSentAt != nil, speedFirstAt == nil { speedFirstAt = Date() }
        }
        .onChange(of: snapshot?.running) { running in
            guard running == false, let sent = speedSentAt else { return }
            let first = speedFirstAt ?? Date()
            let turn = snapshot?.latestMessageTurn
            let tokens = turn.flatMap { snapshot?.usageByTurn[$0]?.output }
            if let model = speedModel {
                var speed = HubModelSpeed.load()
                speed.record(model: model, sentAt: sent, firstTokenAt: first, endedAt: Date(), outputTokens: tokens)
                speed.save()
            }
            speedSentAt = nil; speedFirstAt = nil
        }
        .hubPage(isPresented: $speedOpen) { pushed in HubModelSpeedView(pushed: pushed) }
        .hubPage(isPresented: $helpersOpen) { pushed in
            HubHelpersSheet(api: api, helpers: helpers, opened: openHelper, stop: stopHelper, pushed: pushed)
        }
        .task(id: ScreenshotLoad(sequence: snapshot?.latestScreenshotSequence, retry: screenshotRetry)) {
            await loadScreenshots()
        }
        .onChange(of: draft) { text in
            if openedInitialAction { HubChatDrafts.save(text, for: chat.sessionId) }
        }
        .onChange(of: chat.sessionId) { id in draft = HubChatDrafts.load(id) }
        .task(id: requestID) {
            if !openedInitialAction {
                openedInitialAction = true
                // What you typed and left unsent is still here when you come back.
                draft = initialDraft.isEmpty ? HubChatDrafts.load(chat.sessionId) : initialDraft
                openComposerAction(composerAction)
            }
            await loadFileDrafts()
        }
        .erased()
        .fileImporter(isPresented: $filePickerOpen, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): Task { await stageFiles(urls) }
            case .failure: error = "Could not open the selected files."
            }
        }
        .sheet(isPresented: $photoPickerOpen) {
            HubChatPhotoPicker { result in
                switch result {
                case .success(.photo(let data)): Task { await stagePhoto(data) }
                case .success(.video(let url)): Task { await stageVideo(url) }
                case .failure: error = "Could not add this photo or video."
                }
            }
        }
        .sheet(isPresented: $characterPickerOpen) {
            HubChatCharacterView(sessionID: chat.sessionId, api: api) { name in
                character = name
            }
        }
        .hubPage(isPresented: $instructionsOpen) { pushed in
            HubNavigation(pushed: pushed) {
                HubInstructionsView(api: api, sessionID: chat.sessionId)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { if !pushed { Button("Done") { instructionsOpen = false } } }
                    }
            }
        }
        .hubPage(isPresented: $appsOpen) { pushed in HubConversationAppsView(api: api, sessionID: chat.sessionId, pushed: pushed) }
        .hubPage(item: $openedOutput) { receipt, pushed in
            HubConversationAppsView(api: api, sessionID: chat.sessionId, pushed: pushed, initialFile: receipt.file)
        }
        .sheet(isPresented: $commandsOpen, onDismiss: {
            if focusAfterCommandPick {
                focusAfterCommandPick = false
                composerFocused = true
            }
        }) {
            HubChatCommandsView(api: api, sessionID: chat.sessionId) { name in
                focusAfterCommandPick = true
                let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                if text.isEmpty || (text.hasPrefix("/") && !text.contains(where: \.isWhitespace)) {
                    draft = "/\(name) "
                } else {
                    draft = "/\(name) " + draft
                }
            }
        }
        .sheet(isPresented: $modelPickerOpen) {
            HubChatModelPicker(api: api, sessionID: chat.sessionId, current: selectedModel ?? snapshot?.model) {
                selectedModel = snapshot?.model == $0 ? nil : $0
            }
        }
        .alert("Rename chat", isPresented: $renameOpen) {
            TextField("Chat title", text: $renameDraft)
            Button("Rename") {
                let title = renameDraft
                Task { await saveTitle(title) }
            }
            .disabled(renameDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("Cancel", role: .cancel) {}
        }
        .sheet(item: $queueEdit) { item in
            NavigationView {
                HubForm {
                    TextEditor(text: $queueDraft).frame(minHeight: 140)
                        .accessibilityLabel("Queued message")
                    if queuedMessages?.contains(item) != true {
                        Text("This message has changed or is no longer waiting.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    if let error { Text(error).font(.footnote).foregroundStyle(.secondary) }
                }
                .navigationTitle("Edit queued message")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { queueEdit = nil }.disabled(queueBusy) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") { changeQueue(item, action: .edit(queueDraft)) }
                            .disabled(queueBusy || queuedMessages?.contains(item) != true ||
                                      queueDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                                      queueDraft.utf8.count > 32_768)
                    }
                }
            }
            .navigationViewStyle(.stack)
            .interactiveDismissDisabled(queueBusy)
        }
        .hubPage(item: $researchMode) { mode, pushed in
            HubResearchView(sessionID: chat.sessionId, api: api, question: draft, showJobs: mode == .jobs,
                            didStart: { question in
                                if draft.trimmingCharacters(in: .whitespacesAndNewlines) ==
                                    question.trimmingCharacters(in: .whitespacesAndNewlines) { draft = "" }
                            }, openChat: openChat, pushed: pushed)
        }
        .foregroundStyle(.primary)
        .tint(accent)
        // Home's living backdrop shows through; it comes alive while you type
        // and while HUB works.
        .preference(key: HubBackdropEnergyPreference.self, value: composerFocused || snapshot?.running == true ? 1 : 0)
    }

    private func openComposerAction(_ action: HubNativeChatRequest.ComposerAction?) {
        switch action {
        case .commands: commandsOpen = true
        case .files: filePickerOpen = true
        case .photos: photoPickerOpen = true
        case .characters: characterPickerOpen = true
        case .research: researchMode = .new
        case .researchTasks: researchMode = .jobs
        case .instructions: instructionsOpen = true
        case nil: break
        }
    }

    private var chatHeader: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button { composerFocused = false; back(deliveryUncertain || sending ? "" : draft) } label: {
                    Image(systemName: "chevron.left").font(.body.weight(.semibold))
                        .frame(width: 40, height: 40)
                        .hubGlassCircle()
                }
                .accessibilityLabel("Home")
                VStack(alignment: .leading, spacing: 1) {
                    Text(renamedTitle ?? snapshot?.title ?? chat.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                    let subtitle = [character, (selectedModel ?? snapshot?.model)?.model].compactMap { $0 }.joined(separator: " · ")
                    if !subtitle.isEmpty {
                        Text(subtitle).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer(minLength: 4)
                // Unlock: the whole chat answers with the unrestricted model
                // until it is locked again.
                // One tap: Smart, Fast or Unrestricted for this chat.
                if let modelSlots, modelSlots.mainId != nil {
                    let current = modelSlots.mode
                    Menu {
                        ForEach(HubChatCharacterPicker.Mode.allCases) { mode in
                            if modelSlots.characterID(for: mode) != nil {
                                Button {
                                    composerFocused = false
                                    Task { await setMode(mode) }
                                } label: {
                                    Label(Self.modeTitle(mode), systemImage: mode == current ? "checkmark" : Self.modeIcon(mode))
                                }
                            }
                        }
                    } label: {
                        Image(systemName: Self.modeIcon(current))
                            .font(.body.weight(.semibold))
                            .foregroundColor(current == .unrestricted ? .orange : nil)
                            .frame(width: 40, height: 40)
                            .hubGlass(Circle(), interactive: true, tint: current == .unrestricted ? Color.orange.opacity(0.35) : nil)
                    }
                    .disabled(slotBusy || !modelSlots.canSelect || snapshot?.running == true)
                    .accessibilityLabel("Model: \(Self.modeTitle(current))")
                    .accessibilityHint("Choose Smart, Fast or Unrestricted for this chat.")
                    .accessibilityIdentifier("hub.chat.mode")
                }
                // The step-by-step view of the turn, one tap away instead of a
                // second screen with its own tab bar.
                Button {
                    composerFocused = false
                    withAnimation(.easeInOut(duration: 0.2)) { tab = tab == .chat ? .trajectory : .chat }
                } label: {
                    Image(systemName: tab == .trajectory ? "text.bubble.fill" : "point.3.connected.trianglepath.dotted")
                        .font(.body.weight(.semibold))
                        .frame(width: 40, height: 40)
                        .hubGlass(Circle(), interactive: true, tint: tab == .trajectory ? HubWorkspacePalette.accent.opacity(0.5) : nil)
                }
                .accessibilityLabel(tab == .trajectory ? "Back to chat" : "Trajectory")
                .accessibilityHint(tab == .trajectory ? "Shows the conversation." : "Shows each step HUB took, with tools and timings.")
                .accessibilityIdentifier("hub.chat.trajectory")
                if tab == .chat, requestedVisual == nil, let latestVisual {
                    Button { composerFocused = false; showVisual(latestVisual) } label: {
                        Image(systemName: "rectangle.on.rectangle").frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Open canvas")
                }
                if composerFocused {
                    Button { composerFocused = false } label: {
                        Image(systemName: "keyboard.chevron.compact.down").frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Hide keyboard")
                }
                if !callActive {
                    Button {
                        composerFocused = false
                        videoCall()
                    } label: {
                        Image(systemName: "video.fill").font(.body.weight(.semibold))
                            .frame(width: 40, height: 40)
                            .hubGlassCircle()
                    }
                    .accessibilityLabel("Video call")
                    .accessibilityHint("Talk to HUB and show it your camera; it can point at things in the room.")
                    .accessibilityIdentifier("hub.chat.video")
                }
                Menu {
                    Button {
                        composerFocused = false
                        withAnimation(.easeOut(duration: 0.2)) { screenOpen.toggle() }
                    } label: { Label(screenOpen ? "Hide PC screen" : "Watch PC screen", systemImage: "display") }
                    .disabled(connectionLost)
                    Button {
                        composerFocused = false
                        speedOpen = true
                    } label: { Label("Model speed", systemImage: "speedometer") }
                    Button {
                        composerFocused = false
                        renameDraft = renamedTitle ?? snapshot?.title ?? chat.title
                        renameOpen = true
                    } label: { Label("Rename chat", systemImage: "pencil") }
                    .disabled(connectionLost || renaming)
                } label: {
                    Image(systemName: "ellipsis").font(.body.weight(.semibold))
                        .frame(width: 40, height: 40)
                        .hubGlassCircle()
                }
                .accessibilityLabel("Chat options")
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 12)
            .padding(.bottom, 6)
            if !helpers.isEmpty {
                let running = helpers.filter { $0.state == .running }.count
                Button { composerFocused = false; openHelper = nil; helpersOpen = true } label: {
                    HStack(spacing: 6) {
                        if running > 0 { ProgressView().controlSize(.mini) } else { Image(systemName: "person.2") }
                        Text(running > 0 ? "Helpers · \(running) running" : "Helpers · \(helpers.count)")
                    }
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 12)
                    .frame(minHeight: 30)
                    .background(HubWorkspacePalette.border.opacity(0.09), in: Capsule())
                }
                .buttonStyle(.plain)
                .padding(.bottom, 6)
                .accessibilityIdentifier("hub.chat.helpers")
            }
            if tab == .trajectory {
                Text("Trajectory · each step of this chat")
                    .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16).padding(.bottom, 4)
            }
            Divider()
            if connectionLost {
                HStack {
                    Text(reconnecting ? "Checking conversation connection…" : "Connection interrupted").font(.footnote)
                    Spacer()
                    Button("Retry", action: reconnect).disabled(reconnecting)
                }
                .padding(12)
            }
        }
    }

    private func visualCard(_ requested: HubChatPresentation) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Text(loadedVisual?.summary.title ?? requested.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Spacer()
                Menu {
                    Toggle("Live updates", isOn: $followVisuals)
                    if let latestVisual, latestVisual.id != requested.id {
                        Button("Show latest") { showVisual(latestVisual) }
                    }
                    if loadedVisual != nil {
                        Button("Reset visual") { visualReset = UUID() }
                    }
                } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44) }
                .accessibilityLabel("Canvas options")
                Button {
                    composerFocused = false
                    visualExpanded.toggle()
                } label: {
                    Image(systemName: visualExpanded ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel(visualExpanded ? "Back to chat" : "Expand canvas")
                Button {
                    visualExpanded = false
                    requestedVisual = nil
                    loadedVisual = nil
                } label: { Image(systemName: "xmark").frame(width: 44, height: 44) }
                .accessibilityLabel("Hide canvas")
            }
            .padding(.leading, 12)
            if visualLoadFailed {
                Button("Couldn’t open visual. Retry") {
                    visualLoadFailed = false
                    visualRetry += 1
                }
                .font(.footnote)
                .padding(.bottom, 8)
            }
            if let loadedVisual {
                HubContainedDocumentView(document: loadedVisual.document)
                    .id(visualReset)
                    .accessibilityLabel(loadedVisual.summary.title)
                    .frame(height: visualExpanded ? nil : 230)
                    .frame(maxHeight: visualExpanded ? .infinity : nil)
            } else if !visualLoadFailed {
                ProgressView("Opening visual…").padding(16)
                    .frame(maxHeight: visualExpanded ? .infinity : nil)
            } else if visualExpanded {
                Spacer()
            }
        }
        .background(panel, in: RoundedRectangle(cornerRadius: 16))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .padding(.horizontal, visualExpanded ? 6 : 16)
        .padding(.vertical, 4)
    }

    /// A closed visual stays one tap away in the conversation.
    private func visualReopenCard(_ visual: HubChatPresentation) -> some View {
        Button { composerFocused = false; showVisual(visual) } label: {
            HStack(spacing: 12) {
                Image(systemName: visual.kind == .vega ? "chart.xyaxis.line" : visual.kind == .app ? "square.grid.2x2" : "doc.richtext")
                    .font(.title3)
                    .foregroundStyle(accent)
                    .frame(width: 42, height: 42)
                    .background(accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(visual.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Text(visual.kind == .app ? "Interactive app · Tap to open" : "Visual · Tap to open")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                Image(systemName: "arrow.up.left.and.arrow.down.right").foregroundStyle(.secondary)
            }
            .padding(10)
            .background(panel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(accent.opacity(0.18)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open \(visual.title)")
        .accessibilityIdentifier("hub.chat.visual.reopen")
    }

    private func showVisual(_ visual: HubChatPresentation) {
        seenVisualID = visual.id
        visualLoadFailed = false
        requestedVisual = visual
    }

    private func loadVisual(_ visual: HubChatPresentation) async {
        do {
            let document = try await api.chatPresentationDocument(sessionID: chat.sessionId, id: visual.id)
            guard !Task.isCancelled, requestedVisual?.id == visual.id else { return }
            loadedVisual = LoadedVisual(summary: visual, document: document)
            visualReset = UUID()
        } catch {
            if !Task.isCancelled && requestedVisual?.id == visual.id { visualLoadFailed = true }
        }
    }

    private func followPresentations() async {
        var delay: UInt64 = 2_000_000_000
        while !Task.isCancelled {
            do {
                let value = try await api.chatPresentation(sessionID: chat.sessionId)
                guard !Task.isCancelled else { return }
                latestVisual = value
                if let value {
                    if let requestedVisual {
                        if followVisuals && value.id != requestedVisual.id { showVisual(value) }
                    } else if value.id != seenVisualID && !composerFocused {
                        showVisual(value)
                    }
                }
                delay = snapshot?.running == true ? 2_000_000_000 : 5_000_000_000
            } catch {
                delay = 10_000_000_000
            }
            do { try await Task.sleep(nanoseconds: delay) }
            catch { return }
        }
    }

    private var trajectory: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                if history.hasMore {
                    Button(historyError ? "Retry loading earlier activity" : "Load earlier activity") {
                        historyRequest += 1
                    }
                    .disabled(historyLoading || connectionLost)
                }
                let entries = olderActivity + (snapshot?.activity ?? [])
                let turns = HubTrajectory.turns(messages: olderMessages + (snapshot?.messages ?? []), activity: entries,
                                                usage: olderUsage.merging(snapshot?.usageByTurn ?? [:]) { $0.combining($1) })
                if entries.isEmpty && turns.isEmpty { Text("No recorded activity").foregroundStyle(.secondary) }
                if !turns.isEmpty { HubTrajectorySummary(turns: turns, model: (selectedModel ?? snapshot?.model)?.model) }
                ForEach(turns) { turn in
                    HubTrajectoryTurnCard(turn: turn, running: snapshot?.running == true && turn.id == turns.last?.id)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        }
    }

    private func activityRow(_ item: HubChatActivity) -> some View {
        let title = Text(item.title).foregroundStyle(item.failed ? Color.red : Color.primary)
        return Group {
            if let detail = item.detail, !detail.isEmpty {
                DisclosureGroup {
                    Text(detail).font(.footnote.monospaced()).textSelection(.enabled)
                } label: { title }
            } else {
                title
            }
        }
    }

    @ViewBuilder
    private func transcriptActivity(_ entries: [HubChatActivity]) -> some View {
        if preferences.transcript == .compact {
            DisclosureGroup("Activity · \(entries.count)") {
                ForEach(entries) { activityRow($0) }
            }
            .font(.footnote)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(entries) { activityRow($0) }
            }
            .font(.footnote)
        }
    }

    private var transcript: some View {
        GeometryReader { viewport in
            ScrollViewReader { scroll in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if let snapshot {
                            if history.hasMore {
                                // Top-of-viewport loading also works when a sparse
                                // opening window is shorter than the screen.
                                Group {
                                    if historyError {
                                        Button("Retry loading earlier messages") {
                                            readingLatest = false
                                            historyRequest += 1
                                        }
                                        .disabled(historyLoading || connectionLost)
                                    } else if historyLoading {
                                        ProgressView()
                                            .accessibilityLabel("Loading earlier messages")
                                    } else {
                                        Button("Load earlier messages") {
                                            readingLatest = false
                                            historyRequest += 1
                                        }
                                        .disabled(connectionLost)
                                        .accessibilityIdentifier("hub.chat.history.earlier")
                                    }
                                }
                                .frame(maxWidth: .infinity)
                                .background {
                                    GeometryReader { geometry in
                                        Color.clear.preference(key: EarlierChatOffset.self,
                                            value: geometry.frame(in: .named("chatViewport")).maxY)
                                    }
                                }
                            }
                            let messages = olderMessages + snapshot.messages
                            let activity = Dictionary(grouping: olderActivity + snapshot.activity, by: \.turn)
                            let usage = olderUsage.merging(snapshot.usageByTurn) { $0.combining($1) }
                            let currentTurn = snapshot.running ? snapshot.latestMessageTurn : nil
                            let sentFiles = history.sentFiles + snapshot.sentFiles
                            ForEach(messages) { message in
                                VStack(alignment: .leading, spacing: 8) {
                                if message.role == "user" {
                                    HStack {
                                        Spacer(minLength: 48)
                                        VStack(alignment: .trailing, spacing: 8) {
                                            if !message.text.isEmpty { Text(message.text).textSelection(.enabled) }
                                            chatPhotos(message)
                                        }
                                        .padding(.horizontal, 14)
                                        .padding(.vertical, 10)
                                        .background(HubChatPalette.userBubble, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                                        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(accent.opacity(0.18)))
                                        .contextMenu {
                                            if !message.text.isEmpty {
                                                Button { UIPasteboard.general.string = message.text } label: {
                                                    Label("Copy message", systemImage: "doc.on.doc")
                                                }
                                            }
                                        }
                                    }
                                } else if message.role == "command" || message.role == "command-error" {
                                    Label {
                                        Text(message.text).textSelection(.enabled)
                                    } icon: {
                                        Image(systemName: message.role == "command-error" ? "exclamationmark.circle" : "terminal")
                                    }
                                    .font(.footnote)
                                    .foregroundStyle(message.role == "command-error" ? Color.red : Color.secondary)
                                } else {
                                    // Screenshots stay where they were taken: before the turn's
                                    // first message, or after the message sent just before them.
                                    if let turn = message.turn,
                                       messages.first(where: { $0.turn == turn && $0.role == "assistant" })?.id == message.id {
                                        ForEach(screenshots.filter {
                                            $0.turn == turn && HubChatScreenshot.anchor(of: $0, in: messages) == nil
                                        }) { screenshot in
                                            screenshotImage(screenshot)
                                        }
                                    }
                                    if !message.text.isEmpty {
                                        HubMarkdownText(source: message.text)
                                            .equatable()
                                            .contextMenu {
                                                Button { UIPasteboard.general.string = message.text } label: {
                                                    Label("Copy message", systemImage: "doc.on.doc")
                                                }
                                                if modelSlots?.unrestrictedId != nil, modelSlots?.unlocked == false, !snapshot.running {
                                                    Button { retryUnrestricted(after: message) } label: {
                                                        Label("Retry unrestricted", systemImage: "lock.open")
                                                    }
                                                }
                                            }
                                    }
                                    chatPhotos(message)
                                    ForEach(screenshots.filter {
                                        $0.turn == message.turn && HubChatScreenshot.anchor(of: $0, in: messages) == message.id
                                    }) { screenshot in
                                        screenshotImage(screenshot)
                                    }
                                    if let turn = message.turn, messages.last(where: { $0.turn == turn && $0.role == "assistant" })?.id == message.id {
                                        if turn != currentTurn, let entries = activity[turn], !entries.isEmpty {
                                            transcriptActivity(entries)
                                        }
                                        if turn != currentTurn {
                                            messageActions(message, usage: usage[turn])
                                        }
                                    }
                                }
                                ForEach(sentFiles.filter { HubChatSentFile.anchor(of: $0, in: messages) == message.id }) { receipt in
                                    sentFileCard(receipt)
                                }
                                }
                                .id(message.id)
                            }
                            // A screenshot from a turn with no reply yet (still running) shows
                            // at the end. One from an earlier turn whose messages are not
                            // loaded waits for them, instead of appearing out of place here.
                            let oldestLoadedTurn = messages.filter { $0.role == "assistant" }.compactMap(\.turn).min()
                            ForEach(screenshots.filter { screenshot in
                                !messages.contains { $0.role == "assistant" && $0.turn == screenshot.turn } &&
                                    oldestLoadedTurn.map { screenshot.turn > $0 } ?? true
                            }) { screenshot in
                                screenshotImage(screenshot)
                            }
                            if screenshotListFailed && snapshot.latestScreenshotSequence != nil {
                                Button("Retry loading screenshots") { screenshotRetry += 1 }.font(.footnote)
                            }
                            if requestedVisual == nil, let latestVisual {
                                visualReopenCard(latestVisual)
                            }
                            // Emails waiting for the user: HUB never sends them itself.
                            ForEach(mailDrafts) { draft in
                                HubMailDraftCard(draft: draft) {
                                    Task {
                                        _ = try? await api.changeMail(["action": "dismiss", "id": draft.id])
                                        mailDrafts.removeAll { $0.id == draft.id }
                                    }
                                }
                            }
                            // Helpers at work right now, each one tap from its steps.
                            ForEach(helpers.filter { $0.state == .running }) { helper in
                                HubHelperCard(helper: helper, open: {
                                    composerFocused = false
                                    openHelper = helper
                                    helpersOpen = true
                                }, stop: { Task { await stopHelper(helper) } })
                            }
                            // HUB asked to see the screen or camera: one tap starts the call.
                            if let request = shareRequest(in: snapshot, messages: messages) {
                                HubShareRequestCard(camera: request.camera, reason: request.reason) {
                                    composerFocused = false
                                    dictation.cancel()
                                    voiceInChat(request.camera ? .camera : .screen)
                                }
                                .disabled(connectionLost)
                            }
                            // A successful file receipt can arrive before the turn's first reply.
                            ForEach(sentFiles.filter { receipt in
                                HubChatSentFile.anchor(of: receipt, in: messages) == nil &&
                                    (oldestLoadedTurn.map { receipt.turn >= $0 } ?? true)
                            }) { receipt in
                                sentFileCard(receipt)
                            }
                            // HUB found the earlier chat the user meant: continue there.
                            if let earlier = earlierChat(in: snapshot, messages: messages) {
                                HubEarlierChatCard(title: earlier.title) {
                                    composerFocused = false
                                    openChat(HubConversationChoice(sessionId: earlier.id, title: earlier.title, updatedAt: 0))
                                }
                            }
                            if !snapshot.partial.isEmpty { Text(snapshot.partial) }
                            if let failure = snapshot.failure { Text(failure).font(.footnote).foregroundStyle(.red) }
                            if snapshot.running && !connectionLost {
                                let asked = messages.last(where: { $0.role == "user" }).flatMap { Int($0.id) }
                                let steps = HubLiveSteps.steps(snapshot.activity.filter { entry in
                                    if let asked { return entry.sequence > asked }
                                    return currentTurn != nil && entry.turn == currentTurn
                                })
                                if !steps.isEmpty { HubLiveStepsView(steps: steps) }
                                if snapshot.partial.isEmpty && steps.isEmpty { HubThinkingIndicator() }
                            }
                            // Messages HUB has not taken in yet stay in the chat,
                            // marked as waiting, instead of disappearing.
                            ForEach(queuedMessages ?? []) { item in
                                pendingBubble(item.text.isEmpty ? "Attachment" : item.text,
                                              caption: item.placement == .steering ? "Steering the current turn" : "Waiting for HUB",
                                              item: item)
                            }
                            if let echo {
                                pendingBubble(echo.text.isEmpty ? (echo.attachments == 1 ? "1 attachment" : "\(echo.attachments) attachments") : echo.text,
                                              caption: sending ? "Sending…" : "Sent", item: nil)
                                if !snapshot.running && awaitingAfter != nil && !connectionLost { HubThinkingIndicator() }
                            }
                        } else if let cachedMessages {
                            cachedTranscript(cachedMessages)
                        } else if !connectionLost {
                            ProgressView("Loading chat…")
                        }
                        Color.clear.frame(height: 1).id("latest")
                            .background {
                                GeometryReader { geometry in
                                    Color.clear.preference(key: LatestChatOffset.self,
                                                           value: geometry.frame(in: .named("chatViewport")).maxY)
                                }
                            }
                    }
                    .font(.system(size: CGFloat(preferences.fontSize) * transcriptScale))
                    .foregroundStyle(HubChatPalette.text)
                    .padding(16)
                    .background {
                        GeometryReader { geometry in
                            Color.clear.preference(key: ChatContentHeight.self, value: geometry.size.height)
                        }
                    }
                }
                .coordinateSpace(name: "chatViewport")
                .onPreferenceChange(EarlierChatOffset.self) { offset in
                    let visible = offset.map { $0 >= 0 && $0 <= viewport.size.height } ?? false
                    let appeared = visible && !historyTopVisible
                    historyTopVisible = visible
                    if appeared { autoLoadEarlier() }
                }
                .onPreferenceChange(LatestChatOffset.self) { offset in
                    latestVisible = offset.map { $0 <= viewport.size.height + 24 && $0 >= 0 } ?? false
                    // When content gets shorter (the "Sending…" bubble, the steps or
                    // the thinking dots go away), the view can stay scrolled past
                    // its end and show an empty screen. Settle back on the last line.
                    if let offset, !dragging, contentHeight > viewport.size.height,
                       offset < viewport.size.height - 40 {
                        scroll.scrollTo("latest", anchor: .bottom)
                    }
                }
                .onPreferenceChange(ChatContentHeight.self) { height in
                    let changed = abs(height - contentHeight) > 1
                    contentHeight = height
                    // Rows are measured as they appear; keep the newest line in view.
                    if changed, readingLatest, !dragging { scroll.scrollTo("latest", anchor: .bottom) }
                }
                .simultaneousGesture(DragGesture(minimumDistance: 8).onChanged { value in
                    dragging = true
                    readingLatest = false
                    // Scrolling back through the chat puts the keyboard away.
                    if value.translation.height > 12, composerFocused { composerFocused = false }
                }.onEnded { _ in
                    dragging = false
                    if latestVisible { readingLatest = true } else { autoLoadEarlier() }
                })
                .onChange(of: snapshot?.messages.last?.id) { _ in
                    if readingLatest { scroll.scrollTo("latest", anchor: .bottom) }
                }
                .onChange(of: snapshot?.partial) { _ in
                    if readingLatest { scroll.scrollTo("latest", anchor: .bottom) }
                }
                .onChange(of: screenshots.map(\.id)) { _ in
                    if readingLatest { scroll.scrollTo("latest", anchor: .bottom) }
                }
                .onChange(of: echo) { sent in
                    // Sending always brings the newest line into view, settled
                    // twice so estimated row heights cannot leave it off.
                    if sent != nil { readingLatest = true; settleAtLatest(scroll) }
                    else if readingLatest { scroll.scrollTo("latest", anchor: .bottom) }
                }
                .onChange(of: snapshot?.running) { running in
                    // Keep the finished state of this chat on the phone for next time.
                    if running == false, let messages = snapshot?.messages { api.cacheChat(messages, sessionID: chat.sessionId) }
                }
                .task(id: chat.sessionId) {
                    if cachedMessages == nil { cachedMessages = api.cachedChat(sessionID: chat.sessionId) }
                    if cachedMessages != nil { scroll.scrollTo("latest", anchor: .bottom) }
                }
                .onChange(of: queuedMessages?.count) { _ in
                    if readingLatest { scroll.scrollTo("latest", anchor: .bottom) }
                }
                .onChange(of: bottomRequest) { _ in settleAtLatest(scroll) }
                .onChange(of: historyAnchor) { anchor in
                    if let anchor { scroll.scrollTo(anchor, anchor: .top); historyAnchor = nil }
                }
                .overlay(alignment: .bottomTrailing) {
                    if !readingLatest && !latestVisible {
                        Button {
                            readingLatest = true
                            bottomRequest += 1
                        } label: {
                            Image(systemName: "arrow.down").frame(width: 44, height: 44)
                        }
                        .accessibilityLabel("Jump to latest")
                        .background(panel, in: Circle())
                        .padding(12)
                    }
                }
            }
        }
    }

    private func messageActions(_ message: HubChatMessage, usage: HubChatTurnUsage?) -> some View {
        HStack(spacing: 6) {
            // A refusal from the normal model: one tap asks the unrestricted one.
            if let modelSlots, modelSlots.unrestrictedId != nil, !modelSlots.unlocked,
               message.id == snapshot?.messages.last(where: { $0.role == "assistant" })?.id,
               HubChatCharacterPicker.looksLikeRefusal(message.text) {
                Button { retryUnrestricted(after: message) } label: {
                    Label("Retry unrestricted", systemImage: "lock.open").frame(minHeight: 36)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.orange)
                .disabled(connectionLost || slotBusy || snapshot?.running == true)
                .accessibilityIdentifier("hub.chat.retryUnrestricted")
            }
            if let sequence = Int(message.id) {
                Button {
                    Task { await branch(sequence) }
                } label: {
                    Image(systemName: "arrow.triangle.branch").frame(width: 44, height: 36)
                }
                .buttonStyle(.plain)
                .disabled(connectionLost || branching)
                .accessibilityLabel("Branch conversation from this turn")
            }
            if let usage, usage.recordedResponses > 0 {
                Menu {
                    Text("Input · \(usage.input.formatted())")
                    Text("Output · \(usage.output.formatted())")
                    if usage.cacheRead > 0 { Text("Cache read · \(usage.cacheRead.formatted())") }
                    if usage.cacheWrite > 0 { Text("Cache write · \(usage.cacheWrite.formatted())") }
                    Text("Recorded responses · \(usage.recordedResponses)")
                } label: {
                    Label("Tokens", systemImage: "chart.bar").frame(minHeight: 36)
                }
                .accessibilityLabel("Recorded token usage for this turn")
            }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
    }

    private struct EarlierChatOffset: PreferenceKey {
        static let defaultValue: CGFloat? = nil
        static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) { value = nextValue() ?? value }
    }

    private struct LatestChatOffset: PreferenceKey {
        static let defaultValue: CGFloat? = nil
        static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) { value = nextValue() ?? value }
    }

    private struct ChatContentHeight: PreferenceKey {
        static let defaultValue: CGFloat = 0
        static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
    }

    private func chatPhotos(_ message: HubChatMessage) -> some View {
        ForEach(message.photos) { photo in
            HubChatImageView(name: photo.name ?? "Photo") {
                try await api.chatPhoto(sessionID: chat.sessionId, photo: photo)
            }
        }
    }

    private func screenshotImage(_ screenshot: HubChatScreenshot) -> some View {
        HubChatImageView(name: screenshot.name, canSave: true) {
            try await api.chatScreenshot(sessionID: chat.sessionId, id: screenshot.id)
        }
    }

    /// Keeps the chat's helper list current: often while one runs, rarely otherwise.
    private func followHelpers() async {
        while !Task.isCancelled {
            if let work = try? await api.workActivity(), !Task.isCancelled {
                let next = work.helpers(of: chat.sessionId)
                if next != helpers { withAnimation(.easeInOut(duration: 0.2)) { helpers = next } }
            }
            if let mail = try? await api.mail(sessionID: chat.sessionId), !Task.isCancelled {
                let next = mail.drafts ?? []
                if next != mailDrafts { withAnimation(.easeInOut(duration: 0.2)) { mailDrafts = next } }
            }
            let busy = helpers.contains { $0.state == .running } || snapshot?.running == true
            do { try await Task.sleep(nanoseconds: busy ? 3_000_000_000 : 20_000_000_000) } catch { return }
        }
    }

    private func stopHelper(_ helper: HubHomeWork.Helper) async {
        do { try await api.cancelChat(sessionID: helper.id) }
        catch { self.error = "Could not stop the helper. Check that HUB is online and try again." }
        if let work = try? await api.workActivity() { helpers = work.helpers(of: chat.sessionId) }
    }

    private func loadModelSlots() async {
        guard let value = try? await api.chatCharacters(sessionID: chat.sessionId), !Task.isCancelled else { return }
        modelSlots = value
    }

    static func modeTitle(_ mode: HubChatCharacterPicker.Mode) -> String {
        switch mode {
        case .smart: return "Smart"
        case .fast: return "Fast"
        case .unrestricted: return "Unrestricted"
        }
    }

    static func modeIcon(_ mode: HubChatCharacterPicker.Mode) -> String {
        switch mode {
        case .smart: return "sparkles"
        case .fast: return "bolt"
        case .unrestricted: return "lock.open.fill"
        }
    }

    @discardableResult
    private func setUnlocked(_ unlocked: Bool) async -> Bool {
        await setMode(unlocked ? .unrestricted : .smart)
    }

    /// Switches which model answers in this chat.
    @discardableResult
    private func setMode(_ mode: HubChatCharacterPicker.Mode) async -> Bool {
        guard !slotBusy else { return false }
        slotBusy = true
        defer { slotBusy = false }
        do {
            let current = try await api.chatCharacters(sessionID: chat.sessionId)
            guard let target = current.characterID(for: mode) else { return false }
            // Switch whenever the chosen model is not the one answering: after a
            // voice call the fast voice model can still be answering this chat.
            if !current.isAnswering(target) {
                _ = try await api.selectChatCharacter(sessionID: chat.sessionId, id: target, revision: current.revision)
            }
            modelSlots = try await api.chatCharacters(sessionID: chat.sessionId)
            error = nil
            return true
        } catch {
            self.error = "Could not switch the model. Check that HUB is online and try again."
            return false
        }
    }

    /// Answers the last message again with the unrestricted model.
    private func retryUnrestricted(after message: HubChatMessage) {
        let messages = olderMessages + (snapshot?.messages ?? [])
        guard let index = messages.firstIndex(where: { $0.id == message.id }),
              let question = messages[..<index].last(where: { $0.role == "user" && !$0.text.isEmpty })?.text else { return }
        Task {
            guard await setUnlocked(true) else { return }
            draft = question
            send()
        }
    }

    /// A short opening window can show both ends at once. Reading the latest
    /// message must not prevent reaching earlier pages in that case.
    private func autoLoadEarlier() {
        if (historyTopVisible || history.restoring) && history.hasMore && !historyLoading && !historyError && !connectionLost {
            historyRequest += 1
        }
    }

    private func loadEarlierMessages() async {
        // Hidden context/tool-only pages still advance the journal boundary.
        // Bound each automatic batch; the explicit load control remains available.
        for _ in 0..<8 {
            guard !Task.isCancelled, let request = history.begin() else { return }
            let anchor = olderMessages.first?.id ?? snapshot?.messages.first?.id
            do {
                let page = try await api.chatHistory(sessionID: chat.sessionId, through: request.cursor, before: request.before)
                guard !Task.isCancelled else { history.cancel(request); return }
                guard history.receive(page, for: request) else { return }
                if readingLatest { bottomRequest += 1 }
                else { historyAnchor = anchor }
            } catch {
                if Task.isCancelled { history.cancel(request) }
                else { history.fail(request) }
                return
            }
            if !history.restoring && !historyTopVisible { return }
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let error { Text(error).font(.footnote).foregroundStyle(.secondary) }
            if let notice = dictation.notice {
                Text(notice).font(.footnote).foregroundStyle(.secondary)
            }
            if stopRequest != nil {
                ProgressView("Stopping…").font(.footnote)
            } else if !connectionLost && snapshot?.lastTurnWasStopped == true {
                Label("Turn stopped", systemImage: "stop.circle").font(.footnote).foregroundStyle(.secondary)
            }
            if !queueAvailable && !connectionLost {
                Button("Refresh message queue") { attempt += 1 }.font(.footnote)
            }
            if !fileDrafts.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(fileDrafts, id: \.id) { file in
                            HStack(spacing: 4) {
                                Label(file.name, systemImage: "paperclip").lineLimit(1)
                                Button {
                                    Task { await removeFile(file) }
                                } label: {
                                    Image(systemName: "xmark").frame(width: 34, height: 44)
                                }
                                .accessibilityLabel("Remove \(file.name)")
                                .disabled(sending || attachmentBusy || deliveryUncertain)
                            }
                            .font(.caption)
                            .padding(.leading, 8)
                            .background(panel, in: Capsule())
                        }
                    }
                }
            }
            HStack(alignment: .bottom, spacing: 6) {
                HubComposerField(text: $draft, focus: $composerFocused, identifier: "hub.chat.draft", live: dictation.isActive) {
                    send(fromKeyboard: true)
                }
                .submitLabel(.send)
                .padding(.leading, 12)
                // While voice typing only the microphone (to stop) and Send stay.
                if !dictation.isActive {
                Menu {
                    Button {
                        composerFocused = false
                        commandsOpen = true
                    } label: { Label("Commands & skills", systemImage: "terminal") }
                    .disabled(connectionLost)
                    Button {
                        composerFocused = false
                        filePickerOpen = true
                    } label: { Label("Files", systemImage: "paperclip") }
                    .disabled(sending || connectionLost || attachmentBusy || deliveryUncertain)
                    Button {
                        composerFocused = false
                        photoPickerOpen = true
                    } label: { Label("Photos", systemImage: "photo") }
                    .disabled(sending || connectionLost || attachmentBusy || deliveryUncertain)
                    Button {
                        composerFocused = false
                        researchMode = .new
                    } label: { Label("Research…", systemImage: "magnifyingglass") }
                    .disabled(!fileDrafts.isEmpty)
                    Button {
                        composerFocused = false
                        researchMode = .jobs
                    } label: { Label("Research tasks", systemImage: "list.bullet.rectangle") }
                    Button {
                        composerFocused = false
                        instructionsOpen = true
                    } label: { Label("Instructions", systemImage: "doc.text") }
                    Button {
                        composerFocused = false
                        appsOpen = true
                    } label: { Label("Conversation outputs", systemImage: "doc.richtext") }
                } label: {
                    Image(systemName: "plus").frame(width: 44, height: 44)
                }
                .accessibilityLabel("More actions")
                .accessibilityIdentifier("hub.chat.more")
                }
                HubDictationButton(dictation: dictation, identifier: "hub.chat.dictate") {
                    if !dictation.isActive { dictationBase = draft }
                    dictation.toggle(api: api)
                }
                .disabled(!dictation.isActive && connectionLost)
                if !dictation.isActive {
                    Button {
                        dictation.cancel()
                        composerFocused = false
                        voice()
                    } label: { Image(systemName: "waveform").frame(width: 44, height: 44) }
                    .accessibilityLabel("Voice")
                    .accessibilityIdentifier("hub.chat.voice")
                }
                if snapshot?.running == true || awaitingAfter != nil {
                    Button(action: stop) {
                        Image(systemName: "stop.fill")
                            .foregroundColor(HubWorkspacePalette.onAccent)
                            .frame(width: 40, height: 40)
                            .background(Circle().fill(accent))
                            .frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Stop")
                    .accessibilityIdentifier("hub.chat.stop")
                    .disabled(stopRequest != nil)
                } else {
                    Button { send() } label: {
                        Image(systemName: "arrow.up")
                            .font(.body.weight(.bold))
                            .foregroundColor(canSend ? HubWorkspacePalette.onAccent : HubWorkspacePalette.muted)
                            .frame(width: 40, height: 40)
                            .background(Circle().fill(canSend ? accent : accent.opacity(0.10)))
                            .frame(width: 44, height: 44)
                            .animation(.easeOut(duration: 0.15), value: canSend)
                    }
                        .accessibilityLabel("Send")
                        .accessibilityIdentifier("hub.chat.send")
                        .disabled(!canSend)
                }
            }
            .buttonStyle(.plain)
            .padding(5)
            .hubGlass(RoundedRectangle(cornerRadius: 26, style: .continuous))
            if deliveryUncertain {
                Button("I checked the conversation") {
                    deliveryUncertain = false
                    error = nil
                }
                .font(.footnote)
                .disabled(connectionLost)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .onReceive(dictation.$text) { spoken in
            if dictation.isActive { draft = HubDictationTranscript.join(dictationBase, spoken) }
        }
        .onDisappear { dictation.cancel() }
    }

    /// Jumps to the newest message. The chat list builds rows lazily, so the
    /// first jump from far up lands on estimated heights and overshoots; two
    /// quick corrections settle it on the real bottom.
    private func settleAtLatest(_ scroll: ScrollViewProxy) {
        scroll.scrollTo("latest", anchor: .bottom)
        for delay in [0.15, 0.4] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                if readingLatest { scroll.scrollTo("latest", anchor: .bottom) }
            }
        }
    }
    private func sentFileCard(_ receipt: HubChatSentFile) -> some View {
        Button {
            composerFocused = false
            openedOutput = receipt
        } label: {
            HStack(spacing: 12) {
                Image(systemName: HubModel3DView.canShow(receipt.file.name) ? "cube.transparent" : "doc.fill")
                    .font(.title3).foregroundStyle(accent)
                VStack(alignment: .leading, spacing: 3) {
                    Text(receipt.file.name).font(.subheadline.weight(.semibold)).lineLimit(2)
                    Text(ByteCountFormatter.string(fromByteCount: Int64(receipt.file.bytes), countStyle: .file) +
                         " · Version " + String(receipt.file.sha256.prefix(8)))
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").foregroundStyle(.secondary)
            }
            .frame(minHeight: 44).padding(14)
            .background(panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("hub.chat.sentFile.\(receipt.id)")
    }
    /// The earlier chat HUB offered to go back to since the user last wrote.
    private func earlierChat(in snapshot: HubChatSnapshot, messages: [HubChatMessage]) -> (id: String, title: String)? {
        let asked = messages.last(where: { $0.role == "user" }).flatMap { Int($0.id) } ?? -1
        for call in snapshot.activity.reversed() where call.title == "hub_find_chat" && call.sequence > asked && !call.failed {
            guard let data = call.detail?.data(using: .utf8),
                  let arguments = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let id = (arguments["open"] as? String)?.trimmingCharacters(in: .whitespaces), !id.isEmpty,
                  id != chat.sessionId else { continue }
            let title = (arguments["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Earlier chat"
            return (id, title)
        }
        return nil
    }

    /// The saved copy of this chat: plain bubbles, marked as updating.
    @ViewBuilder
    private func cachedTranscript(_ messages: [HubChatMessage]) -> some View {
        ForEach(messages.filter { $0.role == "user" || $0.role == "assistant" }) { message in
            if message.role == "user" {
                HStack {
                    Spacer(minLength: 48)
                    Text(message.text.isEmpty ? "Photo" : message.text)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(HubChatPalette.userBubble, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                }
            } else if !message.text.isEmpty {
                HubMarkdownText(source: message.text)
                    .equatable()
            }
        }
        Label(connectionLost ? "Offline · showing the saved copy" : "Updating…", systemImage: connectionLost ? "wifi.slash" : "arrow.triangle.2.circlepath")
            .font(.caption).foregroundStyle(.secondary)
            .accessibilityIdentifier("hub.chat.cached")
    }

    /// HUB's latest hub_request_share since the user last wrote, if any.
    private func shareRequest(in snapshot: HubChatSnapshot, messages: [HubChatMessage]) -> (camera: Bool, reason: String)? {
        let asked = messages.last(where: { $0.role == "user" }).flatMap { Int($0.id) } ?? -1
        guard let call = snapshot.activity.last(where: { $0.title == "hub_request_share" && $0.sequence > asked && !$0.failed }) else { return nil }
        let arguments = call.detail.flatMap { $0.data(using: .utf8) }
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        return (arguments["kind"] as? String == "camera", (arguments["reason"] as? String) ?? "")
    }

    /// A sent message HUB has not taken in yet: drawn like the user's other
    /// messages, a little faded, with what it is waiting for underneath.
    private func pendingBubble(_ text: String, caption: String, item: HubQueuedChatMessage?) -> some View {
        HStack {
            Spacer(minLength: 48)
            VStack(alignment: .trailing, spacing: 4) {
                Text(verbatim: text)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(accent.opacity(0.10), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .strokeBorder(accent.opacity(0.22), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
                HStack(spacing: 4) {
                    Image(systemName: "clock").imageScale(.small)
                    Text(caption)
                    if let item {
                        Menu {
                            if item.canEdit {
                                Button("Edit") {
                                    composerFocused = false
                                    error = nil
                                    queueDraft = item.text
                                    queueEdit = item
                                }
                            }
                            if item.placement == .queued && snapshot?.running == true {
                                Button("Send to current turn") { changeQueue(item, action: .steer) }
                            }
                            Button("Remove from queue", role: .destructive) { changeQueue(item, action: .remove) }
                        } label: {
                            Image(systemName: "ellipsis").frame(width: 36, height: 28)
                        }
                        .accessibilityLabel("Queued message options")
                        .disabled(queueBusy || connectionLost)
                    }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("hub.chat.pending")
    }

    private func changeQueue(_ item: HubQueuedChatMessage, action: HubChatQueueAction) {
        guard !queueBusy, !connectionLost, queuedMessages?.contains(item) == true else { return }
        queueBusy = true
        error = nil
        Task {
            defer { queueBusy = false }
            do {
                try await api.updateChatQueue(sessionID: chat.sessionId, item: item, action: action)
                queueEdit = nil
            } catch {
                self.error = "Could not confirm the queue change. Check whether the message is still waiting."
            }
        }
    }

    private var canSend: Bool {
        canSubmit && snapshot?.running == false
    }

    private var canSubmit: Bool {
        snapshot != nil && !sending && !attachmentBusy && awaitingAfter == nil && stopRequest == nil && !deliveryUncertain && !connectionLost &&
            (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !fileDrafts.isEmpty)
    }

    private func loadFileDrafts() async {
        guard let context = attachments() else { return }
        do {
            let values = try await context.store.recovery().drafts
            guard !Task.isCancelled else { return }
            fileDrafts = values.filter {
                $0.origin == context.server.origin.absoluteString && $0.sessionID == chat.sessionId && $0.callID == "text-composer"
            }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        } catch {
            if !Task.isCancelled { self.error = "Could not read files saved for this conversation." }
        }
    }

    private func stageFiles(_ urls: [URL]) async {
        guard !attachmentBusy, !sending, let context = attachments() else { return }
        attachmentBusy = true
        error = nil
        defer { attachmentBusy = false }
        for url in urls.prefix(max(0, 8 - fileDrafts.count)) {
            let accessing = url.startAccessingSecurityScopedResource()
            defer { if accessing { url.stopAccessingSecurityScopedResource() } }
            do {
                let file = try await context.store.stage(source: url, server: context.server,
                                                         sessionID: chat.sessionId, callID: "text-composer")
                fileDrafts.append(file)
            } catch {
                self.error = "Could not add \(url.lastPathComponent). Choose a nonempty file up to 25 MB."
            }
        }
    }

    private func removeFile(_ file: HubAttachmentDraft) async {
        guard !sending, !attachmentBusy, let context = attachments() else { return }
        attachmentBusy = true
        defer { attachmentBusy = false }
        do {
            try await context.store.discard(file)
            fileDrafts.removeAll { $0.id == file.id }
        } catch {
            self.error = "Could not remove the local copy."
        }
    }

    /// A video from Photos, made small enough to send (the assistant watches it on the PC).
    private func stageVideo(_ source: URL) async {
        guard !attachmentBusy, !sending, fileDrafts.count < 8, let context = attachments() else { return }
        attachmentBusy = true
        defer {
            attachmentBusy = false
            try? FileManager.default.removeItem(at: source)
        }
        do {
            let (video, shortened) = try await HubChatPhotoPicker.compressVideo(source)
            defer { try? FileManager.default.removeItem(at: video) }
            let file = try await context.store.stage(source: video, server: context.server,
                                                     sessionID: chat.sessionId, callID: "text-composer")
            fileDrafts.append(file)
            error = shortened ? "This video is long, so only its beginning fits (25 MB). Send a shorter clip for the rest." : nil
        } catch {
            self.error = "Could not prepare this video. Try a shorter clip."
        }
    }

    private func stagePhoto(_ data: Data) async {
        guard !attachmentBusy, !sending, fileDrafts.count < 8, let context = attachments() else { return }
        attachmentBusy = true
        defer { attachmentBusy = false }
        do {
            let file = try await context.store.stage(data: data, name: "Photo.jpg", server: context.server,
                                                     sessionID: chat.sessionId, callID: "text-composer")
            fileDrafts.append(file)
            error = nil
        } catch {
            self.error = "Could not save this photo to the draft."
        }
    }

    private func prepareFiles(_ files: [HubAttachmentDraft], context: HubChatAttachmentContext) async throws -> ([String], [HubChatPhoto]) {
        var references: [String] = []
        var photos: [HubChatPhoto] = []
        for file in files {
            let data = try await context.store.bytes(file, server: context.server, sessionID: chat.sessionId, callID: "text-composer")
            let fileType = UTType(filenameExtension: (file.name as NSString).pathExtension)
            let type = fileType?.preferredMIMEType
            if let type, ["image/png", "image/jpeg", "image/webp", "image/gif"].contains(type) {
                photos.append(HubChatPhoto(name: file.name, mediaType: type, data: data))
            } else if fileType?.conforms(to: .image) == true {
                throw HubAttachmentError.invalidFile
            } else {
                references.append(try await context.upload.prepareChatFile(file, bytes: data))
            }
        }
        return (references, photos)
    }

    private func follow() async {
        let conversation = chat.sessionId
        queuedMessages = nil
        queueAvailable = true
        do {
            try await api.followChat(sessionID: conversation, queue: { items in
                guard !Task.isCancelled else { return }
                queuedMessages = items
                queueAvailable = items != nil
                // Once the message waits in HUB's queue, the queue shows it.
                if let echo, items?.contains(where: {
                    $0.text.trimmingCharacters(in: .whitespacesAndNewlines) == echo.text
                }) == true {
                    self.echo = nil
                }
            }) { value in
                guard !Task.isCancelled else { return }
                let completed = snapshot?.running == true && !value.running
                history.follow(value)
                snapshot = value
                connectionLost = false
                reconnecting = false
                autoLoadEarlier()
                if let request = stopRequest, let end = value.lastTurnEndSequence,
                   end > (request.priorEnd ?? -1) {
                    stopRequest = nil
                    awaitingAfter = nil
                    error = nil
                }
                if selectedModel == value.model { selectedModel = nil }
                if renamedTitle == value.title { renamedTitle = nil }
                if value.running || completed || (awaitingAfter != nil && (value.latestUserMessageID ?? "") != awaitingAfter) {
                    awaitingAfter = nil
                }
                // HUB's own copy of the sent message has arrived.
                if let echo, (value.latestUserMessageID ?? "") != echo.after {
                    self.echo = nil
                }
            }
        } catch {
            if !Task.isCancelled {
                connectionLost = true
                reconnecting = false
                awaitingAfter = nil
                queuedMessages = nil
            }
        }
    }

    private func reconnect() {
        guard !reconnecting else { return }
        reconnecting = true
        attempt += 1
    }

    private func loadScreenshots() async {
        screenshotListFailed = false
        do {
            let result = try await api.chatScreenshots(sessionID: chat.sessionId)
            if !Task.isCancelled { screenshots = result }
        } catch {
            if !Task.isCancelled { screenshotListFailed = true }
        }
    }

    private func saveTitle(_ name: String) async {
        guard !renaming else { return }
        renaming = true
        defer { renaming = false }
        do {
            let title = try await api.renameChat(sessionID: chat.sessionId, title: name)
            renamedTitle = snapshot?.title == title ? nil : title
            renamed(title)
        } catch {
            self.error = "Could not confirm the new title. Reopen the chat to check."
        }
    }

    private func branch(_ sequence: Int) async {
        guard !branching else { return }
        branching = true
        defer { branching = false }
        do {
            let id = try await api.branchChat(sessionID: chat.sessionId, at: sequence)
            openChat(HubConversationChoice(sessionId: id, title: "Branched conversation", updatedAt: 0))
        } catch {
            self.error = "Could not confirm the branch. Check Recents before trying again."
        }
    }

    private func send(fromKeyboard: Bool = false) {
        guard (fromKeyboard ? canSubmit : canSend) else { return }
        dictation.cancel()
        let delivery = snapshot?.running == true ? preferences.busyEnter : .queue
        let text = draft
        let files = fileDrafts
        let previous = snapshot?.latestUserMessageID ?? ""
        composerFocused = false
        readingLatest = true
        bottomRequest += 1
        sending = true
        error = nil
        if snapshot?.running != true {
            speedSentAt = Date(); speedFirstAt = nil
            speedModel = (selectedModel ?? snapshot?.model)?.model
        }
        if HubChatCommand.leadingName(in: text) == nil {
            echo = SentEcho(text: text.trimmingCharacters(in: .whitespacesAndNewlines), attachments: files.count, after: previous)
        }
        Task {
            var delivered = false
            defer {
                sending = false
                if !delivered { echo = nil }
            }
            do {
                var prepared: ([String], [HubChatPhoto]) = ([], [])
                let context = attachments()
                let command: HubChatCommand?
                if let name = HubChatCommand.leadingName(in: text) {
                    do {
                        command = try await api.chatCommands(sessionID: chat.sessionId).first { $0.name == name }
                    } catch {
                        self.error = "Could not check available commands. Your draft is still here."
                        return
                    }
                } else {
                    command = nil
                }
                if !files.isEmpty {
                    guard let context else { throw HubAttachmentError.signInRequired }
                    if let command, command.input?.images != true {
                        self.error = "/\(command.name) does not accept attachments."
                        return
                    }
                    if command != nil, files.contains(where: { file in
                        let type = UTType(filenameExtension: (file.name as NSString).pathExtension)?.preferredMIMEType
                        return !["image/png", "image/jpeg", "image/webp", "image/gif"].contains(type ?? "")
                    }) {
                        self.error = "This command only accepts image attachments."
                        return
                    }
                    prepared = try await prepareFiles(files, context: context)
                }
                if let command {
                    guard prepared.0.isEmpty else {
                        self.error = "This command only accepts image attachments."
                        return
                    }
                    guard let receipt = try await api.runChatCommand(text, sessionID: chat.sessionId, photos: prepared.1) else {
                        self.error = "/\(command.name) is no longer available. Your draft is still here."
                        return
                    }
                    if receipt.result.kind == .error {
                        self.error = receipt.result.text ?? "The command failed. Your draft is still here."
                        return
                    }
                } else {
                    try await api.sendChat(text, sessionID: chat.sessionId, files: prepared.0, photos: prepared.1, delivery: delivery)
                    delivered = true
                }
                if draft == text { draft = "" }
                for file in files {
                    do {
                        try await context?.store.discard(file)
                        fileDrafts.removeAll { $0.id == file.id }
                    } catch {
                        self.error = "Message sent. A local attachment copy could not be cleared."
                        fileDrafts.removeAll { $0.id == file.id }
                    }
                }
                if command == nil, !connectionLost, snapshot?.running != true, (snapshot?.latestUserMessageID ?? "") == previous {
                    awaitingAfter = previous
                    try? await Task.sleep(nanoseconds: 12_000_000_000)
                    if awaitingAfter == previous {
                        awaitingAfter = nil
                        if echo?.after == previous { echo = nil }
                        error = "HUB accepted your message. Reconnecting to check its status."
                        connectionLost = true
                        reconnect()
                    }
                }
            } catch HubChatSendError.unknownDelivery(_) {
                deliveryUncertain = true
                error = "Delivery could not be confirmed. Check this conversation before sending again."
            } catch HubAttachmentError.invalidFile {
                self.error = "One attachment could not be sent. Photos must be JPEG, PNG, GIF or WebP."
            } catch {
                self.error = "Message could not be sent. Your text is still here."
            }
        }
    }

    private func stop() {
        guard stopRequest == nil, snapshot?.running == true || awaitingAfter != nil else { return }
        composerFocused = false
        let request = StopRequest(priorEnd: snapshot?.lastTurnEndSequence)
        stopRequest = request
        error = nil
        Task {
            do {
                try await api.cancelChat(sessionID: chat.sessionId)
                guard stopRequest == request else { return }
                if connectionLost { reconnect() }
                try? await Task.sleep(nanoseconds: 6_000_000_000)
                guard stopRequest == request else { return }
                stopRequest = nil
                awaitingAfter = nil
                error = "HUB received Stop. Checking whether the turn ended."
                connectionLost = true
                reconnect()
            } catch {
                guard stopRequest == request else { return }
                stopRequest = nil
                self.error = "Could not confirm that HUB received Stop."
            }
        }
    }
}

@MainActor
private struct HubChatCommandsView: View {
    let api: HubConversationAPI
    let sessionID: String
    let select: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var commands: [HubChatCommand]?
    @State private var skills: [HubChatSkill]?
    @State private var query = ""
    @State private var loading = true
    @State private var attempt = 0

    var body: some View {
        NavigationView {
            HubList {
                if loading { ProgressView("Loading commands and skills…") }
                if let commands {
                    Section("Commands") {
                        let matching = commands.filter { matches($0.name, description: $0.description) }
                        if matching.isEmpty { Text("No matching commands").foregroundStyle(.secondary) }
                        ForEach(matching) { command in
                            option(command.name, description: command.description, hint: command.input?.hint)
                        }
                    }
                } else if !loading {
                    Text("Commands could not be loaded.").foregroundStyle(.secondary)
                }
                if let skills {
                    let names = Set(commands?.map(\.name) ?? [])
                    Section("Skills") {
                        let matching = skills.filter { !names.contains($0.name) && matches($0.name, description: $0.description) }
                        if matching.isEmpty { Text("No matching skills").foregroundStyle(.secondary) }
                        ForEach(matching) { skill in option(skill.name, description: skill.description, hint: nil) }
                    }
                } else if !loading {
                    Text("Skills could not be loaded.").foregroundStyle(.secondary)
                }
                if !loading && (commands == nil || skills == nil) {
                    Button("Retry") { attempt += 1 }
                }
            }
            .searchable(text: $query, prompt: "Find a command or skill")
            .navigationTitle("Commands & skills")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            }
        }
        .navigationViewStyle(.stack)
        .task(id: attempt) {
            loading = true
            async let commandCatalog = try? api.chatCommands(sessionID: sessionID)
            async let skillCatalog = try? api.chatSkills(sessionID: sessionID)
            let (commands, skills) = await (commandCatalog, skillCatalog)
            guard !Task.isCancelled else { return }
            self.commands = commands
            self.skills = skills
            loading = false
        }
    }

    private func matches(_ name: String, description: String) -> Bool {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return term.isEmpty || ("/" + name).localizedCaseInsensitiveContains(term) ||
            description.localizedCaseInsensitiveContains(term)
    }

    private func option(_ name: String, description: String, hint: String?) -> some View {
        Button {
            select(name)
            dismiss()
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text("/" + name).font(.body.monospaced())
                Text(description).font(.caption).foregroundStyle(.secondary)
                if let hint, !hint.isEmpty { Text(hint).font(.caption).foregroundStyle(.secondary) }
            }
        }
    }
}

@MainActor
private struct HubChatModelPicker: View {
    let api: HubConversationAPI
    let sessionID: String
    let current: HubChatModelSelection?
    let onSelect: (HubChatModelSelection) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var catalog: HubChatModels?
    @State private var query = ""
    @State private var model: HubChatModels.Provider.Model?
    @State private var provider: String?
    @State private var effort = ""
    @State private var attempt = 0
    @State private var loading = true
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationView {
            Group {
                if let model, let provider { options(model, provider: provider) }
                else { catalogue }
            }
            .navigationTitle(model == nil ? "Model & reasoning" : "Model options")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(model == nil ? "Close" : "Models") {
                        if model == nil { dismiss() }
                        else { model = nil; provider = nil; error = nil }
                    }
                    .disabled(saving)
                }
            }
        }
        .navigationViewStyle(.stack)
        .interactiveDismissDisabled(saving)
        .task(id: attempt) {
            loading = true
            error = nil
            defer { loading = false }
            do {
                let value = try await api.chatModels()
                if !Task.isCancelled { catalog = value }
            } catch {
                if !Task.isCancelled { self.error = "Could not load the available models." }
            }
            // HUB's own catalogue adds context size, prices and inputs; the
            // picker still works without it.
            if let extra = try? await api.modelCatalog(), !Task.isCancelled {
                details = Dictionary(extra.models.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            }
        }
    }

    @State private var details: [String: HubModelCatalog.Model] = [:]

    /// What the picker knows about one model, from both catalogues.
    private struct Spec {
        var contextWindow: Int?
        var maxTokens: Int?
        var images: Bool?
        var reasoning: Bool
        var pricing: HubModelCatalog.Model.Pricing?
        var favorite: Bool
    }

    private func spec(_ choice: HubChatModels.Provider.Model, provider: String) -> Spec {
        let extra = details[provider + "/" + choice.id]
        return Spec(contextWindow: extra?.contextWindow ?? choice.contextWindow,
                    maxTokens: choice.defaultMaxTokens ?? extra?.maxTokens,
                    images: extra.map { $0.input.contains("image") } ?? choice.inputModalities.map { $0.contains("image") },
                    reasoning: choice.canReason || extra?.reasoning == true,
                    pricing: extra?.pricing,
                    favorite: extra?.favorite == true)
    }

    private static func price(_ value: Double) -> String {
        value == 0 ? "free" : value < 0.1 ? String(format: "$%.3f", value) : String(format: "$%.2f", value)
    }

    private enum ModelFilter: String, CaseIterable, Identifiable {
        case all = "All"
        case reasoning = "Reasoning"
        case images = "Sees images"
        case longContext = "Long context"
        var id: Self { self }

        func includes(_ spec: Spec) -> Bool {
            switch self {
            case .all: return true
            case .reasoning: return spec.reasoning
            case .images: return spec.images == true
            case .longContext: return (spec.contextWindow ?? 0) >= 200_000
            }
        }
    }

    @State private var filter = ModelFilter.all

    private var catalogue: some View {
        HubList {
            if loading { ProgressView("Loading models…") }
            if let error {
                Text(error).foregroundStyle(.secondary)
                Button("Retry") { attempt += 1 }
            }
            if let catalog {
                let search = query.trimmingCharacters(in: .whitespacesAndNewlines)
                if let current, let now = lookup(current, in: catalog) {
                    Section("In this chat") {
                        modelRow(now.model, provider: now.provider, catalog: catalog, showProvider: true)
                    }
                }
                Section {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(ModelFilter.allCases) { option in
                                Button { filter = option } label: {
                                    Text(option.rawValue)
                                        .font(.caption.weight(filter == option ? .semibold : .regular))
                                        .padding(.horizontal, 12)
                                        .frame(minHeight: 32)
                                        .background(filter == option ? HubWorkspacePalette.accent.opacity(0.2) : HubWorkspacePalette.border.opacity(0.06),
                                                    in: Capsule())
                                }
                                .buttonStyle(.plain)
                                .accessibilityAddTraits(filter == option ? .isSelected : [])
                            }
                        }
                    }
                    .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
                }
                let groups = catalog.groups.compactMap { group -> FilteredGroup? in
                    let models = group.models.filter { filter.includes(spec($0, provider: group.id)) && (search.isEmpty ||
                        "\($0.name) \($0.id) \(group.name) \($0.description ?? "")".localizedCaseInsensitiveContains(search)) }
                    return models.isEmpty ? nil : FilteredGroup(id: group.id, name: group.name, models: models)
                }
                if groups.isEmpty {
                    Text(search.isEmpty && filter == .all ? "No configured models" : "No matching models").foregroundStyle(.secondary)
                }
                ForEach(groups) { group in
                    Section {
                        ForEach(group.models) { choice in
                            modelRow(choice, provider: group.id, catalog: catalog, showProvider: false)
                        }
                    } header: {
                        Text("\(group.name) · \(group.models.count)")
                    }
                }
                if !catalog.failures.isEmpty {
                    Text("Unavailable providers · \(catalog.failures.map(\.name).joined(separator: ", "))")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .searchable(text: $query, prompt: "Find a model…")
    }

    private func lookup(_ selection: HubChatModelSelection, in catalog: HubChatModels) -> (model: HubChatModels.Provider.Model, provider: String)? {
        guard let group = catalog.groups.first(where: { $0.id == selection.provider }),
              let model = group.models.first(where: { $0.id == selection.model }) else { return nil }
        return (model, group.id)
    }

    private func modelRow(_ choice: HubChatModels.Provider.Model, provider: String, catalog: HubChatModels, showProvider: Bool) -> some View {
        let isCurrent = current?.provider == provider && current?.model == choice.id
        let isDefault = catalog.defaultSelection?.provider == provider && catalog.defaultSelection?.model == choice.id
        let info = spec(choice, provider: provider)
        return Button {
            model = choice
            self.provider = provider
            effort = isCurrent ? (current?.reasoningEffort ?? "") : ""
        } label: {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 6) {
                        Text(choice.name).font(.body.weight(isCurrent ? .semibold : .regular)).lineLimit(1)
                        if isDefault { badge("Default", tint: .green) }
                        if info.favorite { Image(systemName: "heart.fill").font(.caption2).foregroundStyle(.pink).accessibilityLabel("Favorite") }
                    }
                    if let description = choice.description, !description.isEmpty {
                        Text(description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                    HStack(spacing: 5) {
                        if let window = info.contextWindow { badge(HubChatModels.tokens(window) + " context") }
                        if info.reasoning { badge("Reasoning") }
                        if info.images == true { badge("Images") }
                        if let price = info.pricing { badge(Self.price(price.input) + " in", tint: .secondary) }
                        if showProvider { badge(catalog.groups.first(where: { $0.id == provider })?.name ?? provider) }
                    }
                }
                Spacer(minLength: 4)
                if isCurrent {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(HubWorkspacePalette.accent)
                        .accessibilityLabel("Current model")
                } else {
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("hub.model.\(provider).\(choice.id)")
    }

    private func badge(_ text: String, tint: Color = HubWorkspacePalette.accent) -> some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .foregroundStyle(tint)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(tint.opacity(0.12), in: Capsule())
            .lineLimit(1)
    }

    private struct FilteredGroup: Identifiable {
        let id: String
        let name: String
        let models: [HubChatModels.Provider.Model]
    }

    private func options(_ choice: HubChatModels.Provider.Model, provider: String) -> some View {
        let providerName = catalog?.groups.first(where: { $0.id == provider })?.name ?? provider
        let info = spec(choice, provider: provider)
        return HubForm {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(choice.name).font(.title3.bold())
                    Text(providerName).font(.subheadline).foregroundStyle(.secondary)
                    if let description = choice.description { Text(description).font(.footnote).padding(.top, 2) }
                }
                .padding(.vertical, 4)
            }
            Section("Details") {
                detail("Model ID", choice.id, monospaced: true)
                detail("Context window", info.contextWindow.map { HubChatModels.tokens($0) + " tokens" } ?? "Not reported")
                if let output = info.maxTokens { detail("Longest reply", HubChatModels.tokens(output) + " tokens") }
                detail("Reads images", info.images.map { $0 ? "Yes" : "No" } ?? "Not reported")
                detail("Reasoning", choice.canReason ? "\(choice.reasoning?.efforts.count ?? 0) levels" : (info.reasoning ? "Yes" : "No"))
                if let price = info.pricing {
                    detail("Price per 1M tokens", Self.price(price.input) + " in · " + Self.price(price.output) + " out")
                }
            }
            if let efforts = choice.reasoning?.efforts, !efforts.isEmpty {
                Section {
                    effortRow(id: "", name: "Provider default",
                              description: choice.reasoning?.defaultEffort.map { "Uses \($0)" } ?? "Let the provider decide")
                    if !effort.isEmpty && !efforts.contains(where: { $0.id == effort }) {
                        effortRow(id: effort, name: effort, description: nil)
                    }
                    ForEach(efforts) { level in effortRow(id: level.id, name: level.name, description: level.description) }
                } header: {
                    Text("Reasoning effort")
                } footer: {
                    Text("More effort thinks longer and costs more tokens; lower effort answers faster.")
                }
            }
            Section {
                if let error { Text(error).font(.footnote).foregroundStyle(.secondary) }
                Button {
                    Task { await select(choice, provider: provider) }
                } label: {
                    HStack {
                        Spacer()
                        if saving { ProgressView() } else { Text("Use in this chat").fontWeight(.semibold) }
                        Spacer()
                    }
                    .frame(minHeight: 44)
                }
                .accessibilityIdentifier("hub.model.use")
            }
        }
        .disabled(saving)
    }

    private func detail(_ title: String, _ value: String, monospaced: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).foregroundStyle(.secondary)
            Spacer(minLength: 12)
            Text(value)
                .font(monospaced ? .footnote.monospaced() : .body)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
        .accessibilityElement(children: .combine)
    }

    private func effortRow(id: String, name: String, description: String?) -> some View {
        Button { effort = id } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(name)
                    if let description, !description.isEmpty {
                        Text(description).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if effort == id { Image(systemName: "checkmark").foregroundStyle(HubWorkspacePalette.accent) }
            }
            .frame(minHeight: 40)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(effort == id ? .isSelected : [])
    }

    private func select(_ choice: HubChatModels.Provider.Model, provider: String) async {
        guard !saving else { return }
        saving = true
        defer { saving = false }
        do {
            let selected = try await api.selectChatModel(sessionID: sessionID, provider: provider, model: choice.id,
                effort: choice.reasoning?.efforts.isEmpty == false ? effort : nil)
            onSelect(selected)
            dismiss()
        } catch {
            self.error = "Could not confirm the selection. Reopen the chat to check its model."
        }
    }
}

@MainActor
struct HubChatCharacterView: View {
    let sessionID: String
    let api: HubConversationAPI
    var stillAvailable: () -> Bool = { true }
    let selected: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var picker: HubChatCharacterPicker?
    @State private var attempt = 0
    @State private var changing = false
    @State private var error: String?
    @State private var notice: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Choose character").font(.headline)
                Spacer()
                Button("Done") { dismiss() }.disabled(changing)
            }
            if let error {
                Text(error).foregroundStyle(.secondary)
                Button("Retry") { attempt += 1 }
            }
            if let notice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
            if let picker {
                if !picker.canSelect {
                    Text("This conversation has an assigned character.").font(.footnote).foregroundStyle(.secondary)
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(picker.characters) { option in
                            Button { Task { await select(option, revision: picker.revision) } } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(option.name).font(.headline)
                                        Text(option.model.map { "\(option.role) · \($0)" } ?? "Model not configured")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if option.id == picker.selectedId { Image(systemName: "checkmark") }
                                }
                                .frame(minHeight: 44)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(changing || error != nil || !picker.canSelect || option.model == nil || option.id == picker.selectedId)
                        }
                    }
                }
            } else if error == nil {
                ProgressView("Loading characters…")
            }
        }
        .task(id: attempt) { await load() }
        .interactiveDismissDisabled(changing)
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .foregroundStyle(.primary)
        .hubBackdrop()
    }

    private func load() async {
        error = nil
        guard stillAvailable() else { error = "The voice conversation has ended."; return }
        do {
            let value = try await api.chatCharacters(sessionID: sessionID)
            guard !Task.isCancelled else { return }
            picker = value
            if value.pending, notice == nil { notice = "Selection applies to the next reply." }
        } catch {
            if !Task.isCancelled { self.error = "Could not load characters." }
        }
    }

    private func select(_ option: HubChatCharacterPicker.Character, revision: Int) async {
        guard !changing else { return }
        guard stillAvailable() else { error = "The voice conversation has ended."; return }
        changing = true
        defer { changing = false }
        do {
            let pending = try await api.selectChatCharacter(sessionID: sessionID, id: option.id, revision: revision)
            notice = pending ? "\(option.name) will reply next." : "Now speaking with \(option.name)."
            selected(option.name)
            await load()
        } catch {
            self.error = "Could not confirm the switch. Reload to check the selected character."
        }
    }
}

@MainActor
struct HubChatImageView: View {
    let name: String
    var canSave = false
    let load: () async throws -> Data
    @State private var image: UIImage?
    @State private var savedFile: SavedFile?
    @State private var exporting = false
    @State private var exportFailed = false
    @State private var failed = false
    @State private var attempt = 0
    @State private var fullScreen = false

    private struct SavedFile {
        let bytes: Data
        let type: UTType
        let name: String
    }

    var body: some View {
        Group {
            if let image {
                VStack(alignment: .leading, spacing: 4) {
                    Image(uiImage: image).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 12))
                        .contentShape(Rectangle())
                        .onTapGesture { fullScreen = true }
                        .accessibilityLabel(name)
                        .accessibilityAddTraits(.isImage)
                        .accessibilityAction(named: "Open full screen") { fullScreen = true }
                    .fullScreenCover(isPresented: $fullScreen) {
                        HubImageViewer(image: image, name: name)
                    }
                    if let savedFile {
                        HStack {
                            Text(name).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            Spacer()
                            HubShareFileButton(bytes: savedFile.bytes, name: savedFile.name, label: "Share screenshot")
                            Button {
                                exportFailed = false
                                exporting = true
                            } label: {
                                Image(systemName: "square.and.arrow.down").frame(width: 44, height: 44)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Save screenshot to Files")
                        }
                        if exportFailed { Text("Could not save the screenshot.").font(.footnote).foregroundStyle(.secondary) }
                    }
                }
            } else if failed {
                Button("Retry loading image") { failed = false; attempt += 1 }
            } else {
                ProgressView("Loading image…")
            }
        }
        .fileExporter(isPresented: $exporting, document: savedFile.map { HubFileDocument(bytes: $0.bytes) },
                      contentType: savedFile?.type ?? .image, defaultFilename: savedFile?.name) { result in
            if case .failure = result { exportFailed = true }
        }
        .task(id: attempt) {
            do {
                let bytes = try await load()
                guard let decoded = UIImage(data: bytes) else { throw HubAttachmentError.invalidResponse }
                if !Task.isCancelled {
                    image = decoded
                    if canSave, let source = CGImageSourceCreateWithData(bytes as CFData, nil),
                       let identifier = CGImageSourceGetType(source), let type = UTType(identifier as String) {
                        let leaf = (name as NSString).lastPathComponent
                        let safeName = leaf.isEmpty || leaf == "." || leaf == ".." ? "Screenshot" : leaf
                        let base = (safeName as NSString).deletingPathExtension
                        let filename = type.preferredFilenameExtension.map { "\(base).\($0)" } ?? safeName
                        savedFile = SavedFile(bytes: bytes, type: type, name: filename)
                    }
                }
            } catch {
                if !Task.isCancelled { failed = true }
            }
        }
    }

}

@MainActor
struct HubShareFileButton: View {
    let bytes: Data
    let name: String
    let label: LocalizedStringKey
    @State private var sharing = false
    @State private var sharedFile: URL?
    @State private var shareFailed = false

    var body: some View {
        Button { share() } label: { Image(systemName: "square.and.arrow.up").frame(width: 44, height: 44) }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(label))
            .sheet(isPresented: $sharing, onDismiss: clearSharedFile) {
                if let sharedFile { HubShareSheet(file: sharedFile) }
            }
            .alert("Could not prepare this file for sharing", isPresented: $shareFailed) {
                Button("OK", role: .cancel) {}
            }
    }

    private func share() {
        guard !sharing else { return }
        clearSharedFile()
        shareFailed = false
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
            let file = directory.appendingPathComponent(name)
            try bytes.write(to: file, options: [.atomic, .completeFileProtection])
            sharedFile = file
            sharing = true
        } catch {
            try? FileManager.default.removeItem(at: directory)
            shareFailed = true
        }
    }

    private func clearSharedFile() {
        guard let sharedFile else { return }
        try? FileManager.default.removeItem(at: sharedFile.deletingLastPathComponent())
        self.sharedFile = nil
    }
}

private struct HubShareSheet: UIViewControllerRepresentable {
    let file: URL
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, _ in dismiss() }
        return controller
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

@MainActor
private struct HubChatPhotoPicker: UIViewControllerRepresentable {
    enum Picked {
        case photo(Data)
        /// A private copy in the temporary folder; the receiver removes it.
        case video(URL)
    }

    let completion: (Result<Picked, Error>) -> Void
    @Environment(\.dismiss) private var dismiss

    /// Re-encodes a video at medium quality as MP4, at most 24 MB (longer
    /// videos keep their beginning). Returns the file and whether it was cut.
    nonisolated static func compressVideo(_ source: URL) async throws -> (URL, Bool) {
        let asset = AVURLAsset(url: source)
        guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetMediumQuality) else { throw HubAttachmentError.invalidFile }
        let output = FileManager.default.temporaryDirectory.appendingPathComponent("Video-\(UUID().uuidString.prefix(8)).mp4")
        export.outputURL = output
        export.outputFileType = .mp4
        export.shouldOptimizeForNetworkUse = true
        export.fileLengthLimit = 24_000_000
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            export.exportAsynchronously { done.resume() }
        }
        guard export.status == .completed else {
            try? FileManager.default.removeItem(at: output)
            throw HubAttachmentError.invalidFile
        }
        let full = CMTimeGetSeconds(asset.duration)
        let kept = CMTimeGetSeconds(AVURLAsset(url: output).duration)
        return (output, full.isFinite && kept.isFinite && kept + 1 < full)
    }

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var configuration = PHPickerConfiguration()
        configuration.filter = .any(of: [.images, .videos])
        configuration.selectionLimit = 1
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: PHPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(dismiss: { dismiss() }, completion: completion)
    }

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let dismiss: () -> Void
        let completion: (Result<Picked, Error>) -> Void

        init(dismiss: @escaping () -> Void, completion: @escaping (Result<Picked, Error>) -> Void) {
            self.dismiss = dismiss
            self.completion = completion
        }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            dismiss()
            guard let provider = results.first?.itemProvider else { return }
            let completion = completion
            if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
                provider.loadFileRepresentation(forTypeIdentifier: UTType.movie.identifier) { url, _ in
                    // The system deletes its copy when this returns: keep our own.
                    let result = Result<Picked, Error> {
                        guard let url else { throw HubAttachmentError.invalidFile }
                        let copy = FileManager.default.temporaryDirectory
                            .appendingPathComponent("Picked-\(UUID().uuidString.prefix(8)).\(url.pathExtension.isEmpty ? "mov" : url.pathExtension)")
                        try FileManager.default.copyItem(at: url, to: copy)
                        return .video(copy)
                    }
                    DispatchQueue.main.async { completion(result) }
                }
                return
            }
            provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, _ in
                let result = Result {
                    guard let url, let source = CGImageSourceCreateWithURL(url as CFURL, nil),
                          let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                            kCGImageSourceCreateThumbnailFromImageAlways: true,
                            kCGImageSourceCreateThumbnailWithTransform: true,
                            kCGImageSourceThumbnailMaxPixelSize: 2400,
                          ] as CFDictionary) else { throw HubAttachmentError.invalidFile }
                    let data = NSMutableData()
                    guard let encoder = CGImageDestinationCreateWithData(data as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil)
                    else { throw HubAttachmentError.invalidFile }
                    CGImageDestinationAddImage(encoder, image, [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary)
                    guard CGImageDestinationFinalize(encoder) else { throw HubAttachmentError.invalidFile }
                    return Picked.photo(data as Data)
                }
                DispatchQueue.main.async { completion(result) }
            }
        }
    }
}

/// Three softly pulsing dots while the assistant works, instead of a spinner.
/// A photo on a black full screen: pinch or double-tap to zoom, swipe down
/// or Close to go back, Share to send it on.
struct HubImageViewer: View {
    let image: UIImage
    let name: String
    @Environment(\.dismiss) private var dismiss
    @State private var drag: CGFloat = 0

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.ignoresSafeArea()
            HubZoomableImage(image: image)
                .ignoresSafeArea()
                .offset(y: drag)
                .simultaneousGesture(DragGesture(minimumDistance: 20).onChanged { value in
                    if value.translation.height > 0 && abs(value.translation.width) < value.translation.height { drag = value.translation.height }
                }.onEnded { value in
                    if value.translation.height > 140 { dismiss() } else { withAnimation(.spring()) { drag = 0 } }
                })
                .accessibilityLabel(name)
            HStack {
                Button { dismiss() } label: {
                    Image(systemName: "xmark").font(.headline).foregroundStyle(.white)
                        .frame(width: 44, height: 44).background(.ultraThinMaterial, in: Circle())
                }
                .accessibilityLabel("Close image")
                Spacer()
                if let data = image.pngData() {
                    HubShareFileButton(bytes: data, name: ((name as NSString).deletingPathExtension.isEmpty ? "Image" : (name as NSString).deletingPathExtension) + ".png", label: "Share image")
                        .foregroundStyle(.white)
                        .background(.ultraThinMaterial, in: Circle())
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .opacity(drag > 0 ? 0 : 1)
        }
        .background(Color.black)
        .preferredColorScheme(.dark)
    }
}

/// UIKit zooming: pinch, pan, and double-tap to toggle 2.5x.
struct HubZoomableImage: UIViewRepresentable {
    let image: UIImage

    func makeUIView(context: Context) -> UIScrollView {
        let scroll = UIScrollView()
        scroll.delegate = context.coordinator
        scroll.minimumZoomScale = 1
        scroll.maximumZoomScale = 6
        scroll.showsVerticalScrollIndicator = false
        scroll.showsHorizontalScrollIndicator = false
        scroll.backgroundColor = .clear
        scroll.contentInsetAdjustmentBehavior = .never
        let view = UIImageView(image: image)
        view.contentMode = .scaleAspectFit
        view.isUserInteractionEnabled = true
        view.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(view)
        NSLayoutConstraint.activate([
            view.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
            view.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
            view.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            view.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            view.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
        ])
        context.coordinator.imageView = view
        let doubleTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.toggleZoom(_:)))
        doubleTap.numberOfTapsRequired = 2
        scroll.addGestureRecognizer(doubleTap)
        return scroll
    }

    func updateUIView(_ view: UIScrollView, context: Context) {
        context.coordinator.imageView?.image = image
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        weak var imageView: UIImageView?
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
        @objc func toggleZoom(_ gesture: UITapGestureRecognizer) {
            guard let scroll = gesture.view as? UIScrollView else { return }
            if scroll.zoomScale > 1.01 {
                scroll.setZoomScale(1, animated: true)
            } else {
                let point = gesture.location(in: imageView)
                let size = CGSize(width: scroll.bounds.width / 2.5, height: scroll.bounds.height / 2.5)
                scroll.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
            }
        }
    }
}

/// The Trajectory tab: what happened in each turn, in order.
enum HubTrajectory {
    struct Step: Identifiable {
        enum Kind { case tool, instructions, context, retry, command, failure }
        let id: Int
        let kind: Kind
        let title: String
        let rawName: String?
        let detail: String?
        let result: String?
        let failed: Bool
    }

    struct Turn: Identifiable {
        let id: Int
        let number: Int
        let prompt: String?
        let reply: String?
        let steps: [Step]
        let usage: HubChatTurnUsage?
        var toolCount: Int { steps.filter { $0.kind == .tool }.count }
        var failures: Int { steps.filter(\.failed).count }
    }

    static func turns(messages: [HubChatMessage], activity: [HubChatActivity], usage: [Int: HubChatTurnUsage]) -> [Turn] {
        let asks = messages.compactMap { message -> (seq: Int, message: HubChatMessage)? in
            guard message.role == "user", let seq = Int(message.id) else { return nil }
            return (seq, message)
        }.sorted { $0.seq < $1.seq }
        guard !asks.isEmpty || !activity.isEmpty else { return [] }
        let starts = asks.map(\.seq)
        func owner(_ sequence: Int) -> Int { starts.last { $0 < sequence } ?? 0 }
        let grouped = Dictionary(grouping: activity.sorted { $0.sequence < $1.sequence }) { owner($0.sequence) }
        let keys = Set(starts).union(grouped.keys).sorted()
        return keys.enumerated().map { index, key in
            let ask = asks.first { $0.seq == key }?.message
            let next = starts.first { $0 > key } ?? Int.max
            let reply = messages.last {
                $0.role == "assistant" && (Int($0.id).map { $0 > key && $0 < next } ?? ($0.turn != nil && $0.turn == ask?.turn))
            }?.text
            return Turn(id: key, number: index + 1, prompt: ask?.text, reply: reply, steps: steps(grouped[key] ?? []),
                        usage: ask?.turn.flatMap { usage[$0] })
        }
    }

    /// Pairs each tool call with its result and names it in plain words.
    static func steps(_ entries: [HubChatActivity]) -> [Step] {
        var steps: [Step] = []
        for entry in entries {
            switch entry.title {
            case "Tool result", "Tool failed":
                if let index = steps.lastIndex(where: { $0.kind == .tool && $0.result == nil }) {
                    let call = steps[index]
                    steps[index] = Step(id: call.id, kind: .tool, title: call.title, rawName: call.rawName, detail: call.detail,
                                        result: entry.detail ?? (entry.title == "Tool failed" ? "Failed" : "Done"),
                                        failed: entry.title == "Tool failed" || entry.failed)
                }
            case "System prompt":
                steps.append(Step(id: entry.sequence, kind: .instructions, title: "Instructions sent to the model", rawName: nil, detail: entry.detail, result: nil, failed: false))
            case "Context updated":
                steps.append(Step(id: entry.sequence, kind: .context, title: "Context refreshed", rawName: nil, detail: nil, result: nil, failed: false))
            case "Waiting to retry model request", "Retrying model request":
                steps.append(Step(id: entry.sequence, kind: .retry, title: entry.title == "Retrying model request" ? "Retried the model" : "Model busy; waiting to retry", rawName: nil, detail: entry.detail, result: nil, failed: false))
            case "Command started", "Command finished", "Command failed":
                steps.append(Step(id: entry.sequence, kind: .command, title: entry.title, rawName: nil, detail: entry.detail, result: nil, failed: entry.failed))
            case "This turn failed":
                steps.append(Step(id: entry.sequence, kind: .failure, title: "This turn failed", rawName: nil, detail: entry.detail, result: nil, failed: true))
            default:
                steps.append(Step(id: entry.sequence, kind: .tool, title: HubLiveSteps.describe(tool: entry.title), rawName: entry.title, detail: entry.detail, result: nil, failed: entry.failed))
            }
        }
        // Context refreshes are noise once there are real steps.
        return steps.count > 3 ? steps.filter { $0.kind != .context } : steps
    }
}

struct HubTrajectorySummary: View {
    let turns: [HubTrajectory.Turn]
    let model: String?

    var body: some View {
        let tools = turns.reduce(0) { $0 + $1.toolCount }
        let failures = turns.reduce(0) { $0 + $1.failures }
        let tokens = turns.reduce(0) { $0 + ($1.usage.map { $0.input + $0.output } ?? 0) }
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                stat("\(turns.count)", "turns")
                stat("\(tools)", "tool calls")
                stat("\(failures)", failures == 1 ? "failure" : "failures", warn: failures > 0)
                if tokens > 0 { stat(HubChatModels.tokens(tokens), "tokens") }
            }
            if let model { Text(model).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
        }
        .padding(.bottom, 4)
    }

    private func stat(_ value: String, _ label: String, warn: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value).font(.headline).foregroundStyle(warn ? Color.orange : Color.primary)
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HubWorkspacePalette.border.opacity(0.06), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

struct HubTrajectoryTurnCard: View {
    let turn: HubTrajectory.Turn
    let running: Bool
    @State private var expanded: Set<Int> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Turn \(turn.number)").font(.caption.weight(.semibold)).foregroundStyle(HubWorkspacePalette.accent)
                Spacer()
                Group {
                    if running { Text("Working…") }
                    else {
                        Text([turn.toolCount > 0 ? "\(turn.toolCount) tools" : nil,
                              turn.usage.map { HubChatModels.tokens($0.input + $0.output) + " tokens" }]
                            .compactMap { $0 }.joined(separator: " · "))
                    }
                }
                .font(.caption2).foregroundStyle(.secondary)
            }
            if let prompt = turn.prompt, !prompt.isEmpty {
                Text(prompt).font(.subheadline.weight(.medium)).lineLimit(3)
            }
            if !turn.steps.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(turn.steps.enumerated()), id: \.element.id) { index, step in
                        stepRow(step, last: index == turn.steps.count - 1)
                    }
                }
            }
            if let reply = turn.reply, !reply.isEmpty {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "text.bubble").font(.caption).foregroundStyle(.secondary)
                    Text(reply).font(.footnote).foregroundStyle(.secondary).lineLimit(3)
                }
            }
        }
        .padding(12)
        .background(HubWorkspacePalette.panel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(HubWorkspacePalette.border.opacity(0.06)))
    }

    private func icon(_ step: HubTrajectory.Step) -> (String, Color) {
        if step.failed { return ("exclamationmark.circle.fill", .orange) }
        switch step.kind {
        case .tool: return (step.result == nil && running ? "circle.dotted" : "checkmark.circle.fill", HubWorkspacePalette.accent)
        case .instructions: return ("doc.text", .secondary)
        case .context: return ("arrow.triangle.2.circlepath", .secondary)
        case .retry: return ("arrow.clockwise", .orange)
        case .command: return ("terminal", .secondary)
        case .failure: return ("xmark.octagon.fill", .red)
        }
    }

    private func stepRow(_ step: HubTrajectory.Step, last: Bool) -> some View {
        let open = expanded.contains(step.id)
        let (symbol, tint) = icon(step)
        let hasDetail = (step.detail?.isEmpty == false) || (step.result?.isEmpty == false)
        return HStack(alignment: .top, spacing: 10) {
            VStack(spacing: 0) {
                Image(systemName: symbol).font(.footnote).foregroundStyle(tint).frame(width: 18, height: 18)
                if !last { Rectangle().fill(HubWorkspacePalette.border.opacity(0.12)).frame(width: 1.5).frame(maxHeight: .infinity) }
            }
            VStack(alignment: .leading, spacing: 3) {
                Button {
                    guard hasDetail else { return }
                    if open { expanded.remove(step.id) } else { expanded.insert(step.id) }
                } label: {
                    HStack(spacing: 6) {
                        Text(step.title).font(.footnote.weight(step.kind == .tool ? .semibold : .regular))
                            .foregroundStyle(step.failed ? Color.orange : Color.primary)
                        if let raw = step.rawName, raw != step.title {
                            Text(raw).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        if hasDetail { Image(systemName: open ? "chevron.up" : "chevron.down").font(.caption2).foregroundStyle(.secondary) }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if open {
                    if let detail = step.detail, !detail.isEmpty {
                        Text(detail.count > 4000 ? String(detail.prefix(4000)) + "…" : detail)
                            .font(.caption.monospaced()).textSelection(.enabled)
                            .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                            .background(HubWorkspacePalette.border.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
                    }
                    if let result = step.result, !result.isEmpty, result != "Done" {
                        Text(result).font(.caption.monospaced()).foregroundStyle(step.failed ? Color.orange : Color.secondary).textSelection(.enabled)
                    }
                }
            }
            .padding(.bottom, last ? 0 : 10)
        }
    }
}

/// Plain-language steps for the turn that is still running.
enum HubLiveSteps {
    struct Step: Identifiable {
        let id: Int
        let title: String
        let failed: Bool
    }

    static func steps(_ entries: [HubChatActivity]) -> [Step] {
        var result: [Step] = []
        for entry in entries {
            switch entry.title {
            case "System prompt", "Context updated", "Tool result", "Command finished": continue
            case "Tool failed":
                if let last = result.popLast() {
                    result.append(Step(id: last.id, title: last.title, failed: true))
                }
            case "Waiting to retry model request", "Retrying model request":
                result.append(Step(id: entry.sequence, title: "Retrying the model", failed: false))
            case "Command started":
                result.append(Step(id: entry.sequence, title: "Running a command", failed: false))
            case "Command failed":
                result.append(Step(id: entry.sequence, title: "A command failed", failed: true))
            case "This turn failed": continue
            default:
                result.append(Step(id: entry.sequence, title: describe(tool: entry.title), failed: entry.failed))
            }
        }
        return Array(result.suffix(5))
    }

    static func describe(tool name: String) -> String {
        let key = name.lowercased()
        let known: [(String, String)] = [
            ("phone_context", "Checking your phone"),
            ("view_screen", "Looking at your screen"),
            ("highlight_screen", "Pointing at your screen"),
            ("present", "Building a visual"),
            ("research", "Researching"),
            ("delegate", "Handing work to a helper"),
            ("send_message", "Messaging another agent"),
            ("list_agents", "Checking the other agents"),
            ("interrupt_agent", "Stopping a helper"),
            ("switch_character", "Switching assistant"),
            ("planner", "Checking your planner"),
            ("goals", "Updating goals"),
            ("automation", "Updating automations"),
            ("work_plan", "Planning the work"),
            ("save_conversation", "Saving the conversation"),
            ("knowledge", "Searching your knowledge"),
            ("memory", "Checking memory"),
            ("web_search", "Searching the web"),
            ("search", "Searching"),
            ("fetch", "Reading a web page"),
            ("browser", "Using the browser"),
            ("screenshot", "Taking a screenshot"),
            ("read", "Reading files"),
            ("write", "Writing a file"),
            ("edit", "Editing a file"),
            ("bash", "Running a command"),
            ("shell", "Running a command"),
            ("exec", "Running a command"),
        ]
        if let match = known.first(where: { key.contains($0.0) }) { return match.1 }
        var words = key.split(whereSeparator: { $0 == "_" || $0 == "-" || $0 == "." || $0 == "/" }).map(String.init)
        if words.first == "hub" { words.removeFirst() }
        let phrase = words.joined(separator: " ")
        return phrase.isEmpty ? "Working" : "Using " + phrase
    }
}

struct HubLiveStepsView: View {
    let steps: [HubLiveSteps.Step]

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                let current = index == steps.count - 1
                HStack(spacing: 8) {
                    Group {
                        if step.failed {
                            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange)
                        } else if current {
                            ProgressView().controlSize(.mini)
                        } else {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(HubWorkspacePalette.accent.opacity(0.7))
                        }
                    }
                    .frame(width: 16, height: 16)
                    Text(step.title)
                        .font(.footnote.weight(current ? .semibold : .regular))
                        .foregroundStyle(current ? Color.primary : Color.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
        .background(HubWorkspacePalette.accent.opacity(0.07), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .animation(.easeOut(duration: 0.2), value: steps.map(\.id))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Working: " + steps.map(\.title).joined(separator: ", "))
        .accessibilityIdentifier("hub.chat.liveSteps")
    }
}

struct HubThinkingIndicator: View {
    @State private var phase = 0

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3) { index in
                Circle()
                    .fill(HubWorkspacePalette.accent)
                    .frame(width: 7, height: 7)
                    .opacity(phase == index ? 1 : 0.3)
                    .scaleEffect(phase == index ? 1.15 : 0.9)
            }
        }
        .padding(.vertical, 6)
        .animation(.easeInOut(duration: 0.3), value: phase)
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 350_000_000)
                phase = (phase + 1) % 3
            }
        }
        .accessibilityElement()
        .accessibilityLabel("Working")
    }
}

/// A running helper in the chat: its task, a live indicator, Open and Stop.
struct HubHelperCard: View {
    let helper: HubHomeWork.Helper
    let open: () -> Void
    let stop: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Button(action: open) {
                HStack(spacing: 10) {
                    HubHelperStateIcon(state: helper.state)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(helper.title).font(.subheadline.weight(.semibold)).lineLimit(2)
                        Text(HubHelperStateIcon.label(helper.state)).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Shows the helper's steps")
            if helper.state == .running {
                Button(action: stop) { Image(systemName: "stop.circle").font(.title3).frame(width: 44, height: 44) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Stop helper")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(HubWorkspacePalette.border.opacity(0.07), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityIdentifier("hub.chat.helper.\(helper.id)")
    }
}

struct HubHelperStateIcon: View {
    let state: HubHomeWork.Helper.State

    static func label(_ state: HubHomeWork.Helper.State) -> String {
        switch state {
        case .running: return "Working…"
        case .done: return "Done"
        case .failed: return "Failed"
        case .stopped: return "Stopped"
        }
    }

    var body: some View {
        Group {
            switch state {
            case .running: ProgressView()
            case .done: Image(systemName: "checkmark.circle.fill").foregroundColor(.green)
            case .failed: Image(systemName: "exclamationmark.triangle.fill").foregroundColor(.orange)
            case .stopped: Image(systemName: "stop.circle.fill").foregroundColor(.secondary)
            }
        }
        .frame(width: 24, height: 24)
        .accessibilityHidden(true)
    }
}

/// Everything a chat's helpers did.
struct HubHelpersSheet: View {
    let api: HubConversationAPI
    let helpers: [HubHomeWork.Helper]
    var opened: HubHomeWork.Helper?
    let stop: (HubHomeWork.Helper) async -> Void
    var pushed = false
    @Environment(\.dismiss) private var dismiss
    @State private var selection: String?

    var body: some View {
        HubNavigation(pushed: pushed) {
            List {
                if helpers.isEmpty { Text("This chat has not started any helpers.").foregroundStyle(.secondary) }
                ForEach(helpers) { helper in
                    NavigationLink(tag: helper.id, selection: $selection) {
                        HubHelperWorkView(api: api, helper: helper, stop: stop)
                    } label: {
                        HStack(spacing: 10) {
                            HubHelperStateIcon(state: helper.state)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(helper.title).lineLimit(2)
                                Text("\(HubHelperStateIcon.label(helper.state)) · \(Date(timeIntervalSince1970: helper.updatedAt / 1000).formatted(.relative(presentation: .named)))")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Helpers")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { if !pushed { Button("Done") { dismiss() } } } }
            .onAppear { if selection == nil { selection = opened?.id } }
        }
    }
}

/// One helper's work, read-only: its brief, each step and what it wrote.
struct HubHelperWorkView: View {
    let api: HubConversationAPI
    let helper: HubHomeWork.Helper
    let stop: (HubHomeWork.Helper) async -> Void
    @State private var work: HubHelperWork?
    @State private var failed = false
    @State private var stopping = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let work {
                    Text("Task").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    HubMarkdownText(source: work.brief.isEmpty ? helper.title : work.brief)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(HubWorkspacePalette.border.opacity(0.07), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    ForEach(Array(work.entries.enumerated()), id: \.offset) { _, entry in
                        if entry.kind == "step" {
                            Label {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(entry.title ?? "Step").font(.footnote.weight(.semibold))
                                    if let detail = entry.detail, !detail.isEmpty {
                                        Text(detail).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(3)
                                    }
                                }
                            } icon: {
                                Image(systemName: entry.failed == true ? "xmark.circle" : "wrench.and.screwdriver")
                                    .foregroundColor(entry.failed == true ? .orange : .secondary)
                            }
                        } else if let text = entry.text {
                            HubMarkdownText(source: text)
                        }
                    }
                    if work.running {
                        HStack(spacing: 8) { ProgressView(); Text("Working…").foregroundStyle(.secondary) }
                    }
                } else if failed {
                    Text("Could not load this helper's work. Check that HUB is online.").foregroundStyle(.secondary)
                } else {
                    ProgressView("Loading…")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        }
        .navigationTitle(helper.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if work?.running ?? (helper.state == .running) {
                ToolbarItem(placement: .primaryAction) {
                    Button(stopping ? "Stopping…" : "Stop") {
                        stopping = true
                        Task { await stop(helper); stopping = false }
                    }
                    .disabled(stopping)
                }
            }
        }
        .task {
            // Refreshes while the helper is still working.
            while !Task.isCancelled {
                if let value = try? await api.helperWork(sessionID: helper.id) { work = value; failed = false }
                else if work == nil { failed = true }
                guard work?.running == true else { return }
                do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }
            }
        }
    }
}
/// An email the assistant wrote. Opening it hands it to the user's mail app,
/// where only the user's own tap sends it.
struct HubMailDraftCard: View {
    let draft: HubMailState.Draft
    let dismiss: () -> Void
    @Environment(\.openURL) private var openURL
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Email draft · not sent", systemImage: "envelope")
                .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            if let from = draft.from { Text("From: \(from) · choose it in your mail app").font(.footnote).foregroundStyle(.secondary) }
            Text("To: \(draft.to)").font(.footnote)
            if !draft.cc.isEmpty { Text("Cc: \(draft.cc)").font(.footnote) }
            Text(draft.subject).font(.subheadline.weight(.semibold))
            Text(draft.body).font(.footnote).lineLimit(expanded ? nil : 4)
                .onTapGesture { withAnimation { expanded.toggle() } }
            HStack {
                Button {
                    if let url = URL(string: draft.mailto) { openURL(url) }
                } label: {
                    Label("Open in Mail", systemImage: "paperplane").frame(minHeight: 36)
                }
                .hubGlassButton(prominent: true)
                .accessibilityHint("Opens the email in your mail app. It is sent only if you tap Send there.")
                Spacer()
                Button("Dismiss", action: dismiss).font(.footnote).frame(minHeight: 36)
            }
        }
        .padding(12)
        .background(HubWorkspacePalette.border.opacity(0.07), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityIdentifier("hub.chat.mailDraft.\(draft.id)")
    }
}
/// Each model's speed as measured on this phone: how long until the first
/// words arrive, and how fast it writes after that.
struct HubModelSpeedView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var speed = HubModelSpeed.load()
    var pushed = false

    var body: some View {
        HubNavigation(pushed: pushed) {
            HubList {
                let summaries = speed.summaries
                if summaries.isEmpty {
                    Text("Send a few messages and each model's speed appears here.").foregroundStyle(.secondary)
                }
                ForEach(summaries) { item in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(item.model).font(.headline)
                        HStack(spacing: 18) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(String(format: "%.1f s", item.firstToken)).font(.title3.weight(.semibold)).monospacedDigit()
                                Text("First words").font(.caption).foregroundStyle(.secondary)
                            }
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.tokensPerSecond.map { String(format: "%.0f", $0) } ?? "–").font(.title3.weight(.semibold)).monospacedDigit()
                                Text("Tokens / second").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text("\(item.count) replies").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                }
                Section {
                } footer: {
                    Text("Measured on this phone from the last 20 replies of each model: the wait includes the network and any tools the model used before writing. Typical values, not a benchmark.")
                }
            }
            .navigationTitle("Model speed")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { if !pushed { Button("Done") { dismiss() } } } }
        }
    }
}
/// HUB asked to see the user's screen or camera. iOS lets only the user start
/// a share, so the card starts the call and says where to tap.
struct HubShareRequestCard: View {
    let camera: Bool
    let reason: String
    let start: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(camera ? "HUB asks to see your camera" : "HUB asks to see your screen",
                  systemImage: camera ? "camera" : "rectangle.on.rectangle")
                .font(.subheadline.weight(.semibold))
            if !reason.isEmpty { Text(reason).font(.subheadline).foregroundStyle(.secondary) }
            Button(action: start) {
                Label(camera ? "Share camera" : "Share screen", systemImage: camera ? "camera.fill" : "rectangle.on.rectangle")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 40)
            }
            .hubGlassButton(prominent: true)
            Text("Starts a call in this chat and opens sharing.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(14)
        .background(HubWorkspacePalette.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("hub.chat.shareRequest")
    }
}
/// HUB found the earlier chat the user was talking about.
struct HubEarlierChatCard: View {
    let title: String
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 12) {
                Image(systemName: "arrow.uturn.backward.circle.fill").font(.title2).foregroundStyle(HubWorkspacePalette.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Continue in the earlier chat").font(.caption).foregroundStyle(.secondary)
                    Text(title).font(.subheadline.weight(.semibold)).lineLimit(2).multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").foregroundStyle(.secondary)
            }
            .padding(14)
            .background(HubWorkspacePalette.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("hub.chat.earlierChat")
    }
}
/// The chat's own colours: a softer charcoal than the app's near-black, with
/// off-white text, so long reading is easier on the eyes.
enum HubChatPalette {
    /// The chat background from the Theme page: soft (default), the app's own, or warm paper.
    static let background = Color(uiColor: UIColor { traits in
        let dark = traits.userInterfaceStyle == .dark
        switch HubThemeSettings.current.chatTone {
        case .soft: return HubThemeSettings.rgb(dark ? 0x1E2026 : 0xF4F5F8)
        case .app: return HubWorkspacePalette.background.resolvedColor(with: traits)
        case .paper: return HubThemeSettings.rgb(dark ? 0x24211C : 0xFBF7EE)
        }
    })
    /// Your own messages: tinted with the accent, or neutral grey.
    static var userBubble: Color {
        HubThemeSettings.current.bubble == .neutral ? Color(uiColor: .tertiarySystemFill) : HubWorkspacePalette.accent.opacity(0.16)
    }
    static let text = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? UIColor(white: 0.86, alpha: 1) : UIColor(white: 0.13, alpha: 1)
    })
}

/// Unsent text per chat, kept on the phone so leaving a chat and coming back
/// does not lose it. Cleared when the message is sent (the draft becomes empty).
enum HubChatDrafts {
    private static func key(_ sessionID: String) -> String { "hub.chat.draft." + sessionID }
    static func load(_ sessionID: String) -> String {
        UserDefaults.standard.string(forKey: key(sessionID)) ?? ""
    }
    static func save(_ text: String, for sessionID: String) {
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            UserDefaults.standard.removeObject(forKey: key(sessionID))
        } else {
            UserDefaults.standard.set(String(text.prefix(20_000)), forKey: key(sessionID))
        }
    }
}
