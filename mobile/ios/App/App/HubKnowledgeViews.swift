import SwiftUI
import UIKit
import HubNative
import UniformTypeIdentifiers

@MainActor
struct HubKnowledgeConnectionsView: View {
    private struct EvidenceSelection: Identifiable {
        let relation: String
        let index: Int
        var id: String { "\(relation)/\(index)" }
    }

    let api: HubConversationAPI
    let note: HubKnowledgeNote
    let openRecord: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var items: [HubKnowledgeRelationship] = []
    @State private var total: Int?
    @State private var cursor: String?
    @State private var loading = false
    @State private var pageError = false
    @State private var query = ""
    @State private var matches: [HubHomeKnowledge.Node] = []
    @State private var searchBusy = false
    @State private var searchFailed = false
    @State private var target: HubHomeKnowledge.Node?
    @State private var trace: HubKnowledgeConnectionPath?
    @State private var traceBusy = false
    @State private var traceFailed = false
    @State private var traceAttempt = 0
    @State private var selectedEvidence: EvidenceSelection?
    @State private var evidence: HubKnowledgeSourceEvidence?
    @State private var evidenceFailed = false
    @State private var evidenceAttempt = 0

    private var search: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationView {
            List {
                Section(note.title) {
                    if let total {
                        Text(total > 0 ? "\(items.count) of \(total) sourced connections" : "No sourced connections yet.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(items) { item in
                        if let node = item.node { relationship(item, node: node) }
                    }
                    if loading || (total == nil && !pageError) { ProgressView("Loading connections…") }
                    if pageError {
                        Text("Could not load connections.").foregroundStyle(.secondary)
                        Button("Refresh connections") { Task { await loadPage("") } }.disabled(loading)
                    } else if let cursor {
                        Button("More connections") { Task { await loadPage(cursor) } }.disabled(loading)
                    }
                }
                Section("Trace connections") {
                    TextField("Find another record…", text: $query)
                        .accessibilityLabel("Find a connection target")
                    if searchBusy { ProgressView("Searching…") }
                    if searchFailed {
                        Button("Retry search") { Task { await findTargets(search) } }.disabled(searchBusy)
                    }
                    if !searchBusy, !searchFailed, search.count >= 2, matches.isEmpty {
                        Text("No matching records.").foregroundStyle(.secondary)
                    }
                    ForEach(matches.prefix(8), id: \.id) { node in
                        Button(node.title ?? "Knowledge record") { target = node }
                            .accessibilityAddTraits(target?.id == node.id ? .isSelected : [])
                    }
                    if matches.count > 8 { Text("Refine your search to see more matches.").font(.footnote) }
                }
                if let target { traceSection(target) }
            }
            .navigationTitle("Connections")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
        .navigationViewStyle(.stack)
        .preferredColorScheme(.dark)
        .task { await loadPage("") }
        .task(id: search) { await findTargets(search) }
        .task(id: target.map { "\($0.id)/\(traceAttempt)" }) {
            if let target { await findPath(target.id) }
        }
        .sheet(item: $selectedEvidence) { selection in
            NavigationView {
                List {
                    if let evidence {
                        Section(evidence.sourceTitle) {
                            Text(evidence.citation.quote).textSelection(.enabled)
                            Text(evidenceVersion(evidence.version)).font(.footnote).foregroundStyle(.secondary)
                        }
                        if let excerpt = evidence.excerpt {
                            Section("Context") { Text(excerpt.text).textSelection(.enabled) }
                        }
                    } else if evidenceFailed {
                        Text("Could not load this source. The connection may have changed.")
                        Button("Retry") { evidenceAttempt += 1 }
                    } else {
                        ProgressView("Loading source…")
                    }
                }
                .navigationTitle("Source evidence")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { selectedEvidence = nil } } }
            }
            .navigationViewStyle(.stack)
            .task(id: evidenceAttempt) { await loadEvidence(selection) }
        }
    }

    private func relationship(_ item: HubKnowledgeRelationship, node: HubHomeKnowledge.Node) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(node.title ?? "Knowledge record") { openRecord(node.id) }.font(.headline)
            Text(item.predicate)
            Text([scope(item.scope), item.interpretation ? "Knowledge AI interpretation" : "Recorded relationship"].joined(separator: " · "))
                .font(.caption).foregroundStyle(.secondary)
            if !item.evidence.isEmpty {
                DisclosureGroup("Source excerpts") {
                    ForEach(item.evidence.indices, id: \.self) { index in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.evidence[index].quote).textSelection(.enabled)
                            if let role = item.evidence[index].role { Text(role.capitalized).font(.caption) }
                            Button("Inspect source") {
                                evidence = nil
                                evidenceFailed = false
                                selectedEvidence = EvidenceSelection(relation: item.id, index: index)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
        }
        .buttonStyle(.borderless)
        .padding(.vertical, 4)
    }

    private func traceSection(_ node: HubHomeKnowledge.Node) -> some View {
        Section(node.title ?? "Connection path") {
            if traceBusy { ProgressView("Tracing connections…") }
            if traceFailed { Button("Retry tracing") { traceAttempt += 1 } }
            if let trace, trace.targetId == node.id {
                if trace.found {
                    Text(trace.nodes.map { $0.title ?? "Knowledge record" }.joined(separator: " → "))
                    Text(trace.meaning).font(.footnote).foregroundStyle(.secondary)
                    ForEach(trace.relations.indices, id: \.self) { index in
                        relationship(trace.relations[index], node: trace.nodes[index + 1])
                    }
                } else {
                    Text(trace.complete ? "No sourced connection chain found." : "Search limit reached before finding this record.")
                }
            }
        }
    }

    private func loadPage(_ requested: String) async {
        guard !loading else { return }
        loading = true
        pageError = false
        defer { loading = false }
        do {
            let page = try await api.knowledgeNeighbors(id: note.id, cursor: requested)
            guard !Task.isCancelled else { return }
            if requested.isEmpty { items = [] }
            var seen = Set(items.map(\.id))
            items.append(contentsOf: page.items.filter { seen.insert($0.id).inserted })
            total = page.total
            cursor = page.nextCursor
        } catch { if !Task.isCancelled { pageError = true } }
    }

    private func findTargets(_ input: String) async {
        matches = []
        target = nil
        trace = nil
        searchBusy = input.count >= 2
        searchFailed = false
        guard searchBusy else { return }
        defer { if search == input, !Task.isCancelled { searchBusy = false } }
        do {
            try await Task.sleep(nanoseconds: 250_000_000)
            let results = try await api.searchKnowledgeRecords(input)
            guard search == input, !Task.isCancelled else { return }
            matches = results.filter { $0.id != note.id }
        } catch { if search == input, !Task.isCancelled { searchFailed = true } }
    }

    private func findPath(_ id: String) async {
        trace = nil
        traceBusy = true
        traceFailed = false
        defer { if target?.id == id, !Task.isCancelled { traceBusy = false } }
        do {
            let result = try await api.knowledgeConnectionPath(from: note.id, to: id)
            if target?.id == id, !Task.isCancelled { trace = result }
        } catch { if target?.id == id, !Task.isCancelled { traceFailed = true } }
    }

    private func loadEvidence(_ selection: EvidenceSelection) async {
        evidenceFailed = false
        do {
            let result = try await api.knowledgeSourceEvidence(relation: selection.relation, index: selection.index)
            if selectedEvidence?.id == selection.id, !Task.isCancelled { evidence = result }
        } catch { if selectedEvidence?.id == selection.id, !Task.isCancelled { evidenceFailed = true } }
    }

    private func scope(_ value: String) -> String {
        switch value {
        case "short": "Within a domain"
        case "long": "Across domains"
        case "archive": "Chat archive link"
        default: "Domain unassigned"
        }
    }

    private func evidenceVersion(_ value: String) -> String {
        switch value {
        case "current": "Current source"
        case "archived": "Archived source"
        case "captured-episode": "Captured source excerpt"
        default: "Recorded quote"
        }
    }
}

@MainActor
struct HubKnowledgeArchivesView: View {
    let api: HubConversationAPI
    let changed: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var batches: [HubKnowledgeArchive] = []
    @State private var moreBatches: Int?
    @State private var preview: HubKnowledgeArchivePreview?
    @State private var offset = 0
    @State private var selected: Set<String> = []
    @State private var record: HubKnowledgeArchivePreview.Record?
    @State private var original: HubKnowledgeArchiveMessages?
    @State private var originalOffset = 0
    @State private var busy = false
    @State private var notice: String?
    @State private var pickerOpen = false
    @State private var confirmation: Mutation?
    @State private var stale = false

    private enum Mutation: String, Identifiable {
        case admit, withdraw
        var id: Self { self }
        var title: String { self == .admit ? "Admit selected conversations?" : "Withdraw admitted conversations?" }
    }

    var body: some View {
        NavigationView {
            List {
                if busy { ProgressView("Working with the archive on HUB…") }
                if let notice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
                if let record { originalMessages(record) }
                else if let preview { previewRows(preview) }
                else { archiveList }
            }
            .disabled(busy)
            .navigationTitle("Conversation archives")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(record != nil ? "Archive" : preview != nil ? "All archives" : "Done") { goBack() }
                        .disabled(busy)
                }
            }
        }
        .navigationViewStyle(.stack)
        .task { await loadBatches() }
        .interactiveDismissDisabled(busy || !selected.isEmpty)
        .fileImporter(isPresented: $pickerOpen, allowedContentTypes: [.zip, .json, .html]) { result in
            switch result {
            case .success(let url): Task { await stage(url) }
            case .failure: notice = "Could not open the selected archive."
            }
        }
        .confirmationDialog(confirmation?.title ?? "", isPresented: Binding(
            get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }),
            titleVisibility: .visible, presenting: confirmation) { action in
                Button(action == .admit ? "Admit \(selected.count) conversations" : "Withdraw admitted batch",
                       role: action == .withdraw ? .destructive : nil) {
                    Task { await mutate(action) }
                }
                Button("Cancel", role: .cancel) {}
            } message: { action in
                Text(action == .admit
                    ? "Selected conversations become available in Knowledge search, graph and assistant memory. Organization may use your current Knowledge AI budget."
                    : "The conversations leave Knowledge search, graph and assistant memory. Their original messages and private upload are retained.")
            }
    }

    private var archiveList: some View {
        Section {
            Button("Add a private archive") { pickerOpen = true }
            Button("Refresh archives") { Task { await loadBatches() } }
            if batches.isEmpty && !busy { Text("No private archives").foregroundStyle(.secondary) }
            ForEach(batches) { batch in
                Button {
                    Task { await loadPreview(batch.id, offset: 0) }
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(batch.filename)
                        Text("\(batch.conversations) conversations · \(batch.state)")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            if let moreBatches { Button("Older archives") { Task { await loadBatches(offset: moreBatches) } } }
        } footer: {
            Text("ZIP, JSON or HTML up to 80 MB. The upload stays private until you explicitly admit conversations.")
        }
    }

    private func previewRows(_ preview: HubKnowledgeArchivePreview) -> some View {
        Group {
            Section {
                Text(preview.filename).font(.headline)
                Text("\(preview.conversations) conversations · \(preview.admitted) admitted").font(.footnote)
                if let error = preview.error { Text(error).font(.footnote).foregroundStyle(.secondary) }
                ForEach(Array(preview.warnings.enumerated()), id: \.offset) { _, warning in
                    Text(warning).font(.footnote).foregroundStyle(.secondary)
                }
                Button("Refresh preview") { Task { await loadPreview(preview.id, offset: offset) } }
                if preview.state != "failed" {
                    if preview.state != "archived" {
                        Button("Keep archive private") { Task { await keepPrivate(preview) } }
                    }
                    if selected.count > 0 {
                        Button("Review selected admission · \(selected.count)") { confirmation = .admit }.disabled(stale)
                        Button("Clear selection") { selected.removeAll() }
                    }
                    if preview.admitted > 0 {
                        Button("Review batch withdrawal", role: .destructive) { confirmation = .withdraw }.disabled(stale)
                    }
                }
            }
            if preview.state != "failed" {
                Section("Original conversations") {
                    ForEach(preview.records) { item in
                        VStack(alignment: .leading, spacing: 6) {
                            Toggle(item.title, isOn: Binding(get: { selected.contains(item.id) }, set: { on in
                                if on {
                                    if selected.count < 50 { selected.insert(item.id) }
                                    else { notice = "Select up to 50 conversations at a time." }
                                } else { selected.remove(item.id) }
                            }))
                            .disabled(!item.canAdmit || stale)
                            Text("\(item.channel) · \(item.messages) messages · \(item.status)")
                                .font(.caption).foregroundStyle(.secondary)
                            Button("Preview original messages") { Task { await loadOriginal(preview.id, item: item, offset: 0) } }
                        }
                    }
                    if offset > 0 {
                        Button("Previous page") { Task { await loadPreview(preview.id, offset: max(0, offset - 50)) } }
                    }
                    if let next = preview.nextOffset {
                        Button("Next page") { Task { await loadPreview(preview.id, offset: next) } }
                    }
                }
            }
        }
    }

    private func originalMessages(_ item: HubKnowledgeArchivePreview.Record) -> some View {
        Section(item.title) {
            if let original {
                Text("\(original.total) messages").font(.footnote).foregroundStyle(.secondary)
                ForEach(Array(original.messages.enumerated()), id: \.offset) { _, message in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(message.role.capitalized).font(.caption.weight(.semibold))
                        Text(message.text).textSelection(.enabled)
                        if message.truncated { Text("Excerpt. HUB retained the full original.").font(.caption2).foregroundStyle(.secondary) }
                    }
                }
                if let preview, originalOffset > 0 {
                    Button("Previous messages") { Task { await loadOriginal(preview.id, item: item, offset: max(0, originalOffset - 8)) } }
                }
                if let preview, let next = original.nextOffset {
                    Button("Next messages") { Task { await loadOriginal(preview.id, item: item, offset: next) } }
                }
            }
        }
    }

    private func goBack() {
        notice = nil
        if record != nil {
            record = nil
            original = nil
        } else if preview != nil {
            if !selected.isEmpty {
                notice = "Clear the selection before returning to the archive list."
                return
            }
            preview = nil
            Task { await loadBatches() }
        } else { dismiss() }
    }

    private func perform(_ failure: String, _ operation: () async throws -> Void) async {
        guard !busy else { return }
        busy = true
        notice = nil
        defer { busy = false }
        do { try await operation() }
        catch { if !Task.isCancelled { notice = failure } }
    }

    private func loadBatches(offset: Int = 0) async {
        await perform("Could not load the private archives.") {
            let result = try await api.knowledgeArchives(offset: offset)
            try Task.checkCancellation()
            let existing = offset == 0 ? Set<UUID>() : Set(batches.map(\.id))
            batches = (offset == 0 ? [] : batches) + result.batches.filter { !existing.contains($0.id) }
            moreBatches = result.nextOffset
        }
    }

    private func show(_ value: HubKnowledgeArchivePreview, offset: Int) {
        if preview?.id != value.id || preview?.previewHash != value.previewHash { selected.removeAll() }
        preview = value
        self.offset = offset
        stale = false
    }

    private func loadPreview(_ id: UUID, offset: Int) async {
        await perform("Could not load the archive preview.") {
            let value = try await api.knowledgeArchive(id, offset: offset)
            try Task.checkCancellation()
            show(value, offset: offset)
        }
    }

    private func loadOriginal(_ id: UUID, item: HubKnowledgeArchivePreview.Record, offset: Int) async {
        await perform("Could not read those original messages.") {
            let result = try await api.knowledgeArchiveMessages(id, recordID: item.id, offset: offset)
            try Task.checkCancellation()
            original = result
            originalOffset = offset
            record = item
        }
    }

    private func stage(_ url: URL) async {
        await perform("Could not confirm the upload. Check the archive list before uploading again.") {
            let file = try await Task.detached(priority: .userInitiated) {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
                guard values.isRegularFile == true, let bytes = values.fileSize,
                      (1...HubConversationAPI.knowledgeArchiveUploadLimit).contains(bytes) else { return nil as Data? }
                let handle = try FileHandle(forReadingFrom: url)
                defer { try? handle.close() }
                return try handle.read(upToCount: HubConversationAPI.knowledgeArchiveUploadLimit + 1)
            }.value
            try Task.checkCancellation()
            guard let file else {
                notice = "Choose a ZIP, JSON or HTML file up to 80 MB."
                return
            }
            let value = try await api.stageKnowledgeArchive(file, filename: url.lastPathComponent)
            show(value, offset: 0)
            notice = value.state == "failed" ? "HUB retained the original upload. Review the parsing error." : "Archive saved privately."
        }
    }

    private func keepPrivate(_ preview: HubKnowledgeArchivePreview) async {
        await perform("Could not confirm that HUB saved the archive status. Refresh the preview.") {
            try await api.keepKnowledgeArchivePrivate(preview.id)
            notice = "Archive kept private."
            if let current = try? await api.knowledgeArchive(preview.id, offset: offset) { show(current, offset: offset) }
        }
    }

    private func mutate(_ action: Mutation) async {
        guard let preview, !stale else { return }
        await perform("Could not confirm the change. Refresh the preview before trying again.") {
            stale = true
            switch action {
            case .admit:
                let receipt = try await api.admitKnowledgeArchive(preview, recordIDs: selected.sorted())
                notice = "\(receipt.admitted) admitted · \(receipt.duplicates) duplicates · \(receipt.queued) organization jobs queued."
            case .withdraw:
                let count = try await api.withdrawKnowledgeArchive(preview.id)
                notice = "\(count) conversations withdrawn."
            }
            selected.removeAll()
            if let current = try? await api.knowledgeArchive(preview.id) { show(current, offset: 0) }
            await changed()
        }
    }
}

@MainActor
struct HubKnowledgeBackupsView: View {
    let api: HubConversationAPI
    @Environment(\.dismiss) private var dismiss
    @State private var copies: [HubKnowledgeBackups.Copy] = []
    @State private var page: HubKnowledgeBackups?
    @State private var busy = false
    @State private var notice: String?
    @State private var restored: HubKnowledgeRestoredCopy?
    @State private var restoreCandidate: HubKnowledgeBackups.Copy?

    var body: some View {
        NavigationView {
            List {
                Section {
                    Button("Create verified backup") { Task { await createBackup() } }
                    Button("Refresh backups") { Task { await refresh() } }
                    if busy { ProgressView("Checking backup data on HUB…") }
                    if let notice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
                } footer: {
                    Text("Copies are saved on the HUB computer. Keep each backup folder with its snapshot.json.")
                }
                if let restored {
                    Section("Restored copy") {
                        Text("The restored copy is separate and its background work is paused.").font(.footnote)
                        path(restored.vault)
                        if restored.root != restored.vault { path(restored.root) }
                    }
                }
                if page != nil || !copies.isEmpty {
                    Section("Saved copies · \(page?.total ?? copies.count)") {
                        if let page { DisclosureGroup("Storage on HUB") { path(page.storage) } }
                        if let count = page?.incompleteCopies, count > 0 {
                            Text("\(count) incomplete or unreadable copies are retained on HUB.").font(.footnote)
                        }
                        if copies.isEmpty { Text("No verified backups").foregroundStyle(.secondary) }
                        ForEach(copies) { copy in backupRow(copy) }
                        if let next = page?.nextOffset {
                            Button("Older backups") { Task { await refresh(offset: next) } }
                        }
                    }
                }
            }
            .disabled(busy)
            .navigationTitle("Knowledge backups")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() }.disabled(busy) }
            }
        }
        .navigationViewStyle(.stack)
        .interactiveDismissDisabled(busy)
        .task { await refresh() }
        .confirmationDialog("Restore a separate copy?", isPresented: Binding(
            get: { restoreCandidate != nil }, set: { if !$0 { restoreCandidate = nil } }),
            presenting: restoreCandidate) { copy in
                Button("Restore separate copy") { Task { await restore(copy) } }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("HUB will verify this backup and write a separate folder on the computer. Restored background work starts paused.")
            }
    }

    private func path(_ value: String) -> some View {
        Text(value).font(.caption.monospaced()).textSelection(.enabled)
    }

    private func backupRow(_ copy: HubKnowledgeBackups.Copy) -> some View {
        DisclosureGroup {
            path(copy.path)
            Button("Verify integrity") { Task { await verify(copy) } }
            Button("Restore as a separate copy") { restoreCandidate = copy }
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(Date(timeIntervalSince1970: copy.at / 1_000).formatted(date: .abbreviated, time: .shortened))
                Text("\(copy.records) records · \(ByteCountFormatter.string(fromByteCount: copy.bytes, countStyle: .file))")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func refresh(offset: Int = 0) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            try await load(offset: offset)
            notice = nil
        } catch {
            if !Task.isCancelled { notice = "Could not load backups from HUB." }
        }
    }

    private func load(offset: Int = 0) async throws {
        let result = try await api.knowledgeBackups(offset: offset)
        try Task.checkCancellation()
        let existing: Set<UUID> = offset == 0 ? [] : Set(copies.map(\.id))
        copies = (offset == 0 ? [] : copies) + result.items.filter { !existing.contains($0.id) }
        page = result
    }

    private func createBackup() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let copy = try await api.createKnowledgeBackup()
            do {
                try await load()
            } catch {
                page = nil
                copies.removeAll { $0.id == copy.id }
                copies.insert(copy, at: 0)
            }
            notice = "Verified backup saved with \(copy.records) records."
        } catch {
            notice = "Could not confirm the backup. Refresh the list before creating another copy."
        }
    }

    private func verify(_ copy: HubKnowledgeBackups.Copy) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let files = try await api.verifyKnowledgeBackup(copy.id)
            notice = "Verified \(files) files against their saved hashes."
        } catch {
            notice = "Could not verify the saved copy."
        }
    }

    private func restore(_ copy: HubKnowledgeBackups.Copy) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            restored = try await api.restoreKnowledgeBackupCopy(copy.id)
            notice = "Verified separate copy restored."
        } catch {
            notice = "Could not confirm the restore. Check the folders on HUB before trying again."
        }
    }
}

@MainActor
struct HubKnowledgeGraphView: View {
    let graph: HubHomeKnowledge
    let height: CGFloat
    var scope = Scope.all
    var overview = false
    var showsControls = true
    var spatial = false
    let select: (String) -> Void
    @State private var scale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @GestureState private var pinch: CGFloat = 1
    @GestureState private var drag: CGSize = .zero
    @State private var layout: HubKnowledgeLayout.Layout?
    @State private var yaw = 0.2
    @State private var pitch = 0.12
    @State private var selectedID: String?

    enum Scope: String, CaseIterable, Identifiable {
        case all = "All knowledge"
        case notes = "Brain notes"
        case archive = "Chat archive"

        var id: Self { self }

        func includes(_ node: HubHomeKnowledge.Node) -> Bool {
            self == .all || (node.kind == "conversation") == (self == .archive)
        }
    }

    var body: some View {
        GeometryReader { geometry in
            Group {
                if let layout {
                    if spatial { spatialCanvas(layout, size: geometry.size) }
                    else { canvas(layout, size: geometry.size) }
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .task(id: LayoutRequest(graph: graph, size: geometry.size, scope: scope)) {
                let graph = graph
                let aspect = Double(geometry.size.width / max(1, geometry.size.height))
                let notes = scope != .archive
                let archive = scope != .notes
                let overview = overview
                let result = await Task.detached(priority: .userInitiated) {
                    HubKnowledgeLayout.project(graph, includesNotes: notes, includesArchive: archive,
                                               overview: overview, aspect: aspect)
                }.value
                if !Task.isCancelled { layout = result }
            }
        }
        .frame(height: height)
    }

    private func spatialCanvas(_ layout: HubKnowledgeLayout.Layout, size: CGSize) -> some View {
        let zoom = min(12, max(0.3, scale * pinch))
        let cameraYaw = yaw + Double(drag.width) * 0.008
        let cameraPitch = min(1.3, max(-1.3, pitch + Double(drag.height) * 0.008))
        let roots = layout.groups.filter { $0.parentID == nil }
        let radius = roots.reduce(135.0) { maximum, group in
            max(maximum, sqrt(group.spatialX * group.spatialX + group.spatialY * group.spatialY +
                              group.spatialZ * group.spatialZ) + group.radius)
        }
        let camera = max(900, radius * 3.5)
        let factor = min(size.width, size.height) / CGFloat(radius * 2.5) * zoom
        let cosineYaw = cos(cameraYaw), sineYaw = sin(cameraYaw)
        let cosinePitch = cos(cameraPitch), sinePitch = sin(cameraPitch)
        func project(_ x: Double, _ y: Double, _ z: Double) -> SpatialProjection {
            let horizontal = x * cosineYaw - z * sineYaw
            let rotatedZ = x * sineYaw + z * cosineYaw
            let vertical = y * cosinePitch - rotatedZ * sinePitch
            let depth = y * sinePitch + rotatedZ * cosinePitch
            let perspective = camera + depth > camera * 0.12 ? CGFloat(camera / (camera + depth)) : 0
            return SpatialProjection(point: CGPoint(x: size.width / 2 + CGFloat(horizontal) * factor * perspective,
                                                      y: size.height / 2 + CGFloat(vertical) * factor * perspective),
                                     depth: depth, perspective: perspective)
        }
        let ids = spatialSample(roots)
        let projected = layout.points.filter { ids.contains($0.id) }.map { item in
            SpatialNode(item: item, projection: project(item.spatialX, item.spatialY, item.spatialZ))
        }.filter { $0.projection.perspective > 0 }.sorted { $0.projection.depth > $1.projection.depth }
        let points = Dictionary(projected.map { ($0.item.id, $0.projection.point) }, uniquingKeysWith: { first, _ in first })
        let selected = graph.nodes.first { $0.id == selectedID }

        return ZStack(alignment: .bottomTrailing) {
            Canvas { context, _ in
                var lines = Path()
                var highlighted = Path()
                for edge in graph.edges {
                    guard let from = points[edge.source], let to = points[edge.target] else { continue }
                    if edge.source == selectedID || edge.target == selectedID {
                        highlighted.move(to: from)
                        highlighted.addLine(to: to)
                    } else {
                        lines.move(to: from)
                        lines.addLine(to: to)
                    }
                }
                for group in layout.groups where group.parentID == nil || zoom >= 1.6 {
                    let center = project(group.spatialX, group.spatialY, group.spatialZ)
                    let r = CGFloat(group.radius) * factor * center.perspective
                    guard r > 3 else { continue }
                    let ring = Path(ellipseIn: CGRect(x: center.point.x - r, y: center.point.y - r, width: r * 2, height: r * 2))
                    let tone = color(group.hue, id: group.id)
                    context.fill(ring, with: .color(tone.opacity(0.06)))
                    context.stroke(ring, with: .color(tone.opacity(0.22)), style: StrokeStyle(lineWidth: 1,
                        dash: group.id == HubKnowledgeLayout.archiveID ? [5, 4] : []))
                    var label = context.resolve(Text(group.title).font(.caption.weight(.medium)))
                    label.shading = .color(tone)
                    context.draw(label, at: CGPoint(x: center.point.x, y: center.point.y - r - 11))
                }
                context.stroke(lines, with: .color(Color.white.opacity(0.16)), lineWidth: 1)
                context.stroke(highlighted, with: .color(Color.white.opacity(0.52)), lineWidth: 1.5)
                for node in projected {
                    let point = node.projection.point
                    let r: CGFloat = (node.item.id == selectedID ? 7 : 4) * sqrt(zoom) * node.projection.perspective
                    let dot = CGRect(x: point.x - r, y: point.y - r, width: r * 2, height: r * 2)
                    context.fill(Path(ellipseIn: dot), with: .color(color(node.item.hue, id: node.item.groupID)))
                }
            }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .local)
                .updating($drag) { value, state, _ in state = value.translation }
                .onEnded { value in
                    let displacement = value.translation
                    if hypot(displacement.width, displacement.height) < 7 {
                        selectedID = projected.reversed().first {
                            hypot($0.projection.point.x - value.location.x, $0.projection.point.y - value.location.y) <= 18
                        }?.item.id
                    } else {
                        yaw += Double(displacement.width) * 0.008
                        pitch = min(1.3, max(-1.3, pitch + Double(displacement.height) * 0.008))
                    }
                })
            .simultaneousGesture(MagnificationGesture().updating($pinch) { value, state, _ in state = value }
                .onEnded { scale = min(12, max(0.3, scale * $0)) })
            HStack(spacing: 4) {
                if let selected {
                    Button { select(selected.id) } label: {
                        Text(selected.title ?? "Open record").lineLimit(1).frame(minHeight: 44)
                    }
                    .accessibilityLabel("Open selected record")
                }
                Spacer(minLength: 4)
                Button { scale = max(0.3, scale / 1.25) } label: { Image(systemName: "minus").frame(width: 44, height: 44) }
                    .accessibilityLabel("Zoom out")
                Button("Fit") { scale = 1; yaw = 0.2; pitch = 0.12 }.frame(minWidth: 44, minHeight: 44)
                Button { scale = min(12, scale * 1.25) } label: { Image(systemName: "plus").frame(width: 44, height: 44) }
                    .accessibilityLabel("Zoom in")
            }
            .font(.caption).buttonStyle(.plain).padding(.horizontal, 6)
            .background(Color.black.opacity(0.22), in: RoundedRectangle(cornerRadius: 12))
            .padding(4)
        }
        .clipped()
        .accessibilityLabel("3D Knowledge graph")
        .accessibilityHint("Drag to rotate. Use the record list to browse all notes.")
    }

    private func spatialSample(_ roots: [HubKnowledgeLayout.Group]) -> Set<String> {
        var ids: Set<String> = []
        if let selectedID { ids.insert(selectedID) }
        let length = roots.map { $0.members.count }.max() ?? 0
        for index in 0..<length {
            for root in roots where root.members.indices.contains(index) {
                ids.insert(root.members[index])
                if ids.count >= 500 { return ids }
            }
        }
        return ids
    }

    private struct SpatialProjection {
        let point: CGPoint
        let depth: Double
        let perspective: CGFloat
    }

    private struct SpatialNode {
        let item: HubKnowledgeLayout.Point
        let projection: SpatialProjection
    }

    private func canvas(_ layout: HubKnowledgeLayout.Layout, size: CGSize) -> some View {
        let byID = Dictionary(graph.nodes.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let zoom = min(4, max(0.5, scale * pinch))
        let translation = CGSize(width: offset.width + drag.width, height: offset.height + drag.height)
        let points = positions(layout.points, zoom: zoom, offset: translation, size: size)
        return ZStack(alignment: .bottomTrailing) {
            Canvas { context, _ in
                var lines = Path()
                for edge in graph.edges {
                    guard let a = points[edge.source], let b = points[edge.target] else { continue }
                    lines.move(to: a)
                    lines.addLine(to: b)
                }
                context.stroke(lines, with: .color(Color(red: 0.64, green: 0.71, blue: 0.81).opacity(0.28)), lineWidth: 1)
                for item in layout.points {
                    guard let point = points[item.id] else { continue }
                    let radius: CGFloat = item.groupID == HubKnowledgeLayout.archiveID ? 2.5 : 4.7
                    let dot = CGRect(x: point.x - radius, y: point.y - radius, width: 2 * radius, height: 2 * radius)
                    context.fill(Path(ellipseIn: dot), with: .color(color(item.hue, id: item.groupID)))
                }
                for group in layout.groups where group.parentID == nil || zoom >= 1.6 {
                    if overview, group.id == HubKnowledgeLayout.unassignedID { continue }
                    let members = group.members.compactMap { points[$0] }
                    guard let top = members.map(\.y).min() else { continue }
                    let x = members.reduce(0) { $0 + $1.x } / CGFloat(members.count)
                    var label = context.resolve(Text(group.title).font(.caption.weight(.medium)))
                    label.shading = .color(color(group.hue, id: group.id))
                    context.draw(label, at: CGPoint(x: x, y: top - 19))
                }
                if !overview, zoom >= 2.2 {
                    for item in layout.points {
                        guard let point = points[item.id], let title = byID[item.id]?.title,
                              CGRect(origin: .zero, size: size).contains(point) else { continue }
                        context.draw(Text(String(title.prefix(36))).font(.caption2), at: CGPoint(x: point.x, y: point.y + 11))
                    }
                }
            }
            .contentShape(Rectangle())
            .gesture(DragGesture().updating($drag) { value, state, _ in state = value.translation }
                .onEnded { value in
                    offset = CGSize(width: offset.width + value.translation.width, height: offset.height + value.translation.height)
                })
            .simultaneousGesture(MagnificationGesture().updating($pinch) { value, state, _ in state = value }
                .onEnded { scale = min(4, max(0.5, scale * $0)) })
            ForEach(layout.points.filter { $0.groupID != HubKnowledgeLayout.archiveID || zoom > 1.8 }, id: \.id) { item in
                if let point = points[item.id], CGRect(origin: .zero, size: size).contains(point) {
                    Button { select(item.id) } label: {
                        Color.clear.frame(width: 20, height: 20).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .position(point)
                    .accessibilityLabel(byID[item.id]?.title ?? "Knowledge record")
                }
            }
            if showsControls { HStack(spacing: 2) {
                Button { scale = max(0.5, scale / 1.25) } label: { Image(systemName: "minus").frame(width: 44, height: 44) }
                    .accessibilityLabel("Zoom out")
                Button("Fit") { scale = 1; offset = .zero }.frame(minWidth: 44, minHeight: 44)
                Button { scale = min(4, scale * 1.25) } label: { Image(systemName: "plus").frame(width: 44, height: 44) }
                    .accessibilityLabel("Zoom in")
            }
            .buttonStyle(.plain)
            .font(.caption)
            .background(.black.opacity(0.22), in: RoundedRectangle(cornerRadius: 12))
            .padding(4)
            }
        }
        .clipped()
        .accessibilityLabel("Knowledge graph")
    }

    private struct LayoutRequest: Equatable {
        let graph: HubHomeKnowledge
        let size: CGSize
        let scope: Scope
    }

    private func positions(_ items: [HubKnowledgeLayout.Point], zoom: CGFloat, offset: CGSize, size: CGSize) -> [String: CGPoint] {
        let x = items.map(\.x), y = items.map(\.y)
        guard let minX = x.min(), let maxX = x.max(), let minY = y.min(), let maxY = y.max() else { return [:] }
        let width = max(1, size.width - 40), height = max(1, size.height - 70)
        let inset: CGFloat = overview ? 54 : 65
        let fit = min(width / (CGFloat(maxX - minX) + inset), height / (CGFloat(maxY - minY) + inset)) * zoom
        let centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2
        return Dictionary(uniqueKeysWithValues: items.map { item in
            let x = size.width / 2 + CGFloat(item.x - centerX) * fit + offset.width
            let y = size.height / 2 - 8 + CGFloat(item.y - centerY) * fit + offset.height
            return (item.id, CGPoint(x: x, y: y))
        })
    }

    private func color(_ hue: Double, id: String) -> Color {
        if id == HubKnowledgeLayout.archiveID { return Color(red: 0.54, green: 0.76, blue: 0.84) }
        if id == HubKnowledgeLayout.unassignedID && !overview { return Color(red: 0.62, green: 0.65, blue: 0.7) }
        let saturation = id == HubKnowledgeLayout.unassignedID ? 0.35 : 0.53
        let light = id == HubKnowledgeLayout.unassignedID ? 0.68 : 0.72
        let brightness = light + saturation * min(light, 1 - light)
        return Color(hue: hue, saturation: 2 * (1 - light / brightness), brightness: brightness)
    }
}

@MainActor
struct HubKnowledgeActivityView: View {
    let api: HubConversationAPI
    @Environment(\.dismiss) private var dismiss
    @State private var entries: [HubKnowledgeActivity.Entry] = []
    @State private var page: HubKnowledgeActivity?
    @State private var failed = false
    @State private var loading = false
    @State private var acting = false
    @State private var actionMessage: String?
    @State private var confirmation: QueueAction?

    private enum QueueAction: String, Identifiable {
        case process = "Process queued records"
        case retry = "Retry failed records"
        var id: String { rawValue }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Knowledge AI Activity").font(.headline)
                Spacer()
                Menu {
                    Button("Refresh activity") { Task { await load(0) } }
                    Button(QueueAction.process.rawValue) { confirmation = .process }.disabled(page?.enabled != true)
                    Button(QueueAction.retry.rawValue) { confirmation = .retry }.disabled(page?.enabled != true)
                } label: {
                    Image(systemName: "ellipsis.circle").frame(width: 44, height: 44)
                }
                .accessibilityLabel("Knowledge AI actions")
                .disabled(acting || loading)
                Button("Done") { dismiss() }
            }
            if acting { ProgressView() }
            if let actionMessage { Text(actionMessage).font(.footnote).foregroundStyle(.secondary) }
            if let page {
                Text(page.enabled ? page.state.capitalized : "Disabled").foregroundStyle(.secondary)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if entries.isEmpty { Text(page.historyNotice).foregroundStyle(.secondary) }
                        ForEach(entries) { entry in
                            VStack(alignment: .leading, spacing: 5) {
                                Text((entry.outcome ?? entry.status).replacingOccurrences(of: "-", with: " ").capitalized).font(.headline)
                                Text(Date(timeIntervalSince1970: entry.updatedAt / 1000).formatted()).font(.caption).foregroundStyle(.secondary)
                                if let reason = entry.reason { Text(reason) }
                                if let error = entry.error { Text(error.message).foregroundStyle(.red) }
                                if let retryAt = entry.retryAt { Text("Retry: \(Date(timeIntervalSince1970: retryAt / 1000).formatted())") }
                                ForEach(Array(entry.changes.enumerated()), id: \.offset) { change in
                                    Text("\(change.element.action.capitalized) · \(change.element.title)")
                                }
                                ForEach(Array(entry.warnings.enumerated()), id: \.offset) { warning in
                                    Text(warning.element).font(.footnote).foregroundStyle(.secondary)
                                }
                                Divider()
                            }
                        }
                        if let next = page.nextOffset {
                            Button("Load more") { Task { await load(next) } }.disabled(loading)
                        }
                    }
                }
            }
            if loading { ProgressView("Loading activity…") }
            if failed { Button("Retry") { Task { await load(0) } } }
        }
        .task { await load(0) }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .foregroundStyle(.white)
        .background(Color(uiColor: HubHomeView.backgroundColor).ignoresSafeArea())
        .preferredColorScheme(.dark)
        .alert(item: $confirmation) { action in
            Alert(title: Text(action.rawValue), message: Text("Knowledge AI uses the configured model and budget."),
                  primaryButton: .default(Text("Continue")) { Task { await run(action) } }, secondaryButton: .cancel())
        }
    }

    private func run(_ action: QueueAction) async {
        guard !acting else { return }
        acting = true
        defer { acting = false }
        do {
            switch action {
            case .process:
                _ = try await api.processKnowledgeQueue()
                actionMessage = "Processing requested. Refresh to check progress."
            case .retry:
                let count = try await api.retryFailedKnowledge()
                actionMessage = count == 0 ? "No failed records to retry." : "\(count) records queued again."
            }
        } catch { actionMessage = "Could not confirm the request. Refresh activity before retrying." }
        await load(0)
    }

    private func load(_ offset: Int) async {
        guard !loading else { return }
        loading = true
        failed = false
        defer { loading = false }
        do {
            let result = try await api.knowledgeActivity(offset: offset)
            guard !Task.isCancelled else { return }
            if offset == 0 { entries = [] }
            var seen = Set(entries.map(\.id))
            entries += result.entries.filter { seen.insert($0.id).inserted }
            page = result
        } catch {
            if !Task.isCancelled { failed = true }
        }
    }
}
