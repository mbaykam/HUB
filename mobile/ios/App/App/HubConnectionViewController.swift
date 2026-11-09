import UIKit
import WebKit
import SafariServices

/// Remote HUB is deliberately a plain, unprivileged web view. No Capacitor
/// bridge, script message handler, injected cookie, or agent-controlled native API.
final class HubConnectionViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private let savedOriginKey = "hub.ios.server-origin.v1"
    private var server: HubServer?
    private var webView: WKWebView!
    private let message = UILabel()
    private let progress = UIProgressView(progressViewStyle: .bar)
    private var progressObservation: NSKeyValueObservation?
    private var probe: Task<Void, Never>?
    private var api: HubVoiceAPI?
    private var connectionGeneration = 0
    private var connected = false
    deinit { probe?.cancel(); api?.invalidate() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        title = "HUB"
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
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
            UIAction(title: "Connection", image: UIImage(systemName: "network")) { [weak self] _ in self?.showConnection() },
            UIAction(title: "Reload", image: UIImage(systemName: "arrow.clockwise")) { [weak self] _ in self?.reload() },
            UIAction(title: "Sign out on this iPhone", image: UIImage(systemName: "rectangle.portrait.and.arrow.right"), attributes: .destructive) { [weak self] _ in self?.confirmSignOut() }
        ]))
        navigationItem.rightBarButtonItem?.accessibilityLabel = "HUB connection options"
        progressObservation = webView.observe(\.estimatedProgress, options: [.new]) { [weak self] web, _ in
            self?.progress.progress = Float(web.estimatedProgress)
            self?.progress.isHidden = web.estimatedProgress >= 1
        }
        if let address = UserDefaults.standard.string(forKey: savedOriginKey), let saved = try? HubServer(address: address) {
            connect(saved)
        } else {
            DispatchQueue.main.async { [weak self] in self?.showConnection() }
        }
    }

    private func showConnection(error: String? = nil, address: String? = nil) {
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
        connectionGeneration += 1
        probe?.cancel()
        connected = false
        server = value
        api?.invalidate()
        api = HubVoiceAPI(server: value) { [weak webView] in
            await withCheckedContinuation { continuation in
                DispatchQueue.main.async {
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
        if let url = webView.url, server?.contains(url) == true { webView.reload() }
        else if let server { webView.load(URLRequest(url: server.origin)) }
    }

    private func confirmSignOut() {
        let alert = UIAlertController(title: "Sign out on this iPhone?", message: "Your conversations, files and settings on HUB will stay intact.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Sign out", style: .destructive) { [weak self] _ in
            guard let self else { return }
            self.connectionGeneration += 1
            self.probe?.cancel()
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

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        let mainFrame = navigationAction.targetFrame?.isMainFrame ?? true
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
            } catch {
                guard let self, !Task.isCancelled, generation == self.connectionGeneration else { return }
                self.connected = false
                self.message.text = error as? HubVoiceAPIError == .signInRequired
                    ? "Sign in to HUB, then choose Reload."
                    : "Connection interrupted. Check Connection or choose Reload."
            }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { showFailure(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { showFailure(error) }
    private func showFailure(_ error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { message.text = "Could not open HUB. Check your connection, then choose Reload." }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        message.text = "HUB needs to reconnect. Choose Reload to continue."
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        var parts = URLComponents()
        parts.scheme = origin.protocol; parts.host = origin.host
        if origin.port != 0 { parts.port = origin.port }
        let trusted = parts.url.map { server?.contains($0) == true } ?? false
        decisionHandler(trusted && frame.isMainFrame ? .prompt : .deny)
    }
}
