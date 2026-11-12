import UIKit
import WebKit
import CryptoKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        true
    }
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Keyboard probe", sessionRole: session.role)
        configuration.delegateClass = KeyboardProbeScene.self
        return configuration
    }
}

final class KeyboardProbeScene: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = ProcessInfo.processInfo.arguments.contains("--installed-renderer") ? InstalledRendererController() : KeyboardProbeController()
        self.window = window
        window.makeKeyAndVisible()
    }
}

/// Actual exported renderer in a real UIKit scene. No message/native bridge or
/// synthetic backend responses are installed on this web view.
final class InstalledRendererController: UIViewController, WKNavigationDelegate {
    private let status = UILabel(), report = UILabel()
    private var webView: HubWebView!
    private var started = Date(), initialNavigation = false
    private var proof = [String: Any]()
    private let base = URL(string: "https://installed-ui-renderer-probe.invalid/")!

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        status.accessibilityIdentifier = "renderer.status"; status.text = "Loading actual renderer"
        report.accessibilityIdentifier = "renderer.metrics"; report.text = "Read-only renderer metrics"
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.applicationNameForUserAgent = "HUBiOS/0.2"
        webView = HubWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        let stack = UIStackView(arrangedSubviews: [status, report, webView])
        stack.axis = .vertical; stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor), stack.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor), stack.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            status.heightAnchor.constraint(equalToConstant: 22), report.heightAnchor.constraint(equalToConstant: 20)
        ])
        do {
            guard let document = Bundle.main.url(forResource: "document", withExtension: "html", subdirectory: "InstalledUI"),
                  let manifestURL = Bundle.main.url(forResource: "manifest", withExtension: "json", subdirectory: "InstalledUI") else {
                throw NSError(domain: "RendererProbe", code: 1, userInfo: [NSLocalizedDescriptionKey: "Required actual exported resources are missing"])
            }
            let data = try Data(contentsOf: document), manifestData = try Data(contentsOf: manifestURL)
            let manifest = try JSONSerialization.jsonObject(with: manifestData) as? [String: Any]
            let expected = manifest?["document"] as? [String: Any]
            let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            guard expected?["sha256"] as? String == hash, expected?["bytes"] as? Int == data.count,
                  var html = String(data: data, encoding: .utf8), let head = html.range(of: "<head>", options: .caseInsensitive) else {
                throw NSError(domain: "RendererProbe", code: 2, userInfo: [NSLocalizedDescriptionKey: "Bundled export checksum/head mismatch"])
            }
            html.insert(contentsOf: "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; worker-src blob:; form-action 'none'; base-uri 'none'\">", at: head.upperBound)
            proof = ["sourceSHA256": hash, "sourceBytes": data.count,
                     "manifestSHA256": SHA256.hash(data: manifestData).map { String(format: "%02x", $0) }.joined(),
                     "loadedSHA256": SHA256.hash(data: Data(html.utf8)).map { String(format: "%02x", $0) }.joined(),
                     "testOnlyCSP": true, "nativeBridge": false, "nonPersistent": true]
            started = Date()
            webView.loadHTMLString(html, baseURL: base)
        } catch { finish(error: String(describing: error)) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if !initialNavigation && action.navigationType == .other && (action.request.url == base || action.request.url?.absoluteString == "about:blank") {
            initialNavigation = true; decisionHandler(.allow)
        } else { decisionHandler(.cancel) }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { poll() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(error: String(describing: error)) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(error: String(describing: error)) }

    private func finish(error: String? = nil) {
        if let error { proof["error"] = error }
        if let bytes = try? JSONSerialization.data(withJSONObject: proof, options: [.sortedKeys]), let json = String(data: bytes, encoding: .utf8) {
            report.accessibilityValue = json
        }
        status.text = error == nil ? "Renderer ready" : "Renderer failed"
    }

    private func poll() {
        webView.evaluateJavaScript("""
        (()=>{function d(e){if(!e)return null;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,visible:r.width>0&&r.height>0&&r.right>0&&r.x<innerWidth&&r.bottom>0&&r.y<innerHeight&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'&&!e.closest('[hidden]')}}
        const c=document.querySelector('[data-composer-card]');return {home:!!document.querySelector('[data-hub-home-nav]'),compact:!!c?.hasAttribute('data-hub-compact-composer'),composer:d(c),menu:d(c?.querySelector('[data-hub-composer-menu]')),voice:d(document.querySelector('[data-voice-start]')),send:d(c?.querySelector('[data-hub-composer-send]')),href:location.href,viewport:{width:innerWidth,height:innerHeight},userAgent:navigator.userAgent,rootChildren:document.querySelector('#root')?.childElementCount??0,text:document.body.innerText.slice(0,1400)}})()
        """) { [weak self] value, error in
            guard let self else { return }
            if let error { self.finish(error: String(describing: error)); return }
            guard let metrics = value as? [String: Any] else { self.finish(error: "No actual renderer metrics"); return }
            self.proof["renderer"] = metrics
            self.proof["nativeWebViewURL"] = self.webView.url?.absoluteString ?? "<nil>"
            func rect(_ name: String) -> [String: Any] { metrics[name] as? [String: Any] ?? [:] }
            let card = rect("composer"), menu = rect("menu"), voice = rect("voice"), send = rect("send")
            let visible = [card, menu, voice, send].allSatisfy { $0["visible"] as? Bool == true }
            let thin = (card["height"] as? Double ?? .infinity) <= 80
            let order = (menu["right"] as? Double ?? .infinity) <= (voice["x"] as? Double ?? -.infinity) &&
                        (voice["right"] as? Double ?? .infinity) <= (send["x"] as? Double ?? -.infinity)
            if metrics["home"] as? Bool == true && metrics["compact"] as? Bool == true && visible && thin && order {
                self.proof["realRendered"] = true; self.finish()
            } else if Date().timeIntervalSince(self.started) >= 50 {
                self.proof["realRendered"] = false; self.finish(error: "Actual Home/compact composer and three visible ordered controls did not render within 50s")
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.poll() }
            }
        }
    }
}

final class KeyboardProbeController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler {
    private var webView: WKWebView!
    private let status = UILabel()
    private let typed = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let hub = ProcessInfo.processInfo.arguments.contains("--hub-web-view")
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(self, name: "probeText")
        webView = hub ? HubWebView(frame: .zero, configuration: configuration) : WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        status.accessibilityIdentifier = "probe.status"
        status.text = hub ? "HUB public override · loading" : "Baseline WKWebView · loading"
        typed.accessibilityIdentifier = "probe.typed"
        typed.text = "No synthetic text entered"
        typed.numberOfLines = 2
        let stack = UIStackView(arrangedSubviews: [status, typed, webView])
        stack.axis = .vertical
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 12),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -12),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            stack.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor)
        ])
        webView.loadHTMLString("""
        <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'">
        <style>body{font:18px system-ui;margin:12px}input,[contenteditable]{display:block;box-sizing:border-box;width:100%;margin:12px 0;padding:12px;border:1px solid #888;border-radius:12px}[contenteditable]{min-height:76px;outline:none}</style>
        <p>Synthetic keyboard probe. No accounts or network.</p>
        <input aria-label="Previous synthetic field" placeholder="Previous field">
        <div contenteditable="true" role="textbox" aria-label="Keyboard probe editor" autocorrect="off" autocapitalize="off" spellcheck="false"></div>
        <input aria-label="Next synthetic field" placeholder="Next field">
        <script>document.querySelector('[contenteditable]').addEventListener('input',e=>window.webkit.messageHandlers.probeText.postMessage(e.currentTarget.innerText));</script>
        """, baseURL: URL(string: "https://keyboard-probe.invalid/"))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { status.text = "Ready · synthetic local document" }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if let text = message.body as? String { typed.text = text; typed.accessibilityValue = text }
    }
}
