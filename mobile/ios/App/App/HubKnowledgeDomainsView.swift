import SwiftUI
import HubNative

@MainActor
struct HubKnowledgeDomainsView: View {
    let api: HubConversationAPI
    let changed: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var registry: HubKnowledgeDomains?
    @State private var draft: Draft?
    @State private var memberDomain: HubKnowledgeDomains.Domain?
    @State private var selectedNotes: Set<String> = []
    @State private var search = ""
    @State private var notice: String?
    @State private var loading = true
    @State private var saving = false
    @State private var stale = false
    @State private var attempt = 0

    private struct Draft {
        var id: String?
        var title = ""
        var aliases = ""
        var parent = ""

        var names: [String] {
            aliases.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        }
        var valid: Bool {
            let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
            return !name.isEmpty && name.utf16.count <= 100 && names.count <= 12 && names.allSatisfy { $0.utf16.count <= 100 }
        }
    }

    var body: some View {
        NavigationView {
            Form {
                if loading || saving { ProgressView() }
                if let notice {
                    Text(notice).font(.footnote).foregroundStyle(.secondary)
                    if stale {
                        Button(draft == nil && memberDomain == nil ? "Reload domains" : "Reload domains and discard draft") {
                            draft = nil
                            memberDomain = nil
                            attempt += 1
                        }
                    }
                }
                if let registry {
                    if let draft { editor(draft, registry: registry) }
                    else if let memberDomain { memberships(memberDomain, registry: registry) }
                    else { domains(registry) }
                }
            }
            .disabled(saving)
            .navigationTitle(memberDomain?.title ?? "Knowledge domains")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(draft == nil && memberDomain == nil ? "Done" : "Cancel") {
                        if draft != nil || memberDomain != nil { draft = nil; memberDomain = nil }
                        else { dismiss() }
                    }
                    .disabled(saving)
                }
            }
        }
        .navigationViewStyle(.stack)
        .interactiveDismissDisabled(draft != nil || memberDomain != nil || saving)
        .task(id: attempt) { await load() }
    }

    private func domains(_ registry: HubKnowledgeDomains) -> some View {
        let available = registry.domains.filter { $0.status != "merged" }
        let roots = available.filter { $0.parentId == nil && $0.status == "active" }
        return Section {
            Button { draft = Draft() } label: { Label("New domain", systemImage: "plus") }
                .disabled(stale)
            if available.isEmpty { Text("No domains yet").foregroundStyle(.secondary) }
            ForEach(available) { domain in
                let notes = registry.memberships.filter { $0.domainId == domain.id }.count
                VStack(alignment: .leading, spacing: 5) {
                    Text(path(domain, in: available)).font(.headline)
                    Text("\(notes) notes · \(domain.status)").font(.footnote).foregroundStyle(.secondary)
                    Menu {
                        Button("Edit domain") {
                            draft = Draft(id: domain.id, title: domain.title,
                                          aliases: domain.aliases.joined(separator: ", "), parent: domain.parentId ?? "")
                        }
                        Button("Manage note memberships") {
                            memberDomain = domain
                            selectedNotes = Set(registry.memberships.filter { $0.domainId == domain.id }.map(\.nodeId))
                            search = ""
                        }
                    } label: { Label("Manage", systemImage: "ellipsis.circle").frame(minHeight: 44) }
                    .disabled(stale)
                }
            }
        } header: {
            Text("\(roots.count) of \(registry.maxActiveDomains) active main domains")
        }
    }

    @ViewBuilder
    private func editor(_ value: Draft, registry: HubKnowledgeDomains) -> some View {
        let candidates = registry.domains.filter {
            $0.status != "merged" && Optional($0.id) != value.id && !isDescendant($0, of: value.id, in: registry.domains)
        }
        Section("Domain details") {
            TextField("Name", text: draftField(\.title, fallback: value.title))
            TextField("Aliases, separated by commas", text: draftField(\.aliases, fallback: value.aliases))
            Picker("Parent domain", selection: draftField(\.parent, fallback: value.parent)) {
                Text("Main level").tag("")
                ForEach(candidates) { Text(path($0, in: registry.domains)).tag($0.id) }
            }
            Button("Save domain") {
                let title = value.title.trimmingCharacters(in: .whitespacesAndNewlines)
                let parent = value.parent.isEmpty ? nil : value.parent
                let edit: HubKnowledgeDomains.Change
                if let id = value.id { edit = .edit(id: id, title: title, aliases: value.names, parent: parent) }
                else { edit = .create(title: title, aliases: value.names, parent: parent) }
                Task { await save([edit], revision: registry.revision) }
            }
            .disabled(!value.valid || stale)
        }
        if let original = registry.domains.first(where: { $0.id == value.id }) {
            Section {
                Button(original.status == "active" ? "Deactivate domain and its subdomains" : "Activate domain") {
                    Task { await save([.activate(id: original.id, active: original.status != "active")], revision: registry.revision) }
                }
                .disabled(stale || value.title != original.title ||
                    value.names != original.aliases || value.parent != (original.parentId ?? ""))
            }
        }
    }

    private func draftField(_ key: WritableKeyPath<Draft, String>, fallback: String) -> Binding<String> {
        Binding(get: { draft?[keyPath: key] ?? fallback }, set: { draft?[keyPath: key] = $0 })
    }

    private func memberships(_ domain: HubKnowledgeDomains.Domain, registry: HubKnowledgeDomains) -> some View {
        let previous = Set(registry.memberships.filter { $0.domainId == domain.id }.map(\.nodeId))
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        let matches = registry.nodes.filter { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) }
        return Section {
            TextField("Find a brain note…", text: $search)
            if matches.isEmpty { Text("No matching notes").foregroundStyle(.secondary) }
            ForEach(matches) { note in
                Toggle(note.title, isOn: Binding(get: { selectedNotes.contains(note.id) }, set: { assigned in
                    if assigned { selectedNotes.insert(note.id) } else { selectedNotes.remove(note.id) }
                }))
            }
            Button("Save memberships") {
                let changes = selectedNotes.symmetricDifference(previous).sorted().map {
                    HubKnowledgeDomains.Change.membership(note: $0, domain: domain.id, assigned: selectedNotes.contains($0))
                }
                Task { await save(changes, revision: registry.revision) }
            }
            .disabled(previous == selectedNotes || stale)
        } header: { Text("Brain note memberships") }
    }

    private func path(_ domain: HubKnowledgeDomains.Domain, in domains: [HubKnowledgeDomains.Domain]) -> String {
        lineage(domain, in: domains).reversed().map(\.title).joined(separator: " / ")
    }

    private func isDescendant(_ domain: HubKnowledgeDomains.Domain, of id: String?, in domains: [HubKnowledgeDomains.Domain]) -> Bool {
        guard let id else { return false }
        return lineage(domain, in: domains).dropFirst().contains { $0.id == id }
    }

    private func lineage(_ domain: HubKnowledgeDomains.Domain, in domains: [HubKnowledgeDomains.Domain]) -> [HubKnowledgeDomains.Domain] {
        var result = [domain]
        while let parent = result.last?.parentId, !result.contains(where: { $0.id == parent }),
              let item = domains.first(where: { $0.id == parent }) {
            result.append(item)
        }
        return result
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let current = try await api.knowledgeDomains()
            guard !Task.isCancelled else { return }
            registry = current
            stale = false
            notice = nil
        } catch {
            guard !Task.isCancelled else { return }
            stale = true
            notice = "Could not load Knowledge domains."
        }
    }

    private func save(_ changes: [HubKnowledgeDomains.Change], revision: Int) async {
        guard !saving, !stale else { return }
        saving = true
        defer { saving = false }
        do {
            try await api.changeKnowledgeDomains(changes, revision: revision)
            draft = nil
            memberDomain = nil
            await load()
            await changed()
        } catch {
            stale = true
            notice = "Could not confirm the domain change. Reload to check what HUB saved."
        }
    }
}
