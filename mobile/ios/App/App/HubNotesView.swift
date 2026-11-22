import SwiftUI
import HubNative

/// Notes: the user's own notes, one of HUB's main features next to chat.
/// Everything is shown from the phone's copy at once and synced with HUB in
/// the background, so notes open instantly and work without a connection.
@MainActor
final class HubNotesModel: ObservableObject {
    static let shared = HubNotesModel()

    @Published private(set) var index = HubNotesIndex()
    @Published private(set) var syncState: HubNotesLibrary.SyncState = .idle
    @Published var searchResults: [HubNoteSummary]?
    let library = HubNotesLibrary.standard()
    var api: (() -> HubConversationAPI?) = { nil }
    private var syncTask: Task<Void, Never>?
    private var syncAgain = false

    var connectedAPI: HubConversationAPI? { api() }

    func reload() async {
        guard let library else { return }
        index = await library.index()
    }

    /// Sends local changes and takes HUB's, a moment after the last edit.
    func sync(after delay: Double = 0) {
        if syncTask != nil { syncAgain = true; return }
        syncTask = Task { [weak self] in
            if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            guard let self else { return }
            repeat {
                self.syncAgain = false
                guard let library = self.library, let api = self.api() else {
                    self.syncState = .offline(waiting: await self.library?.pendingCount() ?? 0)
                    break
                }
                self.syncState = .syncing
                self.syncState = await library.sync(api)
                self.index = await library.index()
            } while self.syncAgain
            self.syncTask = nil
        }
    }

    func note(_ id: String) async -> HubNote? {
        if let cached = await library?.cachedNote(id) { return cached }
        guard let api = api(), let note = try? await api.note(id: id) else { return nil }
        await library?.remember(note)
        return note
    }

    func save(id: String, folder: String, body: String, pinned: Bool) async {
        await library?.write(id: id, folder: folder, body: body, pinned: pinned)
        await reload()
        sync(after: 1.5)
    }

    func delete(_ id: String) async {
        await library?.delete(id: id)
        await reload()
        sync()
    }

    func setPinned(_ summary: HubNoteSummary, _ pinned: Bool) async {
        guard let note = await note(summary.id) else { return }
        await save(id: note.id, folder: note.folder, body: note.body, pinned: pinned)
    }

    func move(_ summary: HubNoteSummary, to folder: String) async {
        guard let note = await note(summary.id) else { return }
        await save(id: note.id, folder: folder, body: note.body, pinned: note.pinned)
    }

    func folderAction(_ work: (HubConversationAPI) async throws -> [String]) async -> Bool {
        guard let api = api(), let folders = try? await work(api) else { return false }
        await library?.setFolders(folders)
        await reload()
        sync()
        return true
    }

    func search(_ query: String) async {
        let words = query.trimmingCharacters(in: .whitespaces)
        guard !words.isEmpty else { searchResults = nil; return }
        // The phone's copy answers at once; it holds every note's text.
        let lowered = words.lowercased(with: Locale(identifier: "tr")).split(separator: " ").map(String.init)
        var found: [(HubNoteSummary, Int)] = []
        for summary in index.notes {
            let body = (await library?.cachedNote(summary.id)?.body ?? summary.snippet).lowercased(with: Locale(identifier: "tr"))
            let title = summary.title.lowercased(with: Locale(identifier: "tr"))
            guard lowered.allSatisfy({ body.contains($0) || title.contains($0) || summary.folder.lowercased().contains($0) }) else { continue }
            found.append((summary, lowered.filter { title.contains($0) }.count))
        }
        searchResults = found.sorted { ($0.1, $0.0.updatedAt) > ($1.1, $1.0.updatedAt) }.map(\.0)
    }
}

enum HubNotesFolder: Hashable {
    case all, main, folder(String), deleted

    var title: String {
        switch self {
        case .all: return String(localized: "All Notes")
        case .main: return String(localized: "Notes")
        case .folder(let name): return name
        case .deleted: return String(localized: "Recently Deleted")
        }
    }

    func contains(_ note: HubNoteSummary) -> Bool {
        switch self {
        case .all: return true
        case .main: return note.folder.isEmpty
        case .folder(let name): return note.folder == name
        case .deleted: return false
        }
    }
}

struct HubOpenNote: Identifiable, Hashable {
    let id: String
    let isNew: Bool
}

@MainActor
struct HubNotesView: View {
    @ObservedObject var model: HubNotesModel
    let close: () -> Void
    /// Opens straight into a new note (quick note from a widget or the lock screen).
    var startNew = false
    /// Opens straight into this note (from Home).
    var openID: String? = nil

    @State private var folder: HubNotesFolder = .all
    @State private var query = ""
    @State private var open: HubOpenNote?
    @State private var foldersOpen = false
    @State private var deleted: [HubNoteSummary]?
    @State private var movingNote: HubNoteSummary?
    @State private var startedNew = false
    @AppStorage("hub.notes.gallery") private var gallery = true

    private var shown: [HubNoteSummary] {
        if let results = model.searchResults, !query.trimmingCharacters(in: .whitespaces).isEmpty { return results }
        return model.index.notes.filter { folder.contains($0) }
    }

    var body: some View {
        NavigationView {
            ZStack {
                if folder == .deleted { deletedList } else if gallery { galleryView } else { list }
                NavigationLink(isActive: Binding(get: { open != nil }, set: { if !$0 { open = nil } })) {
                    if let open {
                        HubNoteEditorView(model: model, noteID: open.id, isNew: open.isNew,
                                          folder: { if case .folder(let name) = folder { return name } else { return "" } }())
                    }
                } label: { EmptyView() }
                .hidden()
            }
            .navigationTitle(folder.title)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button { close() } label: { Image(systemName: "xmark").font(.body.weight(.semibold)) }
                        .accessibilityLabel("Close Notes")
                }
                ToolbarItemGroup(placement: .navigationBarTrailing) {
                    Button { foldersOpen = true } label: { Image(systemName: "folder") }
                        .accessibilityLabel("Folders")
                    Menu {
                        Button { gallery = true } label: { Label("View as Gallery", systemImage: "square.grid.2x2") }
                        Button { gallery = false } label: { Label("View as List", systemImage: "list.bullet") }
                    } label: { Image(systemName: gallery ? "square.grid.2x2" : "list.bullet") }
                    .accessibilityLabel("View")
                    Button { newNote() } label: { Image(systemName: "square.and.pencil") }
                        .accessibilityLabel("New note")
                        .accessibilityIdentifier("hub.notes.new")
                }
            }
        }
        .navigationViewStyle(.stack)
        .tint(HubWorkspacePalette.accent)
        .sheet(isPresented: $foldersOpen) { HubNoteFoldersView(model: model, selected: $folder) }
        .sheet(item: $movingNote) { note in
            HubNoteMoveView(folders: model.index.folders, current: note.folder) { target in
                Task { await model.move(note, to: target) }
            }
        }
        .task {
            await model.reload()
            model.sync()
            if !startedNew {
                startedNew = true
                if startNew { newNote() } else if let openID { open = HubOpenNote(id: openID, isNew: false) }
            }
        }
        .onChange(of: folder) { value in
            if value == .deleted { Task { deleted = try? await model.connectedAPI?.deletedNotes() } }
        }
    }

    /// Notes as a gallery of previews, like the iPhone Notes app.
    private var galleryView: some View {
        ScrollView {
            let notes = shown
            let pinned = notes.filter(\.pinned)
            let rest = query.isEmpty ? notes.filter { !$0.pinned } : notes
            let columns = [GridItem(.adaptive(minimum: 150, maximum: 220), spacing: 14)]
            VStack(alignment: .leading, spacing: 18) {
                if !pinned.isEmpty && query.isEmpty {
                    Label("Pinned", systemImage: "pin.fill").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                    LazyVGrid(columns: columns, spacing: 18) { ForEach(pinned) { card($0) } }
                    if !rest.isEmpty { Text("Notes").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary) }
                }
                LazyVGrid(columns: columns, spacing: 18) { ForEach(rest) { card($0) } }
                syncFooter(count: notes.count).font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity)
            }
            .padding(16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .searchable(text: $query, prompt: "Search")
        .onChange(of: query) { value in Task { await model.search(value) } }
        .refreshable { model.sync() }
        .overlay {
            if model.index.notes.isEmpty, query.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "note.text").font(.largeTitle).foregroundStyle(.secondary)
                    Text("No notes yet").font(.headline)
                    Button("New Note") { newNote() }
                }
            }
        }
    }

    private func card(_ note: HubNoteSummary) -> some View {
        Button { open = HubOpenNote(id: note.id, isNew: false) } label: {
            HubNotePreviewCard(summary: note, model: model, showFolder: folder == .all)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("hub.notes.card.\(note.id)")
        .contextMenu {
            Button { Task { await model.setPinned(note, !note.pinned) } } label: { Label(note.pinned ? "Unpin Note" : "Pin Note", systemImage: "pin") }
            Button { movingNote = note } label: { Label("Move", systemImage: "folder") }
            Button(role: .destructive) { Task { await model.delete(note.id) } } label: { Label("Delete", systemImage: "trash") }
        }
    }

    private var list: some View {
        List {
            let notes = shown
            let pinned = notes.filter(\.pinned)
            if !pinned.isEmpty && query.isEmpty {
                Section { ForEach(pinned) { row($0) } } header: { Label("Pinned", systemImage: "pin.fill") }
            }
            Section {
                ForEach(query.isEmpty ? notes.filter { !$0.pinned } : notes) { row($0) }
            } header: {
                if !pinned.isEmpty && query.isEmpty { Text("Notes") }
            } footer: {
                syncFooter(count: notes.count)
            }
        }
        .listStyle(.insetGrouped)
        .searchable(text: $query, prompt: "Search")
        .onChange(of: query) { value in Task { await model.search(value) } }
        .refreshable { model.sync() }
        .overlay {
            if model.index.notes.isEmpty, query.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "note.text").font(.largeTitle).foregroundStyle(.secondary)
                    Text("No notes yet").font(.headline)
                    Button("New Note") { newNote() }
                }
            }
        }
    }

    private func row(_ note: HubNoteSummary) -> some View {
        Button { open = HubOpenNote(id: note.id, isNew: false) } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(note.title).font(.headline).lineLimit(1).foregroundStyle(Color.primary)
                HStack(spacing: 6) {
                    Text(Self.when(note.updatedAt)).foregroundStyle(Color.primary.opacity(0.8))
                    if note.checklist.total > 0 {
                        Label("\(note.checklist.done)/\(note.checklist.total)", systemImage: "checklist").labelStyle(.titleAndIcon)
                    }
                    Text(note.snippet.isEmpty ? String(localized: "No additional text") : note.snippet).lineLimit(1)
                }
                .font(.subheadline).foregroundStyle(.secondary)
                if folder == .all, !note.folder.isEmpty {
                    Label(note.folder, systemImage: "folder").font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 2)
        }
        .accessibilityIdentifier("hub.notes.row.\(note.id)")
        .swipeActions(edge: .leading) {
            Button { Task { await model.setPinned(note, !note.pinned) } } label: {
                Label(note.pinned ? "Unpin" : "Pin", systemImage: note.pinned ? "pin.slash.fill" : "pin.fill")
            }
            .tint(.orange)
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) { Task { await model.delete(note.id) } } label: { Label("Delete", systemImage: "trash") }
            Button { movingNote = note } label: { Label("Move", systemImage: "folder") }.tint(.indigo)
        }
        .contextMenu {
            Button { Task { await model.setPinned(note, !note.pinned) } } label: { Label(note.pinned ? "Unpin Note" : "Pin Note", systemImage: "pin") }
            Button { movingNote = note } label: { Label("Move", systemImage: "folder") }
            Button(role: .destructive) { Task { await model.delete(note.id) } } label: { Label("Delete", systemImage: "trash") }
        }
    }

    @ViewBuilder private func syncFooter(count: Int) -> some View {
        switch model.syncState {
        case .syncing: Text("\(count) notes · Syncing…")
        case .offline(let waiting) where waiting > 0: Text("\(count) notes · \(waiting) waiting for HUB")
        case .offline: Text("\(count) notes · HUB is not reachable; you can keep writing")
        default: Text("\(count) notes")
        }
    }

    private var deletedList: some View {
        List {
            Section {
                ForEach(deleted ?? []) { note in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(note.title).font(.headline)
                        Text(note.snippet).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                    }
                    .swipeActions {
                        Button {
                            Task {
                                if let restored = try? await model.connectedAPI?.restoreNote(id: note.id) {
                                    await model.library?.remember(restored)
                                    await model.reload()
                                    deleted?.removeAll { $0.id == note.id }
                                }
                            }
                        } label: { Label("Recover", systemImage: "arrow.uturn.backward") }.tint(.green)
                    }
                }
            } footer: {
                Text(deleted == nil ? "Connect to HUB to see deleted notes." : "Notes are kept here for 30 days. Swipe to recover one.")
            }
        }
        .listStyle(.insetGrouped)
    }

    private func newNote() {
        open = HubOpenNote(id: UUID().uuidString.lowercased(), isNew: true)
    }

    static func when(_ ms: Double) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        if Calendar.current.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
        if Calendar.current.isDateInYesterday(date) { return String(localized: "Yesterday") }
        if let days = Calendar.current.dateComponents([.day], from: date, to: Date()).day, days < 7 { return date.formatted(.dateTime.weekday(.wide)) }
        return date.formatted(date: .numeric, time: .omitted)
    }
}

@MainActor
struct HubNoteFoldersView: View {
    @ObservedObject var model: HubNotesModel
    @Binding var selected: HubNotesFolder
    @Environment(\.dismiss) private var dismiss
    @State private var naming: (from: String?, text: String)?
    @State private var failed = false

    var body: some View {
        NavigationView {
            List {
                Section {
                    folderRow(.all, icon: "tray.full", count: model.index.notes.count)
                    folderRow(.main, icon: "note.text", count: model.index.notes.filter { $0.folder.isEmpty }.count)
                    ForEach(model.index.folders, id: \.self) { name in
                        folderRow(.folder(name), icon: "folder", count: model.index.notes.filter { $0.folder == name }.count)
                            .contextMenu {
                                Button { naming = (name, name) } label: { Label("Rename", systemImage: "pencil") }
                                Button(role: .destructive) {
                                    Task { failed = !(await model.folderAction { try await $0.deleteNoteFolder(name) }) }
                                } label: { Label("Delete Folder (notes move to Notes)", systemImage: "trash") }
                            }
                    }
                    folderRow(.deleted, icon: "trash", count: nil)
                } footer: {
                    if failed { Text("HUB is not reachable. Folders change when it is connected.") }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Folders")
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button { naming = (nil, "") } label: { Label("New Folder", systemImage: "folder.badge.plus") }
                }
                ToolbarItem(placement: .navigationBarTrailing) { Button("Done") { dismiss() } }
            }
            .alert(naming?.from == nil ? "New Folder" : "Rename Folder", isPresented: Binding(get: { naming != nil }, set: { if !$0 { naming = nil } })) {
                TextField("Name", text: Binding(get: { naming?.text ?? "" }, set: { naming?.text = $0 }))
                Button("Cancel", role: .cancel) { naming = nil }
                Button("Save") {
                    guard let value = naming else { return }
                    naming = nil
                    Task {
                        let name = value.text.trimmingCharacters(in: .whitespaces)
                        guard !name.isEmpty else { return }
                        if let from = value.from {
                            failed = !(await model.folderAction { try await $0.renameNoteFolder(from, to: name) })
                            if selected == .folder(from) { selected = .folder(name) }
                        } else {
                            failed = !(await model.folderAction { try await $0.createNoteFolder(name) })
                        }
                    }
                }
            }
        }
        .navigationViewStyle(.stack)
    }

    private func folderRow(_ folder: HubNotesFolder, icon: String, count: Int?) -> some View {
        Button { selected = folder; dismiss() } label: {
            HStack {
                Label(folder.title, systemImage: icon).foregroundStyle(Color.primary)
                Spacer()
                if let count { Text("\(count)").foregroundStyle(.secondary) }
                if selected == folder { Image(systemName: "checkmark").foregroundStyle(HubWorkspacePalette.accent) }
            }
        }
    }
}

struct HubNoteMoveView: View {
    let folders: [String]
    let current: String
    let move: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationView {
            List {
                ForEach([""] + folders, id: \.self) { name in
                    Button {
                        move(name)
                        dismiss()
                    } label: {
                        HStack {
                            Label(name.isEmpty ? String(localized: "Notes") : name, systemImage: name.isEmpty ? "note.text" : "folder")
                            Spacer()
                            if name == current { Image(systemName: "checkmark") }
                        }
                    }
                }
            }
            .navigationTitle("Move to Folder")
            .toolbar { ToolbarItem(placement: .navigationBarTrailing) { Button("Cancel") { dismiss() } } }
        }
        .navigationViewStyle(.stack)
    }
}

@MainActor
struct HubNoteHistoryView: View {
    let api: HubConversationAPI?
    let noteID: String
    let restore: (HubNoteSaveResult) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var versions: [HubNoteVersion]?
    @State private var failed = false

    var body: some View {
        NavigationView {
            List {
                if let versions, versions.isEmpty { Text("No earlier versions yet.").foregroundStyle(.secondary) }
                ForEach(versions ?? []) { version in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(Date(timeIntervalSince1970: version.at / 1000).formatted(date: .abbreviated, time: .shortened)).font(.headline)
                        Text(version.body).font(.footnote).foregroundStyle(.secondary).lineLimit(6)
                        Button("Restore This Version") {
                            Task {
                                if let result = try? await api?.restoreNoteVersion(id: noteID, at: version.at) { restore(result); dismiss() }
                                else { failed = true }
                            }
                        }
                        .font(.subheadline.weight(.semibold))
                    }
                    .padding(.vertical, 4)
                }
                if failed { Text("HUB is not reachable right now.").foregroundStyle(.red) }
            }
            .navigationTitle("Version History")
            .toolbar { ToolbarItem(placement: .navigationBarTrailing) { Button("Done") { dismiss() } } }
            .task {
                do { versions = try await api?.noteHistory(id: noteID) ?? [] } catch { failed = true; versions = [] }
            }
        }
        .navigationViewStyle(.stack)
    }
}

/// One note in the gallery: a small rendering of its first lines (headings,
/// to-dos, lists), its first picture as a cover, then the title and date.
@MainActor
struct HubNotePreviewCard: View {
    let summary: HubNoteSummary
    @ObservedObject var model: HubNotesModel
    var showFolder = false
    @State private var lines: [HubNoteLine] = []
    @State private var cover: UIImage?

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            VStack(alignment: .leading, spacing: 3) {
                if let cover {
                    Image(uiImage: cover).resizable().scaledToFill()
                        .frame(maxWidth: .infinity).frame(height: 78).clipped()
                        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                        .padding(.bottom, 3)
                }
                ForEach(Array(lines.prefix(cover == nil ? 13 : 7).enumerated()), id: \.offset) { _, line in preview(line) }
                Spacer(minLength: 0)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .frame(height: 190)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.primary.opacity(0.08)))
            .overlay(alignment: .topTrailing) {
                if summary.pinned { Image(systemName: "pin.fill").font(.caption2).foregroundStyle(.orange).padding(8) }
            }
            Text(summary.title).font(.subheadline.weight(.semibold)).lineLimit(1)
            HStack(spacing: 4) {
                Text(HubNotesView.when(summary.updatedAt))
                if showFolder, !summary.folder.isEmpty { Text("· " + summary.folder).lineLimit(1) }
            }
            .font(.caption).foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
        .task(id: summary.version + String(summary.updatedAt)) { await load() }
    }

    @ViewBuilder private func preview(_ line: HubNoteLine) -> some View {
        let text = HubNoteInline.plain(line.text)
        let pad = CGFloat(line.indent) * 8
        switch line.kind {
        case .title: Text(text).font(.system(size: 12, weight: .bold)).lineLimit(1)
        case .heading: Text(text).font(.system(size: 10.5, weight: .bold)).lineLimit(1)
        case .subheading: Text(text).font(.system(size: 9.5, weight: .semibold)).lineLimit(1)
        case .checklist:
            HStack(spacing: 4) {
                Image(systemName: line.checked ? "checkmark.circle.fill" : "circle").font(.system(size: 8))
                    .foregroundStyle(line.checked ? HubWorkspacePalette.accent : Color.secondary)
                Text(text).font(.system(size: 9)).strikethrough(line.checked).foregroundStyle(line.checked ? .secondary : .primary).lineLimit(1)
            }
            .padding(.leading, pad)
        case .bullet, .dashed, .numbered:
            Text((line.kind == .dashed ? "– " : line.kind == .numbered ? "· " : "• ") + text).font(.system(size: 9)).lineLimit(1).padding(.leading, pad)
        case .quote: Text(text).font(.system(size: 9).italic()).foregroundStyle(.secondary).lineLimit(1)
        case .monospaced: Text(text).font(.system(size: 8.5, design: .monospaced)).lineLimit(1)
        case .body:
            if line.object?.hasPrefix("|") == true {
                Label("Table", systemImage: "tablecells").font(.system(size: 9)).foregroundStyle(.secondary)
            } else if line.object == nil {
                Text(text.isEmpty ? " " : text).font(.system(size: 9)).foregroundStyle(Color.primary.opacity(0.85)).lineLimit(2)
            }
        }
    }

    private func load() async {
        let body = await model.library?.cachedNote(summary.id)?.body ?? summary.snippet
        var parsed = HubNoteMarkdown.parse(body)
        // The first line is the title: shown bold even when written as body text.
        if let first = parsed.firstIndex(where: { $0.object == nil && !$0.text.trimmingCharacters(in: .whitespaces).isEmpty }),
           parsed[first].kind == .body { parsed[first].kind = .title }
        lines = parsed.filter { !($0.object?.hasPrefix("![") ?? false) }
        if let picture = parsed.compactMap({ $0.object.flatMap(HubNoteMarkdown.image) }).first,
           let data = await model.library?.attachment(picture.path, api: model.api()),
           let image = UIImage(data: data) {
            cover = image.preparingThumbnail(of: CGSize(width: 440, height: 240)) ?? image
        }
    }
}
