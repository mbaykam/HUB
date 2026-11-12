import XCTest
#if canImport(WebKit)
import WebKit

/// Isolated public-API probe. No application code, credentials, or network is used.
@MainActor
final class OriginTests: XCTestCase, WKNavigationDelegate {
    private var finished: XCTestExpectation?
    private var navigationError: Error?
    private var guardNavigation: XCTestExpectation?
    private var guardValues: [String: String]?

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.request.url?.path == "/navigation-guard-probe" {
            let origin = action.sourceFrame.securityOrigin
            guardValues = [
                "destination": action.request.url?.absoluteString ?? "<nil>",
                "source": action.sourceFrame.request.url?.absoluteString ?? "<nil>",
                "sourceMain": String(action.sourceFrame.isMainFrame),
                "targetMain": String(action.targetFrame?.isMainFrame ?? false),
                "securityOrigin": "\(origin.protocol)://\(origin.host):\(origin.port)",
                "linkActivated": String(action.navigationType == .linkActivated),
                "webViewURL": webView.url?.absoluteString ?? "<nil>"
            ]
            decisionHandler(.cancel) // The reserved host must never receive a request.
            guardNavigation?.fulfill()
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        finished?.fulfill()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        navigationError = error
        finished?.fulfill()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        navigationError = error
        finished?.fulfill()
    }

    func testHTTPSBaseOriginAndCookiesWithoutNetwork() async throws {
        guard ProcessInfo.processInfo.environment["HUB_RUN_WEBKIT_PROBE"] == "1" else {
            throw XCTSkip("Set HUB_RUN_WEBKIT_PROBE=1 in a graphical macOS session to run WebKit")
        }
        let config = WKWebViewConfiguration()
        // The production app uses persistent storage; this isolated probe must not
        // read or leave an actual user's cookies, caches, or website storage.
        config.websiteDataStore = .nonPersistent()
        let store = config.websiteDataStore.httpCookieStore
        for (name, httpOnly) in [("probe_visible", false), ("probe_private", true)] {
            var properties: [HTTPCookiePropertyKey: Any] = [
                .domain: "installed-ui-probe.invalid", .path: "/",
                .name: name, .value: "synthetic", .secure: "TRUE"
            ]
            if httpOnly { properties[HTTPCookiePropertyKey("HttpOnly")] = "TRUE" }
            let cookie = try XCTUnwrap(HTTPCookie(properties: properties))
            XCTAssertEqual(cookie.isHTTPOnly, httpOnly)
            await withCheckedContinuation { continuation in
                store.setCookie(cookie) { continuation.resume() }
            }
        }

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        finished = expectation(description: "inline document committed")
        let html = """
        <!doctype html><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'">
        <title>Isolated installed UI origin probe</title><div id="root">Synthetic probe</div>
        <a id="guard-link" href="/navigation-guard-probe">Synthetic navigation</a>
        """
        webView.loadHTMLString(html, baseURL: URL(string: "https://installed-ui-probe.invalid/")!)
        await fulfillment(of: [try XCTUnwrap(finished)], timeout: 15)
        if let navigationError { throw navigationError }

        let result = try await webView.evaluateJavaScript("""
        ({origin: location.origin, href: location.href, base: document.baseURI,
          secure: isSecureContext, cookies: document.cookie,
          relative: new URL('/api', document.baseURI).href,
          websocket: new URL('/api/remote.mux', location.origin).href.replace(/^https:/, 'wss:')})
        """)
        let values = try XCTUnwrap(result as? [String: Any])
        XCTAssertEqual(values["origin"] as? String, "https://installed-ui-probe.invalid")
        XCTAssertEqual(values["href"] as? String, "https://installed-ui-probe.invalid/")
        XCTAssertEqual(webView.url?.absoluteString, "https://installed-ui-probe.invalid/")
        XCTAssertEqual(values["base"] as? String, "https://installed-ui-probe.invalid/")
        XCTAssertEqual(values["secure"] as? Bool, true)
        XCTAssertEqual(values["relative"] as? String, "https://installed-ui-probe.invalid/api")
        XCTAssertEqual(values["websocket"] as? String, "wss://installed-ui-probe.invalid/api/remote.mux")
        let cookies = try XCTUnwrap(values["cookies"] as? String)
        XCTAssertTrue(cookies.contains("probe_visible=synthetic"))
        XCTAssertFalse(cookies.contains("probe_private"))
        XCTAssertEqual(webView.backForwardList.backList.count, 0)
        guardNavigation = expectation(description: "native navigation guard sees inline document source")
        _ = try await webView.evaluateJavaScript("document.getElementById('guard-link').click()")
        await fulfillment(of: [try XCTUnwrap(guardNavigation)], timeout: 10)
        let observed = try XCTUnwrap(guardValues)
        print("InstalledUIOrigin navigation guard: \(observed)")
        XCTAssertEqual(observed["destination"], "https://installed-ui-probe.invalid/navigation-guard-probe")
        XCTAssertEqual(observed["source"], "https://installed-ui-probe.invalid/")
        XCTAssertEqual(observed["webViewURL"], "https://installed-ui-probe.invalid/")
        XCTAssertEqual(observed["sourceMain"], "true")
        XCTAssertEqual(observed["targetMain"], "true")
        XCTAssertEqual(observed["linkActivated"], "true")
        // WKSecurityOrigin uses port 0 for an implicit default port.
        XCTAssertEqual(observed["securityOrigin"], "https://installed-ui-probe.invalid:0")
        XCTAssertEqual(webView.url?.absoluteString, "https://installed-ui-probe.invalid/", "cancel leaves the installed document in place")
        webView.navigationDelegate = nil
        webView.stopLoading()
    }
}
#endif
