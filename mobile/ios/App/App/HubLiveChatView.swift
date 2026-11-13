import SwiftUI
import UIKit
import HubNative

@MainActor
struct HubLiveChatView: View {
    let chat: HubConversationChoice
    let api: HubConversationAPI
    let back: () -> Void
    let voice: () -> Void
    let openChat: (HubConversationChoice) -> Void
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

    private enum ResearchMode: String, Identifiable {
        case new, jobs
        var id: Self { self }
    }

    private let panel = Color(red: 0.085, green: 0.105, blue: 0.165)
    private let accent = Color(red: 0.75, green: 0.80, blue: 1)

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Button { composerFocused = false; back() } label: {
                    Label("Home", systemImage: "chevron.left").frame(minHeight: 44)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(chat.title).font(.headline).lineLimit(1)
                    if let character { Text(character).font(.caption).foregroundStyle(.secondary) }
                }
                Spacer()
                if composerFocused {
                    Button { composerFocused = false } label: {
                        Image(systemName: "keyboard.chevron.compact.down").frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Hide keyboard")
                }
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 16)
            Divider()
            if connectionLost {
                HStack {
                    Text("Connection interrupted").font(.footnote)
                    Spacer()
                    Button("Retry") { connectionLost = false; attempt += 1 }
                }
                .padding(12)
            }
            transcript
            composer
        }
        .task(id: attempt) { await follow() }
        .task(id: snapshot?.latestScreenshotSequence) { await loadScreenshots() }
        .sheet(isPresented: $characterPickerOpen) {
            HubChatCharacterView(sessionID: chat.sessionId, api: api) { name in
                character = name
            }
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
                                        Text(message.text)
                                            .padding(14)
                                            .background(panel, in: RoundedRectangle(cornerRadius: 18))
                                    }
                                } else {
                                    let formatted = try? AttributedString(markdown: message.text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
                                    Text(formatted ?? AttributedString(message.text)).textSelection(.enabled)
                                    if let turn = message.turn, messages.last(where: { $0.turn == turn && $0.role == "assistant" })?.id == message.id {
                                        ForEach(screenshots.filter { $0.turn == turn }) { screenshot in
                                            HubChatScreenshotView(screenshot: screenshot, sessionID: chat.sessionId, api: api)
                                        }
                                    }
                                }
                            }
                            ForEach(screenshots.filter { screenshot in
                                !messages.contains { $0.role == "assistant" && $0.turn == screenshot.turn }
                            }) { screenshot in
                                HubChatScreenshotView(screenshot: screenshot, sessionID: chat.sessionId, api: api)
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
                .task(id: historyRequest) {
                    if historyRequest != 0 { await loadEarlierMessages() }
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
            olderPage = page
            historyAnchor = anchor
        } catch {
            if !Task.isCancelled { historyError = true }
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let error { Text(error).font(.footnote).foregroundStyle(.secondary) }
            HStack(spacing: 6) {
                TextField("Chat…", text: $draft, prompt: Text("Chat…").foregroundColor(accent.opacity(0.75)))
                    .focused($composerFocused)
                    .submitLabel(.send)
                    .onSubmit(send)
                    .padding(.leading, 12)
                Menu {
                    Button {
                        composerFocused = false
                        characterPickerOpen = true
                    } label: { Label("Choose character", systemImage: "person.crop.circle") }
                    Button {
                        composerFocused = false
                        researchMode = .new
                    } label: { Label("Research…", systemImage: "magnifyingglass") }
                    Button {
                        composerFocused = false
                        researchMode = .jobs
                    } label: { Label("Research tasks", systemImage: "list.bullet.rectangle") }
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
        snapshot != nil && !sending && awaitingAfter == nil && !deliveryUncertain && snapshot?.running == false && !connectionLost &&
            !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func follow() async {
        let conversation = chat.sessionId
        do {
            try await api.followChat(sessionID: conversation) { value in
                guard !Task.isCancelled else { return }
                let completed = snapshot?.running == true && !value.running
                if snapshot?.historyCursor != value.historyCursor {
                    olderMessages = []
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
        let previous = snapshot?.messages.last?.id ?? ""
        composerFocused = false
        readingLatest = true
        bottomRequest += 1
        sending = true
        error = nil
        Task {
            defer { sending = false }
            do {
                try await api.sendChat(text, sessionID: chat.sessionId)
                if draft == text { draft = "" }
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
private struct HubChatScreenshotView: View {
    let screenshot: HubChatScreenshot
    let sessionID: String
    let api: HubConversationAPI
    @State private var image: UIImage?
    @State private var failed = false
    @State private var attempt = 0

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFit().accessibilityLabel(screenshot.name)
            } else if failed {
                Button("Retry loading screenshot") { failed = false; attempt += 1 }
            } else {
                ProgressView("Loading screenshot…")
            }
        }
        .task(id: attempt) {
            do {
                let bytes = try await api.chatScreenshot(sessionID: sessionID, id: screenshot.id)
                guard let decoded = UIImage(data: bytes) else { throw HubAttachmentError.invalidResponse }
                if !Task.isCancelled { image = decoded }
            } catch {
                if !Task.isCancelled { failed = true }
            }
        }
    }
}
