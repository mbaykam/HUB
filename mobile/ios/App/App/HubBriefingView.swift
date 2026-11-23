import SwiftUI
import HubNative

/// The assistant's chosen name, as last loaded from HUB (Settings → Assistant).
enum HubAssistantName {
    static let key = "hub.assistantName"
    static var current: String {
        let name = UserDefaults.standard.string(forKey: key)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? "HUB" : name
    }
}

/// Home's daily briefing: headlines on the topics you follow. The PC fetches
/// them from news feeds, so reading the briefing costs no model tokens.
@MainActor
final class HubBriefingModel: ObservableObject {
    @Published private(set) var value: HubBriefing?
    @Published private(set) var failed = false
    @Published private(set) var busy = false
    @Published var error: String?
    var api: HubConversationAPI?

    static let suggestions = ["Türkiye", "Dünya", "Yapay zekâ", "Teknoloji", "Ekonomi", "Borsa İstanbul", "Bitcoin", "Bilim", "Spor", "Adana"]

    func load() async {
        guard let api else { return }
        do {
            var latest = try await api.briefing()
            value = latest
            failed = false
            // HUB fetches stale headlines in the background; look again shortly.
            var tries = 0
            while latest.refreshing && tries < 4 && !Task.isCancelled {
                tries += 1
                try await Task.sleep(nanoseconds: 3_000_000_000)
                latest = try await api.briefing()
                value = latest
            }
        } catch {
            if !Task.isCancelled { failed = value == nil }
        }
    }

    func refresh() async {
        guard let api, !busy else { return }
        busy = true
        defer { busy = false }
        do { value = try await api.refreshBriefing(); error = nil }
        catch { self.error = "Could not refresh the briefing. Check that HUB is online." }
    }

    @discardableResult
    func add(_ title: String) async -> Bool {
        let topic = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let api, !topic.isEmpty, !busy else { return false }
        busy = true
        defer { busy = false }
        do {
            value = try await api.addBriefingTopic(topic)
            error = nil
            Task { await load() }
            return true
        } catch {
            self.error = "Could not add “\(topic)”. A topic has at most 80 characters, and the briefing follows up to 16."
            return false
        }
    }

    func remove(_ topic: HubBriefing.Topic) async {
        guard let api, !busy else { return }
        busy = true
        defer { busy = false }
        do { value = try await api.removeBriefingTopic(id: topic.id); error = nil }
        catch { self.error = "Could not remove “\(topic.title)”." }
    }

    func move(_ topic: HubBriefing.Topic, to index: Int) async {
        guard let api, !busy else { return }
        busy = true
        defer { busy = false }
        do { value = try await api.moveBriefingTopic(id: topic.id, to: index); error = nil }
        catch { self.error = "Could not reorder the topics." }
    }
}

/// The briefing's card on Home.
struct HubBriefingCard: View {
    @ObservedObject var model: HubBriefingModel
    let openTopics: () -> Void
    @Environment(\.openURL) private var openURL
    @AppStorage("hub.briefing.topic") private var chosenTopic = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let value = model.value {
                if value.topics.isEmpty {
                    emptyState
                } else {
                    topicChips(value.topics)
                    headlines(value)
                    footer(value)
                }
            } else if model.failed {
                Button("Retry loading the briefing") { Task { await model.load() } }.font(.subheadline)
            } else {
                ProgressView().frame(maxWidth: .infinity, minHeight: 60)
            }
            if let error = model.error {
                Label(error, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
            }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Pick what you want to hear about. \(HubAssistantName.current) adds topics too when you talk about something new.")
                .font(.subheadline).foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(HubBriefingModel.suggestions.prefix(6), id: \.self) { topic in
                        Button { Task { await model.add(topic) } } label: {
                            Label(topic, systemImage: "plus").font(.caption)
                                .padding(.horizontal, 10).frame(minHeight: 32)
                                .background(HubWorkspacePalette.border.opacity(0.08), in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .disabled(model.busy)
                    }
                }
            }
            Button(action: openTopics) { Label("Choose topics", systemImage: "slider.horizontal.3").font(.subheadline) }
                .buttonStyle(.plain).foregroundStyle(HubWorkspacePalette.accent)
        }
    }

    private func topicChips(_ topics: [HubBriefing.Topic]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip("All", selected: !topics.contains { $0.id == chosenTopic }) { chosenTopic = "" }
                ForEach(topics) { topic in
                    chip(topic.title, selected: topic.id == chosenTopic) { chosenTopic = topic.id }
                }
            }
        }
    }

    private func chip(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.subheadline.weight(.medium)).lineLimit(1)
                .padding(.horizontal, 14).frame(minHeight: 34)
                .foregroundStyle(selected ? HubWorkspacePalette.onAccent : Color.primary)
                .background(selected ? AnyShapeStyle(HubWorkspacePalette.accent) : AnyShapeStyle(HubWorkspacePalette.border.opacity(0.1)), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// One topic: its top three headlines. All: the top story of each topic.
    private typealias Row = (item: HubBriefing.Item, topic: String?)

    private func rows(_ sections: [HubBriefing.Section]) -> [Row] {
        if let section = sections.first(where: { $0.topicId == chosenTopic }) {
            return section.items.prefix(3).map { item -> Row in (item: item, topic: nil) }
        }
        var all: [Row] = []
        for section in sections {
            if let first = section.items.first { all.append((item: first, topic: section.title)) }
        }
        return Array(all.prefix(5))
    }

    @ViewBuilder private func headlines(_ value: HubBriefing) -> some View {
        let list = rows(value.briefing?.sections ?? [])
        if list.isEmpty {
            Text(value.refreshing || value.briefing == nil ? "Gathering today's headlines…" : "No fresh headlines for this topic in the last two days.")
                .font(.subheadline).foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(list, id: \.item.id) { row in
                    Button { if let link = row.item.link { openURL(link) } } label: { headline(row.item, topic: row.topic) }
                        .buttonStyle(.plain)
                        .disabled(row.item.link == nil)
                }
            }
        }
    }

    private func headline(_ item: HubBriefing.Item, topic: String?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            if let topic {
                Text(topic.uppercased()).font(.caption2.weight(.semibold)).foregroundStyle(HubWorkspacePalette.accent)
            }
            Text(item.title).font(.subheadline.weight(.medium)).lineLimit(3).multilineTextAlignment(.leading)
            HStack(spacing: 4) {
                Text(item.source)
                if let date = item.date {
                    Text("·")
                    Text(date, style: .relative)
                }
            }
            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the article")
    }

    private func footer(_ value: HubBriefing) -> some View {
        HStack {
            if let edition = value.briefing {
                Text("Updated \(edition.date.formatted(date: .omitted, time: .shortened))").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if model.busy || value.refreshing {
                ProgressView().controlSize(.small)
            } else {
                Button { Task { await model.refresh() } } label: {
                    Image(systemName: "arrow.clockwise").font(.footnote.weight(.semibold)).frame(width: 36, height: 32)
                }
                .buttonStyle(.plain)
                .foregroundStyle(HubWorkspacePalette.accent)
                .accessibilityLabel("Refresh the briefing")
            }
        }
    }
}

/// Briefing → Topics: what the briefing follows, in order.
struct HubBriefingTopicsView: View {
    @ObservedObject var model: HubBriefingModel
    var pushed = false
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @FocusState private var typing: Bool

    private var topics: [HubBriefing.Topic] { model.value?.topics ?? [] }

    var body: some View {
        HubNavigation(pushed: pushed) {
            List {
                Section {
                    HStack {
                        TextField("Add a topic, like “Formula 1”", text: $draft)
                            .focused($typing)
                            .submitLabel(.done)
                            .onSubmit(add)
                        Button("Add", action: add)
                            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy)
                    }
                } footer: {
                    Text("Short search words work best. \(HubAssistantName.current) can add or remove topics too when your interests change; those are marked.")
                }
                if !topics.isEmpty {
                    Section("Following") {
                        ForEach(topics) { topic in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(topic.title)
                                if topic.addedByAssistant {
                                    Text("Added by \(HubAssistantName.current)").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                        .onDelete { offsets in
                            for index in offsets { let topic = topics[index]; Task { await model.remove(topic) } }
                        }
                        .onMove { source, destination in
                            guard let from = source.first else { return }
                            let topic = topics[from]
                            Task { await model.move(topic, to: destination > from ? destination - 1 : destination) }
                        }
                    }
                }
                let ideas = HubBriefingModel.suggestions.filter { idea in !topics.contains { $0.title.caseInsensitiveCompare(idea) == .orderedSame } }
                if !ideas.isEmpty {
                    Section("Ideas") {
                        ForEach(ideas, id: \.self) { idea in
                            Button { Task { await model.add(idea) } } label: { Label(idea, systemImage: "plus.circle") }
                                .disabled(model.busy)
                        }
                    }
                }
                if let error = model.error {
                    Section { Text(error).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Briefing topics")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { if !pushed { Button("Done") { dismiss() } } }
                ToolbarItem(placement: .primaryAction) { if !topics.isEmpty { EditButton() } }
            }
        }
        .task { if model.value == nil { await model.load() } }
    }

    private func add() {
        let topic = draft
        Task { if await model.add(topic) { draft = "" } }
    }
}
