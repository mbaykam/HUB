import UIKit

final class HubVoiceViewController: UIViewController {
    private let voice: HubNativeVoice
    private let openConversation: () -> Void
    private let restart: () -> Void
    private let status = UILabel()
    private let transcript = UITextView()
    private let mute = UIButton(type: .system)
    private let interrupt = UIButton(type: .system)
    private let end = UIButton(type: .system)
    private let attention = UIButton(type: .system)

    init(voice: HubNativeVoice, restart: @escaping () -> Void, openConversation: @escaping () -> Void) { self.voice = voice; self.restart = restart; self.openConversation = openConversation; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("Use init(voice:)") }
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Voice conversation"
        view.backgroundColor = UIColor(red: 0.04, green: 0.055, blue: 0.09, alpha: 1)
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Hide", style: .plain, target: self, action: #selector(hide))
        navigationItem.rightBarButtonItem = UIBarButtonItem(image: UIImage(systemName: "ellipsis.circle"), menu: UIMenu(children: [
            UIAction(title: "Open conversation", image: UIImage(systemName: "text.bubble")) { [weak self] _ in self?.openConversation() },
            UIAction(title: "Share a file", image: UIImage(systemName: "paperclip")) { [weak self] _ in self?.shareFile() },
            UIAction(title: "Reconnect audio", image: UIImage(systemName: "arrow.clockwise")) { [weak self] _ in self?.voice.reconnect() }
            ,UIAction(title: "Interrupt reply", image: UIImage(systemName: "hand.raised")) { [weak self] _ in self?.voice.interrupt() }
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
        status.textAlignment = .center
        status.textColor = .white
        status.accessibilityTraits = .updatesFrequently
        transcript.isEditable = false
        transcript.backgroundColor = .clear
        transcript.textColor = .secondaryLabel
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
        end.addAction(UIAction { [weak self] _ in guard let self else { return }; if self.voice.isActive { self.voice.end() } else { self.restart() } }, for: .touchUpInside)
        let actions = UIStackView(arrangedSubviews: [mute, attention])
        actions.distribution = .fillEqually; actions.spacing = 12
        let symbol = UIImageView(image: UIImage(systemName: "waveform.circle.fill"))
        symbol.contentMode = .scaleAspectFit; symbol.tintColor = UIColor(red: 0.7, green: 0.75, blue: 1, alpha: 1)
        symbol.heightAnchor.constraint(equalToConstant: 96).isActive = true
        symbol.isAccessibilityElement = false
        let stack = UIStackView(arrangedSubviews: [symbol, status, transcript, actions, end])
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
        mute.isEnabled = voice.isActive; interrupt.isEnabled = voice.isActive; end.isEnabled = true
        end.setTitle(voice.isActive ? "End conversation" : "Resume conversation", for: .normal)
        end.configuration?.baseBackgroundColor = voice.isActive ? .systemRed : .systemIndigo
        navigationItem.leftBarButtonItem?.title = voice.isActive ? "Hide" : "Close"
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
