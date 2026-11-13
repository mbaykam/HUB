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
    @Published var hasActiveVoice = false
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
    var addTodo: (UUID, String) async -> Bool
    var completeTodo: (HubHomePlanner.Item) -> Void
    var readKnowledgeNote: (String) async throws -> HubKnowledgeNote
    var readChat: (String) async throws -> HubChatSnapshot
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
    @State private var chatOpen = false
    @State private var selectedChat: HubConversationChoice?
    @State private var chatSnapshot: HubChatSnapshot?
    @State private var chatLoadFailed = false
    @State private var chatAttempt = 0
    @State private var tasksOpen = false
    @State private var todoDraft = ""
    @State private var todoDraftID = UUID()
    @FocusState private var composerFocused: Bool
    @FocusState private var todoFocused: Bool
    private let card = Color(red: 0.085, green: 0.105, blue: 0.165)
    private let accent = Color(red: 0.75, green: 0.80, blue: 1.0)

    var body: some View {
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
        .foregroundStyle(.white)
        .tint(accent)
        .background(Color(uiColor: Self.backgroundColor).ignoresSafeArea())
        .preferredColorScheme(.dark)
        .sheet(isPresented: $knowledgeOpen, onDismiss: clearKnowledgeSelection) { knowledgeScreen }
        .sheet(isPresented: $chatOpen, onDismiss: clearChatSelection) { chatScreen }
        .sheet(isPresented: $tasksOpen) { HubTasksView(load: readTasks) }
        .onChange(of: model.connection) { connection in
            if connection == .needsSetup || connection == .signInRequired {
                knowledgeOpen = false
                clearKnowledgeSelection()
                chatOpen = false
                tasksOpen = false
                clearChatSelection()
            }
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
                            Text("\(notes.count) brain notes  ·  \(value.nodes.count - notes.count) chats")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            if !notes.isEmpty { knowledgeMap(value, nodes: Array(notes.prefix(48))) }
                        }

                    }
                    section("Your day", symbol: "calendar") {
                        if let planner = model.planner {
                            let today = Calendar.current.startOfDay(for: Date())
                            let date = Calendar.current.dateComponents([.year, .month, .day], from: today)
                            let day = String(format: "%04d-%02d-%02d", date.year ?? 0, date.month ?? 0, date.day ?? 0)
                            let events = Array(planner.items.lazy.filter {
                                !$0.deleted && $0.kind == "event" && ($0.date == day || $0.start?.hasPrefix(day) == true)
                            }.prefix(3))
                            ForEach(events, id: \.id) { item in
                                Label(item.title, systemImage: "calendar").lineLimit(2)
                            }
                            let items = Array(planner.items.lazy.filter {
                                !$0.deleted && $0.state == "open" && $0.kind == "todo"
                            }.prefix(3))
                            if items.isEmpty && events.isEmpty {
                                Text("No open to-dos").foregroundStyle(.secondary)
                            }
                            ForEach(items, id: \.id) { item in
                                Button { completeTodo(item) } label: {
                                    Label(item.title, systemImage: "circle")
                                        .lineLimit(2)
                                        .frame(minHeight: 44, alignment: .leading)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Complete \(item.title)")
                                .disabled(!canEditPlanner || item.version == nil)
                            }
                            quickTodo
                        }

                    }
                    section("Recent chats", symbol: "bubble.left.and.bubble.right") {
                        if let conversations = model.conversations {
                            if conversations.isEmpty {
                                Text("No conversations yet").foregroundStyle(.secondary)
                            }
                            ForEach(Array(conversations.prefix(5)), id: \.sessionId) { chat in
                                Button { showChat(chat) } label: {
                                    HStack {
                                        Text(chat.title).lineLimit(2)
                                        Spacer()
                                        Image(systemName: "chevron.right").font(.caption)
                                    }
                                    .frame(minHeight: 36)
                                }
                                .buttonStyle(.plain)
                            }
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

    private func showPanel(_ destination: Panel) {
        hideKeyboard()
        withAnimation(.easeInOut(duration: 0.2)) { panel = destination }
    }

    private func closePanel() {
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
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        if let conversations = model.conversations {
                            if conversations.isEmpty {
                                Text("No conversations yet").foregroundStyle(.secondary)
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
                            }
                        } else {
                            connectionRow
                        }
                    }
                }
            } else {
                Button(action: showKnowledge) {
                    Label("Knowledge", systemImage: "circle.hexagongrid").frame(minHeight: 44)
                }
                Button {
                    closePanel()
                    tasksOpen = true
                } label: { Label("Tasks", systemImage: "checklist").frame(minHeight: 44) }
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

    private func showKnowledge() {
        dismissKeyboard {
            closePanel()
            knowledgeOpen = true
        }
    }

    private func showChat(_ chat: HubConversationChoice) {
        dismissKeyboard {
            closePanel()
            clearChatSelection()
            selectedChat = chat
            chatOpen = true
        }
    }

    private func clearChatSelection() {
        selectedChat = nil
        chatSnapshot = nil
        chatLoadFailed = false
    }

    private var chatScreen: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(selectedChat?.title ?? "Chat").font(.headline).lineLimit(2)
                Spacer()
                Button("Done") { chatOpen = false }
            }
            if let chat = selectedChat {
                if let snapshot = chatSnapshot {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            if snapshot.hasMore {
                                Text("Showing recent messages").font(.footnote).foregroundStyle(.secondary)
                            }
                            if snapshot.messages.isEmpty { Text("No text messages yet").foregroundStyle(.secondary) }
                            ForEach(snapshot.messages) { message in
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(message.role == "user" ? "You" : "Assistant").font(.caption).foregroundStyle(.secondary)
                                    Text(message.text).textSelection(.enabled)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(12)
                                .background(card, in: RoundedRectangle(cornerRadius: 14))
                            }
                        }
                    }
                } else if chatLoadFailed {
                    Button("Retry loading chat") { chatLoadFailed = false; chatAttempt += 1 }
                } else {
                    ProgressView("Loading chat…")
                }
                if chatSnapshot != nil { Button("Refresh") { chatAttempt += 1 } }
                Button("Open in workspace") {
                    chatOpen = false
                    openChat(chat.sessionId)
                }
            }
            Spacer(minLength: 0)
        }
        .task(id: chatAttempt) {
            guard let id = selectedChat?.sessionId else { return }
            do {
                let snapshot = try await readChat(id)
                if !Task.isCancelled, selectedChat?.sessionId == id { chatSnapshot = snapshot }
            } catch {
                if !Task.isCancelled, selectedChat?.sessionId == id {
                    chatSnapshot = nil
                    chatLoadFailed = true
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

    private func clearKnowledgeSelection() {
        selectedNoteID = nil
        selectedNote = nil
        noteLoadFailed = false
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
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        let notes = graph.nodes.filter { $0.kind != "conversation" && $0.title != nil }
                        if !notes.isEmpty { knowledgeMap(graph, nodes: Array(notes.prefix(48))) }
                        if notes.isEmpty { Text("No notes yet").foregroundStyle(.secondary) }
                        ForEach(notes, id: \.id) { node in
                            Button {
                                selectedNoteID = node.id
                                noteAttempt += 1
                            } label: {
                                HStack {
                                    Text(node.title ?? "").lineLimit(2)
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
            if model.plannerSaving { ProgressView().accessibilityLabel("Saving to planner") }
            if let error = model.plannerError { Text(error).font(.footnote).foregroundStyle(.secondary) }
        }
    }

    private func submitTodo() {
        let title = todoDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canEditPlanner, !title.isEmpty else { return }
        let id = todoDraftID
        todoFocused = false
        Task {
            if await addTodo(id, title), id == todoDraftID { todoDraft = "" }
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

    private func knowledgeMap(_ graph: HubHomeKnowledge, nodes: [HubHomeKnowledge.Node]) -> some View {
        Canvas { context, size in
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            var positions: [String: CGPoint] = [:]
            for (index, node) in nodes.enumerated() {
                let angle = CGFloat(index) * 2.399963
                let distance = sqrt(CGFloat(index + 1) / CGFloat(nodes.count))
                positions[node.id] = CGPoint(
                    x: center.x + cos(angle) * distance * (center.x - 10),
                    y: center.y + sin(angle) * distance * (center.y - 10)
                )
            }
            for edge in graph.edges {
                guard let start = positions[edge.source], let end = positions[edge.target] else { continue }
                var line = Path()
                line.move(to: start)
                line.addLine(to: end)
                context.stroke(line, with: .color(accent.opacity(0.30)), lineWidth: 1)
            }
            for point in positions.values {
                let dot = Path(ellipseIn: CGRect(x: point.x - 3, y: point.y - 3, width: 6, height: 6))
                context.fill(dot, with: .color(accent))
            }
        }
        .frame(height: 100)
        .accessibilityHidden(true)
    }
}

@MainActor
private struct HubTasksView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var tasks: HubWorkspaceTasks?
    @State private var failed = false
    @State private var attempt = 0
    var load: () async throws -> HubWorkspaceTasks

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
                        taskSection("Goals", tasks.goals)
                        taskSection("Routines", tasks.routines)
                    }
                }
                Button("Refresh") { attempt += 1 }
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

    private func taskSection(_ title: String, _ tasks: [HubWorkspaceTask]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline).accessibilityAddTraits(.isHeader)
            let visible = tasks.filter { $0.state != "archived" }.sorted { $0.updatedAt > $1.updatedAt }
            if visible.isEmpty { Text("No \(title.lowercased())").foregroundStyle(.secondary) }
            ForEach(visible) { task in
                DisclosureGroup {
                    if let detail = task.objective ?? task.prompt { Text(detail).textSelection(.enabled) }
                    if let nextAt = task.nextAt, task.state == "active" {
                        Text(Date(timeIntervalSince1970: nextAt / 1_000).formatted()).foregroundStyle(.secondary)
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
}
