import SwiftUI
import UIKit
import PhotosUI
import VisionKit
import PencilKit
import CryptoKit
import HubNative

// MARK: - The note screen

@MainActor
struct HubNoteEditorView: View {
    @ObservedObject var model: HubNotesModel
    let noteID: String
    let isNew: Bool
    let folder: String

    @Environment(\.dismiss) private var dismiss
    @State private var loaded = false
    @State private var markdown = ""
    @State private var revision = 0
    @State private var pinned = false
    @State private var noteFolder = ""
    @State private var existed = false
    @State private var lastSaved: (body: String, pinned: Bool, folder: String)?
    @State private var saveTask: Task<Void, Never>?
    @State private var historyOpen = false
    @State private var moveOpen = false
    @State private var deleteAsk = false

    var body: some View {
        Group {
            if loaded {
                HubNoteTextView(markdown: markdown, revision: revision, startEditing: isNew || markdown.isEmpty,
                                library: model.library, api: model.api) { text in
                    markdown = text
                    scheduleSave()
                }
                .ignoresSafeArea(.container, edges: .bottom)
            } else {
                ProgressView()
            }
        }
        .background(Color(uiColor: .systemBackground))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .navigationBarTrailing) {
                Button { pinned.toggle(); scheduleSave(after: 0) } label: { Image(systemName: pinned ? "pin.fill" : "pin") }
                    .accessibilityLabel(pinned ? "Unpin note" : "Pin note")
                Menu {
                    Button { share() } label: { Label("Share", systemImage: "square.and.arrow.up") }
                    Button { moveOpen = true } label: { Label("Move to Folder", systemImage: "folder") }
                    Button { historyOpen = true } label: { Label("Version History", systemImage: "clock.arrow.circlepath") }
                    Button(role: .destructive) { deleteAsk = true } label: { Label("Delete", systemImage: "trash") }
                } label: { Image(systemName: "ellipsis.circle") }
                .accessibilityLabel("Note options")
            }
        }
        .confirmationDialog("Delete this note?", isPresented: $deleteAsk, titleVisibility: .visible) {
            Button("Delete Note", role: .destructive) {
                saveTask?.cancel()
                lastSaved = (markdown, pinned, noteFolder)
                Task { await model.delete(noteID); dismiss() }
            }
        } message: { Text("It stays in Recently Deleted for 30 days.") }
        .sheet(isPresented: $historyOpen) {
            HubNoteHistoryView(api: model.connectedAPI, noteID: noteID) { result in
                Task {
                    await model.library?.remember(result.note)
                    await model.reload()
                    markdown = result.note.body
                    lastSaved = (result.note.body, result.note.pinned, result.note.folder)
                    revision += 1
                }
            }
        }
        .sheet(isPresented: $moveOpen) {
            HubNoteMoveView(folders: model.index.folders, current: noteFolder) { target in
                noteFolder = target
                scheduleSave(after: 0)
            }
        }
        .task { await load() }
        .onDisappear { finish() }
    }

    private func load() async {
        guard !loaded else { return }
        if let note = await model.note(noteID) {
            markdown = note.body
            pinned = note.pinned
            noteFolder = note.folder
            existed = true
            lastSaved = (note.body, note.pinned, note.folder)
        } else {
            noteFolder = folder
        }
        loaded = true
    }

    private func scheduleSave(after delay: Double = 0.8) {
        saveTask?.cancel()
        saveTask = Task {
            if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            guard !Task.isCancelled else { return }
            await saveIfChanged()
        }
    }

    private func saveIfChanged() async {
        let blank = markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if blank && !existed { return }
        if let lastSaved, lastSaved.body == markdown, lastSaved.pinned == pinned, lastSaved.folder == noteFolder { return }
        lastSaved = (markdown, pinned, noteFolder)
        existed = true
        await model.save(id: noteID, folder: noteFolder, body: markdown, pinned: pinned)
    }

    /// Leaving the note saves it; a note left empty is removed, like Notes does.
    private func finish() {
        saveTask?.cancel()
        let blank = markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        Task {
            if blank { if existed { await model.delete(noteID) } }
            else { await saveIfChanged() }
            model.sync()
        }
    }

    private func share() {
        let controller = UIActivityViewController(activityItems: [markdown], applicationActivities: nil)
        HubNotePresenter.top()?.present(controller, animated: true)
    }
}

enum HubNotePresenter {
    static func top() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        var top = scenes.flatMap(\.windows).first { $0.isKeyWindow }?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }
}

// MARK: - Text view bridge

struct HubNoteTextView: UIViewRepresentable {
    let markdown: String
    let revision: Int
    let startEditing: Bool
    let library: HubNotesLibrary?
    let api: () -> HubConversationAPI?
    let changed: (String) -> Void

    func makeCoordinator() -> HubNoteEditorCoordinator {
        HubNoteEditorCoordinator(library: library, api: api, changed: changed)
    }

    func makeUIView(context: Context) -> UITextView {
        let view: UITextView
        if #available(iOS 16.0, *) { view = UITextView(usingTextLayoutManager: false) } else { view = UITextView() }
        context.coordinator.attach(view)
        context.coordinator.load(markdown)
        context.coordinator.revision = revision
        if startEditing {
            let coordinator = context.coordinator
            Task { @MainActor in coordinator.beginEditing(at: view.textStorage.length) }
        }
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.changed = changed
        if context.coordinator.revision != revision {
            context.coordinator.revision = revision
            context.coordinator.load(markdown)
        }
    }
}

extension NSAttributedString.Key {
    static let hubLine = NSAttributedString.Key("hubNoteLine")
    static let hubIndent = NSAttributedString.Key("hubNoteIndent")
    static let hubChecked = NSAttributedString.Key("hubNoteChecked")
    static let hubMarker = NSAttributedString.Key("hubNoteMarker")
    static let hubObject = NSAttributedString.Key("hubNoteObject")
    static let hubBold = NSAttributedString.Key("hubNoteBold")
    static let hubItalic = NSAttributedString.Key("hubNoteItalic")
    static let hubStrike = NSAttributedString.Key("hubNoteStrike")
}

// MARK: - Editor

@MainActor
final class HubNoteEditorCoordinator: NSObject, UITextViewDelegate, UIGestureRecognizerDelegate,
                                      PHPickerViewControllerDelegate, VNDocumentCameraViewControllerDelegate,
                                      UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    let library: HubNotesLibrary?
    let api: () -> HubConversationAPI?
    var changed: (String) -> Void
    var revision = 0
    private weak var textView: UITextView?
    private var applying = false
    private var editedRange: NSRange?
    private var images: [String: UIImage] = [:]

    init(library: HubNotesLibrary?, api: @escaping () -> HubConversationAPI?, changed: @escaping (String) -> Void) {
        self.library = library
        self.api = api
        self.changed = changed
    }

    private var storage: NSTextStorage { textView!.textStorage }
    private var containerWidth: CGFloat {
        guard let view = textView else { return 320 }
        return max(120, view.bounds.width - view.textContainerInset.left - view.textContainerInset.right - 2 * view.textContainer.lineFragmentPadding)
    }

    func attach(_ view: UITextView) {
        textView = view
        view.delegate = self
        view.backgroundColor = .systemBackground
        view.textContainerInset = UIEdgeInsets(top: 14, left: 18, bottom: 160, right: 18)
        view.textContainer.lineFragmentPadding = 0
        view.alwaysBounceVertical = true
        view.keyboardDismissMode = .interactive
        view.isEditable = false
        view.isSelectable = true
        view.dataDetectorTypes = [.link, .phoneNumber]
        view.linkTextAttributes = [.foregroundColor: HubWorkspacePalette.accentUIColor]
        view.inputAccessoryView = makeToolbar()
        view.accessibilityIdentifier = "hub.note.text"
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        tap.delegate = self
        view.addGestureRecognizer(tap)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

    // MARK: Styles

    static func baseFont(_ kind: HubNoteLineKind) -> UIFont {
        switch kind {
        case .title: return UIFontMetrics(forTextStyle: .title1).scaledFont(for: .systemFont(ofSize: 28, weight: .bold))
        case .heading: return UIFontMetrics(forTextStyle: .title2).scaledFont(for: .systemFont(ofSize: 22, weight: .bold))
        case .subheading: return UIFontMetrics(forTextStyle: .title3).scaledFont(for: .systemFont(ofSize: 19, weight: .semibold))
        case .monospaced: return UIFontMetrics(forTextStyle: .body).scaledFont(for: .monospacedSystemFont(ofSize: 15, weight: .regular))
        default: return UIFont.preferredFont(forTextStyle: .body)
        }
    }

    static func font(_ kind: HubNoteLineKind, bold: Bool, italic: Bool) -> UIFont {
        let base = baseFont(kind)
        var traits = base.fontDescriptor.symbolicTraits
        if bold { traits.insert(.traitBold) }
        if italic { traits.insert(.traitItalic) }
        guard let descriptor = base.fontDescriptor.withSymbolicTraits(traits) else { return base }
        return UIFont(descriptor: descriptor, size: base.pointSize)
    }

    private static let listKinds: Set<HubNoteLineKind> = [.checklist, .bullet, .dashed, .numbered]

    private func paragraphStyle(_ kind: HubNoteLineKind, indent: Int) -> NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        let start = CGFloat(indent) * 26
        style.firstLineHeadIndent = start
        if Self.listKinds.contains(kind) {
            style.headIndent = start + 28
            style.tabStops = [NSTextTab(textAlignment: .left, location: start + 28)]
            style.defaultTabInterval = 28
        } else {
            style.headIndent = start + (kind == .quote ? 14 : 0)
            if kind == .quote { style.firstLineHeadIndent = start + 14 }
        }
        style.paragraphSpacing = kind == .title ? 10 : kind == .heading || kind == .subheading ? 6 : 3
        style.paragraphSpacingBefore = kind == .heading || kind == .subheading ? 8 : 0
        style.lineSpacing = 2
        return style
    }

    private func checkbox(_ checked: Bool) -> NSTextAttachment {
        let attachment = NSTextAttachment()
        let config = UIImage.SymbolConfiguration(pointSize: 20, weight: .regular)
        let name = checked ? "checkmark.circle.fill" : "circle"
        let color: UIColor = checked ? HubWorkspacePalette.accentUIColor : .tertiaryLabel
        attachment.image = UIImage(systemName: name, withConfiguration: config)?.withTintColor(color, renderingMode: .alwaysOriginal)
        attachment.bounds = CGRect(x: 0, y: -4, width: 22, height: 22)
        return attachment
    }

    private func lineAttributes(_ kind: HubNoteLineKind, indent: Int, checked: Bool) -> [NSAttributedString.Key: Any] {
        [.hubLine: kind.rawValue, .hubIndent: indent, .hubChecked: checked]
    }

    private func marker(_ kind: HubNoteLineKind, indent: Int, checked: Bool, number: Int = 1) -> NSAttributedString {
        var attributes = lineAttributes(kind, indent: indent, checked: checked)
        attributes[.hubMarker] = true
        attributes[.font] = Self.baseFont(.body)
        attributes[.foregroundColor] = UIColor.secondaryLabel
        let out = NSMutableAttributedString()
        switch kind {
        case .checklist:
            let box = NSMutableAttributedString(attachment: checkbox(checked))
            box.addAttributes(attributes, range: NSRange(location: 0, length: box.length))
            out.append(box)
            out.append(NSAttributedString(string: "\t", attributes: attributes))
        case .bullet: out.append(NSAttributedString(string: "•\t", attributes: attributes))
        case .dashed: out.append(NSAttributedString(string: "–\t", attributes: attributes))
        case .numbered: out.append(NSAttributedString(string: "\(number).\t", attributes: attributes))
        default: break
        }
        return out
    }

    // MARK: Markdown in and out

    func load(_ markdown: String) {
        guard let textView else { return }
        applying = true
        let document = NSMutableAttributedString()
        let lines = markdown.isEmpty ? [HubNoteLine()] : HubNoteMarkdown.parse(markdown)
        for (index, line) in lines.enumerated() {
            if index > 0 {
                let previous = lines[index - 1]
                document.append(NSAttributedString(string: "\n", attributes: lineAttributes(previous.object == nil ? previous.kind : .body, indent: previous.indent, checked: previous.checked)))
            }
            if let object = line.object { document.append(objectString(object)); continue }
            document.append(marker(line.kind, indent: line.indent, checked: line.checked))
            var base = lineAttributes(line.kind, indent: line.indent, checked: line.checked)
            for run in HubNoteInline.parse(line.text) {
                if run.style.contains(.bold) { base[.hubBold] = true } else { base[.hubBold] = nil }
                if run.style.contains(.italic) { base[.hubItalic] = true } else { base[.hubItalic] = nil }
                if run.style.contains(.strikethrough) { base[.hubStrike] = true } else { base[.hubStrike] = nil }
                document.append(NSAttributedString(string: run.text, attributes: base))
            }
        }
        textView.attributedText = document
        normalize(NSRange(location: 0, length: document.length))
        textView.typingAttributes = typing(for: lines.last?.kind ?? .body, indent: 0, checked: false)
        if document.length == 0 { textView.typingAttributes = typing(for: .body, indent: 0, checked: false, firstLine: true) }
        textView.undoManager?.removeAllActions()
        applying = false
    }

    func serialize() -> String {
        var lines: [HubNoteLine] = []
        let text = storage.string as NSString
        guard text.length > 0 else { return "" }
        var location = 0
        while location < text.length {
            let paragraph = text.paragraphRange(for: NSRange(location: location, length: 0))
            var content = paragraph
            if content.length > 0, text.character(at: NSMaxRange(content) - 1) == 10 { content.length -= 1 }
            lines.append(contentsOf: self.lines(in: content))
            location = NSMaxRange(paragraph)
            if location == text.length, text.character(at: location - 1) == 10 { lines.append(HubNoteLine()) }
        }
        while lines.last.map({ $0.object == nil && $0.text.isEmpty && $0.kind == .body }) == true { lines.removeLast() }
        return HubNoteMarkdown.render(lines)
    }

    private func lines(in range: NSRange) -> [HubNoteLine] {
        let attributes = range.length > 0 ? storage.attributes(at: range.location, effectiveRange: nil)
            : (range.location < storage.length ? storage.attributes(at: range.location, effectiveRange: nil) : textView?.typingAttributes ?? [:])
        let kind = HubNoteLineKind(rawValue: attributes[.hubLine] as? String ?? "") ?? .body
        let indent = attributes[.hubIndent] as? Int ?? 0
        let checked = attributes[.hubChecked] as? Bool ?? false
        var result: [HubNoteLine] = []
        var runs: [(text: String, style: HubNoteInline.Style)] = []
        func flushText() {
            let text = HubNoteInline.render(runs)
            if !runs.isEmpty || result.isEmpty { result.append(HubNoteLine(kind: result.isEmpty ? kind : .body, indent: indent, checked: checked, text: text)) }
            runs = []
        }
        storage.enumerateAttributes(in: range) { values, run, _ in
            if values[.hubMarker] as? Bool == true { return }
            if let object = values[.hubObject] as? String {
                if !runs.isEmpty { flushText() }
                result.append(HubNoteLine(object: object))
                return
            }
            if values[.attachment] != nil { return }
            var style: HubNoteInline.Style = []
            if values[.hubBold] as? Bool == true { style.insert(.bold) }
            if values[.hubItalic] as? Bool == true { style.insert(.italic) }
            if values[.hubStrike] as? Bool == true { style.insert(.strikethrough) }
            runs.append((text: (storage.string as NSString).substring(with: run), style: style))
        }
        if !runs.isEmpty || result.isEmpty { flushText() }
        return result
    }

    // MARK: Keeping every line consistent

    private func typing(for kind: HubNoteLineKind, indent: Int, checked: Bool, firstLine: Bool = false) -> [NSAttributedString.Key: Any] {
        var attributes = lineAttributes(kind, indent: indent, checked: false)
        let shown = firstLine && kind == .body ? .title : kind
        attributes[.font] = Self.baseFont(shown)
        attributes[.foregroundColor] = UIColor.label
        attributes[.paragraphStyle] = paragraphStyle(shown, indent: indent)
        return attributes
    }

    /// Makes each paragraph in range uniform: one kind from its start, a
    /// marker only at the start and only for lists, numbers in order, and
    /// fonts and colors from the kind.
    private func normalize(_ range: NSRange) {
        guard let textView else { return }
        let text = storage.string as NSString
        var selection = textView.selectedRange
        storage.beginEditing()
        var location = text.paragraphRange(for: NSRange(location: min(range.location, max(0, storage.length)), length: 0)).location
        let end = min(storage.length, NSMaxRange(text.paragraphRange(for: NSRange(location: min(NSMaxRange(range), storage.length), length: 0))))
        var guardCount = 0
        var delta = 0
        while location < max(end + delta, 1), location <= storage.length, guardCount < 100_000 {
            guardCount += 1
            let paragraph = (storage.string as NSString).paragraphRange(for: NSRange(location: min(location, storage.length), length: 0))
            if paragraph.length == 0 { break }
            let start = storage.attributes(at: paragraph.location, effectiveRange: nil)
            let kind = HubNoteLineKind(rawValue: start[.hubLine] as? String ?? "") ?? .body
            let indent = start[.hubIndent] as? Int ?? 0
            let checked = start[.hubChecked] as? Bool ?? false
            // Markers anywhere but the start (left after joining lines) go away.
            var markerAtStart = 0
            var stray: [NSRange] = []
            storage.enumerateAttribute(.hubMarker, in: paragraph) { value, run, _ in
                guard value as? Bool == true else { return }
                if run.location == paragraph.location + markerAtStart && stray.isEmpty { markerAtStart += run.length } else { stray.append(run) }
            }
            for run in stray.reversed() {
                storage.deleteCharacters(in: run)
                delta -= run.length
                if run.location < selection.location { selection.location = max(run.location, selection.location - run.length) }
            }
            var current = (storage.string as NSString).paragraphRange(for: NSRange(location: paragraph.location, length: 0))
            let isObjectLine = storage.attribute(.hubObject, at: current.location, effectiveRange: nil) != nil
            // Lists have a marker; other lines do not.
            if !isObjectLine {
                let wantsMarker = Self.listKinds.contains(kind)
                if wantsMarker && markerAtStart == 0 {
                    let added = marker(kind, indent: indent, checked: checked)
                    storage.insert(added, at: current.location)
                    delta += added.length
                    if current.location <= selection.location { selection.location += added.length }
                } else if !wantsMarker && markerAtStart > 0 {
                    storage.deleteCharacters(in: NSRange(location: current.location, length: markerAtStart))
                    delta -= markerAtStart
                    if current.location < selection.location { selection.location = max(current.location, selection.location - markerAtStart) }
                }
            }
            current = (storage.string as NSString).paragraphRange(for: NSRange(location: current.location, length: 0))
            // One kind for the whole line.
            storage.addAttributes(lineAttributes(kind, indent: indent, checked: checked), range: current)
            let first = current.location == 0
            let shown: HubNoteLineKind = first && kind == .body ? .title : kind
            storage.addAttribute(.paragraphStyle, value: paragraphStyle(shown, indent: indent), range: current)
            storage.enumerateAttributes(in: current) { values, run, _ in
                if values[.hubMarker] as? Bool == true || values[.attachment] != nil { return }
                let done = kind == .checklist && checked
                storage.addAttributes([
                    .font: Self.font(shown, bold: values[.hubBold] as? Bool == true, italic: values[.hubItalic] as? Bool == true || kind == .quote),
                    .foregroundColor: done || kind == .quote ? UIColor.secondaryLabel : UIColor.label,
                    .strikethroughStyle: done || values[.hubStrike] as? Bool == true ? NSUnderlineStyle.single.rawValue : 0,
                ], range: run)
            }
            location = NSMaxRange(current)
        }
        renumber()
        storage.endEditing()
        selection.location = min(selection.location, storage.length)
        selection.length = min(selection.length, storage.length - selection.location)
        textView.selectedRange = selection
    }

    /// Numbered lines count up within each run of the same depth.
    private func renumber() {
        let text = storage.string as NSString
        var location = 0
        var counters: [Int: Int] = [:]
        while location < text.length {
            let paragraph = (storage.string as NSString).paragraphRange(for: NSRange(location: location, length: 0))
            let attributes = storage.attributes(at: paragraph.location, effectiveRange: nil)
            let kind = HubNoteLineKind(rawValue: attributes[.hubLine] as? String ?? "") ?? .body
            let indent = attributes[.hubIndent] as? Int ?? 0
            if kind == .numbered {
                counters = counters.filter { $0.key <= indent }
                let number = (counters[indent] ?? 0) + 1
                counters[indent] = number
                var markerRange = NSRange(location: paragraph.location, length: 0)
                storage.enumerateAttribute(.hubMarker, in: paragraph) { value, run, stop in
                    if value as? Bool == true, run.location == paragraph.location { markerRange = run }
                    stop.pointee = true
                }
                let wanted = "\(number).\t"
                if markerRange.length > 0, (storage.string as NSString).substring(with: markerRange) != wanted {
                    storage.replaceCharacters(in: markerRange, with: marker(.numbered, indent: indent, checked: false, number: number))
                }
            } else if kind != .numbered {
                counters = counters.filter { $0.key < indent }
            }
            location = NSMaxRange((storage.string as NSString).paragraphRange(for: NSRange(location: paragraph.location, length: 0)))
        }
    }

    private func paragraphKind(at location: Int) -> (range: NSRange, kind: HubNoteLineKind, indent: Int, checked: Bool, marker: Int) {
        let text = storage.string as NSString
        let paragraph = text.paragraphRange(for: NSRange(location: min(location, text.length), length: 0))
        let attributes: [NSAttributedString.Key: Any] = paragraph.length > 0 ? storage.attributes(at: paragraph.location, effectiveRange: nil) : (textView?.typingAttributes ?? [:])
        var markerLength = 0
        if paragraph.length > 0 {
            storage.enumerateAttribute(.hubMarker, in: paragraph) { value, run, stop in
                if value as? Bool == true, run.location == paragraph.location { markerLength = run.length }
                stop.pointee = true
            }
        }
        return (paragraph, HubNoteLineKind(rawValue: attributes[.hubLine] as? String ?? "") ?? .body,
                attributes[.hubIndent] as? Int ?? 0, attributes[.hubChecked] as? Bool ?? false, markerLength)
    }

    private func notify() {
        guard !applying else { return }
        changed(serialize())
    }

    // MARK: Typing

    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
        let line = paragraphKind(at: range.location)
        let contentLength = line.range.length - line.marker - ((storage.string as NSString).substring(with: line.range).hasSuffix("\n") ? 1 : 0)
        if text == "\n", range.length == 0 {
            if Self.listKinds.contains(line.kind) {
                if contentLength <= 0 {
                    // Return on an empty list line ends the list.
                    setKind(.body, paragraphs: [line.range])
                    return false
                }
                let insert = NSMutableAttributedString(string: "\n", attributes: lineAttributes(line.kind, indent: line.indent, checked: line.checked))
                insert.append(marker(line.kind, indent: line.indent, checked: false))
                replace(range, with: insert, caretAfter: true)
                return false
            }
            if line.kind != .body || line.range.location == 0 {
                // After a title or heading, writing goes on in body text.
                replace(range, with: NSAttributedString(string: "\n", attributes: typing(for: .body, indent: 0, checked: false)), caretAfter: true)
                textView.typingAttributes = typing(for: .body, indent: 0, checked: false)
                return false
            }
        }
        if text.isEmpty, range.length <= 1, line.marker > 0, range.location < line.range.location + line.marker {
            // Deleting a list's marker turns the line into body text.
            setKind(.body, paragraphs: [line.range])
            return false
        }
        editedRange = NSRange(location: range.location, length: (text as NSString).length)
        return true
    }

    func textViewDidChange(_ textView: UITextView) {
        guard !applying else { return }
        applying = true
        normalize(editedRange ?? textView.selectedRange)
        editedRange = nil
        applying = false
        notify()
    }

    func textViewDidChangeSelection(_ textView: UITextView) {
        guard !applying else { return }
        let line = paragraphKind(at: textView.selectedRange.location)
        // The caret never sits inside a marker.
        if line.marker > 0, textView.selectedRange.length == 0, textView.selectedRange.location < line.range.location + line.marker {
            textView.selectedRange = NSRange(location: line.range.location + line.marker, length: 0)
        }
        var attributes = textView.typingAttributes
        attributes[.hubMarker] = nil
        attributes[.hubObject] = nil
        attributes[.attachment] = nil
        if line.range.length == 0 || textView.selectedRange.location == line.range.location + line.marker {
            let fresh = typing(for: line.kind, indent: line.indent, checked: line.checked, firstLine: line.range.location == 0)
            for key in [NSAttributedString.Key.hubLine, .hubIndent, .hubChecked, .font, .paragraphStyle, .foregroundColor] { attributes[key] = fresh[key] }
        }
        textView.typingAttributes = attributes
    }

    func textViewDidEndEditing(_ textView: UITextView) {
        textView.isEditable = false
        notify()
    }

    private func replace(_ range: NSRange, with value: NSAttributedString, caretAfter: Bool) {
        guard let textView else { return }
        applying = true
        storage.replaceCharacters(in: range, with: value)
        textView.selectedRange = NSRange(location: range.location + value.length, length: 0)
        normalize(NSRange(location: range.location, length: value.length))
        textView.undoManager?.removeAllActions()
        applying = false
        notify()
        textView.scrollRangeToVisible(textView.selectedRange)
    }

    func beginEditing(at location: Int) {
        guard let textView else { return }
        textView.isEditable = true
        textView.becomeFirstResponder()
        textView.selectedRange = NSRange(location: min(location, storage.length), length: 0)
        textViewDidChangeSelection(textView)
    }

    // MARK: Taps: checkboxes, objects, start editing

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        guard let textView, gesture.state == .ended else { return }
        var point = gesture.location(in: textView)
        point.x -= textView.textContainerInset.left
        point.y -= textView.textContainerInset.top
        let layout = textView.layoutManager
        let glyph = layout.glyphIndex(for: point, in: textView.textContainer)
        let index = layout.characterIndexForGlyph(at: glyph)
        if index < storage.length {
            let rect = layout.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: textView.textContainer)
            let attributes = storage.attributes(at: index, effectiveRange: nil)
            if rect.insetBy(dx: -8, dy: -6).contains(point) {
                if attributes[.hubMarker] as? Bool == true, attributes[.hubLine] as? String == HubNoteLineKind.checklist.rawValue {
                    toggleChecked(at: index)
                    return
                }
                if let object = attributes[.hubObject] as? String {
                    open(object, at: index)
                    return
                }
            }
        }
        if !textView.isEditable {
            var fraction: CGFloat = 0
            let caret = layout.characterIndex(for: point, in: textView.textContainer, fractionOfDistanceBetweenInsertionPoints: &fraction)
            let below = point.y > layout.usedRect(for: textView.textContainer).maxY
            beginEditing(at: below ? storage.length : caret + (fraction > 0.5 ? 1 : 0))
        }
    }

    private func toggleChecked(at index: Int) {
        let line = paragraphKind(at: index)
        applying = true
        storage.beginEditing()
        storage.addAttribute(.hubChecked, value: !line.checked, range: line.range)
        if line.marker > 0 {
            storage.replaceCharacters(in: NSRange(location: line.range.location, length: line.marker),
                                      with: marker(.checklist, indent: line.indent, checked: !line.checked))
        }
        storage.endEditing()
        normalize(line.range)
        applying = false
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        notify()
    }

    // MARK: Formatting

    func paragraphsInSelection() -> [NSRange] {
        guard let textView else { return [] }
        let text = storage.string as NSString
        var ranges: [NSRange] = []
        var location = textView.selectedRange.location
        let end = NSMaxRange(textView.selectedRange)
        repeat {
            let paragraph = text.paragraphRange(for: NSRange(location: min(location, text.length), length: 0))
            ranges.append(paragraph)
            location = NSMaxRange(paragraph)
        } while location < end && location < text.length
        return ranges
    }

    func setKind(_ kind: HubNoteLineKind, paragraphs: [NSRange]? = nil) {
        guard let textView else { return }
        applying = true
        storage.beginEditing()
        for paragraph in (paragraphs ?? paragraphsInSelection()).reversed() {
            let line = paragraphKind(at: paragraph.location)
            if line.marker > 0 { storage.deleteCharacters(in: NSRange(location: paragraph.location, length: line.marker)) }
            let current = (storage.string as NSString).paragraphRange(for: NSRange(location: paragraph.location, length: 0))
            if current.length > 0 {
                storage.addAttributes(lineAttributes(kind, indent: Self.listKinds.contains(kind) ? line.indent : 0, checked: false), range: current)
            }
        }
        storage.endEditing()
        let all = paragraphs ?? paragraphsInSelection()
        if let first = all.first {
            normalize(NSRange(location: first.location, length: max(0, (all.last.map(NSMaxRange) ?? first.location) - first.location)))
        }
        textView.typingAttributes = typing(for: kind, indent: 0, checked: false)
        textView.undoManager?.removeAllActions()
        applying = false
        notify()
    }

    func toggleChecklist() {
        let lines = paragraphsInSelection().map { paragraphKind(at: $0.location) }
        setKind(lines.allSatisfy { $0.kind == .checklist } ? .body : .checklist)
    }

    func toggleInline(_ key: NSAttributedString.Key) {
        guard let textView else { return }
        let range = textView.selectedRange
        if range.length == 0 {
            var attributes = textView.typingAttributes
            attributes[key] = attributes[key] as? Bool == true ? nil : true
            textView.typingAttributes = attributes
            return
        }
        var all = true
        storage.enumerateAttribute(key, in: range) { value, _, _ in if value as? Bool != true { all = false } }
        applying = true
        if all { storage.removeAttribute(key, range: range) } else { storage.addAttribute(key, value: true, range: range) }
        normalize(range)
        applying = false
        notify()
    }

    func shiftIndent(_ delta: Int) {
        applying = true
        for paragraph in paragraphsInSelection() {
            let line = paragraphKind(at: paragraph.location)
            guard Self.listKinds.contains(line.kind), paragraph.length > 0 else { continue }
            storage.addAttribute(.hubIndent, value: min(4, max(0, line.indent + delta)), range: paragraph)
        }
        if let first = paragraphsInSelection().first { normalize(first) }
        applying = false
        notify()
    }

    // MARK: Objects: pictures, scans, drawings, tables

    private func objectString(_ markdown: String) -> NSAttributedString {
        let attachment = NSTextAttachment()
        let width = containerWidth
        let rows = HubNoteMarkdown.tableRows(markdown)
        if markdown.hasPrefix("|"), !rows.isEmpty {
            attachment.image = HubNoteTableRenderer.image(rows: rows, width: width)
            attachment.bounds = CGRect(origin: .zero, size: attachment.image?.size ?? CGSize(width: width, height: 44))
        } else {
            attachment.image = placeholder(width: width)
            attachment.bounds = CGRect(x: 0, y: 0, width: width, height: width * 0.6)
            if let image = HubNoteMarkdown.image(markdown) { loadImage(image.path, into: attachment) }
        }
        let value = NSMutableAttributedString(attachment: attachment)
        value.addAttributes(lineAttributes(.body, indent: 0, checked: false), range: NSRange(location: 0, length: value.length))
        value.addAttribute(.hubObject, value: markdown, range: NSRange(location: 0, length: value.length))
        return value
    }

    private func placeholder(width: CGFloat) -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: width, height: width * 0.6)).image { context in
            UIColor.secondarySystemFill.setFill()
            UIBezierPath(roundedRect: context.format.bounds, cornerRadius: 12).fill()
        }
    }

    private func loadImage(_ path: String, into attachment: NSTextAttachment) {
        if let cached = images[path] { place(cached, in: attachment); return }
        let library = library, api = api()
        Task { [weak self] in
            var data: Data?
            if path.hasPrefix("https://"), let url = URL(string: path) { data = try? await URLSession.shared.data(from: url).0 }
            else { data = await library?.attachment(path, api: api) }
            guard let self, let data, let image = UIImage(data: data) else { return }
            self.images[path] = image
            self.place(image, in: attachment)
        }
    }

    private func place(_ image: UIImage, in attachment: NSTextAttachment) {
        guard let textView else { return }
        let width = min(containerWidth, image.size.width)
        let size = CGSize(width: width, height: image.size.height * width / max(1, image.size.width))
        attachment.image = UIGraphicsImageRenderer(size: size).image { _ in
            UIBezierPath(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: 12).addClip()
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        attachment.bounds = CGRect(origin: .zero, size: size)
        storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) { value, range, stop in
            if (value as? NSTextAttachment) === attachment {
                textView.layoutManager.invalidateLayout(forCharacterRange: range, actualCharacterRange: nil)
                textView.layoutManager.invalidateDisplay(forCharacterRange: range)
                stop.pointee = true
            }
        }
    }

    /// Puts an object on its own line at the caret.
    private func insertObject(_ markdown: String, image: UIImage? = nil, replacing range: NSRange? = nil) {
        guard let textView else { return }
        applying = true
        let object = NSMutableAttributedString(attributedString: objectString(markdown))
        if let image, let attachment = object.attribute(.attachment, at: 0, effectiveRange: nil) as? NSTextAttachment {
            if let path = HubNoteMarkdown.image(markdown)?.path { images[path] = image }
            place(image, in: attachment)
        }
        if let range {
            storage.replaceCharacters(in: range, with: object)
        } else {
            var at = textView.selectedRange.location
            let text = storage.string as NSString
            let insert = NSMutableAttributedString()
            if at > 0, text.character(at: at - 1) != 10 { insert.append(NSAttributedString(string: "\n", attributes: typing(for: .body, indent: 0, checked: false))) }
            insert.append(object)
            insert.append(NSAttributedString(string: "\n", attributes: typing(for: .body, indent: 0, checked: false)))
            storage.replaceCharacters(in: NSRange(location: at, length: textView.selectedRange.length), with: insert)
            at += insert.length
            textView.selectedRange = NSRange(location: min(at, storage.length), length: 0)
        }
        normalize(NSRange(location: 0, length: storage.length))
        textView.undoManager?.removeAllActions()
        applying = false
        notify()
    }

    private func open(_ object: String, at index: Int) {
        let range = NSRange(location: index, length: 1)
        if object.hasPrefix("|") {
            presentTable(rows: HubNoteMarkdown.tableRows(object), replacing: range)
        } else if let image = HubNoteMarkdown.image(object), let drawing = image.title, drawing.hasPrefix("drawing:") {
            let path = String(drawing.dropFirst("drawing:".count))
            Task { [weak self] in
                guard let self else { return }
                let data = await self.library?.attachment(path, api: self.api())
                self.presentDrawing(existing: data.flatMap { try? PKDrawing(data: $0) }, replacing: range)
            }
        } else if let image = HubNoteMarkdown.image(object), let picture = images[image.path] {
            let viewer = UIHostingController(rootView: HubNoteImageViewer(image: picture))
            viewer.modalPresentationStyle = .fullScreen
            HubNotePresenter.top()?.present(viewer, animated: true)
        }
    }

    // MARK: Toolbar

    private func makeToolbar() -> UIToolbar {
        let toolbar = UIToolbar(frame: CGRect(x: 0, y: 0, width: 320, height: 44))
        let styles = UIMenu(title: "", children: [
            UIAction(title: String(localized: "Title")) { [weak self] _ in self?.setKind(.title) },
            UIAction(title: String(localized: "Heading")) { [weak self] _ in self?.setKind(.heading) },
            UIAction(title: String(localized: "Subheading")) { [weak self] _ in self?.setKind(.subheading) },
            UIAction(title: String(localized: "Body")) { [weak self] _ in self?.setKind(.body) },
            UIAction(title: String(localized: "Monospaced")) { [weak self] _ in self?.setKind(.monospaced) },
            UIMenu(title: "", options: .displayInline, children: [
                UIAction(title: String(localized: "Bulleted List"), image: UIImage(systemName: "list.bullet")) { [weak self] _ in self?.setKind(.bullet) },
                UIAction(title: String(localized: "Dashed List"), image: UIImage(systemName: "list.dash")) { [weak self] _ in self?.setKind(.dashed) },
                UIAction(title: String(localized: "Numbered List"), image: UIImage(systemName: "list.number")) { [weak self] _ in self?.setKind(.numbered) },
                UIAction(title: String(localized: "Block Quote"), image: UIImage(systemName: "text.quote")) { [weak self] _ in self?.setKind(.quote) },
            ]),
            UIMenu(title: "", options: .displayInline, children: [
                UIAction(title: String(localized: "Bold"), image: UIImage(systemName: "bold")) { [weak self] _ in self?.toggleInline(.hubBold) },
                UIAction(title: String(localized: "Italic"), image: UIImage(systemName: "italic")) { [weak self] _ in self?.toggleInline(.hubItalic) },
                UIAction(title: String(localized: "Strikethrough"), image: UIImage(systemName: "strikethrough")) { [weak self] _ in self?.toggleInline(.hubStrike) },
            ]),
            UIMenu(title: "", options: .displayInline, children: [
                UIAction(title: String(localized: "Indent"), image: UIImage(systemName: "increase.indent")) { [weak self] _ in self?.shiftIndent(1) },
                UIAction(title: String(localized: "Outdent"), image: UIImage(systemName: "decrease.indent")) { [weak self] _ in self?.shiftIndent(-1) },
            ]),
        ])
        let attach = UIMenu(title: "", children: [
            UIAction(title: String(localized: "Choose Photo"), image: UIImage(systemName: "photo.on.rectangle")) { [weak self] _ in self?.pickPhotos() },
            UIAction(title: String(localized: "Take Photo"), image: UIImage(systemName: "camera")) { [weak self] _ in self?.takePhoto() },
            UIAction(title: String(localized: "Scan Documents"), image: UIImage(systemName: "doc.viewfinder")) { [weak self] _ in self?.scan() },
        ])
        func space() -> UIBarButtonItem { UIBarButtonItem(systemItem: .flexibleSpace) }
        func button(_ symbol: String, _ action: @escaping () -> Void) -> UIBarButtonItem {
            UIBarButtonItem(title: nil, image: UIImage(systemName: symbol), primaryAction: UIAction { _ in action() }, menu: nil)
        }
        toolbar.items = [
            UIBarButtonItem(title: nil, image: UIImage(systemName: "textformat"), primaryAction: nil, menu: styles),
            space(),
            button("checklist") { [weak self] in self?.toggleChecklist() },
            space(),
            button("tablecells") { [weak self] in self?.presentTable(rows: [["", ""], ["", ""]], replacing: nil) },
            space(),
            UIBarButtonItem(title: nil, image: UIImage(systemName: "paperclip"), primaryAction: nil, menu: attach),
            space(),
            button("pencil.tip.crop.circle") { [weak self] in self?.presentDrawing(existing: nil, replacing: nil) },
            space(),
            button("keyboard.chevron.compact.down") { [weak self] in self?.textView?.resignFirstResponder() },
        ]
        toolbar.items?[0].accessibilityLabel = String(localized: "Text style")
        toolbar.items?[2].accessibilityLabel = String(localized: "Checklist")
        toolbar.items?[4].accessibilityLabel = String(localized: "Table")
        toolbar.items?[6].accessibilityLabel = String(localized: "Attach")
        toolbar.items?[8].accessibilityLabel = String(localized: "Drawing")
        toolbar.items?[10].accessibilityLabel = String(localized: "Hide keyboard")
        toolbar.sizeToFit()
        return toolbar
    }

    // MARK: Photos, camera, scanning

    private func addPicture(_ image: UIImage, alt: String) {
        guard let data = image.jpegData(compressionQuality: 0.85) else { return }
        let hex = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let path = HubNotesLibrary.attachmentPath(sha256: hex, fileExtension: "jpg")
        Task { await library?.keepAttachment(data, path: path) }
        insertObject("![\(alt)](\(path))", image: image)
        HubNotesModel.shared.sync(after: 1)
    }

    private func pickPhotos() {
        var configuration = PHPickerConfiguration()
        configuration.filter = .images
        configuration.selectionLimit = 0
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = self
        HubNotePresenter.top()?.present(picker, animated: true)
    }

    nonisolated func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        Task { @MainActor in
            picker.dismiss(animated: true)
            for result in results where result.itemProvider.canLoadObject(ofClass: UIImage.self) {
                let image: UIImage? = await withCheckedContinuation { continuation in
                    result.itemProvider.loadObject(ofClass: UIImage.self) { object, _ in continuation.resume(returning: object as? UIImage) }
                }
                if let image { self.addPicture(image, alt: String(localized: "Photo")) }
            }
        }
    }

    private func takePhoto() {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else { return }
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = self
        HubNotePresenter.top()?.present(picker, animated: true)
    }

    nonisolated func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        let image = info[.originalImage] as? UIImage
        Task { @MainActor in
            picker.dismiss(animated: true)
            if let image { self.addPicture(image, alt: String(localized: "Photo")) }
        }
    }

    nonisolated func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        Task { @MainActor in picker.dismiss(animated: true) }
    }

    private func scan() {
        guard VNDocumentCameraViewController.isSupported else { return }
        let scanner = VNDocumentCameraViewController()
        scanner.delegate = self
        HubNotePresenter.top()?.present(scanner, animated: true)
    }

    nonisolated func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
        let pages = (0..<scan.pageCount).map { scan.imageOfPage(at: $0) }
        Task { @MainActor in
            controller.dismiss(animated: true)
            for page in pages { self.addPicture(page, alt: String(localized: "Scan")) }
        }
    }

    nonisolated func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
        Task { @MainActor in controller.dismiss(animated: true) }
    }

    nonisolated func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
        Task { @MainActor in controller.dismiss(animated: true) }
    }

    // MARK: Tables and drawings

    private func presentTable(rows: [[String]], replacing range: NSRange?) {
        let editor = UIHostingController(rootView: HubNoteTableEditor(rows: rows) { [weak self] edited in
            guard let self else { return }
            let markdown = HubNoteMarkdown.table(edited)
            self.insertObject(markdown, replacing: range)
        })
        HubNotePresenter.top()?.present(editor, animated: true)
    }

    private func presentDrawing(existing: PKDrawing?, replacing range: NSRange?) {
        let controller = HubDrawingController(drawing: existing ?? PKDrawing()) { [weak self] drawing in
            guard let self, !drawing.strokes.isEmpty else { return }
            let data = drawing.dataRepresentation()
            let bounds = drawing.bounds.insetBy(dx: -24, dy: -24)
            let image = UIGraphicsImageRenderer(size: bounds.size).image { _ in
                UIColor.white.setFill()
                UIRectFill(CGRect(origin: .zero, size: bounds.size))
                drawing.image(from: bounds, scale: UIScreen.main.scale).draw(at: .zero)
            }
            guard let png = image.pngData() else { return }
            let hex = { (bytes: Data) in SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
            let drawingPath = HubNotesLibrary.attachmentPath(sha256: hex(data), fileExtension: "drawing")
            let imagePath = HubNotesLibrary.attachmentPath(sha256: hex(png), fileExtension: "png")
            Task {
                await self.library?.keepAttachment(data, path: drawingPath)
                await self.library?.keepAttachment(png, path: imagePath)
            }
            self.insertObject("![\(String(localized: "Drawing"))](\(imagePath) \"drawing:\(drawingPath)\")", image: image, replacing: range)
            HubNotesModel.shared.sync(after: 1)
        }
        let navigation = UINavigationController(rootViewController: controller)
        navigation.modalPresentationStyle = .fullScreen
        HubNotePresenter.top()?.present(navigation, animated: true)
    }
}

// MARK: - Table editor and rendering

enum HubNoteTableRenderer {
    static func image(rows: [[String]], width: CGFloat) -> UIImage {
        let columns = max(1, rows.map(\.count).max() ?? 1)
        let font = UIFont.preferredFont(forTextStyle: .subheadline)
        let bold = UIFont.systemFont(ofSize: font.pointSize, weight: .semibold)
        let padding: CGFloat = 10
        let columnWidth = width / CGFloat(columns)
        let heights = rows.enumerated().map { index, row -> CGFloat in
            let tallest = row.map { text in
                (text as NSString).boundingRect(with: CGSize(width: columnWidth - padding * 2, height: .greatestFiniteMagnitude),
                                                options: [.usesLineFragmentOrigin], attributes: [.font: index == 0 ? bold : font], context: nil).height
            }.max() ?? font.lineHeight
            return max(font.lineHeight, ceil(tallest)) + padding * 2
        }
        let size = CGSize(width: width, height: max(44, heights.reduce(0, +)))
        return UIGraphicsImageRenderer(size: size).image { _ in
            let frame = CGRect(origin: .zero, size: size).insetBy(dx: 0.5, dy: 0.5)
            let outline = UIBezierPath(roundedRect: frame, cornerRadius: 10)
            outline.addClip()
            UIColor.secondarySystemBackground.setFill()
            UIBezierPath(rect: CGRect(x: 0, y: 0, width: width, height: heights.first ?? 0)).fill()
            UIColor.separator.setStroke()
            var y: CGFloat = 0
            for (index, row) in rows.enumerated() {
                for column in 0..<columns {
                    let text = column < row.count ? row[column] : ""
                    let rect = CGRect(x: CGFloat(column) * columnWidth + padding, y: y + padding, width: columnWidth - padding * 2, height: heights[index] - padding * 2)
                    (text as NSString).draw(with: rect, options: [.usesLineFragmentOrigin],
                                            attributes: [.font: index == 0 ? bold : font, .foregroundColor: UIColor.label], context: nil)
                }
                y += heights[index]
                if index < rows.count - 1 { let line = UIBezierPath(); line.move(to: CGPoint(x: 0, y: y)); line.addLine(to: CGPoint(x: width, y: y)); line.stroke() }
            }
            for column in 1..<max(2, columns) where column < columns {
                let line = UIBezierPath()
                line.move(to: CGPoint(x: CGFloat(column) * columnWidth, y: 0))
                line.addLine(to: CGPoint(x: CGFloat(column) * columnWidth, y: size.height))
                line.stroke()
            }
            outline.lineWidth = 1
            outline.stroke()
        }
    }
}

struct HubNoteTableEditor: View {
    @State var rows: [[String]]
    let save: ([[String]]) -> Void
    @Environment(\.dismiss) private var dismiss

    init(rows: [[String]], save: @escaping ([[String]]) -> Void) {
        let width = max(1, rows.map(\.count).max() ?? 1)
        _rows = State(initialValue: rows.map { $0 + Array(repeating: "", count: width - $0.count) })
        self.save = save
    }

    var body: some View {
        NavigationView {
            ScrollView([.horizontal, .vertical]) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(rows.indices, id: \.self) { row in
                        HStack(spacing: 0) {
                            ForEach(rows[row].indices, id: \.self) { column in
                                TextField(row == 0 ? String(localized: "Heading") : "", text: Binding(get: { rows[row][column] }, set: { rows[row][column] = $0 }))
                                    .font(row == 0 ? .subheadline.weight(.semibold) : .subheadline)
                                    .padding(10)
                                    .frame(width: 150, alignment: .topLeading)
                                    .background(row == 0 ? Color(uiColor: .secondarySystemBackground) : Color.clear)
                                    .overlay(Rectangle().stroke(Color(uiColor: .separator), lineWidth: 0.5))
                            }
                        }
                    }
                }
                .padding(16)
            }
            .navigationTitle("Table")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { save(rows); dismiss() }.font(.body.weight(.semibold))
                }
                ToolbarItemGroup(placement: .bottomBar) {
                    Menu {
                        Button("Add Row") { rows.append(Array(repeating: "", count: rows.first?.count ?? 2)) }
                        Button("Add Column") { rows = rows.map { $0 + [""] } }
                        if rows.count > 1 { Button("Remove Last Row", role: .destructive) { rows.removeLast() } }
                        if (rows.first?.count ?? 0) > 1 { Button("Remove Last Column", role: .destructive) { rows = rows.map { Array($0.dropLast()) } } }
                    } label: { Label("Rows and Columns", systemImage: "tablecells.badge.ellipsis") }
                    Spacer()
                }
            }
        }
        .navigationViewStyle(.stack)
    }
}

// MARK: - Drawing

final class HubDrawingController: UIViewController {
    private let canvas = PKCanvasView()
    private let picker = PKToolPicker()
    private let initial: PKDrawing
    private let done: (PKDrawing) -> Void

    init(drawing: PKDrawing, done: @escaping (PKDrawing) -> Void) {
        initial = drawing
        self.done = done
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = String(localized: "Drawing")
        view.backgroundColor = .white
        canvas.drawing = initial
        canvas.backgroundColor = .white
        canvas.drawingPolicy = .anyInput
        canvas.overrideUserInterfaceStyle = .light
        canvas.frame = view.bounds
        canvas.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(canvas)
        navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in
            guard let self else { return }
            let drawing = self.canvas.drawing
            self.dismiss(animated: true) { self.done(drawing) }
        })
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        picker.setVisible(true, forFirstResponder: canvas)
        picker.addObserver(canvas)
        canvas.becomeFirstResponder()
    }
}

struct HubNoteImageViewer: View {
    let image: UIImage
    @Environment(\.dismiss) private var dismiss
    @State private var scale: CGFloat = 1

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            Image(uiImage: image).resizable().scaledToFit()
                .scaleEffect(scale)
                .gesture(MagnificationGesture().onChanged { scale = max(1, $0) }.onEnded { _ in withAnimation { if scale < 1.1 { scale = 1 } } })
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Button { dismiss() } label: {
                Image(systemName: "xmark.circle.fill").font(.title).symbolRenderingMode(.hierarchical).foregroundStyle(.white)
            }
            .padding()
            .accessibilityLabel("Close")
        }
    }
}
