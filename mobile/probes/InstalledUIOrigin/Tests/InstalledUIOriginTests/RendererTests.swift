import XCTest
#if canImport(WebKit) && os(macOS)
import AppKit
import WebKit

/// Loads the exported product document itself. No substitute UI, native bridge,
/// account, fixture session, or network response is supplied to the renderer.
@MainActor
final class RendererTests: XCTestCase, WKNavigationDelegate {
    private var finished: XCTestExpectation?
    private var navigationError: Error?
    private var cancelledNavigations = [String]()
    private var allowedInitialDocument = false
    private let base = URL(string: "https://installed-ui-renderer-probe.invalid/")!

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finished?.fulfill() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        navigationError = error; finished?.fulfill()
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        navigationError = error; finished?.fulfill()
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // CSP blocks resource/connection traffic; this also blocks top-level
        // navigation, which connect-src does not cover. Only the inline load is allowed.
        if !allowedInitialDocument && action.navigationType == .other &&
            (action.request.url == base || action.request.url?.absoluteString == "about:blank") {
            allowedInitialDocument = true
            decisionHandler(.allow)
        } else {
            cancelledNavigations.append(action.request.url?.absoluteString ?? "<nil>")
            decisionHandler(.cancel)
        }
    }

    func testActualInstalledRendererOfflineAtPhoneWidth() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["HUB_RUN_WEBKIT_PROBE"] == "1",
              let documentPath = environment["HUB_INSTALLED_UI_DOCUMENT_PATH"], !documentPath.isEmpty else {
            throw XCTSkip("Set HUB_RUN_WEBKIT_PROBE=1 and HUB_INSTALLED_UI_DOCUMENT_PATH to the actual exported document.html")
        }
        var html = try String(contentsOfFile: documentPath, encoding: .utf8)
        let head = try XCTUnwrap(html.range(of: "<head>", options: .caseInsensitive), "exported document has a head")
        let csp = """
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; worker-src blob:; form-action 'none'; base-uri 'none'">
        """
        html.insert(contentsOf: csp, at: head.upperBound)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.addUserScript(WKUserScript(source: """
        window.__hubRendererProbeErrors = [];
        for (const level of ['warn','error']) {
          const original = console[level].bind(console);
          console[level] = (...args) => {
            window.__hubRendererProbeErrors.push(level + ': ' + args.map(value => String(value?.stack ?? value)).join(' '));
            original(...args);
          };
        }
        addEventListener('error', e => window.__hubRendererProbeErrors.push(String(e.message)));
        addEventListener('unhandledrejection', e => window.__hubRendererProbeErrors.push(String(e.reason)));
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844), configuration: configuration)
        // A detached macOS web view suppresses requestAnimationFrame. The real
        // mobile enhancements use it, so exercise a visible, disposable window
        // rather than accepting only the unenhanced base renderer.
        _ = NSApplication.shared
        let window = NSWindow(contentRect: webView.frame, styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        webView.customUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1 HUBiOS/0.2"
        webView.navigationDelegate = self
        defer { webView.navigationDelegate = nil; webView.stopLoading(); window.close() }
        finished = expectation(description: "actual exported document didFinish")
        webView.loadHTMLString(html, baseURL: base)
        await fulfillment(of: [try XCTUnwrap(finished)], timeout: 30)
        if let navigationError { throw navigationError }

        // didFinish alone does not establish that the real application mounted.
        // Poll its actual home-navigation seam; do not insert or emulate it.
        let deadline = Date().addingTimeInterval(30)
        var mounted = false
        while Date() < deadline {
            mounted = (try await webView.evaluateJavaScript("!!document.querySelector('[data-hub-home-nav]')") as? Bool) == true
            if mounted { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let result = try await webView.evaluateJavaScript("""
        (() => {
          function describe(element) {
            if (!element) return null;
            const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
            return {label:element.getAttribute('aria-label'), width:rect.width, height:rect.height,
              x:rect.x, y:rect.y, right:rect.right, bottom:rect.bottom,
              visible:!!element.getClientRects().length && rect.width>0 && rect.height>0 &&
                style.display!=='none' && style.visibility!=='hidden' && !element.closest('[hidden]'),
              disabled:element.disabled===true};
          }
          const card = document.querySelector('[data-composer-card]');
          return {href:location.href, origin:location.origin, userAgent:navigator.userAgent,
            viewport:{width:innerWidth,height:innerHeight},
            mounted:!!document.querySelector('[data-hub-home-nav]'),
            rootChildren:document.querySelector('#root')?.childElementCount ?? 0,
            mobile:document.documentElement.hasAttribute('data-minke-mobile-web'),
            composer:describe(card), compact:card?.hasAttribute('data-hub-compact-composer') ?? false,
            menu:describe(card?.querySelector('[data-hub-composer-menu]')),
            voice:describe(document.querySelector('[data-voice-start]')),
            send:describe(card?.querySelector('[data-hub-composer-send]') ?? card?.querySelector('button[aria-label="Send"]')),
            errors:window.__hubRendererProbeErrors ?? [],
            styles:[...document.querySelectorAll('style')].map(s=>({id:s.id,attributes:[...s.attributes].map(a=>[a.name,a.value]),bytes:s.textContent.length})),
            text:document.body.innerText.slice(0,1200)};
        })()
        """)
        var metrics = try XCTUnwrap(result as? [String: Any])
        metrics["cancelledNavigations"] = cancelledNavigations
        metrics["evidenceScope"] = "Actual exported renderer; macOS WebKit, phone-sized viewport and synthetic empty offline data; no iPhone/auth acceptance"
        let json = try JSONSerialization.data(withJSONObject: metrics, options: [.prettyPrinted, .sortedKeys])
        print("InstalledUIOrigin actual renderer:\n\(String(decoding: json, as: UTF8.self))")
        if let evidencePath = environment["HUB_INSTALLED_UI_EVIDENCE_DIR"], !evidencePath.isEmpty {
            let directory = URL(fileURLWithPath: evidencePath, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try json.write(to: directory.appendingPathComponent("renderer-offline-webkit-390x844.json"))
            // WKWebView can produce a blank snapshot when it has no window.
            // Save only a nonuniform public-API snapshot; otherwise report the limitation.
            do {
                let snapshot = WKSnapshotConfiguration()
                snapshot.rect = webView.bounds
                let image = try await webView.takeSnapshot(configuration: snapshot)
                let tiff = try XCTUnwrap(image.tiffRepresentation)
                let bitmap = try XCTUnwrap(NSBitmapImageRep(data: tiff))
                var colors = Set<String>()
                for y in stride(from: 0, to: bitmap.pixelsHigh, by: max(1, bitmap.pixelsHigh / 40)) {
                    for x in stride(from: 0, to: bitmap.pixelsWide, by: max(1, bitmap.pixelsWide / 20)) {
                        if let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB), color.alphaComponent > 0 {
                            colors.insert("\(Int(color.redComponent*255)),\(Int(color.greenComponent*255)),\(Int(color.blueComponent*255))")
                        }
                    }
                }
                if colors.count > 1 {
                    let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                    try png.write(to: directory.appendingPathComponent("renderer-offline-webkit-390x844.png"))
                    print("Saved actual renderer public WKWebView snapshot; visual review remains required")
                } else { print("No screenshot saved: windowless WKWebView snapshot was blank/uniform") }
            } catch { print("No screenshot saved: public WKWebView snapshot unavailable: \(error)") }
        }
        XCTAssertTrue(mounted, "actual [data-hub-home-nav] did not mount; inspect renderer metrics/errors")
        XCTAssertEqual(metrics["href"] as? String, base.absoluteString)
        let viewport = try XCTUnwrap(metrics["viewport"] as? [String: Any])
        XCTAssertEqual(viewport["width"] as? Int, 390)
        XCTAssertEqual(viewport["height"] as? Int, 844)
        let card = try XCTUnwrap(metrics["composer"] as? [String: Any], "real Home must expose its composer even offline")
        XCTAssertEqual(card["visible"] as? Bool, true)
        XCTAssertEqual(metrics["compact"] as? Bool, true)
        XCTAssertLessThanOrEqual(try XCTUnwrap(card["height"] as? Double), 80, "empty compact composer remains thin")
        let menu = try XCTUnwrap(metrics["menu"] as? [String: Any])
        let voice = try XCTUnwrap(metrics["voice"] as? [String: Any])
        let send = try XCTUnwrap(metrics["send"] as? [String: Any])
        for control in [menu, voice, send] { XCTAssertEqual(control["visible"] as? Bool, true) }
        XCTAssertLessThanOrEqual(try XCTUnwrap(menu["right"] as? Double), try XCTUnwrap(voice["x"] as? Double))
        XCTAssertLessThanOrEqual(try XCTUnwrap(voice["right"] as? Double), try XCTUnwrap(send["x"] as? Double))
    }
}
#endif
