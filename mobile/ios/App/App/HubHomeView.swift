import SwiftUI
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
    @Published var conversations: [HubConversationChoice]?
    @Published var hasActiveVoice = false
}

@MainActor
struct HubHomeView: View {
    @ObservedObject var model: HubHomeModel
    var connect: () -> Void
    var voice: () -> Void
    var options: () -> Void
    var workspace: () -> Void
    var openChat: (String) -> Void
    var send: () -> Void

    private let background = Color(red: 0.045, green: 0.064, blue: 0.105)
    private let card = Color(red: 0.085, green: 0.105, blue: 0.165)
    private let accent = Color(red: 0.75, green: 0.80, blue: 1.0)

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    connectionRow
                    section("Knowledge", symbol: "circle.hexagongrid") {
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
                                Label(item.title, systemImage: "circle").lineLimit(2)
                            }
                        }

                    }
                    section("Recent chats", symbol: "bubble.left.and.bubble.right") {
                        if let conversations = model.conversations {
                            if conversations.isEmpty {
                                Text("No conversations yet").foregroundStyle(.secondary)
                            }
                            ForEach(Array(conversations.prefix(5)), id: \.sessionId) { chat in
                                Button { openChat(chat.sessionId) } label: {
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
                    Button(action: workspace) { Label("Open workspace", systemImage: "arrow.up.right") }
                        .buttonStyle(.bordered)
                        .disabled(model.connection != .connected)
                }
                .padding(.top, 12)
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
            }
            composer
        }
        .foregroundStyle(.white)
        .tint(accent)
        .background(background.ignoresSafeArea())
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
                Button("Open conversation to check") { openChat(id) }
                    .font(.footnote)
                    .disabled(model.connection != .connected)
            }
            HStack(spacing: 3) {
                TextField("Chat…", text: $model.draft)
                    .accessibilityIdentifier("hub.home.draft")
                    .submitLabel(.send)
                    .onSubmit(send)
                    .disabled(model.sending)
                    .padding(.leading, 12)
                Button(action: options) {
                    Image(systemName: "plus").frame(width: 44, height: 44)
                }
                .accessibilityLabel("More actions")
                Button(action: voice) {
                    Image(systemName: "waveform").frame(width: 44, height: 44)
                }
                .accessibilityLabel(model.hasActiveVoice ? "Open voice controls" : "Speak")
                Button(action: send) {
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

    private func section<Content: View>(_ title: String, symbol: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: symbol)
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
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
