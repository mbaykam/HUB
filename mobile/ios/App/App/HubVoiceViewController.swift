import UIKit
import SwiftUI
import HubNative

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
    private let canvas = UIButton(type: .system)
    private var canvasWatch: Task<Void, Never>?
    private var lastCanvasCall: String?
    private var lastSurfacedCanvas: UUID?
    private var latestCanvas: HubChatPresentation?

    init(voice: HubNativeVoice, restart: @escaping () -> Void, openConversation: @escaping () -> Void) { self.voice = voice; self.restart = restart; self.openConversation = openConversation; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("Use init(voice:)") }
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Voice conversation"
        view.backgroundColor = HubWorkspacePalette.background
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Hide", style: .plain, target: self, action: #selector(hide))
        navigationItem.rightBarButtonItem = UIBarButtonItem(image: UIImage(systemName: "ellipsis.circle"), menu: UIMenu(children: [
            UIAction(title: "Open conversation", image: UIImage(systemName: "text.bubble")) { [weak self] _ in self?.openConversation() },
            UIAction(title: "Canvas", image: UIImage(systemName: "rectangle.on.rectangle")) { [weak self] _ in self?.openCanvas() },
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
        status.textColor = .label
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
        canvas.configuration = .tinted()
        canvas.isHidden = true
        canvas.setTitle("Open Canvas", for: .normal)
        canvas.addAction(UIAction { [weak self] _ in self?.openCanvas() }, for: .touchUpInside)
        end.configuration = .filled(); end.configuration?.baseBackgroundColor = .systemRed
        end.setTitle("End conversation", for: .normal)
        end.addAction(UIAction { [weak self] _ in guard let self else { return }; if self.voice.isActive { self.voice.end() } else { self.restart() } }, for: .touchUpInside)
        let actions = UIStackView(arrangedSubviews: [mute, interrupt])
        actions.distribution = .fillEqually; actions.spacing = 12
        let symbol = UIImageView(image: UIImage(systemName: "waveform.circle.fill"))
        symbol.contentMode = .scaleAspectFit; symbol.tintColor = .label
        symbol.heightAnchor.constraint(equalToConstant: 96).isActive = true
        symbol.isAccessibilityElement = false
        let stack = UIStackView(arrangedSubviews: [symbol, status, canvas, transcript, attention, actions, end])
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

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        watchCanvas()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        canvasWatch?.cancel()
        canvasWatch = nil
    }

    private func watchCanvas() {
        guard canvasWatch == nil else { return }
        canvasWatch = Task { [weak self] in
            while !Task.isCancelled {
                let seconds = await self?.pollCanvas() ?? 0
                guard seconds > 0 else { return }
                try? await Task.sleep(nanoseconds: seconds * 1_000_000_000)
            }
        }
    }

    private func pollCanvas() async -> UInt64 {
        guard UIApplication.shared.applicationState == .active, view.window != nil, presentedViewController == nil,
              let context = voice.attachmentContext() else { return 3 }
        if lastCanvasCall != context.callID {
            lastCanvasCall = context.callID
            lastSurfacedCanvas = nil
            latestCanvas = nil
            canvas.isHidden = true
        }
        do {
            let presentation = try await context.voiceAPI.presentation(callID: context.callID)
            guard !Task.isCancelled, context.stillOwned(), view.window != nil else { return 0 }
            latestCanvas = presentation
            canvas.isHidden = presentation == nil
            if let presentation, lastSurfacedCanvas != presentation.id, presentedViewController == nil {
                openCanvas()
            }
            return 3
        } catch { return 8 }
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
        if !voice.isActive { canvas.isHidden = true }
    }
    @objc private func hide() { dismiss(animated: true) }
    private func openCanvas() {
        guard presentedViewController == nil else { return }
        guard let context = voice.attachmentContext() else {
            let alert = UIAlertController(title: "Canvas unavailable", message: "Connect to a voice conversation first.", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default))
            present(alert, animated: true)
            return
        }
        lastSurfacedCanvas = latestCanvas?.id
        present(UIHostingController(rootView: HubVoiceCanvasView(context: context)), animated: true)
    }
    private func shareFile() {
        guard let context = voice.attachmentContext(), let screen = try? HubAttachmentViewController(context: context) else {
            let alert = UIAlertController(title: "Files unavailable", message: "Wait for voice to connect, then try again. Unlock your iPhone if local storage is unavailable.", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default)); present(alert, animated: true); return
        }
        present(UINavigationController(rootViewController: screen), animated: true)
    }
}

@MainActor
private struct HubVoiceCanvasView: View {
    let context: HubVoiceAttachmentContext
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var latest: HubChatPresentation?
    @State private var shown: HubChatPresentation?
    @State private var html: String?
    @State private var renderID = UUID()
    @State private var liveUpdates = true
    @State private var retry = 0
    @State private var callEnded = false
    @State private var notice = "Looking for a presentation…"
    @State private var loadError = false

    private struct Refresh: Equatable {
        let active: Bool
        let attempt: Int
        let live: Bool
    }

    var body: some View {
        NavigationView {
            VStack(spacing: 12) {
                if callEnded {
                    Text("The voice call ended.").foregroundStyle(.secondary)
                } else if let html {
                    HubContainedDocumentView(document: html).id(renderID)
                } else {
                    Text(notice).font(.footnote).foregroundStyle(.secondary).padding(16)
                }
                if loadError {
                    Button("Retry") { retry += 1 }.padding(.bottom, 8)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle(shown?.title ?? "Voice Canvas")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Toggle("Live updates", isOn: $liveUpdates)
                        Button("Show latest") {
                            shown = nil
                            retry += 1
                        }
                        .disabled(latest == nil || latest == shown)
                        Button("Reset visual") { renderID = UUID() }.disabled(html == nil)
                    } label: {
                        Image(systemName: "ellipsis.circle").accessibilityLabel("Canvas options")
                    }
                    .disabled(callEnded)
                }
            }
        }
        .navigationViewStyle(.stack)
        .task(id: Refresh(active: scenePhase == .active, attempt: retry, live: liveUpdates)) {
            guard scenePhase == .active else { return }
            await follow()
        }
    }

    private func follow() async {
        while !Task.isCancelled {
            guard context.stillOwned() else {
                callEnded = true
                html = nil
                loadError = false
                return
            }
            do {
                let presentation = try await context.voiceAPI.presentation(callID: context.callID)
                try Task.checkCancellation()
                latest = presentation
                if let presentation, html == nil || ((liveUpdates || shown == nil) && shown != presentation) {
                    let document = try await context.voiceAPI.presentationDocument(callID: context.callID, id: presentation.id)
                    try Task.checkCancellation()
                    guard context.stillOwned() else { continue }
                    html = document
                    shown = presentation
                    renderID = UUID()
                } else if html == nil {
                    notice = "No presentation in this voice call yet."
                }
                loadError = false
            } catch {
                guard !Task.isCancelled else { return }
                loadError = true
                notice = "Could not load the voice presentation."
            }
            try? await Task.sleep(nanoseconds: loadError ? 6_000_000_000 : 2_000_000_000)
        }
    }
}
