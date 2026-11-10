#if canImport(ScreenCaptureKit)
import UIKit
import HubNative

@available(iOS 27.0, *)
@MainActor final class HubScreenViewController: UIViewController, UIAdaptivePresentationControllerDelegate {
    private let context: HubVoiceAttachmentContext
    private let capture: HubScreenCaptureSession
    private let live: HubLiveScreenSharing
    private let mode = UISegmentedControl(items: ["Review frame", "Live"])
    private var liveRequested = false
    private let message = UILabel()
    private let preview = UIImageView()
    private let send = UIButton(type: .system)
    private var frame: HubScreenFrame?
    private var busy = false
    private var observers: [NSObjectProtocol] = []
    private var backgroundAt: Date?
    private var timer: Timer?
    init(context: HubVoiceAttachmentContext) throws {
        self.context = context; capture = try HubScreenCaptureSession(context: context)
        live = HubLiveScreenSharing(consent: { id, start in try await context.voiceAPI.screenConsent(callId: context.callID, shareID: id, start: start) }, upload: { id, sequence, frame in try await context.voiceAPI.screenFrame(callId: context.callID, shareID: id, sequence: sequence, frame: frame) }, owned: context.stillOwned)
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("Use init(context:)") }
    deinit {
        timer?.invalidate(); observers.forEach(NotificationCenter.default.removeObserver)
        let capture = capture, live = live; Task { @MainActor in live.stop(); capture.stop() }
    }
    override func viewDidLoad() {
        super.viewDidLoad(); title = "Share screen"; view.backgroundColor = .systemBackground
        navigationController?.presentationController?.delegate = self
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in self?.close() })
        message.numberOfLines = 0; message.font = .preferredFont(forTextStyle: .body); message.adjustsFontForContentSizeCategory = true
        message.text = "Start sharing with Apple's picker, switch to what you want to show, then return. We'll freeze a recent frame for you to review. Nothing is sent until you choose Send. Voice can continue."
        preview.contentMode = .scaleAspectFit; preview.accessibilityLabel = "Frozen screen frame to review"
        let start = UIButton(type: .system); start.configuration = .tinted(); start.setTitle("Choose screen", for: .normal)
        start.addAction(UIAction { [weak self] _ in self?.chooseScreen() }, for: .touchUpInside)
        let freeze = UIButton(type: .system); freeze.configuration = .tinted(); freeze.setTitle("Freeze frame", for: .normal)
        freeze.addAction(UIAction { [weak self] _ in self?.freeze() }, for: .touchUpInside)
        let stop = UIButton(type: .system); stop.setTitle("Stop sharing", for: .normal)
        stop.addAction(UIAction { [weak self] _ in self?.stopSharing() }, for: .touchUpInside)
        send.configuration = .filled(); send.setTitle("Send reviewed frame", for: .normal); send.isEnabled = false
        send.addAction(UIAction { [weak self] _ in self?.confirmSend() }, for: .touchUpInside)
        let actions = UIStackView(arrangedSubviews: [start, freeze]); actions.distribution = .fillEqually; actions.spacing = 12
        mode.selectedSegmentIndex = 0
        mode.addAction(UIAction { [weak self] _ in
            guard let self else { return }; self.stopSharing(); self.frame = nil; self.preview.image = nil
            let reviewing = self.mode.selectedSegmentIndex == 0
            self.preview.isHidden = !reviewing; self.send.isHidden = !reviewing; freeze.isHidden = !reviewing
            self.message.text = reviewing ? "Choose content, then freeze a recent frame to review before sending." : "Choose screen to start live sharing. HUB keeps only a recent frame briefly; no automatic analysis runs."
        }, for: .valueChanged)
        let stack = UIStackView(arrangedSubviews: [mode, message, preview, actions, send, stop]); stack.axis = .vertical; stack.spacing = 16; stack.translatesAutoresizingMaskIntoConstraints = false
        let scroll = UIScrollView(); scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll); scroll.addSubview(stack)
        let previewHeight = preview.heightAnchor.constraint(equalToConstant: 240)
        previewHeight.priority = .defaultHigh // Stack hiding must be able to collapse the Live layout.
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor), scroll.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor), scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 16), stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -16),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 20), stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -20),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -40), previewHeight,
            start.heightAnchor.constraint(greaterThanOrEqualToConstant: 48), freeze.heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
            send.heightAnchor.constraint(greaterThanOrEqualToConstant: 48), stop.heightAnchor.constraint(greaterThanOrEqualToConstant: 44)
        ])
        capture.changed = { [weak self] in
            guard let self, self.frame == nil, !self.busy else { return }
            if self.liveRequested, let consent = self.capture.consentID {
                self.live.beginAfterSystemConsent(consent)
                if !self.live.active { self.liveRequested = false; self.capture.stop() }
                self.message.text = self.live.status
            }
            else if self.live.active { self.liveRequested = false; self.live.stop(); self.message.text = self.live.status }
            else { self.message.text = self.capture.status }
        }
        live.changed = { [weak self] in guard let self, self.mode.selectedSegmentIndex == 1 else { return }; self.message.text = self.live.status }
        capture.frameReady = { [weak self] frame in guard let self, self.liveRequested else { return }; self.live.offer(frame) }
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.backgroundAt = Date() } })
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in guard let self, let at = self.backgroundAt, Date().timeIntervalSince(at) >= 1 else { return }; self.backgroundAt = nil; if !self.liveRequested { self.freeze() } }
        })
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in Task { @MainActor in
            guard let self else { return }
            if !self.context.stillOwned() { self.stopSharing(); self.frame = nil; self.preview.image = nil; self.send.isEnabled = false; self.message.text = "The original voice call has ended. No frame will be sent to another call." }
            else if self.liveRequested, self.capture.consentID != nil, !self.live.active { let status = self.live.status; self.stopSharing(); self.message.text = status }
        } }
    }
    private func stopSharing() { liveRequested = false; live.stop(); capture.stop() }
    private func chooseScreen() {
        guard !busy else { return }; stopSharing(); frame = nil; preview.image = nil; send.isEnabled = false
        guard mode.selectedSegmentIndex == 1 else { capture.presentSystemPicker(); return }
        let alert = UIAlertController(title: "Share your screen live?", message: "After Apple's picker, recent screen frames will be sent to this HUB voice call, including while you view another app. Only the latest frame stays briefly in HUB memory. No automatic analysis runs. Stop or locking this iPhone ends capture.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Share live", style: .default) { [weak self] _ in guard let self, self.context.stillOwned() else { return }; self.liveRequested = true; self.capture.presentSystemPicker() })
        present(alert, animated: true)
    }
    private func freeze() {
        guard !busy, frame == nil, !liveRequested, mode.selectedSegmentIndex == 0, let consent = capture.consentID else { return }
        Task {
            do {
                let snapshot = try await capture.snapshotForExplicitReview()
                guard context.stillOwned() else { stopSharing(); return }
                guard capture.consentID == consent, mode.selectedSegmentIndex == 0, !liveRequested else { return }
                capture.stop(); frame = snapshot; preview.image = UIImage(data: snapshot.jpeg); send.isEnabled = true
                message.text = "Review this frozen frame before sending. Sharing is stopped; this image stays local until you send it."
            } catch { message.text = "No recent frame is available. Choose screen and try again; nothing was sent." }
        }
    }
    private func confirmSend() {
        guard frame != nil, !busy else { return }
        let alert = UIAlertController(title: "Send this frame?", message: "Share the reviewed image with the current voice conversation on \(context.server.origin.host ?? "HUB")? HUB will retain the image.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Send", style: .default) { [weak self] _ in self?.sendFrame() }); present(alert, animated: true)
    }
    private func sendFrame() {
        guard let frame, !busy else { return }; busy = true; send.isEnabled = false; mode.isEnabled = false; isModalInPresentation = true; navigationItem.rightBarButtonItem?.isEnabled = false
        Task {
            defer { busy = false; mode.isEnabled = true; isModalInPresentation = false; navigationItem.rightBarButtonItem?.isEnabled = true; send.isEnabled = self.frame != nil && context.stillOwned() }
            do {
                guard context.stillOwned() else { throw HubAttachmentError.callEnded }
                let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                let store = try HubAttachmentStore(root: base.appendingPathComponent("HubAttachmentOutbox", isDirectory: true))
                let draft = try await store.stage(data: frame.jpeg, name: "Screen frame.jpg", server: context.server, sessionID: context.sessionID, callID: context.callID, id: frame.id, requestID: frame.id)
                message.text = "Sending the reviewed frame…"
                try await context.uploadAPI.upload(draft, bytes: frame.jpeg)
                guard context.stillOwned() else { throw HubAttachmentError.callEnded }
                try await context.voiceAPI.share(callId: context.callID, uploadID: draft.id, requestID: draft.requestID)
                try await store.discard(draft); self.frame = nil; preview.image = nil; message.text = "Frame sent to your voice conversation."
            } catch { message.text = "Sending was not confirmed. Your local frame is kept; retry here or under Share a file. The same receipt prevents duplicate submission." }
        }
    }
    private func close() { guard !busy else { return }; stopSharing(); frame = nil; dismiss(animated: true) }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { stopSharing(); frame = nil }
}
#endif
