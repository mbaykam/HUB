import XCTest
#if canImport(WebKit)
import WebKit

/// Isolated public-API probe. No application code, credentials, or network is used.
@MainActor
final class OriginTests: XCTestCase, WKNavigationDelegate {
    private var finished: XCTestExpectation?
    private var navigationError: Error?

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
        XCTAssertEqual(values["base"] as? String, "https://installed-ui-probe.invalid/")
        XCTAssertEqual(values["secure"] as? Bool, true)
        XCTAssertEqual(values["relative"] as? String, "https://installed-ui-probe.invalid/api")
        XCTAssertEqual(values["websocket"] as? String, "wss://installed-ui-probe.invalid/api/remote.mux")
        let cookies = try XCTUnwrap(values["cookies"] as? String)
        XCTAssertTrue(cookies.contains("probe_visible=synthetic"))
        XCTAssertFalse(cookies.contains("probe_private"))
        XCTAssertEqual(webView.backForwardList.backList.count, 0)
        webView.navigationDelegate = nil
        webView.stopLoading()
    }
}
#endif
