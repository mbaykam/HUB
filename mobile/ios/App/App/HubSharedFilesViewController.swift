import UIKit
import UniformTypeIdentifiers
import HubNative

/// System-share inbox is user-mediated. No microphone or assistant is started.
@MainActor final class HubSharedFilesViewController: UITableViewController, UIDocumentPickerDelegate {
    private let server: HubServer
    private let inbox: HubShareInbox
    private let store: HubAttachmentStore
    private let catalog: HubConversationAPI
    private let upload: HubAttachmentAPI
    private let stillConnected: () -> Bool
    private let openDraft: (URL) -> Void
    private var shared: [HubSharedFile] = []
    private var pending: [HubAttachmentDraft] = []
    private var recovery: [(id: UUID, damaged: Bool)] = []
    private var busy = false { didSet { isModalInPresentation = busy; navigationController?.isModalInPresentation = busy; navigationItem.rightBarButtonItem?.isEnabled = !busy } }
    private var message = "Choose a saved file and its conversation. Review the message in HUB before pressing Send."
    init(server: HubServer, state: HubDeviceState, stillConnected: @escaping () -> Bool, openDraft: @escaping (URL) -> Void) throws {
        self.server = server; self.stillConnected = stillConnected; self.openDraft = openDraft
        inbox = try HubShareInbox.appGroupInbox()
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        store = try HubAttachmentStore(root: base.appendingPathComponent("HubAttachmentOutbox", isDirectory: true))
        catalog = HubConversationAPI(server: server) { (try? state.cookies()) ?? [] }
        upload = HubAttachmentAPI(server: server) { (try? state.cookies()) ?? [] }
        super.init(style: .insetGrouped)
    }
    required init?(coder: NSCoder) { fatalError("Use init(server:state:)") }
    override func viewDidLoad() {
        super.viewDidLoad(); title = "Files"
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
        tableView.rowHeight = UITableView.automaticDimension; tableView.estimatedRowHeight = 64; reload()
    }
    private func reload() {
        Task {
            do { shared = try await inbox.list() }
            catch { message = "The sharing inbox could not be read. Unlock the iPhone and retry; your copies are preserved." }
            do {
                let value = try await store.recovery(); pending = value.drafts
                recovery = value.incompleteCopies.map { ($0, false) } + value.damagedCopies.map { ($0, true) }
            } catch { message = "Prepared files could not be read. Unlock the iPhone and retry; your copies are preserved." }
            tableView.reloadData()
        }
    }
    override func numberOfSections(in tableView: UITableView) -> Int { 5 }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { section < 2 ? 1 : section == 2 ? shared.count : section == 3 ? pending.count : recovery.count }
    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? { section == 2 ? "Saved from other apps" : section == 3 ? "Prepared copies on this iPhone" : section == 4 && !recovery.isEmpty ? "Interrupted preparation" : nil }
    override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
        section == 1 ? "Up to 8 saved files, 10 MB each. Nothing is uploaded until you choose a conversation and confirm. Swipe a saved file to remove its local copy. The normal HUB composer also accepts files directly." : section == 3 ? "Prepared copies keep their original conversation for safe retries. After sending in HUB, you can explicitly remove the local copy here." : nil
    }
    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
        cell.textLabel?.numberOfLines = 0; cell.detailTextLabel?.numberOfLines = 0
        cell.textLabel?.font = .preferredFont(forTextStyle: .body); cell.textLabel?.adjustsFontForContentSizeCategory = true
        switch indexPath.section {
        case 0: cell.textLabel?.text = message; cell.selectionStyle = .none; cell.accessibilityTraits = [.staticText, .updatesFrequently]
        case 1: cell.textLabel?.text = "Choose from Files"; cell.imageView?.image = UIImage(systemName: "folder"); cell.accessibilityTraits = .button
        case 2: cell.textLabel?.text = shared[indexPath.row].name; cell.detailTextLabel?.text = "Tap to choose a conversation"; cell.accessoryType = .disclosureIndicator
        case 3:
            let draft = pending[indexPath.row]
            cell.textLabel?.text = draft.name
            cell.detailTextLabel?.text = draft.origin != server.origin.absoluteString ? "From another HUB · Local copy only" : draft.callID == "text-composer" ? "Prepared for its saved conversation · Tap to review" : "From a voice call · Tap to review or copy"
            cell.accessoryType = .disclosureIndicator
        default: cell.textLabel?.text = recovery[indexPath.row].damaged ? "Unreadable local receipt" : "Incomplete local copy"; cell.detailTextLabel?.text = "Cannot be sent safely · Tap to review local removal"; cell.accessoryType = .disclosureIndicator
        }
        return cell
    }
    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true); guard !busy else { return }
        if indexPath.section == 1 {
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true); picker.delegate = self; present(picker, animated: true)
        } else if indexPath.section == 2 {
            let item = shared[indexPath.row]
            let picker = HubConversationPicker(api: catalog) { [weak self] choice in self?.review(item, choice: choice) }
            navigationController?.pushViewController(picker, animated: true)
        } else if indexPath.section == 3 { review(pending[indexPath.row]) }
        else if indexPath.section == 4 { reviewRecovery(recovery[indexPath.row]) }
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first, !busy else { return }; busy = true
        Task {
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() }; busy = false; reload() }
            do { let data = try HubShareInbox.readSelectedFile(url); _ = try await inbox.save(data, name: url.lastPathComponent); message = "Saved locally. Tap the file to choose its conversation." }
            catch { message = "Could not save this copy. Choose a nonempty file up to 10 MB; at most eight can wait here." }
        }
    }
    override func tableView(_ tableView: UITableView, trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath) -> UISwipeActionsConfiguration? {
        guard indexPath.section == 2, !busy else { return nil }; let item = shared[indexPath.row]
        let action = UIContextualAction(style: .destructive, title: "Remove copy") { [weak self] _, _, complete in
            guard let self else { complete(false); return }
            let alert = UIAlertController(title: "Remove saved copy?", message: "Remove \(item.name) from this iPhone's sharing inbox? The original in the other app stays intact.", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Keep", style: .cancel) { _ in complete(false) })
            alert.addAction(UIAlertAction(title: "Remove copy", style: .destructive) { _ in
                self.busy = true
                Task { defer { self.busy = false; self.reload() }; do { try await self.inbox.remove(item); complete(true) } catch { self.message = "Could not remove the saved copy."; complete(false) } }
            })
            self.present(alert, animated: true)
        }
        let config = UISwipeActionsConfiguration(actions: [action]); config.performsFirstActionWithFullSwipe = false; return config
    }
    private func review(_ item: HubSharedFile, choice: HubConversationChoice) {
        navigationController?.popToViewController(self, animated: false)
        let alert = UIAlertController(title: item.name, message: "Prepare this file for “\(choice.title)” on \(server.origin.host ?? "HUB")? HUB will retain the original. You will review the message and press Send separately; this does not start an assistant task.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Prepare message", style: .default) { [weak self] _ in
            guard let self, !self.busy else { return }; self.busy = true
            Task {
                defer { self.busy = false; self.reload() }
                do {
                    guard self.stillConnected() else { throw HubAttachmentError.signInRequired }
                    let data = try await self.inbox.bytes(item)
                    let draft = try await self.store.stage(data: data, name: item.name, server: self.server, sessionID: choice.sessionId, callID: "text-composer", id: item.id, requestID: item.id)
                    try await self.inbox.remove(item)
                    try await self.prepare(draft)
                } catch { self.message = self.describe(error) }
            }
        })
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        // Wait for the navigation pop before presenting on its visible parent.
        DispatchQueue.main.async { [weak self] in self?.present(alert, animated: true) }
    }
    private func review(_ draft: HubAttachmentDraft) {
        let sameServer = draft.origin == server.origin.absoluteString
        let text = sameServer ? "You can review this copy or prepare a message. Nothing is sent to an assistant until you press Send in HUB." : "This local copy belongs to another HUB. It cannot be uploaded through your current connection. Keeping or removing this local copy does not change the original."
        let alert = UIAlertController(title: draft.name, message: text, preferredStyle: .alert)
        if sameServer && draft.callID == "text-composer" { alert.addAction(UIAlertAction(title: "Open message draft", style: .default) { [weak self] _ in
            guard let self, !self.busy else { return }; self.busy = true
            Task { defer { self.busy = false; self.reload() }; do { try await self.prepare(draft) } catch { self.message = self.describe(error) } }
        }) }
        if sameServer { alert.addAction(UIAlertAction(title: "Copy to a conversation", style: .default) { [weak self] _ in
            guard let self else { return }
            self.navigationController?.pushViewController(HubConversationPicker(api: self.catalog) { [weak self] choice in self?.reviewCopy(draft, choice: choice) }, animated: true)
        }) }
        alert.addAction(UIAlertAction(title: "Remove local copy", style: .destructive) { [weak self] _ in
            guard let self, !self.busy else { return }; self.busy = true
            Task { defer { self.busy = false; self.reload() }; do { try await self.store.discard(draft); self.message = "Local copy removed. Other originals and HUB files were not changed." } catch { self.message = "Could not remove this local copy." } }
        })
        alert.addAction(UIAlertAction(title: "Keep", style: .cancel)); present(alert, animated: true)
    }
    private func prepare(_ draft: HubAttachmentDraft) async throws {
        guard stillConnected() else { throw HubAttachmentError.signInRequired }
        let bytes = try await store.bytes(draft, server: server, sessionID: draft.sessionID, callID: "text-composer")
        message = "Preparing your message…"; tableView.reloadData()
        try await upload.upload(draft, bytes: bytes)
        // Older hosts can accept a file but cannot hand it to the composer.
        // Confirm the exact receipt capability before claiming a draft opened.
        let url = try await catalog.confirmedDraftURL(draft)
        guard stillConnected() else { throw HubAttachmentError.signInRequired }
        dismiss(animated: true) { [openDraft] in openDraft(url) }
    }
    private func describe(_ error: Error) -> String {
        switch error {
        case HubAttachmentError.full: return "Eight prepared copies are waiting. Review Prepared copies or Interrupted preparation and explicitly remove an unneeded local copy, then retry. Nothing was deleted."
        case HubAttachmentError.signInRequired: return "Sign in to HUB again, then retry. Your saved copy is preserved."
        case HubAttachmentError.wrongConversation: return "This copy is already assigned. Retry its saved entry in Prepared copies; it was not moved."
        default: return "HUB could not confirm the message draft. Reconnect or update the HUB host, then retry its Prepared copy. Your copies are preserved."
        }
    }
    private func reviewRecovery(_ item: (id: UUID, damaged: Bool)) {
        let alert = UIAlertController(title: "Remove unfinished local copy?", message: "This copy has no usable conversation receipt, so it cannot be sent safely. Removing it frees its pending-file slot. The original selected file and files on HUB stay intact.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Keep", style: .cancel))
        alert.addAction(UIAlertAction(title: "Remove unfinished copy", style: .destructive) { [weak self] _ in
            guard let self, !self.busy else { return }; self.busy = true
            Task {
                defer { self.busy = false; self.reload() }
                do {
                    if item.damaged { try await self.store.discardDamagedCopy(item.id) } else { try await self.store.discardIncompleteCopy(item.id) }
                    self.message = "Unfinished local copy removed. The selected original was not changed."
                } catch { self.message = "Could not remove this copy. Your files were preserved." }
            }
        })
        present(alert, animated: true)
    }
    private func reviewCopy(_ draft: HubAttachmentDraft, choice: HubConversationChoice) {
        navigationController?.popToViewController(self, animated: false)
        let alert = UIAlertController(title: draft.name, message: "Copy this file to “\(choice.title)” on the current HUB? The previous copy stays intact. You will review the message and press Send separately.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Prepare copy", style: .default) { [weak self] _ in
            guard let self, !self.busy else { return }; self.busy = true
            Task {
                defer { self.busy = false; self.reload() }
                do {
                    guard self.stillConnected() else { throw HubAttachmentError.signInRequired }
                    let copy = try await self.store.copy(draft, server: self.server, sessionID: choice.sessionId, callID: "text-composer")
                    try await self.prepare(copy)
                } catch { self.message = self.describe(error) }
            }
        })
        alert.addAction(UIAlertAction(title: "Keep", style: .cancel)); DispatchQueue.main.async { [weak self] in self?.present(alert, animated: true) }
    }
}

@MainActor private final class HubConversationPicker: UITableViewController, UISearchResultsUpdating {
    private let api: HubConversationAPI
    private let choose: (HubConversationChoice) -> Void
    private var items: [HubConversationChoice] = []
    private var work: Task<Void, Never>?
    private var generation = 0
    private let search = UISearchController(searchResultsController: nil)
    init(api: HubConversationAPI, choose: @escaping (HubConversationChoice) -> Void) { self.api = api; self.choose = choose; super.init(style: .insetGrouped) }
    required init?(coder: NSCoder) { fatalError("Use init(api:choose:)") }
    deinit { work?.cancel() }
    override func viewDidLoad() {
        super.viewDidLoad(); title = "Choose conversation"; search.searchResultsUpdater = self; search.obscuresBackgroundDuringPresentation = false
        search.searchBar.placeholder = "Search conversations"; navigationItem.searchController = search; definesPresentationContext = true
        updateSearchResults(for: search)
    }
    func updateSearchResults(for searchController: UISearchController) {
        generation += 1; let current = generation, query = searchController.searchBar.text ?? ""; work?.cancel()
        work = Task {
            do {
                try await Task.sleep(nanoseconds: 300_000_000)
                let result = try await api.list(search: query)
                guard !Task.isCancelled, generation == current else { return }
                items = result.conversations; tableView.reloadData()
                let label = UILabel(); label.numberOfLines = 0; label.textAlignment = .center
                label.text = result.hasMore ? "Search to find older conversations." : items.isEmpty ? "No matching conversations." : nil
                tableView.backgroundView = label
            } catch {
                guard !Task.isCancelled, generation == current else { return }; items = []; tableView.reloadData()
                let label = UILabel(); label.numberOfLines = 0; label.textAlignment = .center
                label.text = "Could not load conversations. Sign in or update the HUB host, then search again."; tableView.backgroundView = label
            }
        }
    }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { items.count }
    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil), item = items[indexPath.row]
        cell.textLabel?.text = item.title; cell.textLabel?.numberOfLines = 0; cell.accessoryType = .disclosureIndicator
        cell.detailTextLabel?.text = Date(timeIntervalSince1970: item.updatedAt / 1000).formatted(date: .abbreviated, time: .shortened); return cell
    }
    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) { search.isActive = false; choose(items[indexPath.row]) }
}
