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
                    Text(snapshot?.title ?? chat.title).font(.headline).lineLimit(1)
                    if let character { Text(character).font(.caption).foregroundStyle(.secondary) }
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
                    if let detail = item.detail, !detail.isEmpty {
                        DisclosureGroup {
                            Text(detail).font(.footnote.monospaced()).textSelection(.enabled)
                        } label: {
                            Text(item.title).foregroundStyle(item.failed ? Color.red : Color.primary)
                        }
                    } else {
                        Text(item.title).foregroundStyle(item.failed ? Color.red : Color.primary)
                    }
                    Divider()
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
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
                            ForEach(messages) { message in
                                if message.role == "user" {
                                    HStack {
                                        Spacer(minLength: 48)
                                        VStack(alignment: .trailing, spacing: 8) {
                                            if !message.text.isEmpty { Text(message.text) }
                                            chatPhotos(message)
                                        }
                                        .padding(14)
                                        .background(panel, in: RoundedRectangle(cornerRadius: 18))
                                    }
                                } else {
                                    let formatted = try? AttributedString(markdown: message.text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
                                    if !message.text.isEmpty {
                                        Text(formatted ?? AttributedString(message.text)).textSelection(.enabled)
                                    }
                                    chatPhotos(message)
                                    if let turn = message.turn, messages.last(where: { $0.turn == turn && $0.role == "assistant" })?.id == message.id {
                                        ForEach(screenshots.filter { $0.turn == turn }) { screenshot in
                                            screenshotImage(screenshot)
                                        }
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
            olderPage = page
            historyAnchor = anchor
        } catch {
            if !Task.isCancelled { historyError = true }
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let error { Text(error).font(.footnote).foregroundStyle(.secondary) }
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
                    .onSubmit(send)
                    .padding(.leading, 12)
                Menu {
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
                    Button(action: send) { Image(systemName: "arrow.up").frame(width: 44, height: 44) }
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

    private var canSend: Bool {
        snapshot != nil && !sending && !attachmentBusy && awaitingAfter == nil && !deliveryUncertain &&
            snapshot?.running == false && !connectionLost &&
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
        do {
            try await api.followChat(sessionID: conversation) { value in
                guard !Task.isCancelled else { return }
                let completed = snapshot?.running == true && !value.running
                if snapshot?.historyCursor != value.historyCursor {
                    olderMessages = []
                    olderActivity = []
                    olderPage = nil
                    historyError = false
                }
                snapshot = value
                if value.running || completed || (awaitingAfter != nil && value.messages.last?.id != awaitingAfter) {
                    awaitingAfter = nil
                }
            }
        } catch {
            if !Task.isCancelled {
                connectionLost = true
                awaitingAfter = nil
            }
        }
    }

    private func loadScreenshots() async {
        if let result = try? await api.chatScreenshots(sessionID: chat.sessionId), !Task.isCancelled {
            screenshots = result
        }
    }

    private func send() {
        guard canSend else { return }
        let text = draft
        let files = fileDrafts
        let previous = snapshot?.messages.last?.id ?? ""
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
                if !files.isEmpty {
                    guard let context else { throw HubAttachmentError.signInRequired }
                    prepared = try await prepareFiles(files, context: context)
                }
                try await api.sendChat(text, sessionID: chat.sessionId, files: prepared.0, photos: prepared.1)
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
                if !connectionLost, snapshot?.running != true, (snapshot?.messages.last?.id ?? "") == previous {
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
