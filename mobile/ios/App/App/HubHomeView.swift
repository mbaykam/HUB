import SwiftUI
import UIKit
import HubNative

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
    @Published var openNativeChat: HubNativeChatRequest?
}

struct HubNativeChatRequest: Equatable {
    let id = UUID()
    let choice: HubConversationChoice
}

@MainActor
struct HubHomeView: View {
    static let backgroundColor = UIColor(red: 0.045, green: 0.064, blue: 0.105, alpha: 1)

    @ObservedObject var model: HubHomeModel
    var connect: () -> Void
    var voice: () -> Void
    var options: () -> Void
    var workspace: () -> Void
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

    private enum Panel {
        case history
        case tools

        var edge: Edge { self == .history ? .leading : .trailing }
    }

    @State private var panel: Panel?
    @State private var knowledgeOpen = false
    @State private var selectedNoteID: String?
    @State private var selectedNote: HubKnowledgeNote?
    @State private var noteLoadFailed = false
    @State private var noteAttempt = 0
    @State private var noteEditing = false
    @State private var noteDraft = ""
    @State private var noteSaving = false
    @State private var noteSaveFailed = false
    @State private var knowledgeScope = HubKnowledgeGraphView.Scope.all
    @State private var knowledgeQuery = ""
    @State private var selectedChat: (request: HubNativeChatRequest, api: HubConversationAPI)?
    @State private var tasksOpen = false
    @State private var usageOpen = false
    @State private var settingsOpen = false
    @State private var openPhoneOptions = false
    @State private var knowledgeActivityOpen = false
    @State private var historyQuery = ""
    @State private var historyResults: HubConversationCatalog?
    @State private var historyFailed = false
    @State private var historyAttempt = 0
    @State private var bookmarks: HubChatBookmarks?
    @State private var bookmarksError = false
    @State private var bookmarksBusy = false
    @State private var pinnedExpanded = false
    @State private var creatingChat = false
    @State private var voiceHistoryOpen = false
    @State private var todoDraft = ""
    @State private var todoDraftID = UUID()
    @State private var todoHorizon = HubHomePlanner.Horizon.near
    @State private var agendaDate = Date()
    @State private var plannerTab = PlannerTab.todos
    @State private var plannerOpen = false
    @State private var calendarExpanded = false
    @State private var plannerEditor: PlannerEdit?
    @FocusState private var composerFocused: Bool
    @FocusState private var todoFocused: Bool
    private let card = Color(red: 0.085, green: 0.105, blue: 0.165)
    private let accent = Color(red: 0.75, green: 0.80, blue: 1.0)

    private enum PlannerTab: String {
        case agenda = "Agenda"
        case todos = "To-dos"
    }

    private struct PlannerEdit: Identifiable {
        let id = UUID()
        let item: HubHomePlanner.Item?
        let kind: HubPlannerDraft.Kind
    }

    var body: some View {
        ZStack {
            workspaceContent
                .opacity(selectedChat == nil ? 1 : 0)
                .allowsHitTesting(selectedChat == nil)
                .accessibilityHidden(selectedChat != nil)
            if let selectedChat {
                HubLiveChatView(chat: selectedChat.request.choice, api: selectedChat.api,
                                back: { self.selectedChat = nil }, voice: voice, openChat: showChat, attachments: attachments,
                                requestID: selectedChat.request.id)
                    .id(selectedChat.request.choice.sessionId)
            }
        }
        .foregroundStyle(.white)
        .tint(accent)
        .background(Color(uiColor: Self.backgroundColor).ignoresSafeArea())
        .preferredColorScheme(.dark)
        .sheet(isPresented: $knowledgeOpen, onDismiss: clearKnowledgeSelection) { knowledgeScreen }
        .sheet(isPresented: $tasksOpen) {
            if let api = chatAPI() { HubTasksView(load: readTasks, api: api, openChat: showChat) }
        }
        .sheet(isPresented: $plannerOpen) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Agenda & to-dos").font(.headline)
                    Spacer()
                    Button("Done") { plannerOpen = false }
                }
                ScrollView {
                    if let planner = model.planner { personalPlanner(planner) }
                    else { connectionRow }
                }
            }
            .padding(18)
            .foregroundStyle(.white)
            .background(Color(uiColor: Self.backgroundColor).ignoresSafeArea())
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
            HubWorkspaceSettingsView(api: chatAPI()) {
                openPhoneOptions = true
                settingsOpen = false
            }
        }
        .sheet(isPresented: $knowledgeActivityOpen) {
            if let api = chatAPI() { HubKnowledgeActivityView(api: api) }
        }
        .sheet(isPresented: $voiceHistoryOpen) {
            if let api = chatAPI() { HubVoiceHistoryView(api: api, recent: model.conversations ?? [], open: showChat) }
        }
        .onChange(of: model.openNativeChat) { request in
            if let request { showChat(request); model.openNativeChat = nil }
        }
        .onChange(of: model.connection) { connection in
            if connection == .needsSetup || connection == .signInRequired {
                knowledgeOpen = false
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
            }
        }
    }

    private var workspaceContent: some View {
        GeometryReader { geometry in
            ZStack(alignment: panel?.edge == .trailing ? .trailing : .leading) {
                homeContent
                    .accessibilityHidden(panel != nil)
                if let panel {
                    Button(action: closePanel) { Color.black.opacity(0.46) }
                        .buttonStyle(.plain)
                        .ignoresSafeArea()
                        .accessibilityHidden(true)
                    panelContent(panel)
                        .frame(width: min(geometry.size.width * 0.85, 380))
                        .transition(.move(edge: panel.edge))
                }
            }
            .simultaneousGesture(DragGesture(minimumDistance: 22).onEnded { value in
                let dx = value.translation.width
                guard abs(dx) > 55, abs(dx) > abs(value.translation.height) * 1.5 else { return }
                if let panel {
                    if (panel == .history && dx < 0) || (panel == .tools && dx > 0) { closePanel() }
                } else if dx > 0, value.startLocation.x < 36 {
                    showPanel(.history)
                } else if dx < 0, value.startLocation.x > geometry.size.width - 36 {
                    showPanel(.tools)
                }
            })
        }
    }

    private var homeContent: some View {
        VStack(spacing: 0) {
            HStack {
                Button { showPanel(.history) } label: {
                    Image(systemName: "sidebar.left").frame(width: 44, height: 44)
                }
                .accessibilityLabel("Chat history")
                Spacer()
                if composerFocused || todoFocused {
                    Button(action: hideKeyboard) {
                        Image(systemName: "keyboard.chevron.compact.down").frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Hide keyboard")
                }
                Button { showPanel(.tools) } label: {
                    Image(systemName: "sidebar.right").frame(width: 44, height: 44)
                }
                .accessibilityLabel("Workspace tools")
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 12)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    connectionRow
                    section("Knowledge", actionLabel: "Explore knowledge", open: showKnowledge) {
                        if let value = model.knowledge {
                            let notes = value.nodes.filter { $0.kind != "conversation" }
                            Text("\(notes.count) Brain notes  ·  \(value.domains?.filter { $0.status == "active" && $0.parentId == nil }.count ?? 0) Domains  ·  \(value.edges.count) Connections  ·  \(value.nodes.count - notes.count) Chat archive")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            HubKnowledgeGraphView(graph: value, height: 230, scope: .notes, overview: true, select: selectKnowledgeNode)
                        }

                    }
                    section("Your day", actionLabel: "Open ↗", open: {
                        hideKeyboard()
                        plannerOpen = true
                    }) {
                        if let planner = model.planner {
                            personalPlanner(planner)
                        }

                    }
                    if let work = model.work {
                        section("Your work") { workSummary(work) }
                    } else if model.workUnavailable {
                        section("Your work") {
                            Button("Retry loading work", action: connect)
                        }
                    }
                }
                .padding(.top, 12)
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
            }
            composer
        }
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
        withAnimation(.easeInOut(duration: 0.2)) { panel = destination }
    }

    private func closePanel() {
        historyQuery = ""
        historyResults = nil
        historyFailed = false
        withAnimation(.easeInOut(duration: 0.2)) { panel = nil }
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
                    Text("Chat history").font(.headline).accessibilityAddTraits(.isHeader)
                } else {
                    Button {
                        closePanel()
                        settingsOpen = true
                    } label: {
                        Label("Settings", systemImage: "gearshape")
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    }
                    .buttonStyle(.bordered)
                }
                Spacer()
                Button(action: closePanel) {
                    Image(systemName: "xmark").frame(width: 44, height: 44)
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
        .padding(.horizontal, 18)
        .frame(maxHeight: .infinity, alignment: .topLeading)
        .background(card.ignoresSafeArea())
    }

    private var workspaceTools: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 8) {
                    section("Knowledge", actionLabel: "Explore", open: showKnowledge) {
                        if let graph = model.knowledge {
                            HubKnowledgeGraphView(graph: graph, height: 90, overview: true, showsControls: false, select: selectKnowledgeNode)
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
                Button {
                    closePanel()
                    workspace()
                } label: { Label("Open workspace", systemImage: "arrow.up.right").frame(minHeight: 44) }
                .font(.footnote)
            }
        }
    }

    private func toolTile(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 8) {
                Image(systemName: icon).font(.title3)
                Text(title).font(.caption)
            }
            .frame(maxWidth: .infinity, minHeight: 72)
            .background(card, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(.white.opacity(0.08)))
        }
        .buttonStyle(.plain)
    }

    private var historyPanel: some View {
        let query = String(historyQuery.trimmingCharacters(in: .whitespacesAndNewlines).prefix(120))
        return VStack(alignment: .leading, spacing: 8) {
            TextField("Search chats", text: $historyQuery)
                .textFieldStyle(.roundedBorder)
                .submitLabel(.search)
                .disabled(model.connection != .connected)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if query.isEmpty {
                        pinnedHistory
                        Text("Recents").font(.subheadline.bold()).foregroundStyle(.secondary).padding(.vertical, 10)
                    }
                    if let conversations = query.isEmpty ? model.conversations : historyResults?.conversations {
                        if conversations.isEmpty {
                            Text(query.isEmpty ? "No conversations yet" : "No matching conversations")
                                .foregroundStyle(.secondary)
                        }
                        ForEach(conversations, id: \.sessionId) { chat in
                            historyRow(chat)
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
            Button { Task { await newChat() } } label: {
                Label("New Session", systemImage: "plus.square").frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
            .disabled(creatingChat || model.connection != .connected)
            Button {
                closePanel()
                voiceHistoryOpen = true
            } label: {
                Label("Voice History", systemImage: "waveform").frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.plain)
            .disabled(model.connection != .connected)
        }
        .task(id: model.connection == .connected) { await loadBookmarks() }
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

    private var pinnedHistory: some View {
        DisclosureGroup(isExpanded: $pinnedExpanded) {
            if let bookmarks {
                let byID = Dictionary(uniqueKeysWithValues: (model.conversations ?? []).map { ($0.sessionId, $0) })
                if bookmarks.sessionIds.isEmpty {
                    Text("No pinned conversations").font(.footnote).foregroundStyle(.secondary).padding(.vertical, 8)
                }
                ForEach(bookmarks.sessionIds, id: \.self) { id in
                    historyRow(byID[id] ?? HubConversationChoice(sessionId: id, title: "Pinned conversation", updatedAt: 0))
                }
            }
            if bookmarksError { Button("Retry loading pinned chats") { Task { await loadBookmarks() } } }
        } label: {
            HStack {
                Text("Pinned").font(.headline)
                Spacer()
                if let bookmarks { Text("\(bookmarks.sessionIds.count)").foregroundStyle(.secondary) }
                Image(systemName: "star")
            }
            .frame(minHeight: 44)
        }
    }

    private func historyRow(_ chat: HubConversationChoice) -> some View {
        HStack(spacing: 6) {
            Button { showChat(chat) } label: {
                Text(chat.title).lineLimit(2).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
            }
            if let bookmarks {
                let pinned = bookmarks.sessionIds.contains(chat.sessionId)
                Button { Task { await setPinned(chat.sessionId, pinned: !pinned) } } label: {
                    Image(systemName: pinned ? "star.fill" : "star").frame(width: 44, height: 44)
                }
                .accessibilityLabel(pinned ? "Unpin \(chat.title)" : "Pin \(chat.title)")
                .disabled(bookmarksBusy)
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

    private func newChat() async {
        guard !creatingChat, let api = chatAPI() else { return }
        creatingChat = true
        defer { creatingChat = false }
        do {
            let id = try await api.createChat()
            guard chatAPI() === api else { return }
            showChat(HubConversationChoice(sessionId: id, title: "New chat", updatedAt: 0))
        } catch {
            if chatAPI() === api { model.sendError = "Could not open a new conversation. Try again when connected." }
        }
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
        .foregroundStyle(.white)
        .tint(accent)
        .background(Color(uiColor: Self.backgroundColor).ignoresSafeArea())
        .preferredColorScheme(.dark)
        .interactiveDismissDisabled(noteSaving || noteEditing)
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
                        let text = try? AttributedString(markdown: note.content, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
                        Text(text ?? AttributedString(note.content)).textSelection(.enabled)
                        knowledgeLinks("Links", nodes: note.links ?? [])
                        knowledgeLinks("Backlinks", nodes: note.backlinks ?? [])
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
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
        let records = graph.nodes.filter {
            knowledgeScope.includes($0) && (query.isEmpty || ($0.title?.localizedCaseInsensitiveContains(query) ?? false))
        }
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                Picker("Knowledge scope", selection: $knowledgeScope) {
                    ForEach(HubKnowledgeGraphView.Scope.allCases) { scope in Text(scope.rawValue).tag(scope) }
                }
                .pickerStyle(.segmented)
                HubKnowledgeGraphView(graph: graph, height: 330, scope: knowledgeScope, select: selectKnowledgeNode)
                    .id(knowledgeScope)
                TextField("Find records", text: $knowledgeQuery).textFieldStyle(.roundedBorder)
                if records.isEmpty { Text("No matching records").foregroundStyle(.secondary) }
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
                    Divider()
                }
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
            if let id = model.uncertainChat {
                Button("Open conversation to check") { dismissKeyboard { openChat(id) } }
                    .font(.footnote)
                    .disabled(model.connection != .connected)
            }
            HStack(spacing: 3) {
                TextField("Chat…", text: $model.draft, prompt: Text("Chat…").foregroundColor(accent.opacity(0.75)))
                    .focused($composerFocused)
                    .accessibilityIdentifier("hub.home.draft")
                    .submitLabel(.send)
                    .onSubmit { if canSend { dismissKeyboard(then: send) } }
                    .disabled(model.sending)
                    .padding(.leading, 12)
                Button { dismissKeyboard(then: options) } label: {
                    Image(systemName: "plus").frame(width: 44, height: 44)
                }
                .accessibilityLabel("More actions")
                Button { dismissKeyboard(then: voice) } label: {
                    Image(systemName: "waveform").frame(width: 44, height: 44)
                }
                .accessibilityLabel(model.hasActiveVoice ? "Open voice controls" : "Speak")
                Button { dismissKeyboard(then: send) } label: {
                    Image(systemName: "arrow.up")
                        .font(.body.weight(.semibold))
                        .frame(width: 44, height: 44)
                        .background(Circle().fill(accent.opacity(canSend ? 0.28 : 0.10)))
                }
                .accessibilityLabel("Send")
                .accessibilityIdentifier("hub.home.send")
                .disabled(!canSend)
            }
            .buttonStyle(.plain)
            .padding(5)
            .background(card, in: RoundedRectangle(cornerRadius: 25))
            .overlay(RoundedRectangle(cornerRadius: 25).strokeBorder(.white.opacity(0.09)))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    private var canSend: Bool {
        model.connection == .connected && !model.sending && model.uncertainChat == nil
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
        VStack(alignment: .leading, spacing: 10) {
            Picker("Planner view", selection: $plannerTab) {
                Text("Agenda").tag(PlannerTab.agenda)
                Text("To-dos").tag(PlannerTab.todos)
            }
            .pickerStyle(.segmented)
            if plannerTab == .agenda {
                HStack {
                    Button {
                        calendarExpanded.toggle()
                    } label: {
                        Label(agendaDate.formatted(date: .abbreviated, time: .omitted),
                              systemImage: calendarExpanded ? "chevron.up" : "chevron.down")
                            .frame(minHeight: 44)
                    }
                    .accessibilityLabel(calendarExpanded ? "Collapse calendar" : "Expand calendar")
                    Spacer()
                    Button {
                        plannerEditor = PlannerEdit(item: nil, kind: .event)
                    } label: { Image(systemName: "plus").frame(width: 44, height: 44) }
                    .accessibilityLabel("Add event")
                    .disabled(!canEditPlanner)
                }
                if calendarExpanded {
                    DatePicker("Choose a day", selection: $agendaDate, displayedComponents: .date)
                        .datePickerStyle(.graphical).labelsHidden()
                } else {
                    agendaWeek
                }
                let events = planner.items.filter {
                    !$0.deleted && $0.state == "open" && $0.kind == "event" && $0.occurs(on: agendaDate)
                }.sorted { ($0.start ?? "") < ($1.start ?? "") }
                if events.isEmpty { Text("No plans for this day.").foregroundStyle(.secondary) }
                ForEach(events) { item in
                    Button {
                        plannerEditor = PlannerEdit(item: item, kind: .event)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.title).lineLimit(2)
                            if let instant = HubPlannerDraft.parseInstant(item.start) {
                                Text(instant, style: .time).font(.caption).foregroundStyle(.secondary)
                                    .environment(\.timeZone, item.timeZone.flatMap(TimeZone.init(identifier:)) ?? .current)
                            } else {
                                Text("All day").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .frame(minHeight: 44)
                    }
                    .buttonStyle(.plain)
                    .disabled(!canEditPlanner || item.version == nil)
                }
            } else {
                todoList(planner)
            }
            if model.plannerSaving { ProgressView().accessibilityLabel("Saving to planner") }
            if let error = model.plannerError { Text(error).font(.footnote).foregroundStyle(.secondary) }
        }
    }

    private var agendaWeek: some View {
        let calendar = Calendar.current
        let offset = ((calendar.dateComponents([.weekday], from: agendaDate).weekday ?? 2) + 5) % 7
        let first = calendar.date(byAdding: .day, value: -offset, to: agendaDate) ?? agendaDate
        let days = (0..<7).compactMap { calendar.date(byAdding: .day, value: $0, to: first) }
        return HStack(spacing: 2) {
            ForEach(days, id: \.self) { day in
                let selected = calendar.isDate(day, inSameDayAs: agendaDate)
                Button {
                    agendaDate = day
                } label: {
                    VStack(spacing: 4) {
                        Text(day.formatted(.dateTime.weekday(.narrow))).font(.caption2).foregroundStyle(.secondary)
                        Text(day.formatted(.dateTime.day())).font(.callout.weight(selected ? .semibold : .regular))
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .background(selected ? accent.opacity(0.18) : .clear, in: RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(day.formatted(date: .complete, time: .omitted))
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
    }

    private func todoList(_ planner: HubHomePlanner) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("Your list", selection: $todoHorizon) {
                Text("Soon").tag(HubHomePlanner.Horizon.near)
                Text("Later").tag(HubHomePlanner.Horizon.later)
            }
            .pickerStyle(.segmented)
                .disabled(model.plannerSaving)
            .onChange(of: todoHorizon) { _ in todoDraftID = UUID() }
            quickTodo
            let items = planner.items.filter {
                !$0.deleted && $0.state == "open" && $0.kind == "todo" && ($0.horizon ?? "near") == todoHorizon.rawValue
            }.sorted { ($0.date ?? "9999") < ($1.date ?? "9999") }
            ForEach(items) { item in
                HStack {
                    Button { completeTodo(item) } label: {
                        Image(systemName: "circle").frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Complete \(item.title)")
                    Button {
                        plannerEditor = PlannerEdit(item: item, kind: .todo)
                    } label: {
                        Text(item.title).lineLimit(2).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    }
                }
                .buttonStyle(.plain)
                .disabled(!canEditPlanner || item.version == nil)
            }
            if items.isEmpty {
                Text(todoHorizon == .near ? "Add something you want to get done." : "Keep your longer-term plans here.")
                    .foregroundStyle(.secondary)
            }
            let past = planner.items.filter { $0.deleted || $0.state == "done" }
                .sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
            if !past.isEmpty {
                DisclosureGroup("Completed & removed") {
                    ForEach(past.prefix(50)) { item in
                        HStack {
                            Text(item.title).lineLimit(2)
                            Spacer()
                            Button(item.deleted ? "Restore" : "Reopen") { restorePlannerItem(item) }
                                .disabled(!canEditPlanner || item.version == nil)
                                .frame(minHeight: 44)
                        }
                    }
                }
            }
        }
    }

    private var quickTodo: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                TextField("Add a to-do", text: $todoDraft)
                    .focused($todoFocused)
                    .submitLabel(.done)
                    .onSubmit(submitTodo)
                    .onChange(of: todoDraft) { _ in todoDraftID = UUID() }
                Button("Add") {
                    if todoDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        hideKeyboard()
                        plannerEditor = PlannerEdit(item: nil, kind: .todo)
                    } else { submitTodo() }
                }
                    .buttonStyle(.bordered)
            }
            .disabled(!canEditPlanner)
        }
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

    private func section<Content: View>(_ title: String, actionLabel: String = "Open", open: (() -> Void)? = nil,
                                        @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title)
                    .font(.headline)
                    .accessibilityAddTraits(.isHeader)
                if let open {
                    Spacer()
                    Button(action: open) { Text(actionLabel).font(.footnote).frame(minHeight: 40) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Open \(title)")
                }
            }
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(card, in: RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(.white.opacity(0.08)))
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
        .background(Color(uiColor: HubHomeView.backgroundColor).ignoresSafeArea())
        .preferredColorScheme(.dark)
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
    var load: () async throws -> HubWorkspaceTasks
    let api: HubConversationAPI
    let openChat: (HubConversationChoice) -> Void

    private struct PendingAction {
        let action: HubWorkspaceTaskAction
        let label: String
        let task: HubWorkspaceTask
        let routine: Bool
        var approvalID: String?
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
        .foregroundStyle(.white)
        .background(Color(uiColor: HubHomeView.backgroundColor).ignoresSafeArea())
        .preferredColorScheme(.dark)
        .confirmationDialog(pending?.label ?? "Confirm task action",
                            isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
                            titleVisibility: .visible, presenting: pending) { command in
            Button(command.label, role: destructive(command.action) ? .destructive : nil) {
                Task { await change(command) }
            }
        } message: { command in
            Text(command.task.title)
        }
    }

    private func taskSection(_ title: String, _ items: [HubWorkspaceTask], routine: Bool) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline).accessibilityAddTraits(.isHeader)
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
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(task.title).font(.body.weight(.medium))
                        Text(task.status.replacingOccurrences(of: "-", with: " ")).font(.caption).foregroundStyle(.secondary)
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
            }
        }
        if let plan = task.plan, !plan.isEmpty {
            DisclosureGroup("Milestones") {
                ForEach(plan) { step in
                    Label(step.title, systemImage: step.status == "done" ? "checkmark.circle" : "circle")
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
                    taskAction("Deny request", action: .deny, task: task, routine: false, approvalID: approval.id)
                }
            }
        }
    }

    @ViewBuilder private func taskActions(_ task: HubWorkspaceTask, routine: Bool) -> some View {
        if task.state == "active" { taskAction("Pause", action: .pause, task: task, routine: routine) }
        if task.state == "paused" { taskAction("Resume", action: .resume, task: task, routine: routine) }
        if task.status == "waiting-credit" {
            taskAction("Credits restored", action: .resumeCredit, task: task, routine: routine)
        }
        if routine {
            if ["active", "paused"].contains(task.state) {
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
        }
    }

    private func taskAction(_ label: String, action: HubWorkspaceTaskAction, task: HubWorkspaceTask,
                            routine: Bool, approvalID: String? = nil) -> some View {
        Button(label) {
            let command = PendingAction(action: action, label: label, task: task, routine: routine, approvalID: approvalID)
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
