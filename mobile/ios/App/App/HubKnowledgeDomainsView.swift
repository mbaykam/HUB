import SwiftUI
import HubNative

@MainActor
struct HubKnowledgeDomainsView: View {
    let api: HubConversationAPI
    let changed: () async -> Void
    let openNote: (String) -> Void
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
    @State private var organization: Organization?
    @State private var preview: HubKnowledgeDomains.Preview?
    @State private var confirmation: Confirmation?
    @State private var domainLimit: Int?
    @State private var organizingRecords = false
    @State private var suggestedGroups = false
    @State private var suggestedLabel: String?

    private enum Confirmation: Identifiable {
        case merge(String, String, String)
        case split(String, [HubKnowledgeDomains.Change.SplitGroup], Bool)
        case review(HubKnowledgeDomains.Preview, Bool)
        case undo(HubKnowledgeDomains.Audit)

        var id: String { title }
        var title: String {
            switch self {
            case .merge: "Merge domains?"
            case .split: "Split selected memberships?"
            case .review(_, let approve): approve ? "Apply this proposal?" : "Reject this proposal?"
            case .undo: "Undo the latest domain change?"
            }
        }
        var detail: String {
            switch self {
            case .merge(_, _, let name): "Move the memberships and subdomains into \(name)."
            case .split(_, let groups, _): "Move the selected memberships into \(groups.count) domains."
            case .review(let preview, let approve): approve ? "Apply the reviewed change affecting \(preview.affectedRecords) records." : "Dismiss this proposal from the review queue."
            case .undo: "Restore the registry to its state before this change."
            }
        }
    }

    private struct Organization {
        struct Group: Identifiable {
            let id = UUID()
            var title = ""
            var notes: Set<String> = []
        }
        var source: HubKnowledgeDomains.Domain
        var target = ""
        var groups = [Group(), Group()]
        var deactivate = false
        var splitting: Bool

        var splitGroups: [HubKnowledgeDomains.Change.SplitGroup]? {
            let names = groups.map { $0.title.trimmingCharacters(in: .whitespacesAndNewlines) }
            guard (2...8).contains(groups.count), names.allSatisfy({ !$0.isEmpty && $0.utf16.count <= 100 }),
                  Set(names.map { $0.lowercased() }).count == groups.count,
                  groups.allSatisfy({ !$0.notes.isEmpty }) else { return nil }
            return zip(groups, names).map { .init(title: $0.1, noteIDs: $0.0.notes.sorted()) }
        }
    }

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
                        Button(isEditing ? "Reload domains and discard draft" : "Reload domains") {
                            draft = nil
                            memberDomain = nil
                            organization = nil
                            preview = nil
                            attempt += 1
                        }
                    }
                }
                if let registry {
                    if let preview { proposalReview(preview) }
                    else if let organization { organize(organization, registry: registry) }
                    else if let draft { editor(draft, registry: registry) }
                    else if let memberDomain { memberships(memberDomain, registry: registry) }
                    else { domains(registry) }
                }
            }
            .disabled(saving)
            .navigationTitle(memberDomain?.title ?? organization?.source.title ?? "Knowledge domains")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(isEditing ? "Cancel" : "Done") {
                        if isEditing { draft = nil; memberDomain = nil; organization = nil; preview = nil }
                        else { dismiss() }
                    }
                    .disabled(saving)
                }
            }
        }
        .navigationViewStyle(.stack)
        .interactiveDismissDisabled(isEditing || saving)
        .alert(item: $confirmation) { action in
            Alert(title: Text(action.title), message: Text(action.detail),
                  primaryButton: .default(Text("Confirm")) { Task { await apply(action) } }, secondaryButton: .cancel())
        }
        .sheet(isPresented: $organizingRecords) {
            if let registry { HubKnowledgeOrganizeView(api: api, records: registry.nodes) }
        }
        .sheet(isPresented: $suggestedGroups, onDismiss: {
            if let suggestedLabel {
                draft = Draft(title: suggestedLabel)
                self.suggestedLabel = nil
            }
        }) {
            HubKnowledgeSuggestedGroupsView(api: api, openNote: {
                suggestedGroups = false
                openNote($0)
            }, chooseLabel: {
                suggestedLabel = $0
                suggestedGroups = false
            })
        }
        .task(id: attempt) { await load() }
    }

    private var isEditing: Bool { draft != nil || memberDomain != nil || organization != nil || preview != nil }

    @ViewBuilder private func domains(_ registry: HubKnowledgeDomains) -> some View {
        let available = registry.domains.filter { $0.status != "merged" }
        let roots = available.filter { $0.parentId == nil && $0.status == "active" }
        Section {
            Button { draft = Draft() } label: { Label("New domain", systemImage: "plus") }
                .disabled(stale)
            Button("Organize selected records") { organizingRecords = true }.disabled(stale || registry.nodes.isEmpty)
            Button("Suggested groups") { suggestedGroups = true }.disabled(stale)
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
                        Button("Merge into another domain") { organization = Organization(source: domain, splitting: false) }
                        Button("Split memberships") { organization = Organization(source: domain, splitting: true) }
                            .disabled(notes == 0)
                    } label: { Label("Manage", systemImage: "ellipsis.circle").frame(minHeight: 44) }
                    .disabled(stale)
                }
            }
        } header: {
            Text("\(roots.count) of \(registry.maxActiveDomains) active main domains")
        }
        let pending = (registry.proposals ?? []).filter { $0.status == "pending" }
        if !pending.isEmpty {
            Section("Proposed changes") {
                ForEach(pending) { proposal in
                    Button("Review \(proposal.operation.type) proposal") { Task { await loadPreview(proposal.id) } }
                        .disabled(stale || loading)
                }
            }
        }
        if let history = registry.history, !history.isEmpty {
            Section("Recent changes") {
                ForEach(history.suffix(12).reversed()) { audit in
                    VStack(alignment: .leading) {
                        Text(audit.operations.map(\.type).joined(separator: ", ").capitalized)
                        Text(Date(timeIntervalSince1970: audit.at / 1_000), format: .dateTime.month().day().hour().minute())
                        Text(audit.actor.capitalized + (audit.undone == true ? " · Undone" : ""))
                    }
                    .font(.footnote)
                }
                if let latest = history.last(where: { $0.undone != true }) {
                    Button("Undo latest change") { confirmation = .undo(latest) }.disabled(stale)
                }
            }
        }
        Section("Domain limit") {
            Stepper("Maximum active main domains · \(domainLimit ?? registry.maxActiveDomains)",
                    value: Binding(get: { domainLimit ?? registry.maxActiveDomains }, set: { domainLimit = $0 }), in: 1...20)
            if let domainLimit, domainLimit != registry.maxActiveDomains {
                Button("Save domain limit") { Task { await save([], revision: registry.revision, maxActiveDomains: domainLimit) } }
                    .disabled(stale || domainLimit < roots.count)
                if domainLimit < roots.count { Text("Deactivate a main domain before lowering the limit.").font(.footnote) }
            }
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

    @ViewBuilder
    private func organize(_ value: Organization, registry: HubKnowledgeDomains) -> some View {
        if value.splitting {
            let ids = Set(registry.memberships.filter { $0.domainId == value.source.id }.map(\.nodeId))
            let notes = registry.nodes.filter { ids.contains($0.id) }
            Section {
                if notes.isEmpty { Text("No available memberships to split.").foregroundStyle(.secondary) }
                ForEach(value.groups) { group in
                    DisclosureGroup(group.title.isEmpty ? "New domain · \(group.notes.count) notes" : "\(group.title) · \(group.notes.count) notes") {
                        TextField("New domain name", text: groupField(\.title, for: group))
                        ForEach(notes) { note in
                            let membership = groupField(\.notes, for: group)
                            Toggle(note.title, isOn: Binding(get: { membership.wrappedValue.contains(note.id) }, set: { selected in
                                var notes = membership.wrappedValue
                                if selected { notes.insert(note.id) }
                                else { notes.remove(note.id) }
                                membership.wrappedValue = notes
                            }))
                        }
                        if value.groups.count > 2 {
                            Button("Remove group", role: .destructive) { organization?.groups.removeAll { $0.id == group.id } }
                        }
                    }
                }
                Button("Add group") { organization?.groups.append(Organization.Group()) }.disabled(value.groups.count >= 8)
                Toggle("Deactivate the original domain", isOn: Binding(get: { organization?.deactivate == true },
                                                                       set: { organization?.deactivate = $0 }))
                Button("Review split") {
                    if let groups = value.splitGroups { confirmation = .split(value.source.id, groups, value.deactivate) }
                }
                .disabled(value.splitGroups == nil || stale)
            } header: { Text("Split memberships") }
        } else {
            let options = registry.domains.filter { $0.status != "merged" && $0.id != value.source.id &&
                !isDescendant($0, of: value.source.id, in: registry.domains) }
            Section("Merge into") {
                Picker("Destination", selection: Binding(get: { organization?.target ?? "" }, set: { organization?.target = $0 })) {
                    Text("Choose a domain").tag("")
                    ForEach(options) { Text(path($0, in: registry.domains)).tag($0.id) }
                }
                Button("Review merge") {
                    if let target = options.first(where: { $0.id == value.target }) {
                        confirmation = .merge(value.source.id, target.id, path(target, in: registry.domains))
                    }
                }
                .disabled(value.target.isEmpty || stale)
            }
        }
    }

    private func groupField<Value>(_ key: WritableKeyPath<Organization.Group, Value>, for group: Organization.Group) -> Binding<Value> {
        Binding(get: { organization?.groups.first(where: { $0.id == group.id })?[keyPath: key] ?? group[keyPath: key] }, set: { value in
            guard let index = organization?.groups.firstIndex(where: { $0.id == group.id }) else { return }
            organization?.groups[index][keyPath: key] = value
        })
    }

    @ViewBuilder
    private func proposalReview(_ preview: HubKnowledgeDomains.Preview) -> some View {
        Section("Proposed \(preview.proposal.operation.type)") {
            Text(preview.proposal.evidence).textSelection(.enabled)
            Text("\(preview.affectedRecords) affected record memberships")
            if preview.stale { Text("This preview uses the current domain list.").font(.footnote).foregroundStyle(.secondary) }
        }
        Section("Before") { previewDomains(preview.before) }
        Section("After") { previewDomains(preview.after) }
        Section {
            Button("Approve proposal") { confirmation = .review(preview, true) }.disabled(stale)
            Button("Reject proposal", role: .destructive) { confirmation = .review(preview, false) }.disabled(stale)
        }
    }

    private func previewDomains(_ domains: [HubKnowledgeDomains.Domain]) -> some View {
        ForEach(domains.filter { $0.status != "merged" }) { domain in
            VStack(alignment: .leading) {
                Text(path(domain, in: domains))
                Text(domain.status.capitalized).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func loadPreview(_ id: String) async {
        guard !loading, !stale else { return }
        loading = true
        defer { loading = false }
        do {
            preview = try await api.knowledgeDomainPreview(id)
            notice = nil
        } catch { notice = "Could not load this proposal. It may have changed." }
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
            domainLimit = nil
            stale = false
            notice = nil
        } catch {
            guard !Task.isCancelled else { return }
            stale = true
            notice = "Could not load Knowledge domains."
        }
    }

    private func save(_ changes: [HubKnowledgeDomains.Change], revision: Int, maxActiveDomains: Int? = nil) async {
        await performChange { try await api.changeKnowledgeDomains(changes, revision: revision, maxActiveDomains: maxActiveDomains) }
    }

    private func apply(_ confirmation: Confirmation) async {
        guard let revision = registry?.revision else { return }
        switch confirmation {
        case .merge(let id, let target, _): await save([.merge(id: id, into: target)], revision: revision)
        case .split(let id, let groups, let deactivate):
            await save([.split(id: id, groups: groups, deactivateSource: deactivate)], revision: revision)
        case .review(let preview, let approve):
            await performChange { try await api.reviewKnowledgeDomain(preview, approve: approve) }
        case .undo(let audit):
            await performChange { try await api.undoKnowledgeDomain(audit, revision: revision) }
        }
    }

    private func performChange(_ operation: () async throws -> Void) async {
        guard !saving, !stale else { return }
        saving = true
        defer { saving = false }
        do {
            try await operation()
            draft = nil
            memberDomain = nil
            organization = nil
            preview = nil
            await load()
            await changed()
        } catch {
            stale = true
            notice = "Could not confirm the domain change. Reload to check what HUB saved."
        }
    }
}

@MainActor
private struct HubKnowledgeSuggestedGroupsView: View {
    let api: HubConversationAPI
    let openNote: (String) -> Void
    let chooseLabel: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var page: HubKnowledgeDomains.SuggestedGroups?
    @State private var groups: [HubKnowledgeDomains.SuggestedGroups.Group] = []
    @State private var selected: HubKnowledgeDomains.SuggestedGroups.Group?
    @State private var sources: [HubKnowledgeDomains.Note] = []
    @State private var nextSourceOffset: Int?
    @State private var busy = false
    @State private var failure: String?

    var body: some View {
        NavigationView {
            List {
                if let failure { Text(failure).foregroundStyle(.secondary) }
                if busy { ProgressView() }
                if let selected {
                    Section(selected.label) {
                        Button("Use this label for a domain") { chooseLabel(selected.label) }
                        ForEach(sources) { source in Button(source.title) { openNote(source.id) } }
                        if let nextSourceOffset {
                            Button("More sources") { Task { await loadSources(selected.id, offset: nextSourceOffset) } }
                        }
                        if failure != nil {
                            Button("Reload suggestions") { returnToGroups(); Task { await loadGroups(0) } }
                        }
                    }
                } else {
                    Section {
                        if let page {
                            Text("\(page.total) suggestions · \(page.coverage.consideredRecords) of \(page.coverage.totalRecords) sources considered")
                                .font(.footnote).foregroundStyle(.secondary)
                            if !page.coverage.complete { Text("Some sources were outside the search coverage.").font(.footnote) }
                            if groups.isEmpty { Text("No linked groups yet.").foregroundStyle(.secondary) }
                        }
                        ForEach(groups) { group in
                            Button {
                                selected = group
                                Task { await loadSources(group.id, offset: 0) }
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(group.label)
                                    Text("\(group.count) related records").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                        if failure != nil {
                            Button("Reload suggestions") { Task { await loadGroups(0) } }
                        } else if let offset = page?.nextOffset {
                            Button("More groups") { Task { await loadGroups(offset) } }
                        }
                    }
                }
            }
            .disabled(busy)
            .navigationTitle("Suggested groups")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(selected == nil ? "Done" : "Back") {
                        if selected == nil { dismiss() } else { returnToGroups() }
                    }
                    .disabled(busy)
                }
            }
        }
        .navigationViewStyle(.stack)
        .task { await loadGroups(0) }
    }

    private func returnToGroups() {
        selected = nil
        sources = []
        nextSourceOffset = nil
        failure = nil
    }

    private func loadGroups(_ offset: Int) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let result = try await api.knowledgeSuggestedGroups(offset: offset)
            guard !Task.isCancelled else { return }
            if offset > 0, result.inputHash != page?.inputHash {
                failure = "The source graph changed. Reload suggestions."
                return
            }
            if offset == 0 { groups = [] }
            var seen = Set(groups.map(\.id))
            groups += result.groups.filter { seen.insert($0.id).inserted }
            page = result
            failure = nil
        } catch { if !Task.isCancelled { failure = "Could not load suggested groups." } }
    }

    private func loadSources(_ id: String, offset: Int) async {
        guard !busy, let version = page?.inputHash else { return }
        busy = true
        defer { busy = false }
        do {
            let result = try await api.knowledgeSuggestedSources(id: id, version: version, offset: offset)
            guard !Task.isCancelled, selected?.id == id else { return }
            var seen = Set(sources.map(\.id))
            sources += result.nodes.filter { seen.insert($0.id).inserted }
            nextSourceOffset = result.nextOffset
        } catch { if !Task.isCancelled { failure = "Could not load group sources. The source graph may have changed." } }
    }
}

@MainActor
private struct HubKnowledgeOrganizeView: View {
    let api: HubConversationAPI
    let records: [HubKnowledgeDomains.Note]
    @Environment(\.dismiss) private var dismiss
    @State private var filter = ""
    @State private var selected: Set<String> = []
    @State private var windows: [String: HubKnowledgeDomains.SourceExcerpt] = [:]
    @State private var source: HubKnowledgeDomains.Note?
    @State private var excerpt: HubKnowledgeDomains.SourceExcerpt?
    @State private var offsets = [0]
    @State private var busy = false
    @State private var notice: String?
    @State private var confirmation = false

    private var matches: [HubKnowledgeDomains.Note] {
        let query = filter.trimmingCharacters(in: .whitespacesAndNewlines)
        return query.isEmpty ? records : records.filter { $0.title.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        NavigationView {
            List {
                if let notice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
                if busy { ProgressView() }
                if let source { sourceSection(source) }
                else { recordList }
            }
            .navigationTitle(source == nil ? "Organize records" : "Choose an excerpt")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(source == nil ? "Done" : "Back") {
                        if source != nil { closeSource() } else { dismiss() }
                    }
                    .disabled(busy)
                }
            }
        }
        .navigationViewStyle(.stack)
        .interactiveDismissDisabled(busy)
        .alert("Queue selected records?", isPresented: $confirmation) {
            Button("Queue \(selected.count) records") { Task { await queue() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Knowledge AI will process these sources using its configured model and budget.")
        }
    }

    private var recordList: some View {
        Section {
            TextField("Find a brain note", text: $filter)
            Text("\(selected.count) of 10 records selected").font(.footnote).foregroundStyle(.secondary)
            if matches.isEmpty { Text("No matching records.").foregroundStyle(.secondary) }
            ForEach(matches) { record in
                VStack(alignment: .leading, spacing: 4) {
                    let requiresExcerpt = (record.chars ?? 0) > 23_500 && windows[record.id] == nil
                    Toggle(record.title, isOn: Binding(get: { selected.contains(record.id) }, set: { included in
                        if included { selected.insert(record.id) }
                        else { selected.remove(record.id) }
                    }))
                    .disabled(busy || requiresExcerpt || (selected.count >= 10 && !selected.contains(record.id)))
                    Button(requiresExcerpt ? "Choose an excerpt" : "Preview source") {
                        source = record
                        excerpt = nil
                        offsets = [0]
                        Task { await load(record.id, offset: 0) }
                    }
                    .buttonStyle(.borderless)
                    .disabled(busy)
                    if windows[record.id] != nil { Text("Excerpt selected").font(.caption).foregroundStyle(.secondary) }
                }
            }
            Button("Queue organization") { confirmation = true }.disabled(busy || selected.isEmpty)
        }
    }

    private func sourceSection(_ record: HubKnowledgeDomains.Note) -> some View {
        Section(record.title) {
            if let excerpt {
                Text("\(excerpt.start + 1)–\(excerpt.end) of \(excerpt.totalChars) characters")
                    .font(.footnote).foregroundStyle(.secondary)
                Text(excerpt.content).textSelection(.enabled)
                Button("Use this excerpt") {
                    windows[record.id] = excerpt
                    selected.insert(record.id)
                    closeSource()
                }
                .disabled(busy || (selected.count >= 10 && !selected.contains(record.id)))
                if offsets.count > 1 {
                    Button("Previous excerpt") {
                        let previous = offsets[offsets.count - 2]
                        Task { if await load(record.id, offset: previous) { offsets.removeLast() } }
                    }
                    .disabled(busy)
                }
                if let next = excerpt.nextOffset {
                    Button("Next excerpt") { Task { if await load(record.id, offset: next) { offsets.append(next) } } }
                        .disabled(busy)
                }
            } else if !busy {
                Button("Retry") { Task { await load(record.id, offset: 0) } }
            }
        }
    }

    private func closeSource() {
        source = nil
        excerpt = nil
        notice = nil
    }

    @discardableResult
    private func load(_ id: String, offset: Int) async -> Bool {
        guard !busy else { return false }
        busy = true
        defer { busy = false }
        do {
            excerpt = try await api.knowledgeOrganizationExcerpt(id, offset: offset)
            notice = nil
            return true
        } catch {
            notice = "Could not load this excerpt. The source may have changed."
            return false
        }
    }

    private func queue() async {
        guard !busy, !selected.isEmpty else { return }
        busy = true
        defer { busy = false }
        do {
            let receipt = try await api.queueKnowledgeOrganization(notes: selected, excerpts: selected.compactMap { windows[$0] })
            notice = receipt.automatic ? "\(receipt.queued) records queued. See Knowledge AI Activity for progress."
                : "\(receipt.queued) records queued. Start the pass in Knowledge AI Activity."
            selected = []
            windows = [:]
        } catch {
            notice = "Could not confirm the queue request. Check Knowledge AI Activity before retrying."
        }
    }
}
