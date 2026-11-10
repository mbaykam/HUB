import UIKit
import WebKit
import SafariServices
import HubNative

/// Remote HUB is deliberately a plain, unprivileged web view. No Capacitor
/// bridge, script message handler, injected cookie, or agent-controlled native API.
final class HubConnectionViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private let savedOriginKey = HubClientConfiguration.serverPreferenceKey
    private var server: HubServer?
    private var webView: WKWebView!
    private let message = UILabel()
    private let progress = UIProgressView(progressViewStyle: .bar)
    private var progressObservation: NSKeyValueObservation?
    private var probe: Task<Void, Never>?
    private var api: HubVoiceAPI?
    private var connectionGeneration = 0
    private var connected = false
    private var notificationDestination: HubNotificationDestination?
    private var voice: HubNativeVoice? {
        get { HubAssistantCoordinator.shared.voice }
        set { HubAssistantCoordinator.shared.adopt(newValue) }
    }
    private var deviceState: HubDeviceState?
    deinit { probe?.cancel(); api?.invalidate() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        title = "HUB"
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Voice", style: .plain, target: self, action: #selector(showVoice))
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.applicationNameForUserAgent = "HUBiOS/0.1"
        // Do not add native message handlers to this configuration.
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.translatesAutoresizingMaskIntoConstraints = false
        message.font = .preferredFont(forTextStyle: .caption1)
        message.adjustsFontForContentSizeCategory = true
        message.textColor = .secondaryLabel
        message.textAlignment = .center
        message.numberOfLines = 0
        message.text = "Connect to your HUB to get started."
        message.accessibilityTraits = .updatesFrequently
        let status = UIStackView(arrangedSubviews: [message, progress])
        status.axis = .vertical
        status.spacing = 4
        status.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(status)
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            status.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 4),
            status.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            status.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            webView.topAnchor.constraint(equalTo: status.bottomAnchor, constant: 4),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        navigationItem.rightBarButtonItem = UIBarButtonItem(image: UIImage(systemName: "ellipsis.circle"), menu: UIMenu(children: [
            UIAction(title: "Files", image: UIImage(systemName: "paperclip")) { [weak self] _ in self?.showSharedFiles() },
            UIAction(title: "Notifications", image: UIImage(systemName: "bell")) { [weak self] _ in
                guard let self else { return }; HubNotifications.shared.show(from: self)
            },
            UIAction(title: "Connection", image: UIImage(systemName: "network")) { [weak self] _ in self?.showConnection() },
            UIAction(title: "Reload", image: UIImage(systemName: "arrow.clockwise")) { [weak self] _ in self?.reload() },
            UIAction(title: "Sign out on this iPhone", image: UIImage(systemName: "rectangle.portrait.and.arrow.right"), attributes: .destructive) { [weak self] _ in self?.confirmSignOut() }
        ]))
        navigationItem.rightBarButtonItem?.accessibilityLabel = "HUB connection options"
        progressObservation = webView.observe(\.estimatedProgress, options: [.new]) { [weak self] web, _ in
            self?.progress.progress = Float(web.estimatedProgress)
            self?.progress.isHidden = web.estimatedProgress >= 1
        }
        HubNotifications.shared.destinationHandler = { [weak self] destination in self?.openNotification(destination) }
        if let address = UserDefaults.standard.string(forKey: savedOriginKey), let saved = try? HubServer(address: address) {
            connect(saved)
        } else {
            DispatchQueue.main.async { [weak self] in self?.showConnection() }
        }
    }

    private func showConnection(error: String? = nil, address: String? = nil) {
        guard voice?.isActive != true else { showEndVoiceFirst(); return }
        let sheet = UIAlertController(title: "Connect to HUB", message: error ?? "Enter your secure HUB address. Sign in on the next screen; your session stays on this iPhone.", preferredStyle: .alert)
        sheet.addTextField { field in
            field.placeholder = "https://hub.example.com"
            field.text = address ?? self.server?.origin.absoluteString
            field.keyboardType = .URL
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
            field.accessibilityLabel = "Secure HUB address"
        }
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        sheet.addAction(UIAlertAction(title: "Connect", style: .default) { [weak self, weak sheet] _ in
            let value = sheet?.textFields?.first?.text ?? ""
            guard let candidate = try? HubServer(address: value) else {
                DispatchQueue.main.async { self?.showConnection(error: "Use an HTTPS address with no login token, password, or extra path.", address: value) }
                return
            }
            self?.connect(candidate)
        })
        present(sheet, animated: true)
    }

    private func connect(_ value: HubServer) {
        if let server, server != value { HubNotifications.shared.disable() }
        connectionGeneration += 1
        probe?.cancel()
        connected = false
        server = value
        let nativeState = HubDeviceState(server: value, store: HubKeychainStore())
        deviceState = nativeState
        api?.invalidate()
        api = HubVoiceAPI(server: value) { [weak webView] in
            await withCheckedContinuation { continuation in
                DispatchQueue.main.async {
                    if UIApplication.shared.applicationState == .background {
                        continuation.resume(returning: (try? nativeState.cookies()) ?? [])
                        return
                    }
                    guard let webView else { continuation.resume(returning: []); return }
                    webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { continuation.resume(returning: $0) }
                }
            }
        }
        // Only a canonical origin is saved. The web data store owns HttpOnly cookies.
        UserDefaults.standard.set(value.origin.absoluteString, forKey: savedOriginKey)
        message.text = "Connecting to \(value.origin.host ?? "HUB")…"
        webView.load(URLRequest(url: value.origin))
    }

    private func reload() {
        if server == nil { showConnection(); return }
        if !connected, let server { webView.load(URLRequest(url: server.origin)); return }
        if let url = webView.url, server?.contains(url) == true { webView.reload() }
        else if let server { webView.load(URLRequest(url: server.origin)) }
    }

    private func confirmSignOut() {
        guard voice?.isActive != true else { showEndVoiceFirst(); return }
        let alert = UIAlertController(title: "Sign out on this iPhone?", message: "Your conversations, files and settings on HUB will stay intact.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Sign out", style: .destructive) { [weak self] _ in
            guard let self else { return }
            self.connectionGeneration += 1
            self.probe?.cancel()
            HubNotifications.shared.disable()
            do { try self.deviceState?.clear() }
            catch { self.message.text = "Sign-out could not clear saved access. Unlock this iPhone and try again."; return }
            HubNotifications.shared.forgetConnection()
            self.connected = false
            self.webView.stopLoading()
            self.server = nil
            UserDefaults.standard.removeObject(forKey: self.savedOriginKey)
            let store = self.webView.configuration.websiteDataStore.httpCookieStore
            store.getAllCookies { cookies in
                let group = DispatchGroup()
                for cookie in cookies { group.enter(); store.delete(cookie) { group.leave() } }
                group.notify(queue: .main) {
                    // Destroy the old web view, including its active sockets and
                    // media, instead of merely hiding a still-running signed-in page.
                    self.progressObservation?.invalidate()
                    self.api?.invalidate()
                    self.view.window?.rootViewController = UINavigationController(rootViewController: HubConnectionViewController())
                }
            }
        })
        present(alert, animated: true)
    }

    @objc private func showVoice() {
        guard let api, let server, let deviceState else { showConnection(); return }
        guard connected || voice?.isActive == true else {
            message.text = "Complete HUB sign-in before starting voice."
            return
        }
        if voice?.isActive != true, let pending = try? deviceState.admission() {
            let choices = UIAlertController(title: "Interrupted voice startup", message: "Recover the previous request before starting another conversation.", preferredStyle: .alert)
            choices.addAction(UIAlertAction(title: "Recover startup", style: .default) { [weak self] _ in
                self?.presentVoice(api: api, server: server, deviceState: deviceState, checkpoint: nil, pending: pending)
            })
            choices.addAction(UIAlertAction(title: "Cancel", style: .cancel))
            present(choices, animated: true)
        } else if voice?.isActive != true, let saved = try? deviceState.voice() {
            let choices = UIAlertController(title: "Voice conversation", message: "Continue your last voice conversation, or start a new one.", preferredStyle: .actionSheet)
            choices.addAction(UIAlertAction(title: "Resume last conversation", style: .default) { [weak self] _ in self?.presentVoice(api: api, server: server, deviceState: deviceState, checkpoint: saved) })
            choices.addAction(UIAlertAction(title: "Start new conversation", style: .default) { [weak self] _ in self?.presentVoice(api: api, server: server, deviceState: deviceState, checkpoint: nil) })
            choices.addAction(UIAlertAction(title: "Cancel", style: .cancel))
            choices.popoverPresentationController?.barButtonItem = navigationItem.leftBarButtonItem
            present(choices, animated: true)
        } else { presentVoice(api: api, server: server, deviceState: deviceState, checkpoint: nil) }
    }
    private func presentVoice(api: HubVoiceAPI, server: HubServer, deviceState: HubDeviceState, checkpoint: HubVoiceCheckpoint?, pending: HubVoiceAdmission? = nil) {
        let model = voice?.isActive == true ? voice! : HubNativeVoice(api: api, server: server, deviceState: deviceState, resume: checkpoint, pendingAdmission: pending)
        voice = model
        let sheet = HubVoiceViewController(voice: model) { [weak self, weak model] in
            guard let self else { return }
            guard let destination = model?.conversationDestination() else {
                self.message.text = "Wait for voice to connect before opening its conversation."
                return
            }
            self.dismiss(animated: true) { [weak self] in self?.openNotification(destination) }
        }
        present(UINavigationController(rootViewController: sheet), animated: true) { [weak self, weak sheet] in
            model.changed = { [weak self, weak sheet, weak model] in
                self?.navigationItem.leftBarButtonItem?.title = model?.isActive == true ? "Voice •" : "Voice"
                self?.navigationItem.leftBarButtonItem?.accessibilityLabel = model?.isActive == true ? "Open active voice conversation" : "Start voice conversation"
                sheet?.refresh()
            }
            if !model.isActive { model.start() }
        }
    }
    private func showEndVoiceFirst() {
        let alert = UIAlertController(title: "A voice conversation is active", message: "Open Voice and end the conversation before changing the server or signing out.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }
    private func showSharedFiles() {
        guard connected, let server, let state = deviceState else { message.text = "Sign in to HUB before choosing a file conversation."; return }
        let generation = connectionGeneration
        do {
            let screen = try HubSharedFilesViewController(server: server, state: state, stillConnected: { [weak self] in
                self?.connected == true && self?.connectionGeneration == generation && self?.server == server
            }, openDraft: { [weak self] url in
                guard let self, self.connected, self.connectionGeneration == generation, server.contains(url) else { return }
                self.webView.load(URLRequest(url: url))
            })
            present(UINavigationController(rootViewController: screen), animated: true)
        } catch { message.text = "Files are unavailable. Unlock the iPhone and check the app's sharing setup; HUB's normal file button remains available." }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        let mainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        if let server, server.contains(url), URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains(where: { $0.name == "hubNative" }) == true {
            decisionHandler(.cancel)
            guard connected, presentedViewController == nil,
                  HubVoiceNavigation.requestsConfirmation(url: url, source: navigationAction.sourceFrame.request.url, server: server,
                    sourceIsMainFrame: navigationAction.sourceFrame.isMainFrame, targetIsMainFrame: mainFrame, isLink: navigationAction.navigationType == .linkActivated) else { return }
            offerNativeVoice()
            return
        }
        if !mainFrame {
            decisionHandler(["https", "blob", "about", "data"].contains(url.scheme?.lowercased() ?? "") ? .allow : .cancel)
            return
        }
        guard url.scheme?.lowercased() == "https", url.user == nil, url.password == nil else { decisionHandler(.cancel); return }
        if navigationAction.navigationType == .linkActivated && connected && server?.contains(url) != true {
            decisionHandler(.cancel)
            present(SFSafariViewController(url: url), animated: true)
            return
        }
        if server?.contains(url) != true {
            connected = false
            probe?.cancel()
            message.text = "Complete sign-in to connect to HUB."
        }
        // HTTPS authentication redirects may visit Access and the chosen identity
        // provider. Native API requests still target only the exact selected HUB.
        if navigationAction.targetFrame == nil { decisionHandler(.cancel); webView.load(navigationAction.request); return }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let server, let url = webView.url, server.contains(url) else {
            message.text = "Complete sign-in to connect to HUB."
            return
        }
        checkConnection(server)
    }

    private func checkConnection(_ expected: HubServer) {
        let generation = connectionGeneration
        probe?.cancel()
        guard let api else { return }
        probe = Task { [weak self] in
            do {
                _ = try await api.status()
                guard let self, !Task.isCancelled, generation == self.connectionGeneration,
                      let url = self.webView.url, expected.contains(url) else { return }
                self.connected = true
                self.message.text = "Connected · \(expected.origin.host ?? "HUB")"
                let cookies: [HTTPCookie] = await withCheckedContinuation { continuation in
                    self.webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { continuation.resume(returning: $0) }
                }
                guard !Task.isCancelled, generation == self.connectionGeneration else { return }
                do { try self.deviceState?.rememberVerifiedSession(cookies) }
                catch { self.message.text = "Connected. Sign-in could not be saved on this iPhone." }
                if let state = self.deviceState { HubNotifications.shared.attach(server: expected, state: state) }
                self.openPendingNotification()
            } catch {
                guard let self, !Task.isCancelled, generation == self.connectionGeneration else { return }
                self.connected = false
                self.message.text = error as? HubVoiceAPIError == .signInRequired
                    ? "Sign in to HUB, then choose Reload."
                    : "Connection interrupted. Check Connection or choose Reload."
            }
        }
    }

    private func openNotification(_ destination: HubNotificationDestination) {
        notificationDestination = destination
        if connected { openPendingNotification() }
        else if let server { webView.load(URLRequest(url: server.origin)) }
        else { message.text = "Connect to the HUB used by this notification first." }
    }
    private func openPendingNotification() {
        guard connected, let server, let destination = notificationDestination else { return }
        notificationDestination = nil
        guard let url = try? destination.url(for: server) else {
            message.text = "This notification belongs to a different HUB. Your connection was not changed."
            return
        }
        webView.load(URLRequest(url: url))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { showFailure(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { showFailure(error) }
    private func showFailure(_ error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { message.text = "Could not open HUB. Check your connection, then choose Reload." }
    }
    private func offerNativeVoice() {
        let active = voice?.isActive == true
        let alert = UIAlertController(title: active ? "Open voice controls?" : "Start voice?", message: active ? "Your existing voice conversation will stay active." : "Start or resume a voice conversation using your iPhone microphone.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: active ? "Open controls" : "Continue", style: .default) { [weak self] _ in self?.showVoice() })
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        present(alert, animated: true)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        message.text = "HUB needs to reconnect. Choose Reload to continue."
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        var parts = URLComponents()
        parts.scheme = origin.protocol; parts.host = origin.host
        if origin.port != 0 { parts.port = origin.port }
        let trusted = parts.url.map { server?.contains($0) == true } ?? false
        // Keep one audio owner in this app, including with an older PWA. Camera
        // uploads still use the standard prompt; web/agent frames get no mic.
        if type == .microphone || type == .cameraAndMicrophone {
            decisionHandler(.deny)
            if trusted && frame.isMainFrame { message.text = "Use Voice in the app bar for iPhone audio." }
        } else { decisionHandler(trusted && frame.isMainFrame ? .prompt : .deny) }
    }
}
