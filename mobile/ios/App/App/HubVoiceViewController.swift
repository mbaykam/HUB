import UIKit

final class HubVoiceViewController: UIViewController {
    private let voice: HubNativeVoice
    private let openConversation: () -> Void
    private let status = UILabel()
    private let transcript = UITextView()
    private let mute = UIButton(type: .system)
    private let interrupt = UIButton(type: .system)
    private let end = UIButton(type: .system)
    private let attention = UIButton(type: .system)

    init(voice: HubNativeVoice, openConversation: @escaping () -> Void) { self.voice = voice; self.openConversation = openConversation; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("Use init(voice:)") }
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Voice conversation"
        view.backgroundColor = .systemBackground
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Hide", style: .plain, target: self, action: #selector(hide))
        navigationItem.rightBarButtonItem = UIBarButtonItem(image: UIImage(systemName: "ellipsis.circle"), menu: UIMenu(children: [
            UIAction(title: "Open conversation", image: UIImage(systemName: "text.bubble")) { [weak self] _ in self?.openConversation() },
            UIAction(title: "Share a file", image: UIImage(systemName: "paperclip")) { [weak self] _ in self?.shareFile() },
            UIAction(title: "Reconnect audio", image: UIImage(systemName: "arrow.clockwise")) { [weak self] _ in self?.voice.reconnect() }
        ]))
        navigationItem.rightBarButtonItem?.accessibilityLabel = "Voice options"
        #if canImport(ScreenCaptureKit)
        if #available(iOS 27.0, *) {
            let screen = UIAction(title: "Share screen", image: UIImage(systemName: "rectangle.on.rectangle")) { [weak self] _ in
                guard let self, let context = self.voice.attachmentContext(), let screen = try? HubScreenViewController(context: context) else { return }
                self.present(UINavigationController(rootViewController: screen), animated: true)
            }
            if let menu = navigationItem.rightBarButtonItem?.menu { navigationItem.rightBarButtonItem?.menu = UIMenu(children: menu.children + [screen]) }
        }
        #endif
        status.font = .preferredFont(forTextStyle: .headline)
        status.adjustsFontForContentSizeCategory = true
        status.numberOfLines = 0
        status.accessibilityTraits = .updatesFrequently
        transcript.isEditable = false
        transcript.font = .preferredFont(forTextStyle: .body)
        transcript.adjustsFontForContentSizeCategory = true
        transcript.accessibilityLabel = "Conversation transcript"
        mute.configuration = .tinted()
        mute.addAction(UIAction { [weak self] _ in self?.voice.toggleMute() }, for: .touchUpInside)
        interrupt.configuration = .tinted(); interrupt.setTitle("Interrupt", for: .normal)
        interrupt.addAction(UIAction { [weak self] _ in self?.voice.interrupt() }, for: .touchUpInside)
        attention.configuration = .tinted()
        attention.addAction(UIAction { [weak self] _ in self?.voice.toggleAttention() }, for: .touchUpInside)
        end.configuration = .filled(); end.configuration?.baseBackgroundColor = .systemRed
        end.setTitle("End conversation", for: .normal)
        end.addAction(UIAction { [weak self] _ in self?.voice.end() }, for: .touchUpInside)
        let actions = UIStackView(arrangedSubviews: [mute, interrupt])
        actions.distribution = .fillEqually; actions.spacing = 12
        let stack = UIStackView(arrangedSubviews: [status, transcript, attention, actions, end])
        stack.axis = .vertical; stack.spacing = 16; stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -16),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
            mute.heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
            attention.heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
            end.heightAnchor.constraint(greaterThanOrEqualToConstant: 48)
        ])
        refresh()
    }
    func refresh() {
        status.text = voice.status
        transcript.text = voice.transcript.isEmpty ? "Your conversation will appear here. Hide returns to HUB while keeping the call active. End stops the microphone." : voice.transcript
        mute.setTitle(voice.muted ? "Unmute" : "Mute", for: .normal)
        attention.setTitle(voice.changingAttention ? "Changing listening mode…" : voice.listeningInBackground ? "Resume conversation" : "Background listening", for: .normal)
        attention.isEnabled = voice.canChangeAttention
        mute.isEnabled = voice.isActive; interrupt.isEnabled = voice.isActive; end.isEnabled = voice.isActive
    }
    @objc private func hide() { dismiss(animated: true) }
    private func shareFile() {
        guard let context = voice.attachmentContext(), let screen = try? HubAttachmentViewController(context: context) else {
            let alert = UIAlertController(title: "Files unavailable", message: "Wait for voice to connect, then try again. Unlock your iPhone if local storage is unavailable.", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default)); present(alert, animated: true); return
        }
        present(UINavigationController(rootViewController: screen), animated: true)
    }
}
