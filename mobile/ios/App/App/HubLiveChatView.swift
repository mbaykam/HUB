import SwiftUI
import UIKit
import HubNative
import UniformTypeIdentifiers
import PhotosUI
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
    let back: () -> Void
    let voice: () -> Void
    let openChat: (HubConversationChoice) -> Void
    let attachments: () -> HubChatAttachmentContext?
    let requestID: UUID
    let preferences: HubChatPreferences
    let renamed: (String) -> Void
    @Environment(\.scenePhase) private var scenePhase
    @FocusState private var composerFocused: Bool
    @State private var snapshot: HubChatSnapshot?
    @State private var screenshots: [HubChatScreenshot] = []
    @State private var draft = ""
    @State private var connectionLost = false
    @State private var attempt = 0
    @State private var sending = false
    @State private var awaitingAfter: String?
    @State private var deliveryUncertain = false
    @State private var stopping = false
    @State private var error: String?
    @State private var olderMessages: [HubChatMessage] = []
    @State private var olderActivity: [HubChatActivity] = []
    @State private var olderUsage: [Int: HubChatTurnUsage] = [:]
    @State private var olderPage: HubChatHistoryPage?
    @State private var historyLoading = false
    @State private var historyError = false
    @State private var historyRequest = 0
    @State private var historyAnchor: String?
    @State private var readingLatest = true
    @State private var latestVisible = false
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
    @ScaledMetric(relativeTo: .body) private var transcriptScale: CGFloat = 1

    private struct LoadedVisual {
        let summary: HubChatPresentation
        let document: String
    }

    private struct VisualLoad: Equatable {
        let id: UUID?
        let retry: Int
    }

    private enum ChatTab: String { case chat = "Chat", trajectory = "Trajectory" }

    private enum ResearchMode: String, Identifiable {
        case new, jobs
        var id: Self { self }
    }

    private let panel = Color(red: 0.085, green: 0.105, blue: 0.165)
    private let accent = Color(red: 0.75, green: 0.80, blue: 1)

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 0) {
                chatHeader
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
        .task(id: scenePhase == .active && tab == .chat) {
            if scenePhase == .active && tab == .chat { await followPresentations() }
        }
        .task(id: VisualLoad(id: scenePhase == .active ? requestedVisual?.id : nil, retry: visualRetry)) {
            if scenePhase == .active, let requestedVisual, loadedVisual?.summary.id != requestedVisual.id {
                await loadVisual(requestedVisual)
            }
        }
        .task(id: attempt) { await follow() }
        .task(id: historyRequest) {
            if historyRequest != 0 { await loadEarlierMessages() }
        }
        .task(id: snapshot?.latestScreenshotSequence) { await loadScreenshots() }
        .task(id: requestID) { await loadFileDrafts() }
        .fileImporter(isPresented: $filePickerOpen, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): Task { await stageFiles(urls) }
            case .failure: error = "Could not open the selected files."
            }
        }
        .sheet(isPresented: $photoPickerOpen) {
            HubChatPhotoPicker { result in
                switch result {
                case .success(let data): Task { await stagePhoto(data) }
                case .failure: error = "Could not add this photo."
                }
            }
        }
        .sheet(isPresented: $characterPickerOpen) {
            HubChatCharacterView(sessionID: chat.sessionId, api: api) { name in
                character = name
            }
        }
        .sheet(isPresented: $instructionsOpen) {
            NavigationView {
                HubInstructionsView(api: api, sessionID: chat.sessionId)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("Done") { instructionsOpen = false } }
                    }
            }
            .navigationViewStyle(.stack)
        }
        .sheet(isPresented: $appsOpen) { HubConversationAppsView(api: api, sessionID: chat.sessionId) }
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
                Form {
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
        .sheet(item: $researchMode) { mode in
            HubResearchView(sessionID: chat.sessionId, api: api, question: draft, showJobs: mode == .jobs,
                            didStart: { question in
                                if draft.trimmingCharacters(in: .whitespacesAndNewlines) ==
                                    question.trimmingCharacters(in: .whitespacesAndNewlines) { draft = "" }
                            }, openChat: openChat)
        }
        .foregroundStyle(.white)
        .tint(accent)
        .background(Color(uiColor: HubHomeView.backgroundColor).ignoresSafeArea())
        .preferredColorScheme(.dark)
    }

    private var chatHeader: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Button { composerFocused = false; back() } label: {
                    Label("Home", systemImage: "chevron.left").frame(minHeight: 44)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(renamedTitle ?? snapshot?.title ?? chat.title).font(.headline).lineLimit(1)
                    if let character { Text(character).font(.caption).foregroundStyle(.secondary) }
                    if let model = selectedModel ?? snapshot?.model {
                        Text(model.model).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer()
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
                Menu {
                    Button {
                        composerFocused = false
                        modelPickerOpen = true
                    } label: { Label("Model & reasoning", systemImage: "cpu") }
                    .disabled(connectionLost || snapshot?.running == true || awaitingAfter != nil)
                    Button {
                        composerFocused = false
                        renameDraft = renamedTitle ?? snapshot?.title ?? chat.title
                        renameOpen = true
                    } label: { Label("Rename chat", systemImage: "pencil") }
                    .disabled(connectionLost || renaming)
                } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44) }
                .accessibilityLabel("Chat options")
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 16)
            Picker("Conversation view", selection: $tab) {
                Text("Chat").tag(ChatTab.chat)
                Text("Trajectory").tag(ChatTab.trajectory)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
            Divider()
            if connectionLost {
                HStack {
                    Text("Connection interrupted").font(.footnote)
                    Spacer()
                    Button("Retry") { connectionLost = false; attempt += 1 }
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
                if olderPage?.hasMore ?? snapshot?.hasMore ?? false {
                    Button(historyError ? "Retry loading earlier activity" : "Load earlier activity") {
                        historyRequest += 1
                    }
                    .disabled(historyLoading || connectionLost)
                }
                let entries = olderActivity + (snapshot?.activity ?? [])
                if entries.isEmpty { Text("No recorded activity").foregroundStyle(.secondary) }
                ForEach(entries) { item in
                    activityRow(item)
                    Divider()
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
                            if olderPage?.hasMore ?? snapshot.hasMore {
                                Button(historyError ? "Retry loading earlier messages" : "Load earlier messages") {
                                    readingLatest = false
                                    historyRequest += 1
                                }
                                .disabled(historyLoading || connectionLost)
                                if historyLoading { ProgressView("Loading earlier messages…") }
                            }
                            let messages = olderMessages + snapshot.messages
                            let activity = Dictionary(grouping: olderActivity + snapshot.activity, by: \.turn)
                            let usage = olderUsage.merging(snapshot.usageByTurn) { $0.combining($1) }
                            let currentTurn = snapshot.running ? snapshot.latestMessageTurn : nil
                            ForEach(messages) { message in
                                if message.role == "user" {
                                    HStack {
                                        Spacer(minLength: 48)
                                        VStack(alignment: .trailing, spacing: 8) {
                                            if !message.text.isEmpty { Text(message.text) }
                                            chatPhotos(message)
                                            if !message.text.isEmpty { copyMessage(message.text) }
                                        }
                                        .padding(14)
                                        .background(panel, in: RoundedRectangle(cornerRadius: 18))
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
                                    let formatted = try? AttributedString(markdown: message.text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
                                    if !message.text.isEmpty {
                                        Text(formatted ?? AttributedString(message.text)).textSelection(.enabled)
                                    }
                                    chatPhotos(message)
                                    if let turn = message.turn, messages.last(where: { $0.turn == turn && $0.role == "assistant" })?.id == message.id {
                                        if turn != currentTurn, let entries = activity[turn], !entries.isEmpty {
                                            transcriptActivity(entries)
                                        }
                                        ForEach(screenshots.filter { $0.turn == turn }) { screenshot in
                                            screenshotImage(screenshot)
                                        }
                                        if turn != currentTurn {
                                            messageActions(message, usage: usage[turn])
                                        }
                                    } else if !message.text.isEmpty {
                                        copyMessage(message.text)
                                    }
                                }
                            }
                            ForEach(screenshots.filter { screenshot in
                                !messages.contains { $0.role == "assistant" && $0.turn == screenshot.turn }
                            }) { screenshot in
                                screenshotImage(screenshot)
                            }
                            if !snapshot.partial.isEmpty { Text(snapshot.partial) }
                            if let failure = snapshot.failure { Text(failure).font(.footnote).foregroundStyle(.red) }
                            if snapshot.running && snapshot.partial.isEmpty { ProgressView("Working…") }
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
                    .padding(16)
                }
                .coordinateSpace(name: "chatViewport")
                .onPreferenceChange(LatestChatOffset.self) { offset in
                    latestVisible = offset.map { $0 <= viewport.size.height + 24 && $0 >= 0 } ?? false
                }
                .simultaneousGesture(DragGesture(minimumDistance: 8).onChanged { _ in
                    readingLatest = false
                }.onEnded { _ in
                    if latestVisible { readingLatest = true }
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
                .onChange(of: bottomRequest) { _ in scroll.scrollTo("latest", anchor: .bottom) }
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

    private func copyMessage(_ text: String) -> some View {
        Button { UIPasteboard.general.string = text } label: {
            Image(systemName: "doc.on.doc").frame(width: 44, height: 36)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Copy message")
    }

    private func messageActions(_ message: HubChatMessage, usage: HubChatTurnUsage?) -> some View {
        HStack(spacing: 6) {
            if !message.text.isEmpty { copyMessage(message.text) }
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

    private struct LatestChatOffset: PreferenceKey {
        static let defaultValue: CGFloat? = nil
        static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) { value = nextValue() ?? value }
    }

    private func chatPhotos(_ message: HubChatMessage) -> some View {
        ForEach(message.photos) { photo in
            HubChatImageView(name: photo.name ?? "Photo") {
                try await api.chatPhoto(sessionID: chat.sessionId, photo: photo)
            }
        }
    }

    private func screenshotImage(_ screenshot: HubChatScreenshot) -> some View {
        HubChatImageView(name: screenshot.name) {
            try await api.chatScreenshot(sessionID: chat.sessionId, id: screenshot.id)
        }
    }

    private func loadEarlierMessages() async {
        guard !historyLoading, let snapshot, let cursor = snapshot.historyCursor,
              let sequence = olderPage?.firstSequence ?? snapshot.firstSequence else { return }
        historyLoading = true
        historyError = false
        defer { historyLoading = false }
        do {
            let page = try await api.chatHistory(sessionID: chat.sessionId, through: cursor, before: sequence)
            guard !Task.isCancelled, self.snapshot?.historyCursor == cursor else { return }
            let anchor = olderMessages.first?.id ?? snapshot.messages.first?.id
            olderMessages.insert(contentsOf: page.messages, at: 0)
            olderActivity.insert(contentsOf: page.activity, at: 0)
            olderUsage.merge(page.usageByTurn) { $0.combining($1) }
            olderPage = page
            historyAnchor = anchor
        } catch {
            if !Task.isCancelled { historyError = true }
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let error { Text(error).font(.footnote).foregroundStyle(.secondary) }
            if let items = queuedMessages, !items.isEmpty {
                queuedMessagesView(items)
            } else if !queueAvailable && !connectionLost {
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
            HStack(spacing: 6) {
                TextField("Chat…", text: $draft, prompt: Text("Chat…").foregroundColor(accent.opacity(0.75)))
                    .focused($composerFocused)
                    .submitLabel(.send)
                    .onSubmit { send(fromKeyboard: true) }
                    .padding(.leading, 12)
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
                        characterPickerOpen = true
                    } label: { Label("Choose character", systemImage: "person.crop.circle") }
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
                    } label: { Label("Conversation apps", systemImage: "doc.richtext") }
                } label: {
                    Image(systemName: "plus").frame(width: 44, height: 44)
                }
                .accessibilityLabel("More actions")
                Button {
                    composerFocused = false
                    voice()
                } label: { Image(systemName: "waveform").frame(width: 44, height: 44) }
                .accessibilityLabel("Voice")
                if snapshot?.running == true || awaitingAfter != nil {
                    Button(action: stop) { Image(systemName: "stop.fill").frame(width: 44, height: 44) }
                        .accessibilityLabel("Stop")
                        .disabled(stopping || connectionLost)
                } else {
                    Button { send() } label: { Image(systemName: "arrow.up").frame(width: 44, height: 44) }
                        .accessibilityLabel("Send")
                        .disabled(!canSend)
                }
            }
            .buttonStyle(.plain)
            .padding(5)
            .background(panel, in: RoundedRectangle(cornerRadius: 25))
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
    }

    private func queuedMessagesView(_ items: [HubQueuedChatMessage]) -> some View {
        DisclosureGroup("Queued messages · \(items.count)") {
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(items) { item in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.text.isEmpty ? "Attachment" : item.text).lineLimit(2)
                                if item.placement == .steering {
                                    Text("Steering the current turn").font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
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
                                Image(systemName: "ellipsis").frame(width: 44, height: 40)
                                    .accessibilityLabel("Queued message options")
                            }
                            .disabled(queueBusy || connectionLost)
                        }
                    }
                }
            }
            .frame(height: CGFloat(min(items.count, 3)) * 44)
        }
        .font(.footnote)
        .padding(.horizontal, 8)
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
        snapshot != nil && !sending && !attachmentBusy && awaitingAfter == nil && !deliveryUncertain && !connectionLost &&
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
            }) { value in
                guard !Task.isCancelled else { return }
                let completed = snapshot?.running == true && !value.running
                if snapshot?.historyCursor != value.historyCursor {
                    olderMessages = []
                    olderActivity = []
                    olderUsage = [:]
                    olderPage = nil
                    historyError = false
                }
                snapshot = value
                if selectedModel == value.model { selectedModel = nil }
                if renamedTitle == value.title { renamedTitle = nil }
                if value.running || completed || (awaitingAfter != nil && (value.latestUserMessageID ?? "") != awaitingAfter) {
                    awaitingAfter = nil
                }
            }
        } catch {
            if !Task.isCancelled {
                connectionLost = true
                awaitingAfter = nil
                queuedMessages = nil
            }
        }
    }

    private func loadScreenshots() async {
        if let result = try? await api.chatScreenshots(sessionID: chat.sessionId), !Task.isCancelled {
            screenshots = result
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
        let delivery = snapshot?.running == true ? preferences.busyEnter : .queue
        let text = draft
        let files = fileDrafts
        let previous = snapshot?.latestUserMessageID ?? ""
        composerFocused = false
        readingLatest = true
        bottomRequest += 1
        sending = true
        error = nil
        Task {
            defer { sending = false }
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
                        error = "HUB accepted your message. Reconnecting to check its status."
                        attempt += 1
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
        guard !stopping, !connectionLost else { return }
        composerFocused = false
        stopping = true
        error = nil
        Task {
            defer { stopping = false }
            do {
                try await api.cancelChat(sessionID: chat.sessionId)
            } catch {
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
            List {
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
        }
    }

    private var catalogue: some View {
        List {
            if loading { ProgressView("Loading models…") }
            if let error {
                Text(error).foregroundStyle(.secondary)
                Button("Retry") { attempt += 1 }
            }
            if let catalog {
                let search = query.trimmingCharacters(in: .whitespacesAndNewlines)
                let groups = catalog.groups.compactMap { group -> FilteredGroup? in
                    let models = group.models.filter { search.isEmpty ||
                        "\($0.name) \($0.id) \(group.name)".localizedCaseInsensitiveContains(search) }
                    return models.isEmpty ? nil : FilteredGroup(id: group.id, name: group.name, models: models)
                }
                if groups.isEmpty {
                    Text(search.isEmpty ? "No configured models" : "No matching models").foregroundStyle(.secondary)
                }
                ForEach(groups) { group in
                    Section(group.name) {
                        ForEach(group.models) { choice in
                            Button {
                                model = choice
                                provider = group.id
                                effort = current?.provider == group.id && current?.model == choice.id ? (current?.reasoningEffort ?? "") : ""
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(choice.name)
                                        Text(choice.id).font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if current?.provider == group.id, current?.model == choice.id {
                                        Image(systemName: "checkmark").accessibilityLabel("Current model")
                                    }
                                }
                                .frame(minHeight: 44)
                            }
                        }
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

    private struct FilteredGroup: Identifiable {
        let id: String
        let name: String
        let models: [HubChatModels.Provider.Model]
    }

    private func options(_ choice: HubChatModels.Provider.Model, provider: String) -> some View {
        Form {
            Section {
                Text(choice.name).font(.headline)
                if let description = choice.description { Text(description).font(.footnote) }
            }
            if let efforts = choice.reasoning?.efforts, !efforts.isEmpty {
                Picker("Reasoning effort", selection: $effort) {
                    Text("Provider default").tag("")
                    if !effort.isEmpty && !efforts.contains(where: { $0.id == effort }) { Text(effort).tag(effort) }
                    ForEach(efforts) { Text($0.name).tag($0.id) }
                }
            }
            if let error { Text(error).font(.footnote).foregroundStyle(.secondary) }
            if saving { ProgressView() }
            Button("Use in this chat") {
                Task { await select(choice, provider: provider) }
            }
        }
        .disabled(saving)
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
private struct HubChatCharacterView: View {
    let sessionID: String
    let api: HubConversationAPI
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
        .foregroundStyle(.white)
        .background(Color(uiColor: HubHomeView.backgroundColor).ignoresSafeArea())
    }

    private func load() async {
        error = nil
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
private struct HubChatImageView: View {
    let name: String
    let load: () async throws -> Data
    @State private var image: UIImage?
    @State private var failed = false
    @State private var attempt = 0

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFit().accessibilityLabel(name)
            } else if failed {
                Button("Retry loading image") { failed = false; attempt += 1 }
            } else {
                ProgressView("Loading image…")
            }
        }
        .task(id: attempt) {
            do {
                let bytes = try await load()
                guard let decoded = UIImage(data: bytes) else { throw HubAttachmentError.invalidResponse }
                if !Task.isCancelled { image = decoded }
            } catch {
                if !Task.isCancelled { failed = true }
            }
        }
    }
}

@MainActor
private struct HubChatPhotoPicker: UIViewControllerRepresentable {
    let completion: (Result<Data, Error>) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var configuration = PHPickerConfiguration()
        configuration.filter = .images
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
        let completion: (Result<Data, Error>) -> Void

        init(dismiss: @escaping () -> Void, completion: @escaping (Result<Data, Error>) -> Void) {
            self.dismiss = dismiss
            self.completion = completion
        }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            dismiss()
            guard let provider = results.first?.itemProvider else { return }
            let completion = completion
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
                    return data as Data
                }
                DispatchQueue.main.async { completion(result) }
            }
        }
    }
}
