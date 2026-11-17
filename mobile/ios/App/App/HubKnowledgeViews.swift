import SwiftUI
import UIKit
import HubNative
import UniformTypeIdentifiers
import PDFKit

@MainActor
struct HubKnowledgeForgetView: View {
    let api: HubConversationAPI
    let note: HubKnowledgeNote
    let changed: (HubKnowledgeNote) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var passage = ""
    @State private var confirm = false
    @State private var busy = false
    @State private var failed = false

    var body: some View {
        NavigationView {
            HubForm {
                Section("Passage to forget") {
                    TextEditor(text: $passage).frame(minHeight: 85).accessibilityLabel("Passage to forget")
                    Text("Copy an exact passage from the note below and paste it here.").font(.footnote)
                }
                Section(note.title) {
                    Text(note.content).textSelection(.enabled)
                }
                if busy { ProgressView("Forgetting passage…") }
                if failed { Text("Could not confirm the change. Reopen the note before trying again.").font(.footnote) }
            }
            .disabled(busy)
            .navigationTitle("Forget a passage")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Forget", role: .destructive) { confirm = true }
                        .disabled(busy || failed || passage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .alert("Forget this passage?", isPresented: $confirm) {
                Button("Forget passage", role: .destructive) { Task { await forget() } }
                Button("Cancel", role: .cancel) {}
            } message: { Text("Knowledge will remove the selected passage and retire its earlier evidence from recall.") }
        }
        .navigationViewStyle(.stack)
        .interactiveDismissDisabled(busy)
    }

    private func forget() async {
        guard !busy, !failed else { return }
        busy = true
        defer { busy = false }
        do {
            let updated = try await api.forgetKnowledgePassage(passage, from: note)
            await changed(updated)
            dismiss()
        } catch {
            failed = true
        }
    }
}

/// A note's link to one of its saved files, like
/// `[Original snake.html](../Attachments/snake%20%280531b1c55da4%29.html)`.
/// The vault file name carries the start of the file's SHA-256 in brackets.
struct HubKnowledgeAttachmentLink: Identifiable, Equatable {
    let title: String
    let fileName: String
    let hashPrefix: String?
    var id: String { fileName }
    var isHTML: Bool { HubKnowledgeFilePreview.isHTML(name: fileName, mediaType: "") }

    static func find(in content: String) -> [HubKnowledgeAttachmentLink] {
        guard let pattern = try? NSRegularExpression(pattern: #"\[([^\]\n]{1,200})\]\((?:\.\./)*Attachments/([^)\n]{1,400})\)"#) else { return [] }
        var seen = Set<String>(), found: [HubKnowledgeAttachmentLink] = []
        for match in pattern.matches(in: content, range: NSRange(content.startIndex..., in: content)) {
            guard let titleRange = Range(match.range(at: 1), in: content), let fileRange = Range(match.range(at: 2), in: content) else { continue }
            let raw = String(content[fileRange])
            let file = raw.removingPercentEncoding ?? raw
            guard seen.insert(file).inserted else { continue }
            var hash: String?
            if let marker = file.range(of: #"\(([0-9a-f]{8,64})\)\.[A-Za-z0-9]+$"#, options: .regularExpression) {
                hash = String(file[marker]).trimmingCharacters(in: CharacterSet(charactersIn: "()")).components(separatedBy: ")").first
            }
            found.append(HubKnowledgeAttachmentLink(title: String(content[titleRange]), fileName: file, hashPrefix: hash))
        }
        return found
    }

    /// The saved asset this link points at.
    func asset(in assets: [HubKnowledgeAsset]) -> HubKnowledgeAsset? {
        if let hashPrefix, let match = assets.first(where: { $0.id.hasPrefix(hashPrefix) }) { return match }
        let plain = fileName.replacingOccurrences(of: #" \([0-9a-f]{8,64}\)(?=\.[A-Za-z0-9]+$)"#, with: "", options: .regularExpression)
        return assets.first { $0.name == plain || $0.name == fileName }
    }
}

struct HubOpenedKnowledgeFile: Identifiable {
    let asset: HubKnowledgeAsset
    let data: Data
    var id: String { asset.id }
}

/// Shows a saved Knowledge file inside the app: HTML runs in a sealed web
/// view (with its source one tap away), images zoom, PDFs and text read.
struct HubKnowledgeFilePreview: View {
    let name: String
    let mediaType: String
    let data: Data
    @State private var showSource = false

    static func isHTML(name: String, mediaType: String) -> Bool {
        mediaType == "text/html" || mediaType == "application/xhtml+xml" || name.lowercased().hasSuffix(".html") || name.lowercased().hasSuffix(".htm")
    }

    var body: some View {
        if Self.isHTML(name: name, mediaType: mediaType), let html = String(data: data, encoding: .utf8) {
            VStack(spacing: 0) {
                Picker("View", selection: $showSource) {
                    Text("Run").tag(false)
                    Text("Source").tag(true)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                if showSource {
                    ScrollView([.vertical, .horizontal]) {
                        Text(html).font(.footnote.monospaced()).textSelection(.enabled).padding()
                    }
                } else {
                    HubContainedDocumentView(document: HubContainedDocumentView.normalized(html))
                        .accessibilityLabel(name)
                }
            }
        } else if mediaType.hasPrefix("image/"), let image = UIImage(data: data) {
            HubZoomableImage(image: image).accessibilityLabel(name)
        } else if mediaType == "application/pdf", let document = PDFDocument(data: data) {
            HubKnowledgePDFView(document: document)
        } else if data.count <= 400_000, mediaType.hasPrefix("text/") || mediaType == "application/json",
                  let text = String(data: data, encoding: .utf8) {
            ScrollView { Text(text).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled).padding() }
        } else {
            VStack(alignment: .leading) {
                Text("This file type can't be shown here. Use Save to Files to open it in another app.").foregroundStyle(.secondary).padding()
                Spacer()
            }
        }
    }
}

@MainActor
struct HubKnowledgeOriginalSourceView: View {
    let api: HubConversationAPI
    let source: HubKnowledgeNote.Source
    @Environment(\.dismiss) private var dismiss
    @State private var original: HubKnowledgeOriginalSource?
    @State private var failed = false
    @State private var attempt = 0
    @State private var selected: HubKnowledgeAsset?
    @State private var originalFile: Data?
    @State private var export = false
    @State private var fileFailed = false
    @State private var downloading = false
    @State private var previewing = false

    var body: some View {
        NavigationView {
            HubList {
                if let original {
                    Text(original.content).textSelection(.enabled)
                    if let files = original.assets, !files.isEmpty {
                        Section("Source attachments") {
                            ForEach(files) { file in
                                Button { Task { await fetch(file) } } label: {
                                    Label(file.name, systemImage: HubKnowledgeFilePreview.isHTML(name: file.name, mediaType: file.mediaType) ? "play.rectangle" : "doc")
                                }
                                .disabled(downloading || export)
                            }
                            if downloading, let selected { ProgressView(selected.name) }
                            if fileFailed { Text("Could not verify or save the attachment.").font(.footnote) }
                        }
                    }
                    if let links = original.urls {
                        ForEach(links.indices, id: \.self) { index in
                            if let url = URL(string: links[index]), let scheme = url.scheme?.lowercased(),
                               ["https", "http"].contains(scheme), url.host != nil, url.user == nil, url.password == nil {
                                Link(links[index], destination: url)
                            }
                        }
                    }
                } else if failed {
                    Button("Retry loading source") { attempt += 1 }
                } else {
                    ProgressView("Loading source…")
                }
            }
            .navigationTitle("Original source")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
        .navigationViewStyle(.stack)
        .task(id: attempt) {
            failed = false
            do { original = try await api.knowledgeOriginalSource(id: source.id) }
            catch { if !Task.isCancelled { failed = true } }
        }
        .sheet(isPresented: $previewing) {
            if let selected, let originalFile {
                NavigationView {
                    HubKnowledgeFilePreview(name: selected.name, mediaType: selected.mediaType, data: originalFile)
                        .navigationTitle(selected.name)
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) { Button("Done") { previewing = false } }
                            ToolbarItem(placement: .primaryAction) { HubShareFileButton(bytes: originalFile, name: selected.name, label: "Share or save file") }
                        }
                }
                .navigationViewStyle(.stack)
            }
        }
        .fileExporter(isPresented: $export, document: originalFile.map { HubFileDocument(bytes: $0) },
                      contentType: selected.flatMap { UTType(mimeType: $0.mediaType) } ?? .data, defaultFilename: selected?.name) { result in
            if case .failure = result { fileFailed = true }
            selected = nil
            originalFile = nil
        }
    }

    private func fetch(_ asset: HubKnowledgeAsset) async {
        guard !downloading, !export else { return }
        downloading = true
        defer { downloading = false }
        selected = asset
        originalFile = nil
        fileFailed = false
        do {
            originalFile = try await api.knowledgeAssetBytes(asset)
            previewing = true
        } catch {
            selected = nil
            fileFailed = true
        }
    }
}

@MainActor
struct HubKnowledgeAssetsView: View {
    let api: HubConversationAPI
    @State private var note: HubKnowledgeNote?
    let changed: (HubKnowledgeNote?) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var assets: [HubKnowledgeAsset]?
    @State private var preview: Preview?
    @State private var busy = false
    @State private var chooseFiles = false
    @State private var export = false
    @State private var checkBeforeUpload = false
    @State private var notice: LocalizedStringKey?

    private struct Preview {
        let asset: HubKnowledgeAsset
        let data: Data
    }

    init(api: HubConversationAPI, note: HubKnowledgeNote?, changed: @escaping (HubKnowledgeNote?) async -> Void) {
        self.api = api
        self.changed = changed
        _note = State(initialValue: note)
    }

    var body: some View {
        NavigationView {
            Group {
                if let preview { attachment(preview) }
                else { library }
            }
            .navigationTitle(preview?.asset.name ?? "Attachments")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(preview == nil ? "Done" : "Back") {
                        if preview == nil { dismiss() }
                        else { preview = nil; notice = nil }
                    }
                    .disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if preview != nil { Button("Save to Files") { export = true } }
                    else { Button(note == nil ? "Add files" : "Attach files") { chooseFiles = true }.disabled(busy || checkBeforeUpload) }
                }
            }
        }
        .navigationViewStyle(.stack)
        .interactiveDismissDisabled(busy)
        .task { await load() }
        .fileImporter(isPresented: $chooseFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): Task { await upload(urls) }
            case .failure: notice = "Could not open the selected files."
            }
        }
        .fileExporter(isPresented: $export, document: preview.map { HubFileDocument(bytes: $0.data) },
                      contentType: preview.flatMap { UTType(mimeType: $0.asset.mediaType) } ?? .data,
                      defaultFilename: preview?.asset.name) { result in
            if case .failure = result { notice = "Could not save this attachment." }
        }
    }

    private var library: some View {
        HubList {
            if let note { Label(note.title, systemImage: "note.text") }
            if let notice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
            if busy { ProgressView("Working…") }
            if let assets {
                if assets.isEmpty { Text("No saved attachments yet.").foregroundStyle(.secondary) }
                ForEach(assets) { asset in
                    Button { Task { await open(asset) } } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(asset.name).font(.headline)
                            Text(ByteCountFormatter.string(fromByteCount: Int64(asset.bytes), countStyle: .file))
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        .frame(minHeight: 44)
                    }
                }
            }
            if !busy {
                Button(checkBeforeUpload ? "Check saved files" : assets == nil ? "Retry" : "Refresh attachments") { Task { await load() } }
            }
        }
        .disabled(busy)
    }

    private func attachment(_ preview: Preview) -> some View {
        VStack(alignment: .leading) {
            if let notice { Text(notice).font(.footnote).foregroundStyle(.secondary).padding() }
            HubKnowledgeFilePreview(name: preview.asset.name, mediaType: preview.asset.mediaType, data: preview.data)
        }
    }

    private func load() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let current = try await api.knowledgeAssets()
            if checkBeforeUpload, let note {
                let updated = try await api.knowledgeNote(id: note.id)
                self.note = updated
                await changed(updated)
            }
            assets = current
            checkBeforeUpload = false
            notice = nil
        }
        catch { notice = "Could not load attachments. Try again." }
    }

    private func open(_ asset: HubKnowledgeAsset) async {
        guard !busy else { return }
        busy = true
        notice = nil
        defer { busy = false }
        do { preview = Preview(asset: asset, data: try await api.knowledgeAssetBytes(asset)) }
        catch { notice = "Could not open this attachment. Try opening it again." }
    }

    private func upload(_ urls: [URL]) async {
        guard !busy, !urls.isEmpty else { return }
        busy = true
        defer { busy = false }
        var saved = 0
        do {
            for url in urls {
                let bytes = try await Task.detached(priority: .userInitiated) {
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    let limit = HubConversationAPI.knowledgeAssetLimit
                    let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
                    guard values.isRegularFile == true, let size = values.fileSize, (1...limit).contains(size) else {
                        throw HubAttachmentError.invalidFile
                    }
                    let file = try FileHandle(forReadingFrom: url)
                    defer { try? file.close() }
                    guard let data = try file.read(upToCount: limit + 1), (1...limit).contains(data.count) else {
                        throw HubAttachmentError.invalidFile
                    }
                    return data
                }.value
                let result = try await api.uploadKnowledgeAsset(bytes, name: url.lastPathComponent, attachingTo: note)
                if let updated = result.note { note = updated }
                let previous = assets ?? []
                assets = previous.contains(where: { $0.id == result.asset.id }) ? previous : previous + [result.asset]
                saved += 1
            }
            notice = "\(saved) files saved."
        } catch {
            checkBeforeUpload = true
            notice = "\(saved) files confirmed. Check what was saved before uploading again. Choose files up to 25 MB."
        }
        if saved > 0 { await changed(note) }
    }
}

private struct HubKnowledgePDFView: UIViewRepresentable {
    let document: PDFDocument

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {
        if view.document !== document { view.document = document }
    }
}

@MainActor
struct HubKnowledgeSkillsView: View {
    let api: HubConversationAPI
    let changed: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var catalog: HubKnowledgeSkillCatalog?
    @State private var query = ""
    @State private var draft: HubKnowledgeSkillDraft?
    @State private var baseline: HubKnowledgeSkillDraft?
    @State private var busy = false
    @State private var notice: LocalizedStringKey?
    @State private var confirmDiscard = false
    @State private var toolsText = ""
    @State private var customName = false

    var body: some View {
        NavigationView {
            Group {
                if let draft { editor(draft) }
                else { library }
            }
            .navigationTitle(draft == nil ? "Skills" : baseline?.expectedHash == nil ? "New skill" : "Edit skill")
            .navigationBarTitleDisplayMode(.inline)
            .disabled(busy)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(draft == nil ? "Done" : "Cancel") { close() }.disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if let draft {
                        Button("Save") { Task { await save(draft) } }.disabled(busy || !draft.isValid || draft == baseline)
                    } else {
                        Button("New skill") { edit(HubKnowledgeSkillDraft()) }.disabled(busy || catalog == nil)
                    }
                }
            }
            .alert("Discard skill changes?", isPresented: $confirmDiscard) {
                Button("Discard changes", role: .destructive) { endEditing() }
                Button("Keep editing", role: .cancel) {}
            }
        }
        .navigationViewStyle(.stack)
        .interactiveDismissDisabled(busy || draft != baseline)
        .task { await load() }
    }

    private var library: some View {
        HubList {
            if let notice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
            if busy { ProgressView("Loading skills…") }
            if let catalog {
                TextField("Find a skill", text: $query).autocorrectionDisabled()
                let search = query.trimmingCharacters(in: .whitespacesAndNewlines)
                let skills = catalog.skills.filter { skill in
                    search.isEmpty || [skill.title, skill.name, skill.description].contains { $0.localizedCaseInsensitiveContains(search) }
                }
                if skills.isEmpty { Text(catalog.skills.isEmpty ? "No saved skills yet." : "No matching skills.") }
                ForEach(skills) { skill in
                    Button { Task { await open(skill.name) } } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(skill.title).font(.headline)
                            Text(skill.description).font(.footnote).foregroundStyle(.secondary)
                        }
                        .frame(minHeight: 44)
                    }
                    .accessibilityIdentifier("hub.knowledge.skill.\(skill.name)")
                }
                if let issues = catalog.issues, !issues.isEmpty {
                    Section("Skills needing repair") {
                        ForEach(issues.indices, id: \.self) { index in
                            Text(issues[index].name).font(.subheadline)
                            Text(issues[index].reason).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            if !busy { Button(catalog == nil ? "Retry" : "Refresh skills") { Task { await load() } } }
        }
    }

    private func editor(_ value: HubKnowledgeSkillDraft) -> some View {
        HubForm {
            if let notice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
            if busy { ProgressView("Saving skill…") }
            Section("Details") {
                HubLabeledField(title: "Name") {
                    TextField("Name", text: Binding(get: { draft?.title ?? "" }, set: { title in
                        draft?.title = title
                        if baseline?.expectedHash == nil && !customName { draft?.name = Self.slug(title) }
                    }))
                }
                HubLabeledField(title: "When to use this") {
                    TextField("When to use this", text: field(\.description))
                }
            }
            Section("Workflow instructions") {
                TextEditor(text: field(\.content)).frame(minHeight: 175)
                    .accessibilityLabel("Workflow instructions")
            }
            Section("Advanced") {
                HubLabeledField(title: "Stable skill name") {
                    TextField("Stable skill name", text: Binding(get: { draft?.name ?? "" }, set: { name in
                        customName = true
                        draft?.name = name
                    }))
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .disabled(value.expectedHash != nil)
                }
                HubLabeledField(title: "Required tools") {
                    TextField("Required tools, separated by commas", text: Binding(get: { toolsText }, set: { text in
                        toolsText = text
                        draft?.requiredTools = text.split { $0 == "," || $0.isWhitespace }.map(String.init)
                    }))
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                Text("Character permissions control which tools a workflow can use.").font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    private static func slug(_ title: String) -> String {
        let text = title.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "en_US_POSIX"))
        let words = text.lowercased().split { !$0.isASCII || !($0.isLetter || $0.isNumber) }
        return String(words.joined(separator: "-").prefix(80)).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }

    private func field(_ key: WritableKeyPath<HubKnowledgeSkillDraft, String>) -> Binding<String> {
        Binding(get: { draft?[keyPath: key] ?? "" }, set: { draft?[keyPath: key] = $0 })
    }

    private func edit(_ value: HubKnowledgeSkillDraft) {
        toolsText = value.requiredTools.joined(separator: ", ")
        customName = false
        baseline = value
        draft = value
        notice = nil
    }

    private func endEditing() {
        draft = nil
        baseline = nil
        notice = nil
    }

    private func close() {
        if draft == nil { dismiss() }
        else if draft == baseline { endEditing() }
        else { confirmDiscard = true }
    }

    private func load() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let found = try await api.knowledgeSkills()
            if !Task.isCancelled { catalog = found; notice = nil }
        } catch {
            if !Task.isCancelled { notice = "Could not load skills. Try again." }
        }
    }

    private func open(_ name: String) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let saved = try await api.knowledgeSkill(name: name)
            if !Task.isCancelled { edit(HubKnowledgeSkillDraft(skill: saved)) }
        } catch {
            if !Task.isCancelled { notice = "Could not open this skill. Refresh the list and try again." }
        }
    }

    private func save(_ value: HubKnowledgeSkillDraft) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            catalog = try await api.saveKnowledgeSkill(value)
            endEditing()
            notice = "Skill saved."
            await changed()
        } catch {
            notice = "Could not confirm the save. Copy your draft before reopening the skill to check its current version."
        }
    }
}

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
            HubList {
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
        .task { await loadPage("") }
        .task(id: search) { await findTargets(search) }
        .task(id: target.map { "\($0.id)/\(traceAttempt)" }) {
            if let target { await findPath(target.id) }
        }
        .sheet(item: $selectedEvidence) { selection in
            NavigationView {
                HubList {
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
    @State private var selected: [String: HubKnowledgeArchivePreview.Record] = [:]
    @State private var archiveSearch = ""
    @State private var knowledgePricing: HubKnowledgeSettings?
    @State private var record: HubKnowledgeArchivePreview.Record?
    @State private var original: HubKnowledgeArchiveMessages?
    @State private var originalOffset = 0
    @State private var busy = false
    @State private var notice: String?
    @State private var pickerOpen = false
    @State private var confirmation: Mutation?
    @State private var stale = false
    @State private var confirmQueueHistory = false

    private enum Mutation: String, Identifiable {
        case admit, withdraw
        var id: Self { self }
        var title: String { self == .admit ? "Admit selected conversations?" : "Withdraw admitted conversations?" }
    }

    var body: some View {
        NavigationView {
            HubList {
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
        .task { knowledgePricing = try? await api.knowledgeStatus().settings }
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

    private func queueHistory() async {
        busy = true
        defer { busy = false }
        do {
            let result = try await api.queueEarlierConversationsForKnowledge()
            notice = "\(result.queued) queued · \(result.duplicates) already known · \(result.skipped) skipped"
            await changed()
        } catch {
            notice = "HUB could not queue your earlier conversations. Check your connection and try again."
        }
    }

    private var archiveList: some View {
        Section {
            Button("Add a private archive") { pickerOpen = true }
            Button("Queue earlier HUB conversations") { confirmQueueHistory = true }
                .alert("Queue earlier HUB conversations?", isPresented: $confirmQueueHistory) {
                    Button("Queue conversations") { Task { await queueHistory() } }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("HUB adds your earlier conversations to the Knowledge queue. Organizing them may use your Knowledge AI budget.")
                }
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
                if let count = preview.messages { Text("\(count) original messages").font(.footnote).foregroundStyle(.secondary) }
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
                        if let estimate = selectionEstimate(preview) {
                            Text(estimate).font(.footnote).foregroundStyle(.secondary)
                        }
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
                    TextField("Filter this archive page", text: $archiveSearch)
                    let query = archiveSearch.trimmingCharacters(in: .whitespacesAndNewlines)
                    let matches = preview.records.filter { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) }
                    if matches.isEmpty { Text("No matching conversations on this page.").foregroundStyle(.secondary) }
                    ForEach(matches) { item in
                        VStack(alignment: .leading, spacing: 6) {
                            Toggle(item.title, isOn: Binding(get: { selected[item.id] != nil }, set: { on in
                                if on {
                                    if selected.count < 50 { selected[item.id] = item }
                                    else { notice = "Select up to 50 conversations at a time." }
                                } else { selected.removeValue(forKey: item.id) }
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

    private func selectionEstimate(_ preview: HubKnowledgeArchivePreview) -> String? {
        guard selected.values.allSatisfy({ $0.estimatedCalls != nil && $0.inputBytes != nil }) else { return nil }
        let calls = selected.values.reduce(0.0) { $0 + Double($1.estimatedCalls ?? 0) }
        let inputBytes = selected.values.reduce(0.0) { $0 + Double($1.inputBytes ?? 0) }
        let chunks = "Up to \(calls.formatted(.number.precision(.fractionLength(0)))) organization chunks."
        guard let inputPrice = knowledgePricing?.inputPrice ?? preview.prices?.inputPrice,
              let outputPrice = knowledgePricing?.outputPrice ?? preview.prices?.outputPrice else { return chunks }
        let amount = ((inputBytes + calls * 50_000) * inputPrice + calls * 6_000 * outputPrice) / 1_000_000
        guard amount.isFinite, amount >= 0 else { return chunks }
        return chunks + " Estimated cost \(amount.formatted(.currency(code: "USD").precision(.fractionLength(3))))."
    }

    private func originalMessages(_ item: HubKnowledgeArchivePreview.Record) -> some View {
        Section(item.title) {
            if let original {
                Text("\(original.total) messages").font(.footnote).foregroundStyle(.secondary)
                ForEach(Array(original.messages.enumerated()), id: \.offset) { _, message in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(message.role.capitalized).font(.caption.weight(.semibold))
                        if let at = message.at {
                            Text(Date(timeIntervalSince1970: at / 1_000).formatted()).font(.caption).foregroundStyle(.secondary)
                        }
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
        if preview?.id != value.id || self.offset != offset { archiveSearch = "" }
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
                let receipt = try await api.admitKnowledgeArchive(preview, recordIDs: selected.keys.sorted())
                let summary = "\(receipt.admitted) admitted · \(receipt.duplicates) duplicates · \(receipt.queued) organization jobs queued."
                notice = ([summary] + (receipt.warnings ?? [])).joined(separator: "\n")
            case .withdraw:
                let receipt = try await api.withdrawKnowledgeArchive(preview.id)
                let count = receipt.domainReviewRequired?.count ?? 0
                notice = count == 0 ? "\(receipt.withdrawn) conversations withdrawn. Originals retained."
                    : "\(receipt.withdrawn) conversations withdrawn. Originals retained. Review affected changes in Domains (\(count))."
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
    @State private var confirmResume = false

    private func resumeRestoredWork() async {
        busy = true
        do {
            try await api.resumeRestoredKnowledgeWork()
            busy = false
            await refresh()
            notice = "Saved Knowledge work can run again."
        } catch {
            busy = false
            notice = "HUB could not confirm that saved work resumed. Refresh backups before trying again."
        }
    }

    var body: some View {
        NavigationView {
            HubList {
                Section {
                    Button("Create verified backup") { Task { await createBackup() } }
                    Button("Refresh backups") { Task { await refresh() } }
                    if busy { ProgressView("Checking backup data on HUB…") }
                    if let notice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
                } footer: {
                    Text("Copies are saved on the HUB computer. Keep each backup folder with its snapshot.json.")
                }
                if let hold = page?.restoreHold {
                    Section("Restored work is paused") {
                        Text("\(hold.queued) saved organization jobs · \(hold.mode) · \(hold.provider)/\(hold.model). Review your Knowledge AI settings before resuming.")
                            .font(.footnote)
                        Button("Resume saved Knowledge work") { confirmResume = true }
                    }
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
        .alert("Resume saved Knowledge work?", isPresented: $confirmResume) {
            Button("Resume") { Task { await resumeRestoredWork() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Saved work may resume under your existing Knowledge AI settings and budget.")
        }
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
    var focusID: String? = nil
    var selectDomain: ((String) -> Void)? = nil
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
                    if edge.source == (selectedID ?? focusID) || edge.target == (selectedID ?? focusID) {
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
                context.stroke(lines, with: .color(HubWorkspacePalette.border.opacity(0.16)), lineWidth: 1)
                context.stroke(highlighted, with: .color(HubWorkspacePalette.border.opacity(0.52)), lineWidth: 1.5)
                for node in projected {
                    let point = node.projection.point
                    let r: CGFloat = (node.item.id == (selectedID ?? focusID) ? 7 : 4) * sqrt(zoom) * node.projection.perspective
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
            .background(HubWorkspacePalette.border.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
            .padding(4)
        }
        .clipped()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("3D Knowledge graph")
        .accessibilityHint("Drag to rotate. Use the record list to browse all notes.")
    }

    private func spatialSample(_ roots: [HubKnowledgeLayout.Group]) -> Set<String> {
        var ids: Set<String> = []
        if let selectedID { ids.insert(selectedID) }
        if let focusID { ids.insert(focusID) }
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
        let frame = PlaneFrame(layout: layout, size: size, zoom: zoom, offset: translation, overview: overview)
        let points = Dictionary(layout.points.map { ($0.id, frame.point($0.x, $0.y)) }, uniquingKeysWith: { first, _ in first })
        let visibleGroups = layout.groups.filter { $0.parentID == nil || zoom >= 1.6 }
        let fewRecords = layout.points.count <= 40
        return ZStack(alignment: .bottomTrailing) {
            Canvas { context, _ in
                // Each domain is a soft disc; its subdomains show as you zoom in.
                for group in visibleGroups where group.planeRadius > 0 {
                    let center = frame.point(group.planeX, group.planeY)
                    let r = CGFloat(group.planeRadius) * frame.scale
                    guard r > 4 else { continue }
                    let disc = Path(ellipseIn: CGRect(x: center.x - r, y: center.y - r, width: r * 2, height: r * 2))
                    let tone = color(group.hue, id: group.id)
                    let child = group.parentID != nil
                    context.fill(disc, with: .color(tone.opacity(child ? 0.06 : 0.09)))
                    context.stroke(disc, with: .color(tone.opacity(child ? 0.22 : 0.3)),
                                   style: StrokeStyle(lineWidth: 1, dash: group.id == HubKnowledgeLayout.archiveID || child ? [4, 4] : []))
                }
                var lines = Path()
                for edge in graph.edges {
                    guard let a = points[edge.source], let b = points[edge.target] else { continue }
                    lines.move(to: a)
                    lines.addLine(to: b)
                }
                context.stroke(lines, with: .color(HubWorkspacePalette.muted.opacity(0.3)), lineWidth: 0.8)
                for item in layout.points {
                    guard let point = points[item.id] else { continue }
                    let base: CGFloat = item.groupID == HubKnowledgeLayout.archiveID ? 3 : 4.6
                    let radius: CGFloat = item.id == focusID ? 7.5 : base * min(1.5, max(0.8, sqrt(zoom)))
                    let dot = CGRect(x: point.x - radius, y: point.y - radius, width: 2 * radius, height: 2 * radius)
                    context.fill(Path(ellipseIn: dot), with: .color(color(item.hue, id: item.groupID)))
                }
                // Labels never overlap: each one claims its space, and a label
                // that would cover another is left out until you zoom further.
                var taken: [CGRect] = []
                for group in visibleGroups {
                    if overview, group.id == HubKnowledgeLayout.unassignedID || height < 120 { continue }
                    if selectDomain != nil && canSelectDomain(group.id) { continue }
                    guard let location = groupLabelPosition(group, points: points, frame: frame) else { continue }
                    var label = context.resolve(Text(group.title).font(.caption.weight(.medium)))
                    label.shading = .color(color(group.hue, id: group.id))
                    let measured = label.measure(in: CGSize(width: 220, height: 40))
                    let box = CGRect(x: location.x - measured.width / 2 - 3, y: location.y - measured.height / 2 - 1,
                                     width: measured.width + 6, height: measured.height + 2)
                    if taken.contains(where: { $0.intersects(box) }) { continue }
                    taken.append(box)
                    context.draw(label, at: location)
                }
                if !overview, zoom >= (fewRecords ? 1 : 2) {
                    let visible = CGRect(origin: .zero, size: size)
                    let ordered = layout.points.sorted { first, second in
                        func rank(_ item: HubKnowledgeLayout.Point) -> Int {
                            item.id == focusID ? 0 : item.groupID == HubKnowledgeLayout.archiveID ? 2 : 1
                        }
                        return rank(first) < rank(second)
                    }
                    for item in ordered {
                        guard let point = points[item.id], let title = byID[item.id]?.title, visible.contains(point) else { continue }
                        let short = title.count > 28 ? String(title.prefix(27)) + "…" : title
                        let label = context.resolve(Text(short).font(.caption2))
                        let measured = label.measure(in: CGSize(width: 180, height: 30))
                        let box = CGRect(x: point.x - measured.width / 2 - 3, y: point.y + 5,
                                         width: measured.width + 6, height: measured.height + 2)
                        if taken.contains(where: { $0.intersects(box) }) { continue }
                        taken.append(box)
                        context.fill(Path(roundedRect: box, cornerRadius: 4), with: .color(HubWorkspacePalette.panel.opacity(0.85)))
                        context.draw(label, at: CGPoint(x: box.midX, y: box.midY))
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
            ForEach(layout.points.filter { focusID != nil || scope == .archive || $0.groupID != HubKnowledgeLayout.archiveID || zoom > 1.8 }, id: \.id) { item in
                if let point = points[item.id], CGRect(origin: .zero, size: size).contains(point) {
                    Button { select(item.id) } label: {
                        Color.clear.frame(width: 20, height: 20).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .position(point)
                    .accessibilityLabel(byID[item.id]?.title ?? "Knowledge record")
                }
            }
            if let selectDomain {
                ForEach(visibleGroups.filter { canSelectDomain($0.id) }, id: \.id) { group in
                    if let location = groupLabelPosition(group, points: points, frame: frame), CGRect(origin: .zero, size: size).contains(location) {
                        Button { selectDomain(group.id) } label: {
                            Text(group.title).font(.caption.weight(.medium)).lineLimit(1)
                                .foregroundStyle(color(group.hue, id: group.id))
                                .padding(.horizontal, 6)
                                .frame(minHeight: 28)
                                .background(HubWorkspacePalette.panel, in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("hub.knowledge.domain.\(group.id)")
                        .position(location)
                    }
                }
            }
            if showsControls { HStack(spacing: 2) {
                // The whole 44-point square is tappable, not only the glyph.
                Button { scale = max(0.5, scale / 1.25) } label: {
                    Image(systemName: "minus").frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .accessibilityLabel("Zoom out")
                Button { scale = 1; offset = .zero } label: {
                    Text("Fit").frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                .accessibilityLabel("Fit graph")
                Button { scale = min(4, scale * 1.25) } label: {
                    Image(systemName: "plus").frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .accessibilityLabel("Zoom in")
                .accessibilityValue("\(Int((min(4, max(0.5, scale)) * 100).rounded()))%")
            }
            .buttonStyle(.plain)
            .font(.caption)
            .foregroundStyle(HubWorkspacePalette.muted)
            .background(HubWorkspacePalette.border.opacity(overview ? 0 : 0.08), in: RoundedRectangle(cornerRadius: 12))
            .padding(4)
            }
        }
        .clipped()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Knowledge graph")
    }

    private func canSelectDomain(_ id: String) -> Bool {
        id == HubKnowledgeLayout.archiveID || graph.domains?.contains(where: { $0.id == id && $0.status != "merged" }) == true
    }

    private func groupLabelPosition(_ group: HubKnowledgeLayout.Group, points: [String: CGPoint], frame: PlaneFrame) -> CGPoint? {
        if group.planeRadius > 0 {
            let center = frame.point(group.planeX, group.planeY)
            let r = CGFloat(group.planeRadius) * frame.scale
            // A domain's name sits on top of its disc; a subdomain's just inside its own.
            return CGPoint(x: center.x, y: group.parentID == nil ? center.y - r - 10 : center.y - r + 9)
        }
        let members = group.members.compactMap { points[$0] }
        guard let top = members.map(\.y).min() else { return nil }
        return CGPoint(x: members.reduce(0) { $0 + $1.x } / CGFloat(members.count), y: top - 19)
    }

    /// Maps the flat layout onto the view, fitting every domain disc and
    /// leaving room for the names above them.
    private struct PlaneFrame {
        let scale: CGFloat
        let centerX: Double
        let centerY: Double
        let origin: CGPoint

        init(layout: HubKnowledgeLayout.Layout, size: CGSize, zoom: CGFloat, offset: CGSize, overview: Bool) {
            var minX = Double.infinity, maxX = -Double.infinity, minY = Double.infinity, maxY = -Double.infinity
            for group in layout.groups where group.parentID == nil && group.planeRadius > 0 {
                minX = min(minX, group.planeX - group.planeRadius); maxX = max(maxX, group.planeX + group.planeRadius)
                minY = min(minY, group.planeY - group.planeRadius); maxY = max(maxY, group.planeY + group.planeRadius)
            }
            for point in layout.points {
                minX = min(minX, point.x - 8); maxX = max(maxX, point.x + 8)
                minY = min(minY, point.y - 8); maxY = max(maxY, point.y + 8)
            }
            if !minX.isFinite { minX = -1; maxX = 1; minY = -1; maxY = 1 }
            let labelRoom: CGFloat = overview ? 12 : 30
            let width = max(1, size.width - 24), height = max(1, size.height - 24 - labelRoom - (overview ? 0 : 44))
            let fit = min(width / CGFloat(max(1, maxX - minX)), height / CGFloat(max(1, maxY - minY)))
            scale = min(fit, overview ? 3 : 2.4) * zoom
            centerX = (minX + maxX) / 2
            centerY = (minY + maxY) / 2
            origin = CGPoint(x: size.width / 2 + offset.width,
                             y: size.height / 2 + labelRoom / 2 - (overview ? 0 : 18) + offset.height)
        }

        func point(_ x: Double, _ y: Double) -> CGPoint {
            CGPoint(x: origin.x + CGFloat(x - centerX) * scale, y: origin.y + CGFloat(y - centerY) * scale)
        }
    }

    private struct LayoutRequest: Equatable {
        let graph: HubHomeKnowledge
        let size: CGSize
        let scope: Scope
    }

    private func color(_ hue: Double, id: String) -> Color { Self.tone(hue, id: id) }

    /// One color per domain, shared by the graph, legends and Home.
    static func tone(_ hue: Double, id: String) -> Color {
        if id == HubKnowledgeLayout.archiveID { return Color(red: 0.54, green: 0.76, blue: 0.84) }
        if id == HubKnowledgeLayout.unassignedID { return Color(red: 0.62, green: 0.65, blue: 0.7) }
        let saturation = 0.53, light = 0.72
        let brightness = light + saturation * min(light, 1 - light)
        return Color(hue: hue, saturation: 2 * (1 - light / brightness), brightness: brightness)
    }
}

/// A compact picture of Knowledge: one bar split by domain, and the largest
/// domains as tappable chips.
struct HubKnowledgeDomainStrip: View {
    let domains: [HubKnowledgeLayout.DomainSummary]
    var limit = 4
    var select: ((String) -> Void)? = nil

    var body: some View {
        let total = max(1, domains.reduce(0) { $0 + $1.count })
        VStack(alignment: .leading, spacing: 10) {
            GeometryReader { geometry in
                HStack(spacing: 2) {
                    ForEach(domains) { domain in
                        Capsule()
                            .fill(HubKnowledgeGraphView.tone(domain.hue, id: domain.id))
                            .frame(width: max(4, (geometry.size.width - CGFloat(domains.count - 1) * 2) * CGFloat(domain.count) / CGFloat(total)))
                    }
                }
            }
            .frame(height: 8)
            .accessibilityHidden(true)
            HubChipRow(items: Array(domains.prefix(limit)), extra: max(0, domains.count - limit)) { domain in
                chip(domain)
            }
        }
    }

    @ViewBuilder private func chip(_ domain: HubKnowledgeLayout.DomainSummary) -> some View {
        let label = HStack(spacing: 6) {
            Circle().fill(HubKnowledgeGraphView.tone(domain.hue, id: domain.id)).frame(width: 8, height: 8)
            Text(domain.title).font(.caption).lineLimit(1)
            Text(domain.count, format: .number).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .frame(minHeight: 30)
        .background(HubWorkspacePalette.border.opacity(0.06), in: Capsule())
        if let select, domain.id != HubKnowledgeLayout.unassignedID {
            Button { select(domain.id) } label: { label }
                .buttonStyle(.plain)
                .accessibilityLabel("\(domain.title), \(domain.count) notes")
                .accessibilityIdentifier("hub.knowledge.chip.\(domain.id)")
        } else {
            label
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(domain.title), \(domain.count) notes")
        }
    }
}

/// Lays chips out in a horizontal scroll row, with a "+N" at the end when
/// some are left out.
struct HubChipRow<Item: Identifiable, Content: View>: View {
    let items: [Item]
    let extra: Int
    @ViewBuilder let content: (Item) -> Content

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(items) { content($0) }
                if extra > 0 {
                    Text("+\(extra)").font(.caption).foregroundStyle(.secondary).padding(.horizontal, 6)
                }
            }
        }
    }
}

@MainActor
struct HubKnowledgeActivityView: View {
    let api: HubConversationAPI
    var openRecord: ((String) -> Void)? = nil
    var openConversation: ((String) -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var entries: [HubKnowledgeActivity.Entry] = []
    @State private var page: HubKnowledgeActivity?
    @State private var failed = false
    @State private var loading = false
    @State private var acting = false
    @State private var actionMessage: String?
    @State private var confirmation: QueueAction?
    @State private var reviewEntry: HubKnowledgeActivity.Entry?

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
                activitySummary(page)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if entries.isEmpty { Text(page.historyNotice).foregroundStyle(.secondary) }
                        ForEach(entries) { entry in
                            activityEntry(entry)
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
        .foregroundStyle(.primary)
        .background(Color(uiColor: HubHomeView.backgroundColor).ignoresSafeArea())
        .sheet(item: $reviewEntry, onDismiss: { Task { await load(0) } }) { entry in
            HubKnowledgeCurationReviewView(api: api, entry: entry)
        }
        .alert(item: $confirmation) { action in
            Alert(title: Text(action.rawValue), message: Text("Knowledge AI uses the configured model and budget."),
                  primaryButton: .default(Text("Continue")) { Task { await run(action) } }, secondaryButton: .cancel())
        }
    }

    private func activitySummary(_ page: HubKnowledgeActivity) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(page.enabled ? stateLabel(page.state) : "Paused")
            if let total = page.total { Text("\(total) saved jobs") }
            Text("Last start: \(activityDate(page.lastStartedAt))")
            Text("Last end: \(activityDate(page.lastFinishedAt))")
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
    }

    /// One entry of the librarian's log: what it was, what the librarian did and why.
    private func activityEntry(_ entry: HubKnowledgeActivity.Entry) -> some View {
        let review = entry.source?.channel == "domain-review"
        let (symbol, tint) = entryIcon(entry, review: review)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Image(systemName: symbol).font(.subheadline).foregroundStyle(tint)
                    .frame(width: 32, height: 32)
                    .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text(headline(entry, review: review)).font(.subheadline.weight(.semibold))
                    Text([sourceLabel(entry, review: review), relativeDate(entry.updatedAt)].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            if let reason = entry.reason, !reason.isEmpty {
                Text(reason).font(.callout).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
            if let error = entry.error, entry.status == "failed" { failure(error).font(.footnote) }
            if !entry.changes.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(entry.changes.indices, id: \.self) { index in
                        changeRow(entry.changes[index])
                    }
                }
                .padding(.leading, 4)
            }
            ForEach(entry.warnings.indices, id: \.self) { index in
                Label(entry.warnings[index], systemImage: "info.circle").font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 14) {
                if let source = entry.source { sourceRow(source).font(.footnote) }
                if entry.status == "review" {
                    Button("Review proposed changes") { reviewEntry = entry }.font(.footnote.weight(.semibold))
                }
            }
            DisclosureGroup("Details") {
                VStack(alignment: .leading, spacing: 3) {
                    Text([stateLabel(entry.status), entry.outcome].compactMap { $0 }.joined(separator: " · "))
                    Text("Started: \(activityDate(entry.startedAt))")
                    Text("Finished: \(activityDate(entry.finishedAt))")
                    if let retryAt = entry.retryAt { Text("Last retry: \(activityDate(retryAt))") }
                    if let count = entry.attempts { Text("\(count) model attempts") }
                    if let attempts = entry.previousAttempts {
                        ForEach(attempts.indices, id: \.self) { index in attemptRow(attempts[index]) }
                    }
                    if let error = entry.error, entry.status != "failed" { failure(error) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(12)
        .background(HubWorkspacePalette.panel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(HubWorkspacePalette.border.opacity(0.06)))
    }

    private func entryIcon(_ entry: HubKnowledgeActivity.Entry, review: Bool) -> (String, Color) {
        switch entry.status {
        case "failed": return ("exclamationmark.triangle.fill", .orange)
        case "review": return ("hand.raised.fill", .yellow)
        case "working", "queued": return ("hourglass", .secondary)
        default:
            if review { return ("books.vertical.fill", HubWorkspacePalette.accent) }
            return entry.outcome == "organized" ? ("tray.and.arrow.down.fill", HubWorkspacePalette.accent) : ("archivebox", .secondary)
        }
    }

    private func headline(_ entry: HubKnowledgeActivity.Entry, review: Bool) -> String {
        switch entry.status {
        case "failed": return String(localized: "Couldn't finish")
        case "review": return String(localized: "Waiting for your approval")
        case "working": return String(localized: "Reading now")
        case "queued": return String(localized: "Waiting to read")
        case "waiting-credit": return String(localized: "Waiting for model credit")
        default:
            if review { return entry.outcome == "organized" ? String(localized: "Tidied the domains") : String(localized: "Checked the domains") }
            switch entry.outcome {
            case "organized": return String(localized: "Filed")
            case "archive-only": return String(localized: "Archived, nothing new to keep")
            case "rejected": return String(localized: "Changes rejected")
            default: return String(localized: "Nothing to keep")
            }
        }
    }

    private func sourceLabel(_ entry: HubKnowledgeActivity.Entry, review: Bool) -> String? {
        if review { return String(localized: "Domain review") }
        switch entry.source?.channel {
        case "web", "native", "pwa", "chat": return String(localized: "From a chat")
        case "telegram": return String(localized: "From Telegram")
        case "voice": return String(localized: "From a voice call")
        case "workers": return String(localized: "From a background task")
        case "note", "notes": return String(localized: "From a note")
        case let channel?: return channel.capitalized
        case nil: return nil
        }
    }

    private func relativeDate(_ value: Double?) -> String? {
        guard let value, value.isFinite, value > 0 else { return nil }
        return Date(timeIntervalSince1970: value / 1000).formatted(.relative(presentation: .named))
    }

    @ViewBuilder private func sourceRow(_ source: HubKnowledgeActivity.Entry.Source) -> some View {
        if let id = source.sessionId, let openConversation {
            Button("Open source conversation") { openConversation(id) }
        } else if let id = source.recordId, let openRecord {
            Button("Read source record") { openRecord(id) }
        }
    }

    private func changeRow(_ change: HubKnowledgeActivity.Entry.Change) -> some View {
        let symbol: String = {
            switch change.kind {
            case "note": return "doc.text"
            case "domain": return "books.vertical"
            case "assignment": return "folder"
            case "link": return "link"
            case "tag": return "tag"
            case "reflection": return "lightbulb"
            default: return "circle.fill"
            }
        }()
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: symbol).font(.caption).foregroundStyle(.secondary).frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                (Text(change.action.capitalized).foregroundColor(.secondary) + Text("  ") + Text(change.title))
                    .font(.footnote)
                if let openRecord {
                    if change.kind == "note", let id = change.id {
                        Button("Open note") { openRecord(id) }.font(.caption)
                    } else if change.kind == "link", let id = change.targetId {
                        Button("Open linked record") { openRecord(id) }.font(.caption)
                    }
                }
            }
        }
    }

    private func attemptRow(_ attempt: HubKnowledgeActivity.Entry.Attempt) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Attempt \(attempt.attempt) · \(stateLabel(attempt.status))")
            Text("\(activityDate(attempt.startedAt)) → \(activityDate(attempt.finishedAt))")
            if let reason = attempt.reason { Text(reason) }
            if let error = attempt.error { failure(error) }
        }
        .padding(.top, 4)
    }

    private func failure(_ error: HubKnowledgeActivity.Entry.Failure) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            if error.phase != nil || error.code != nil {
                Text([error.phase, error.code].compactMap { $0 }.joined(separator: " · ")).font(.caption)
            }
            Text(error.message)
        }
        .foregroundStyle(.red)
    }

    private func activityDate(_ value: Double?) -> String {
        guard let value, value.isFinite, value > 0 else { return String(localized: "Not recorded") }
        return Date(timeIntervalSince1970: value / 1000).formatted()
    }

    private func stateLabel(_ value: String) -> String {
        switch value {
        case "ready", "idle": return String(localized: "Idle")
        case "review": return String(localized: "Awaiting review")
        case "done": return String(localized: "Completed")
        case "waiting-credit": return String(localized: "Waiting for credit or provider limit")
        default: return value.replacingOccurrences(of: "-", with: " ").capitalized
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

@MainActor
private struct HubKnowledgeCurationReviewView: View {
    let api: HubConversationAPI
    let entry: HubKnowledgeActivity.Entry
    @Environment(\.dismiss) private var dismiss
    @State private var review: HubKnowledgeCurationReview?
    @State private var error: String?
    @State private var saving = false
    @State private var attempt = 0

    var body: some View {
        NavigationView {
            HubList {
                if let error {
                    Text(error).foregroundStyle(.secondary)
                    Button("Reload review") { attempt += 1 }
                }
                if let review {
                    Section("Proposed changes") {
                        Text(review.plan.decision.replacingOccurrences(of: "-", with: " ").capitalized).font(.headline)
                        Text(review.plan.reason)
                        if review.stale { Text("Preview refreshed against the current Knowledge registry.").font(.footnote) }
                        if !review.plan.tags.isEmpty { Text(review.plan.tags.joined(separator: ", ")).font(.footnote) }
                        planDetails(review.plan)
                    }
                    Section("Original source") {
                        Text(review.source.content).textSelection(.enabled)
                    }
                    Section {
                        Button("Approve changes") { Task { await decide(review, approve: true) } }
                        Button("Reject changes", role: .destructive) { Task { await decide(review, approve: false) } }
                    }
                } else if error == nil { ProgressView("Loading review…") }
            }
            .disabled(saving)
            .navigationTitle("Review Knowledge changes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() }.disabled(saving) }
            }
        }
        .navigationViewStyle(.stack)
        .interactiveDismissDisabled(saving)
        .task(id: attempt) {
            review = nil
            error = nil
            do { review = try await api.knowledgeCurationReview(entry) }
            catch { if !Task.isCancelled { self.error = "Could not load this review. It may have changed." } }
        }
    }

    private func planDetails(_ plan: HubKnowledgeCurationReview.Plan) -> some View {
        Group {
            details("Domain changes", plan.domainOps) { change in
                let operation = change.operation ?? change
                domainRow(operation, evidence: change.evidence ?? operation.evidence)
            }
            details("Relationships", plan.relations) { relation in
                reviewRow(relation.label, detail: relation.targetId, evidence: relation.evidence)
            }
            details("Reflections", plan.reflections) { reflection in
                reviewRow(reflection.observation, detail: reflection.scope.capitalized, evidence: reflection.evidence)
            }
            details("Profile suggestions", plan.profileSuggestions) { suggestion in
                reviewRow(suggestion.text, detail: suggestion.target == "USER.md" ? "Shared user profile" : "Character profile",
                          evidence: suggestion.evidence)
            }
            details("Memories", plan.memories) { memory in
                reviewRow(memory.title, detail: memory.category.capitalized, evidence: memory.evidence)
            }
        }
    }

    private func domainRow(_ change: HubKnowledgeCurationReview.Plan.DomainChange, evidence: String?) -> some View {
        let identity = [change.id, change.nodeId, change.domainId, change.parentId, change.targetId, change.status]
            .compactMap { $0 }.joined(separator: " → ")
        return VStack(alignment: .leading, spacing: 5) {
            reviewRow(change.type.capitalized, detail: change.title, evidence: evidence)
            if !identity.isEmpty { Text(identity).font(.caption).foregroundStyle(.secondary) }
            if let aliases = change.aliases, !aliases.isEmpty {
                Text("Aliases: \(aliases.joined(separator: ", "))").font(.caption)
            }
            if let groups = change.groups {
                ForEach(groups.indices, id: \.self) { index in
                    Text("\(groups[index].title) · \(groups[index].nodeIds.count) records").font(.caption)
                }
            }
            if change.deactivateSource == true { Text("Deactivate the original domain").font(.caption) }
        }
    }

    @ViewBuilder private func details<Row, Content: View>(_ name: LocalizedStringKey, _ values: [Row]?,
                                                          @ViewBuilder content: @escaping (Row) -> Content) -> some View {
        if let values, !values.isEmpty {
            DisclosureGroup(name) {
                ForEach(values.indices, id: \.self) { index in
                    content(values[index])
                }
            }
        }
    }

    private func reviewRow(_ title: String, detail: String?, evidence: String?) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.subheadline.weight(.semibold))
            if let detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
            if let evidence { Text(evidence).italic().font(.footnote).textSelection(.enabled) }
        }
        .padding(.vertical, 4)
    }

    private func decide(_ review: HubKnowledgeCurationReview, approve: Bool) async {
        guard !saving else { return }
        saving = true
        defer { saving = false }
        do {
            try await api.decideKnowledgeCuration(entry, review: review, approve: approve)
            dismiss()
        } catch {
            self.review = nil
            self.error = "Could not confirm the decision. Reload the review before trying again."
        }
    }
}
