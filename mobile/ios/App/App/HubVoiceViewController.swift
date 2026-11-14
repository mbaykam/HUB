import UIKit
import SwiftUI
import AVFoundation
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
    private let character = UIButton(type: .system)
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
            UIAction(title: "Camera", image: UIImage(systemName: "camera")) { [weak self] _ in self?.openCamera() },
            UIAction(title: "Voice personalities", image: UIImage(systemName: "person.wave.2")) { [weak self] _ in self?.openProfiles() },
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
        character.configuration = .tinted()
        character.setTitle("Choose character", for: .normal)
        character.isHidden = true
        character.addAction(UIAction { [weak self] _ in self?.openCharacters() }, for: .touchUpInside)
        end.configuration = .filled(); end.configuration?.baseBackgroundColor = .systemRed
        end.setTitle("End conversation", for: .normal)
        end.addAction(UIAction { [weak self] _ in guard let self else { return }; if self.voice.isActive { self.voice.end() } else { self.restart() } }, for: .touchUpInside)
        let actions = UIStackView(arrangedSubviews: [mute, interrupt])
        actions.distribution = .fillEqually; actions.spacing = 12
        let symbol = UIImageView(image: UIImage(systemName: "waveform.circle.fill"))
        symbol.contentMode = .scaleAspectFit; symbol.tintColor = .label
        symbol.heightAnchor.constraint(equalToConstant: 96).isActive = true
        symbol.isAccessibilityElement = false
        let stack = UIStackView(arrangedSubviews: [symbol, status, character, canvas, transcript, attention, actions, end])
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
        let canChooseCharacter = voice.hasOwnedActiveCall
        character.isHidden = !canChooseCharacter
        if !canChooseCharacter {
            character.setTitle("Choose character", for: .normal)
            character.accessibilityValue = nil
        }
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

    private func openCamera() {
        guard presentedViewController == nil else { return }
        guard let context = voice.attachmentContext(), context.stillOwned() else {
            let alert = UIAlertController(title: "Camera unavailable", message: "Connect to a voice conversation first.", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default))
            present(alert, animated: true)
            return
        }
        present(UIHostingController(rootView: HubVoicePhotoView(context: context)), animated: true)
    }

    private func openProfiles() {
        guard presentedViewController == nil else { return }
        let api = voice.conversationAPI()
        present(UIHostingController(rootView: NavigationView {
            HubVoiceProfilesView(api: api)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { [weak self] in self?.dismiss(animated: true) }
                    }
                }
        }.navigationViewStyle(.stack)), animated: true)
    }

    private func openCharacters() {
        guard presentedViewController == nil, let context = voice.attachmentContext(), context.stillOwned() else { return }
        let picker = HubChatCharacterView(sessionID: context.sessionID, api: voice.conversationAPI(), stillAvailable: context.stillOwned) { [weak self] name in
            self?.character.setTitle(name, for: .normal)
            self?.character.accessibilityLabel = "Choose character"
            self?.character.accessibilityValue = name
        }
        present(UIHostingController(rootView: picker), animated: true)
    }
}

@MainActor
private struct HubVoicePhotoView: View {
    let context: HubVoiceAttachmentContext
    @Environment(\.dismiss) private var dismiss
    @State private var showingCamera = false
    @State private var askingPermission = false
    @State private var photo: Data?
    @State private var instruction = ""
    @State private var receiptID = UUID()
    @State private var attempted = false
    @State private var uploaded = false
    @State private var sending = false
    @State private var sent = false
    @State private var notice = "Take a photo, review it, and send it to the current voice conversation."

    var body: some View {
        NavigationView {
            ScrollView(.vertical, showsIndicators: true) {
                VStack(alignment: .leading, spacing: 16) {
                    if let photo, let image = UIImage(data: photo) {
                        Image(uiImage: image).resizable().scaledToFit()
                            .frame(maxWidth: .infinity, maxHeight: 340)
                            .accessibilityLabel("Photo preview")
                        if !sent {
                            TextField("What should HUB look at?", text: $instruction)
                                .textFieldStyle(.roundedBorder).disabled(attempted)
                            Button(attempted ? "Retry photo" : "Send to HUB") { send(photo) }
                                .buttonStyle(.borderedProminent)
                                .disabled(sending || instruction.utf16.count > 4_000)
                        }
                    }
                    Button(photo == nil ? "Take photo" : sent ? "Take another" : "Retake") {
                        Task { await openCamera() }
                    }
                    .disabled(askingPermission || sending)
                    Text(notice).font(.footnote).foregroundStyle(.secondary)
                    if instruction.utf16.count > 4_000 {
                        Text("Use 4,000 characters or fewer.").font(.footnote)
                    }
                }
                .padding()
            }
            .navigationTitle("Camera")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.disabled(sending) }
            }
            .fullScreenCover(isPresented: $showingCamera) {
                HubStillCamera { image in
                    showingCamera = false
                    if let image { prepare(image) }
                }
                .ignoresSafeArea()
            }
        }
        .navigationViewStyle(.stack)
        .interactiveDismissDisabled(sending)
    }

    private func openCamera() async {
        guard !askingPermission, context.stillOwned() else { notice = "The voice conversation has ended."; return }
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            notice = "The iPhone camera is unavailable."
            return
        }
        askingPermission = true
        defer { askingPermission = false }
        let granted = await AVCaptureDevice.requestAccess(for: .video)
        guard granted else { notice = "Allow camera access in iPhone Settings to take a photo."; return }
        guard context.stillOwned() else { notice = "The voice conversation has ended."; return }
        showingCamera = true
    }

    private func prepare(_ image: UIImage) {
        let longestSide = max(image.size.width, image.size.height)
        guard longestSide.isFinite, image.size.width > 0, image.size.height > 0 else {
            notice = "The photo could not be prepared. Try taking it again."
            return
        }
        let scale = min(1, 1920 / longestSide)
        let size = CGSize(width: max(1, image.size.width * scale), height: max(1, image.size.height * scale))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let rendered = UIGraphicsImageRenderer(size: size, format: format).jpegData(withCompressionQuality: 0.92) { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        photo = rendered
        if sent { instruction = "" }
        receiptID = UUID()
        attempted = false
        uploaded = false
        sent = false
        notice = "Review the photo before you send it."
    }

    private func send(_ jpeg: Data) {
        guard !sending, !sent, instruction.utf16.count <= 4_000 else { return }
        guard context.stillOwned() else { notice = "The voice conversation has ended."; return }
        let id = receiptID
        let question = instruction
        attempted = true
        sending = true
        Task {
            defer { sending = false }
            do {
                if !uploaded {
                    notice = "Uploading photo…"
                    try await context.uploadAPI.uploadVoicePhoto(jpeg, sessionID: context.sessionID, callID: context.callID, uploadID: id)
                    uploaded = true
                }
                guard context.stillOwned() else { throw HubAttachmentError.callEnded }
                notice = "Sharing with the voice assistant…"
                try await context.voiceAPI.share(callId: context.callID, uploadID: id, requestID: id, instruction: question)
                sent = true
                notice = "Photo shared. You can keep talking while HUB looks at it."
            } catch HubAttachmentError.callEnded {
                notice = "The voice conversation ended before sharing was confirmed."
            } catch HubVoiceAPIError.callUnavailable {
                notice = "The voice conversation ended before sharing was confirmed."
            } catch {
                notice = "Sharing could not be confirmed. Retry to use the same request."
            }
        }
    }
}

@MainActor
private struct HubStillCamera: UIViewControllerRepresentable {
    let finish: (UIImage?) -> Void

    func makeUIViewController(context: Context) -> UIViewController {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            return UIHostingController(rootView: VStack(spacing: 16) {
                Text("The iPhone camera is unavailable.")
                Button("Close") { finish(nil) }
            }.padding())
        }
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(finish: finish) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let finish: (UIImage?) -> Void
        init(finish: @escaping (UIImage?) -> Void) { self.finish = finish }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { finish(nil) }
        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            finish(info[.originalImage] as? UIImage)
        }
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
