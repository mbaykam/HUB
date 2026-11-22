import Foundation

// MARK: - Notes on HUB (the user's Apple Notes replacement)

public struct HubNoteChecklist: Codable, Equatable, Sendable {
    public var done: Int
    public var total: Int
    public init(done: Int = 0, total: Int = 0) { self.done = done; self.total = total }
}

public struct HubNoteSummary: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var folder: String
    public var title: String
    public var snippet: String
    public var pinned: Bool
    public var createdAt: Double
    public var updatedAt: Double
    public var version: String
    public var checklist: HubNoteChecklist
    public var attachments: Int
    public var deletedAt: Double?
}

public struct HubNote: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var folder: String
    public var title: String
    public var snippet: String
    public var pinned: Bool
    public var createdAt: Double
    public var updatedAt: Double
    public var version: String
    public var checklist: HubNoteChecklist
    public var attachments: Int
    public var body: String

    public var summary: HubNoteSummary {
        HubNoteSummary(id: id, folder: folder, title: title, snippet: snippet, pinned: pinned, createdAt: createdAt,
                       updatedAt: updatedAt, version: version, checklist: checklist, attachments: attachments, deletedAt: nil)
    }
}

public struct HubNotesIndex: Codable, Equatable, Sendable {
    public var notes: [HubNoteSummary]
    public var folders: [String]
    public init(notes: [HubNoteSummary] = [], folders: [String] = []) { self.notes = notes; self.folders = folders }
}

public struct HubNoteSaveResult: Codable, Equatable, Sendable {
    public let note: HubNote
    public let conflict: HubNote?
}

public struct HubNoteVersion: Codable, Equatable, Identifiable, Sendable {
    public let at: Double
    public let title: String
    public let snippet: String
    public let body: String
    public var id: Double { at }
}

extension HubConversationAPI {
    private static let notesHeaders = ["x-hub-notes": "1"]

    private func notesPost<T: Decodable>(_ value: [String: Any], as type: T.Type) async throws -> T {
        let data = try await requestData("api/hub/notes", headers: Self.notesHeaders,
                                         body: JSONSerialization.data(withJSONObject: value), maxBytes: 8_000_000)
        return try JSONDecoder().decode(T.self, from: data)
    }

    public func notesIndex() async throws -> HubNotesIndex {
        let data = try await requestData("api/hub/notes", headers: Self.notesHeaders, maxBytes: 16_000_000)
        return try JSONDecoder().decode(HubNotesIndex.self, from: data)
    }

    public func note(id: String) async throws -> HubNote {
        struct Box: Decodable { let note: HubNote }
        let data = try await requestData("api/hub/notes", headers: Self.notesHeaders, query: [URLQueryItem(name: "id", value: id)], maxBytes: 8_000_000)
        return try JSONDecoder().decode(Box.self, from: data).note
    }

    public func searchNotes(_ query: String) async throws -> [HubNoteSummary] {
        struct Box: Decodable { let notes: [HubNoteSummary] }
        let data = try await requestData("api/hub/notes", headers: Self.notesHeaders, query: [URLQueryItem(name: "q", value: query)], maxBytes: 8_000_000)
        return try JSONDecoder().decode(Box.self, from: data).notes
    }

    public func saveNote(id: String?, folder: String?, body: String, pinned: Bool?, baseVersion: String?) async throws -> HubNoteSaveResult {
        var value: [String: Any] = ["action": "save", "body": body]
        if let id { value["id"] = id }
        if let folder { value["folder"] = folder }
        if let pinned { value["pinned"] = pinned }
        if let baseVersion { value["baseVersion"] = baseVersion }
        return try await notesPost(value, as: HubNoteSaveResult.self)
    }

    public func deleteNote(id: String) async throws {
        struct Ok: Decodable { let ok: Bool }
        _ = try await notesPost(["action": "delete", "id": id], as: Ok.self)
    }

    public func deletedNotes() async throws -> [HubNoteSummary] {
        struct Box: Decodable { let notes: [HubNoteSummary] }
        let data = try await requestData("api/hub/notes", headers: Self.notesHeaders, query: [URLQueryItem(name: "view", value: "deleted")], maxBytes: 8_000_000)
        return try JSONDecoder().decode(Box.self, from: data).notes
    }

    public func restoreNote(id: String) async throws -> HubNote {
        struct Box: Decodable { let note: HubNote }
        return try await notesPost(["action": "restore", "id": id], as: Box.self).note
    }

    public func noteHistory(id: String) async throws -> [HubNoteVersion] {
        struct Box: Decodable { let versions: [HubNoteVersion] }
        let data = try await requestData("api/hub/notes", headers: Self.notesHeaders, query: [URLQueryItem(name: "history", value: id)], maxBytes: 16_000_000)
        return try JSONDecoder().decode(Box.self, from: data).versions
    }

    public func restoreNoteVersion(id: String, at: Double) async throws -> HubNoteSaveResult {
        try await notesPost(["action": "restore-version", "id": id, "at": at], as: HubNoteSaveResult.self)
    }

    public func createNoteFolder(_ name: String) async throws -> [String] {
        struct Box: Decodable { let folders: [String] }
        return try await notesPost(["action": "folder-create", "name": name], as: Box.self).folders
    }

    public func renameNoteFolder(_ from: String, to: String) async throws -> [String] {
        struct Box: Decodable { let folders: [String] }
        return try await notesPost(["action": "folder-rename", "from": from, "to": to], as: Box.self).folders
    }

    public func deleteNoteFolder(_ name: String) async throws -> [String] {
        struct Box: Decodable { let folders: [String] }
        return try await notesPost(["action": "folder-delete", "name": name], as: Box.self).folders
    }

    /// Uploads a picture, scan page, drawing or recording; returns its
    /// Markdown path (attachments/<name>).
    public func uploadNoteAttachment(_ data: Data, fileExtension: String) async throws -> String {
        struct Box: Decodable { let name: String; let path: String }
        let response = try await requestData("api/hub/notes/attachment", headers: ["x-hub-notes": "1", "x-hub-note-ext": fileExtension],
                                             body: data, maxBytes: 65_536, operationTimeout: 120,
                                             contentType: "application/octet-stream")
        return try JSONDecoder().decode(Box.self, from: response).path
    }

    public func noteAttachment(name: String) async throws -> Data {
        try await requestData("api/hub/notes/attachment", headers: Self.notesHeaders, query: [URLQueryItem(name: "name", value: name)],
                              mediaTypes: ["image/png", "image/jpeg", "image/heic", "application/pdf", "application/octet-stream"],
                              maxBytes: 45_000_000, operationTimeout: 120)
    }
}

// MARK: - The phone's own copy

/// Notes live on the phone first: they open instantly and can be written with
/// no connection. Changes wait here until HUB is reachable, then sync. An
/// edit made against an older version never overwrites: HUB keeps both.
public actor HubNotesLibrary {
    public struct Pending: Codable, Equatable, Sendable {
        public var folder: String
        public var body: String
        public var pinned: Bool
        public var baseVersion: String?
        public var deleted: Bool
        public var changedAt: Double
    }

    struct State: Codable {
        var index = HubNotesIndex()
        var bodies: [String: HubNote] = [:]
        var pending: [String: Pending] = [:]
        var syncedAt: Double?
        /// Attachments made on the phone that HUB has not received yet.
        var uploads: [String] = []

        init() {}
        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            index = try values.decodeIfPresent(HubNotesIndex.self, forKey: .index) ?? HubNotesIndex()
            bodies = try values.decodeIfPresent([String: HubNote].self, forKey: .bodies) ?? [:]
            pending = try values.decodeIfPresent([String: Pending].self, forKey: .pending) ?? [:]
            syncedAt = try values.decodeIfPresent(Double.self, forKey: .syncedAt)
            uploads = try values.decodeIfPresent([String].self, forKey: .uploads) ?? []
        }
    }

    public enum SyncState: Equatable, Sendable { case idle, syncing, synced(Date), offline(waiting: Int) }

    private let directory: URL
    private var state = State()
    private var loaded = false
    public private(set) var syncState: SyncState = .idle

    public init(directory: URL) { self.directory = directory }

    public static func standard() -> HubNotesLibrary? {
        guard let base = try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true) else { return nil }
        return HubNotesLibrary(directory: base.appendingPathComponent("HubNotes", isDirectory: true))
    }

    private var file: URL { directory.appendingPathComponent("library.json") }
    public var attachmentsDirectory: URL { directory.appendingPathComponent("attachments", isDirectory: true) }

    private func load() {
        guard !loaded else { return }
        loaded = true
        if let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode(State.self, from: data) { state = saved }
    }

    private func persist() {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(state) { try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]) }
    }

    /// Every note to show, including ones written here and not yet synced.
    public func index() -> HubNotesIndex {
        load()
        var notes = state.index.notes.filter { state.pending[$0.id]?.deleted != true }
        for (id, change) in state.pending where !change.deleted {
            let summary = Self.summary(id: id, change: change, existing: notes.first { $0.id == id })
            notes.removeAll { $0.id == id }
            notes.append(summary)
        }
        notes.sort { ($0.pinned ? 1 : 0, $0.updatedAt) > ($1.pinned ? 1 : 0, $1.updatedAt) }
        return HubNotesIndex(notes: notes, folders: state.index.folders)
    }

    public func pendingCount() -> Int { load(); return state.pending.count }

    public func cachedNote(_ id: String) -> HubNote? {
        load()
        if let change = state.pending[id], !change.deleted {
            let base = state.bodies[id]
            let summary = Self.summary(id: id, change: change, existing: base?.summary)
            return HubNote(id: id, folder: change.folder, title: summary.title, snippet: summary.snippet, pinned: change.pinned,
                           createdAt: base?.createdAt ?? change.changedAt, updatedAt: change.changedAt, version: base?.version ?? "",
                           checklist: summary.checklist, attachments: summary.attachments, body: change.body)
        }
        return state.bodies[id]
    }

    static func summary(id: String, change: Pending, existing: HubNoteSummary?) -> HubNoteSummary {
        let lines = HubNoteMarkdown.parse(change.body)
        let checks = lines.filter { $0.kind == .checklist }
        return HubNoteSummary(id: id, folder: change.folder, title: HubNoteMarkdown.title(change.body), snippet: HubNoteMarkdown.snippet(change.body),
                              pinned: change.pinned, createdAt: existing?.createdAt ?? change.changedAt, updatedAt: change.changedAt,
                              version: existing?.version ?? "", checklist: HubNoteChecklist(done: checks.filter(\.checked).count, total: checks.count),
                              attachments: lines.filter { $0.object?.hasPrefix("![") == true }.count, deletedAt: nil)
    }

    /// Records a change on the phone right away; sync sends it later.
    public func write(id: String, folder: String, body: String, pinned: Bool) {
        load()
        let base = state.pending[id]?.baseVersion ?? state.bodies[id]?.version ?? state.index.notes.first { $0.id == id }?.version
        state.pending[id] = Pending(folder: folder, body: body, pinned: pinned, baseVersion: base?.isEmpty == true ? nil : base,
                                    deleted: false, changedAt: Date().timeIntervalSince1970 * 1000)
        persist()
    }

    public func delete(id: String) {
        load()
        let known = state.bodies[id] != nil || state.index.notes.contains { $0.id == id }
        if known {
            var change = state.pending[id] ?? Pending(folder: "", body: "", pinned: false, baseVersion: nil, deleted: true, changedAt: 0)
            change.deleted = true
            change.changedAt = Date().timeIntervalSince1970 * 1000
            state.pending[id] = change
        } else {
            state.pending[id] = nil
        }
        persist()
    }

    /// Takes a fresh copy from HUB without sending anything (used after HUB
    /// itself changed a note, for example a restore).
    public func remember(_ note: HubNote) {
        load()
        state.bodies[note.id] = note
        state.index.notes.removeAll { $0.id == note.id }
        state.index.notes.append(note.summary)
        persist()
    }

    public func setFolders(_ folders: [String]) { load(); state.index.folders = folders; persist() }

    /// Sends what changed here, then takes what changed on HUB.
    @discardableResult
    public func sync(_ api: HubConversationAPI) async -> SyncState {
        load()
        syncState = .syncing
        do {
            for name in state.uploads {
                if let data = try? Data(contentsOf: attachmentsDirectory.appendingPathComponent(name)) {
                    _ = try await api.uploadNoteAttachment(data, fileExtension: (name as NSString).pathExtension)
                }
                state.uploads.removeAll { $0 == name }
                persist()
            }
            for (id, change) in state.pending.sorted(by: { $0.value.changedAt < $1.value.changedAt }) {
                if change.deleted {
                    if state.bodies[id] != nil || state.index.notes.contains(where: { $0.id == id }) { try await api.deleteNote(id: id) }
                    state.bodies[id] = nil
                    state.index.notes.removeAll { $0.id == id }
                } else {
                    let result = try await api.saveNote(id: id, folder: change.folder, body: change.body, pinned: change.pinned, baseVersion: change.baseVersion)
                    state.bodies[result.note.id] = result.note
                    if let copy = result.conflict { state.bodies[copy.id] = copy }
                }
                // Only drop the change if nothing newer was written meanwhile.
                if state.pending[id]?.changedAt == change.changedAt { state.pending[id] = nil }
                persist()
            }
            let fresh = try await api.notesIndex()
            for summary in fresh.notes where state.bodies[summary.id]?.version != summary.version && state.pending[summary.id] == nil {
                state.bodies[summary.id] = try await api.note(id: summary.id)
            }
            let ids = Set(fresh.notes.map(\.id))
            state.bodies = state.bodies.filter { ids.contains($0.key) || state.pending[$0.key] != nil }
            state.index = fresh
            state.syncedAt = Date().timeIntervalSince1970 * 1000
            persist()
            syncState = state.pending.isEmpty ? .synced(Date()) : .offline(waiting: state.pending.count)
        } catch {
            persist()
            syncState = .offline(waiting: state.pending.count)
        }
        return syncState
    }

    /// A picture or other attachment, from the phone's copy or from HUB.
    public func attachment(_ path: String, api: HubConversationAPI?) async -> Data? {
        let name = (path as NSString).lastPathComponent
        guard name.range(of: #"^[a-f0-9]{64}\.[a-z0-9]{2,8}$"#, options: .regularExpression) != nil else { return nil }
        let local = attachmentsDirectory.appendingPathComponent(name)
        if let data = try? Data(contentsOf: local) { return data }
        guard let api, let data = try? await api.noteAttachment(name: name) else { return nil }
        try? FileManager.default.createDirectory(at: attachmentsDirectory, withIntermediateDirectories: true)
        try? data.write(to: local, options: .atomic)
        return data
    }

    /// Keeps an attachment the phone just made: it shows at once and is sent
    /// to HUB with the next sync.
    public func keepAttachment(_ data: Data, path: String) {
        load()
        let name = (path as NSString).lastPathComponent
        try? FileManager.default.createDirectory(at: attachmentsDirectory, withIntermediateDirectories: true)
        try? data.write(to: attachmentsDirectory.appendingPathComponent(name), options: .atomic)
        if !state.uploads.contains(name) { state.uploads.append(name); persist() }
    }

    /// The Markdown path a phone-made attachment will have on HUB (HUB names
    /// files by their SHA-256, so both sides agree before upload).
    public static func attachmentPath(sha256 hex: String, fileExtension: String) -> String {
        "attachments/\(hex).\(fileExtension)"
    }
}

// MARK: - Markdown, line by line

public enum HubNoteLineKind: String, Codable, Sendable { case body, title, heading, subheading, bullet, dashed, numbered, checklist, quote, monospaced }

/// One line of a note as the editor shows it. Pictures, scans, drawings and
/// tables are whole-line objects that keep their Markdown in `object`.
public struct HubNoteLine: Equatable, Sendable {
    public var kind: HubNoteLineKind
    public var indent: Int
    public var checked: Bool
    public var text: String
    public var object: String?

    public init(kind: HubNoteLineKind = .body, indent: Int = 0, checked: Bool = false, text: String = "", object: String? = nil) {
        self.kind = kind; self.indent = indent; self.checked = checked; self.text = text; self.object = object
    }
}

public enum HubNoteMarkdown {
    private static func match(_ line: String, _ pattern: String) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let found = regex.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) else { return nil }
        return (0..<found.numberOfRanges).map { index in
            Range(found.range(at: index), in: line).map { String(line[$0]) } ?? ""
        }
    }

    public static func parse(_ markdown: String) -> [HubNoteLine] {
        var lines: [HubNoteLine] = []
        var table: [String] = []
        var code: [String]? = nil
        func flushTable() { if !table.isEmpty { lines.append(HubNoteLine(object: table.joined(separator: "\n"))); table = [] } }
        for raw in markdown.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
            if code != nil {
                if raw.trimmingCharacters(in: .whitespaces).hasPrefix("```") { lines.append(contentsOf: code!.map { HubNoteLine(kind: .monospaced, text: $0) }); code = nil }
                else { code!.append(raw) }
                continue
            }
            if raw.trimmingCharacters(in: .whitespaces).hasPrefix("```") { flushTable(); code = []; continue }
            if raw.trimmingCharacters(in: .whitespaces).hasPrefix("|") { table.append(raw.trimmingCharacters(in: .whitespaces)); continue }
            flushTable()
            let indent = raw.prefix(while: { $0 == " " }).count / 2
            let line = raw.trimmingCharacters(in: .whitespaces)
            if match(line, #"^!\[[^\]]*\]\([^)]+\)$"#) != nil { lines.append(HubNoteLine(object: line)); continue }
            if let m = match(line, #"^[-*+]\s+\[([ xX])\]\s?(.*)$"#) { lines.append(HubNoteLine(kind: .checklist, indent: indent, checked: m[1] != " ", text: m[2])); continue }
            if let m = match(line, #"^(#{1,3})\s+(.*)$"#) { lines.append(HubNoteLine(kind: m[1].count == 1 ? .title : m[1].count == 2 ? .heading : .subheading, text: m[2])); continue }
            if let m = match(line, #"^-\s+(.*)$"#) { lines.append(HubNoteLine(kind: .dashed, indent: indent, text: m[1])); continue }
            if let m = match(line, #"^[*+]\s+(.*)$"#) { lines.append(HubNoteLine(kind: .bullet, indent: indent, text: m[1])); continue }
            if let m = match(line, #"^\d+[.)]\s+(.*)$"#) { lines.append(HubNoteLine(kind: .numbered, indent: indent, text: m[1])); continue }
            if let m = match(line, #"^>\s?(.*)$"#) { lines.append(HubNoteLine(kind: .quote, text: m[1])); continue }
            lines.append(HubNoteLine(text: raw))
        }
        if let code { lines.append(contentsOf: code.map { HubNoteLine(kind: .monospaced, text: $0) }) }
        flushTable()
        return lines
    }

    public static func render(_ lines: [HubNoteLine]) -> String {
        var out: [String] = []
        var numbers: [Int: Int] = [:]
        var index = 0
        while index < lines.count {
            let line = lines[index]
            if line.kind != .numbered { numbers = numbers.filter { $0.key < line.indent } }
            let pad = String(repeating: "  ", count: max(0, line.indent))
            if let object = line.object { out.append(object); index += 1; continue }
            switch line.kind {
            case .body: out.append(line.text)
            case .title: out.append("# " + line.text)
            case .heading: out.append("## " + line.text)
            case .subheading: out.append("### " + line.text)
            case .bullet: out.append(pad + "* " + line.text)
            case .dashed: out.append(pad + "- " + line.text)
            case .numbered:
                numbers = numbers.filter { $0.key <= line.indent }
                let number = (numbers[line.indent] ?? 0) + 1
                numbers[line.indent] = number
                out.append(pad + "\(number). " + line.text)
            case .checklist: out.append(pad + (line.checked ? "- [x] " : "- [ ] ") + line.text)
            case .quote: out.append("> " + line.text)
            case .monospaced:
                var block: [String] = []
                while index < lines.count, lines[index].kind == .monospaced, lines[index].object == nil { block.append(lines[index].text); index += 1 }
                out.append("```"); out.append(contentsOf: block); out.append("```")
                continue
            }
            index += 1
        }
        return out.joined(separator: "\n")
    }

    /// The note's name: its first line that says something.
    public static func title(_ markdown: String) -> String {
        for line in parse(markdown) where line.object == nil {
            let text = HubNoteInline.plain(line.text).trimmingCharacters(in: .whitespaces)
            if !text.isEmpty { return String(text.prefix(120)) }
        }
        return "New Note"
    }

    public static func snippet(_ markdown: String) -> String {
        let texts = parse(markdown).filter { $0.object == nil }.map { HubNoteInline.plain($0.text).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return String(texts.dropFirst().joined(separator: " ").prefix(160))
    }

    /// A Markdown table as rows of cells (the separator row left out).
    public static func tableRows(_ markdown: String) -> [[String]] {
        markdown.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.hasPrefix("|") && $0.range(of: #"^\|(\s*:?-{2,}:?\s*\|)+\s*$"#, options: .regularExpression) == nil }
            .map { row in
                // Split on | but not on an escaped \| inside a cell.
                var cells: [String] = [], cell = "", escaped = false
                for character in row {
                    if escaped { cell.append(character == "|" ? "|" : "\\" + String(character)); escaped = false }
                    else if character == "\\" { escaped = true }
                    else if character == "|" { cells.append(cell); cell = "" }
                    else { cell.append(character) }
                }
                cells.append(cell)
                cells = cells.map { $0.trimmingCharacters(in: .whitespaces) }
                if cells.first == "" { cells.removeFirst() }
                if cells.last == "" { cells.removeLast() }
                return cells
            }
    }

    public static func table(_ rows: [[String]]) -> String {
        let width = max(1, rows.map(\.count).max() ?? 1)
        let filled = rows.map { $0 + Array(repeating: "", count: width - $0.count) }
        let cell = { (text: String) in text.replacingOccurrences(of: "|", with: "\\|").replacingOccurrences(of: "\n", with: " ") }
        var out = ["| " + (filled.first ?? Array(repeating: "", count: width)).map(cell).joined(separator: " | ") + " |",
                   "|" + Array(repeating: " --- |", count: width).joined()]
        out += filled.dropFirst().map { "| " + $0.map(cell).joined(separator: " | ") + " |" }
        return out.joined(separator: "\n")
    }

    /// The path and title of a picture line: ![alt](path "title").
    public static func image(_ object: String) -> (alt: String, path: String, title: String?)? {
        guard let m = match(object, #"^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$"#) else { return nil }
        return (m[1], m[2], m[3].isEmpty ? nil : m[3])
    }
}

/// Bold, italic and strikethrough inside a line, as Markdown marks.
public enum HubNoteInline {
    public struct Style: OptionSet, Hashable, Sendable {
        public let rawValue: Int
        public init(rawValue: Int) { self.rawValue = rawValue }
        public static let bold = Style(rawValue: 1)
        public static let italic = Style(rawValue: 2)
        public static let strikethrough = Style(rawValue: 4)
    }

    public static func parse(_ text: String) -> [(text: String, style: Style)] {
        var runs: [(text: String, style: Style)] = []
        var style: Style = []
        var current = ""
        var index = text.startIndex
        func flush() { if !current.isEmpty { runs.append((text: current, style: style)); current = "" } }
        while index < text.endIndex {
            let rest = text[index...]
            if rest.hasPrefix("**"), style.contains(.bold) || text[text.index(index, offsetBy: 2)...].contains("**") {
                flush(); style.formSymmetricDifference(.bold); index = text.index(index, offsetBy: 2); continue
            }
            if rest.hasPrefix("~~"), style.contains(.strikethrough) || text[text.index(index, offsetBy: 2)...].contains("~~") {
                flush(); style.formSymmetricDifference(.strikethrough); index = text.index(index, offsetBy: 2); continue
            }
            if rest.hasPrefix("*"), !rest.hasPrefix("**"), style.contains(.italic) || text[text.index(after: index)...].contains("*") {
                flush(); style.formSymmetricDifference(.italic); index = text.index(after: index); continue
            }
            current.append(text[index])
            index = text.index(after: index)
        }
        flush()
        return runs
    }

    public static func render(_ runs: [(text: String, style: Style)]) -> String {
        var out = ""
        for run in runs where !run.text.isEmpty {
            // Marks hug the words: spaces at the edges stay outside them.
            let leading = run.text.prefix(while: { $0 == " " }), trailing = run.text.reversed().prefix(while: { $0 == " " })
            let core = run.text.dropFirst(leading.count).dropLast(trailing.count)
            guard !core.isEmpty else { out += run.text; continue }
            var open = "", close = ""
            if run.style.contains(.bold) { open += "**"; close = "**" + close }
            if run.style.contains(.italic) { open += "*"; close = "*" + close }
            if run.style.contains(.strikethrough) { open += "~~"; close = "~~" + close }
            out += String(leading) + open + String(core) + close + String(trailing)
        }
        return out
    }

    public static func plain(_ text: String) -> String { parse(text).map(\.text).joined() }
}
