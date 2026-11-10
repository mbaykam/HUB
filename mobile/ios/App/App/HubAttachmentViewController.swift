import UIKit
import UniformTypeIdentifiers
import HubNative

struct HubVoiceAttachmentContext {
    let server: HubServer
    let sessionID: String
    let callID: String
    let voiceAPI: HubVoiceAPI
    let uploadAPI: HubAttachmentAPI
    let stillOwned: () -> Bool
}

@MainActor final class HubAttachmentViewController: UITableViewController, UIDocumentPickerDelegate {
    private let context: HubVoiceAttachmentContext
    private let store: HubAttachmentStore
    private var items: [HubAttachmentDraft] = []
    private var busy = false
    private var message = "Choose a file, then confirm Send. Your voice conversation stays active."
    init(context: HubVoiceAttachmentContext) throws {
        self.context = context
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        store = try HubAttachmentStore(root: base.appendingPathComponent("HubAttachmentOutbox", isDirectory: true))
        super.init(style: .insetGrouped)
    }
    required init?(coder: NSCoder) { fatalError("Use init(context:)") }
    override func viewDidLoad() {
        super.viewDidLoad(); title = "Share a file"
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
        tableView.rowHeight = UITableView.automaticDimension; tableView.estimatedRowHeight = 60
        reloadDrafts()
    }
    private func reloadDrafts() {
        Task {
            do { items = try await store.drafts(server: context.server) }
            catch { message = "Saved files could not be read. They have been preserved." }
            tableView.reloadData()
        }
    }
    override func numberOfSections(in tableView: UITableView) -> Int { 3 }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { section == 2 ? items.count : 1 }
    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? { section == 2 ? "Pending files" : nil }
    override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
        section == 1 ? "Up to 8 pending files, 25 MB each. Sending retains the original on HUB and shares it with this voice conversation. Reading a file depends on its format and the selected model." : nil
    }
    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
        cell.textLabel?.numberOfLines = 0; cell.detailTextLabel?.numberOfLines = 0
        cell.textLabel?.font = .preferredFont(forTextStyle: .body); cell.textLabel?.adjustsFontForContentSizeCategory = true
        if indexPath.section == 0 {
            cell.textLabel?.text = message; cell.selectionStyle = .none; cell.accessibilityTraits = [.staticText, .updatesFrequently]
        } else if indexPath.section == 1 {
            cell.textLabel?.text = "Choose from Files"; cell.imageView?.image = UIImage(systemName: "folder")
            cell.textLabel?.textColor = busy ? .secondaryLabel : .systemBlue; cell.accessibilityTraits = .button
        } else {
            let draft = items[indexPath.row]
            cell.textLabel?.text = draft.name
            let matching = owns(draft)
            cell.detailTextLabel?.text = ByteCountFormatter.string(fromByteCount: Int64(draft.bytes), countStyle: .file) + (matching ? " · Tap to review and send" : " · From another call; kept locally")
            cell.accessoryType = .disclosureIndicator
        }
        return cell
    }
    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        guard !busy else { return }
        if indexPath.section == 1 {
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
            picker.allowsMultipleSelection = false; picker.delegate = self
            present(picker, animated: true)
        } else if indexPath.section == 2 { review(items[indexPath.row]) }
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first, !busy else { return }
        busy = true; message = "Preparing your file locally…"; tableView.reloadData()
        Task {
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() }; busy = false; reloadDrafts() }
            do {
                guard context.stillOwned() else { throw HubAttachmentError.callEnded }
                _ = try await store.stage(source: url, server: context.server, sessionID: context.sessionID, callID: context.callID)
                message = "Ready. Tap the file below to review and send. Nothing has been uploaded yet."
            } catch { message = describe(error) }
        }
    }
    private func owns(_ draft: HubAttachmentDraft) -> Bool { draft.sessionID == context.sessionID && draft.callID == context.callID && context.stillOwned() }
    private func review(_ draft: HubAttachmentDraft) {
        let sheet = UIAlertController(title: draft.name, message: owns(draft) ? "Send this file to the current voice conversation? HUB will retain the original. You can continue speaking while it uploads." : "This file belongs to a different or ended call. It will not be sent to your current conversation. Your local copy is preserved.", preferredStyle: .alert)
        if owns(draft) { sheet.addAction(UIAlertAction(title: "Send to conversation", style: .default) { [weak self] _ in self?.send(draft) }) }
        sheet.addAction(UIAlertAction(title: "Remove local draft", style: .destructive) { [weak self] _ in
            guard let self else { return }
            Task { do { try await self.store.discard(draft); self.message = "Local draft removed. The original selected file was not changed." } catch { self.message = "Could not remove the local draft." }; self.reloadDrafts() }
        })
        sheet.addAction(UIAlertAction(title: "Keep for later", style: .cancel))
        present(sheet, animated: true)
    }
    private func send(_ draft: HubAttachmentDraft) {
        guard !busy else { return }; busy = true; isModalInPresentation = true
        navigationItem.rightBarButtonItem?.isEnabled = false
        message = "Uploading \(draft.name)…"; tableView.reloadData()
        Task {
            defer { busy = false; isModalInPresentation = false; navigationItem.rightBarButtonItem?.isEnabled = true; reloadDrafts() }
            do {
                guard owns(draft) else { throw HubAttachmentError.callEnded }
                let data = try await store.bytes(draft, server: context.server, sessionID: context.sessionID, callID: context.callID)
                try await context.uploadAPI.upload(draft, bytes: data)
                guard owns(draft) else { throw HubAttachmentError.callEnded }
                message = "Uploaded. Confirming receipt in your conversation…"; tableView.reloadData()
                try await context.voiceAPI.share(callId: context.callID, uploadID: draft.id, requestID: draft.requestID)
                try await store.discard(draft)
                message = "Sent to your voice conversation. The original is retained on HUB."
            } catch { message = describe(error) + " Your draft is kept. Retry uses the same receipt." }
        }
    }
    private func describe(_ error: Error) -> String {
        switch error {
        case HubAttachmentError.tooLarge: return "Choose a nonempty file of 25 MB or less."
        case HubAttachmentError.full: return "Eight files are pending. Send or remove a draft first."
        case HubAttachmentError.signInRequired, HubVoiceAPIError.signInRequired: return "Sign in to HUB again, then retry."
        case HubAttachmentError.callEnded, HubVoiceAPIError.callUnavailable: return "The original voice call has ended."
        default: return "The file could not be sent. Check your connection and try again."
        }
    }
}
