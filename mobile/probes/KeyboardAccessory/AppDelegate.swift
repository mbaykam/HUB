import UIKit
import WebKit

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
        window.rootViewController = KeyboardProbeController()
        self.window = window
        window.makeKeyAndVisible()
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
