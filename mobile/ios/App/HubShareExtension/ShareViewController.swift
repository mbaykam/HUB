import UIKit
import UniformTypeIdentifiers
import HubNative

/// Copies explicitly selected content locally; no credentials, networking,
/// WebKit, JavaScript bridge or unsupported launch-the-containing-app tricks.
@MainActor final class ShareViewController: UIViewController {
    private let status = UILabel()
    private let save = UIButton(type: .system)
    private let cancel = UIButton(type: .system)
    private var saving = false
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .systemBackground
        status.text = "Save one file or photo to HUB on this iPhone (up to 10 MB). Open HUB, start Voice and review it under Share a file before sending. Nothing is uploaded here."
        status.numberOfLines = 0; status.font = .preferredFont(forTextStyle: .body); status.adjustsFontForContentSizeCategory = true
        save.configuration = .filled(); save.setTitle("Save to HUB", for: .normal)
        save.addAction(UIAction { [weak self] _ in self?.saveSelected() }, for: .touchUpInside)
        cancel.setTitle("Cancel", for: .normal)
        cancel.addAction(UIAction { [weak self] _ in self?.extensionContext?.completeRequest(returningItems: nil) }, for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [status, save, cancel]); stack.axis = .vertical; stack.spacing = 20; stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24), stack.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor), save.heightAnchor.constraint(greaterThanOrEqualToConstant: 48)])
    }
    private func saveSelected() {
        guard !saving else { return }
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        guard providers.count == 1, let provider = providers.first,
              let type = provider.registeredTypeIdentifiers.first(where: { id in
                  guard let type = UTType(id) else { return false }; return type.conforms(to: .data) && !type.conforms(to: .url)
              }), let inbox = try? HubShareInbox.appGroupInbox() else {
            status.text = "Choose one supported file or photo. This signed build must also have HUB's App Group enabled."; return
        }
        saving = true; save.isEnabled = false; cancel.isEnabled = false; status.text = "Saving a private local copy…"
        provider.loadFileRepresentation(forTypeIdentifier: type) { [weak self] url, error in
            // Apple's provider URL is valid only inside this callback. Copy its
            // bounded bytes before returning; never persist an external path.
            let result: Result<Data, Error> = Result {
                guard error == nil, let url else { throw HubAttachmentError.invalidFile }
                return try HubShareInbox.readSelectedFile(url)
            }
            var name = provider.suggestedName ?? url?.lastPathComponent ?? "Shared file"
            if (name as NSString).pathExtension.isEmpty, let suffix = UTType(type)?.preferredFilenameExtension { name += "." + suffix }
            Task { @MainActor in
                guard let self else { return }
                do {
                    _ = try await inbox.save(result.get(), name: name)
                    self.extensionContext?.completeRequest(returningItems: nil)
                } catch {
                    self.saving = false; self.save.isEnabled = true; self.cancel.isEnabled = true
                    switch error {
                    case HubAttachmentError.full: self.status.text = "Eight files are waiting in HUB. Open HUB to import or remove one, then retry."
                    case HubAttachmentError.tooLarge: self.status.text = "Choose a nonempty file of 10 MB or less."
                    default: self.status.text = "The file could not be saved. Your original was not changed. Try again or cancel."
                    }
                }
            }
        }
    }
}
