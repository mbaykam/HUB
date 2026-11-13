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
    @Published var openNativeChat: HubConversationChoice?
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
    var readKnowledgeNote: (String) async throws -> HubKnowledgeNote
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
    @State private var knowledgeScope = HubKnowledgeGraphView.Scope.all
    @State private var knowledgeQuery = ""
    @State private var selectedChat: (choice: HubConversationChoice, api: HubConversationAPI)?
    @State private var tasksOpen = false
    @State private var usageOpen = false
    @State private var knowledgeActivityOpen = false
    @State private var historyQuery = ""
    @State private var historyResults: HubConversationCatalog?
    @State private var historyFailed = false
    @State private var historyAttempt = 0
    @State private var todoDraft = ""
    @State private var todoDraftID = UUID()
    @State private var todoHorizon = HubHomePlanner.Horizon.near
    @State private var agendaDate = Date()
    @State private var plannerTab = PlannerTab.todos
    @FocusState private var composerFocused: Bool
    @FocusState private var todoFocused: Bool
    private let card = Color(red: 0.085, green: 0.105, blue: 0.165)
    private let accent = Color(red: 0.75, green: 0.80, blue: 1.0)

    private enum PlannerTab: String {
        case agenda = "Agenda"
        case todos = "To-dos"
    }

    var body: some View {
        ZStack {
            workspaceContent
                .opacity(selectedChat == nil ? 1 : 0)
                .allowsHitTesting(selectedChat == nil)
                .accessibilityHidden(selectedChat != nil)
            if let selectedChat {
                HubLiveChatView(chat: selectedChat.choice, api: selectedChat.api,
                                back: { self.selectedChat = nil }, voice: voice, openChat: showChat)
                    .id(selectedChat.choice.sessionId)
            }
        }
        .foregroundStyle(.white)
        .tint(accent)
        .background(Color(uiColor: Self.backgroundColor).ignoresSafeArea())
        .preferredColorScheme(.dark)
        .sheet(isPresented: $knowledgeOpen, onDismiss: clearKnowledgeSelection) { knowledgeScreen }
        .sheet(isPresented: $tasksOpen) {
            if let api = chatAPI() { HubTasksView(load: readTasks, api: api) }
        }
        .sheet(isPresented: $usageOpen) {
            if let api = chatAPI() { HubUsageView(api: api) }
        }
        .sheet(isPresented: $knowledgeActivityOpen) {
            if let api = chatAPI() { HubKnowledgeActivityView(api: api) }
        }
        .onChange(of: model.openNativeChat) { chat in
            if let chat { showChat(chat); model.openNativeChat = nil }
        }
        .onChange(of: model.connection) { connection in
            if connection == .needsSetup || connection == .signInRequired {
                knowledgeOpen = false
                clearKnowledgeSelection()
                tasksOpen = false
                usageOpen = false
                knowledgeActivityOpen = false
                selectedChat = nil
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
                    section("Knowledge", symbol: "circle.hexagongrid", open: showKnowledge) {
                        if let value = model.knowledge {
                            let notes = value.nodes.filter { $0.kind != "conversation" }
                            Text("\(notes.count) Brain notes  ·  \(value.domains?.filter { $0.status == "active" && $0.parentId == nil }.count ?? 0) Domains  ·  \(value.edges.count) Connections  ·  \(value.nodes.count - notes.count) Chat archive")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            HubKnowledgeGraphView(graph: value, height: 230, scope: .notes, select: selectKnowledgeNode)
                        }

                    }
                    section("Your day", symbol: "calendar") {
                        if let planner = model.planner {
                            personalPlanner(planner)
                        }

                    }
                    if let work = model.work {
                        section("Your work", symbol: "clock") { workSummary(work) }
                    } else if model.workUnavailable {
                        section("Your work", symbol: "clock") {
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
                Text(destination == .history ? "Chat history" : "Workspace")
                    .font(.headline)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Button(action: closePanel) {
                    Image(systemName: "xmark").frame(width: 44, height: 44)
                }
                .accessibilityLabel("Close panel")
            }
            if destination == .history {
                historyPanel
            } else {
                Button(action: showKnowledge) {
                    Label("Knowledge", systemImage: "circle.hexagongrid").frame(minHeight: 44)
                }
                Button {
                    closePanel()
                    knowledgeActivityOpen = true
                } label: { Label("Knowledge AI Activity", systemImage: "clock.arrow.circlepath").frame(minHeight: 44) }
                .disabled(model.connection != .connected)
                Button {
                    closePanel()
                    tasksOpen = true
                } label: { Label("Tasks", systemImage: "checklist").frame(minHeight: 44) }
                .disabled(model.connection != .connected)
                Button {
                    closePanel()
                    usageOpen = true
                } label: { Label("Usage limits", systemImage: "chart.bar.xaxis").frame(minHeight: 44) }
                .disabled(model.connection != .connected)
                Button {
                    closePanel()
                    options()
                } label: { Label("iPhone settings", systemImage: "gearshape").frame(minHeight: 44) }
                Button {
                    closePanel()
                    workspace()
                } label: { Label("Open workspace", systemImage: "arrow.up.right").frame(minHeight: 44) }
                .disabled(model.connection != .connected)
                Spacer()
            }
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 18)
        .frame(maxHeight: .infinity, alignment: .topLeading)
        .background(card.ignoresSafeArea())
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
                    if let conversations = query.isEmpty ? model.conversations : historyResults?.conversations {
                        if conversations.isEmpty {
                            Text(query.isEmpty ? "No conversations yet" : "No matching conversations")
                                .foregroundStyle(.secondary)
                        }
                        ForEach(conversations, id: \.sessionId) { chat in
                            Button { showChat(chat) } label: {
                                HStack {
                                    Text(chat.title).lineLimit(2)
                                    Spacer()
                                    Image(systemName: "chevron.right").font(.caption)
                                }
                                .frame(minHeight: 44)
                                .contentShape(Rectangle())
                            }
                            .disabled(model.connection != .connected)
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
        guard let api = chatAPI() else { return }
        dismissKeyboard {
            closePanel()
            knowledgeOpen = false
            tasksOpen = false
            usageOpen = false
            knowledgeActivityOpen = false
            selectedChat = (chat, api)
        }
    }

    private func clearKnowledgeSelection() {
        selectedNoteID = nil
        selectedNote = nil
        noteLoadFailed = false
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
                } else {
                    Text("Knowledge").font(.headline).accessibilityAddTraits(.isHeader)
                }
                Spacer()
                Button("Done") { knowledgeOpen = false }
            }
            if let id = selectedNoteID {
                Group {
                    if let note = selectedNote {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 12) {
                                Text(note.title).font(.title2.bold()).accessibilityAddTraits(.isHeader)
                                Text(note.content).textSelection(.enabled)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
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

    private func personalPlanner(_ planner: HubHomePlanner) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("Planner view", selection: $plannerTab) {
                Text("Agenda").tag(PlannerTab.agenda)
                Text("To-dos").tag(PlannerTab.todos)
            }
            .pickerStyle(.segmented)
            if plannerTab == .agenda {
                DatePicker("Day", selection: $agendaDate, displayedComponents: .date)
                    .datePickerStyle(.compact)
                let events = planner.items.filter {
                    !$0.deleted && $0.state == "open" && $0.kind == "event" && $0.occurs(on: agendaDate)
                }.sorted { ($0.start ?? "") < ($1.start ?? "") }
                if events.isEmpty { Text("No plans for this day.").foregroundStyle(.secondary) }
                ForEach(events) { item in
                    Label(item.title, systemImage: "calendar").lineLimit(2)
                }
            } else {
                todoList(planner)
            }
            if model.plannerSaving { ProgressView().accessibilityLabel("Saving to planner") }
            if let error = model.plannerError { Text(error).font(.footnote).foregroundStyle(.secondary) }
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
                Button { completeTodo(item) } label: {
                    Label(item.title, systemImage: "circle").lineLimit(2).frame(minHeight: 44, alignment: .leading)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Complete \(item.title)")
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
                Button("Add", action: submitTodo)
                    .buttonStyle(.bordered)
                    .disabled(todoDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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

    private func section<Content: View>(_ title: String, symbol: String, open: (() -> Void)? = nil, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(title, systemImage: symbol)
                    .font(.headline)
                    .accessibilityAddTraits(.isHeader)
                if let open {
                    Spacer()
                    Button(action: open) { Image(systemName: "arrow.up.right").frame(width: 44, height: 44) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Open \(title)")
                }
            }
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(card, in: RoundedRectangle(cornerRadius: 20))
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
    var load: () async throws -> HubWorkspaceTasks
    let api: HubConversationAPI

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
    }

    private func taskSection(_ title: String, _ items: [HubWorkspaceTask], routine: Bool) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline).accessibilityAddTraits(.isHeader)
            let visible = items.filter { $0.state != "archived" }.sorted { $0.updatedAt > $1.updatedAt }
            if visible.isEmpty { Text("No \(title.lowercased())").foregroundStyle(.secondary) }
            ForEach(visible) { task in
                DisclosureGroup {
                    if let detail = task.objective ?? task.prompt { Text(detail).textSelection(.enabled) }
                    if let nextAt = task.nextAt, task.state == "active" {
                        Text(Date(timeIntervalSince1970: nextAt / 1_000).formatted()).foregroundStyle(.secondary)
                    }
                    if ["active", "paused"].contains(task.state),
                       let revision = routine ? tasks?.routinesRevision : task.revision {
                        Button(task.state == "active" ? "Pause" : "Resume") {
                            Task { await change(task, revision: revision, routine: routine) }
                        }
                        .disabled(changing)
                    }
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

    private func change(_ task: HubWorkspaceTask, revision: Int, routine: Bool) async {
        guard !changing else { return }
        changing = true
        changeError = false
        defer { changing = false }
        do { try await api.setWorkspaceTaskPaused(task.state == "active", id: task.id, revision: revision, routine: routine) }
        catch { changeError = true }
        attempt += 1
    }
}
