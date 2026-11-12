import XCTest
#if canImport(WebKit) && os(macOS)
import WebKit
import Security

/// Probe-only trust exception: one generated leaf certificate, one loopback port,
/// one nonpersistent web view. Nothing changes the app or the system trust store.
@MainActor
final class TransportTests: XCTestCase, WKNavigationDelegate {
    private var finished: XCTestExpectation?
    private var navigationError: Error?
    private var certificate = Data()
    private var origin: URL!
    private var pinnedChallenges = 0

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finished?.fulfill() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        navigationError = error; finished?.fulfill()
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        navigationError = error; finished?.fulfill()
    }
    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              space.host == "127.0.0.1", space.port == origin.port,
              let trust = space.serverTrust,
              let leaf = SecTrustGetCertificateAtIndex(trust, 0),
              SecCertificateCopyData(leaf) as Data == certificate else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        pinnedChallenges += 1
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func testIsolatedHTTPSAndWSSCookieTransport() async throws {
        guard ProcessInfo.processInfo.environment["HUB_RUN_WEBKIT_TRANSPORT_PROBE"] == "1" else {
            throw XCTSkip("Set HUB_RUN_WEBKIT_TRANSPORT_PROBE=1 on a graphical Mac with python3 and openssl")
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("hub-origin-probe-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Fixtures/transport.py")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["python3", script.path, directory.path]
        defer {
            if process.isRunning { process.terminate(); process.waitUntilExit() }
            try? FileManager.default.removeItem(at: directory)
        }
        try process.run()
        let ready = directory.appendingPathComponent("ready.json")
        let deadline = Date().addingTimeInterval(10)
        while !FileManager.default.fileExists(atPath: ready.path), process.isRunning, Date() < deadline {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        guard FileManager.default.fileExists(atPath: ready.path) else {
            XCTFail("Loopback TLS fixture did not start; check python3/openssl availability")
            return
        }
        let metadata = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: ready)) as? [String: String])
        origin = try XCTUnwrap(URL(string: try XCTUnwrap(metadata["origin"])))
        XCTAssertEqual(origin.host, "127.0.0.1")
        certificate = try Data(contentsOf: directory.appendingPathComponent("certificate.der"))
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        defer { webView.navigationDelegate = nil; webView.stopLoading() }
        finished = expectation(description: "isolated installed document loaded")
        webView.loadHTMLString("""
        <!doctype html><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src \(origin.absoluteString) \(origin.absoluteString.replacingOccurrences(of: "https:", with: "wss:"))">
        <title>Synthetic transport probe</title>
        """, baseURL: origin.appendingPathComponent("/"))
        await fulfillment(of: [try XCTUnwrap(finished)], timeout: 15)
        if let navigationError { throw navigationError }
        let result = try await webView.callAsyncJavaScript("""
        async function get(path) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8000);
          try {
            const response = await fetch(path, {credentials:'include', signal:controller.signal});
            return {status:response.status, type:response.headers.get('content-type'), body:await response.json()};
          } finally { clearTimeout(timer); }
        }
        function socket() {
          return new Promise((resolve) => {
            const ws = new WebSocket(location.origin.replace(/^https:/, 'wss:') + '/api/socket');
            let done = false;
            const timer = setTimeout(() => finish({error:'timeout'}), 8000);
            function finish(value) { if(done)return; done=true; clearTimeout(timer); ws.close(); resolve(value); }
            ws.onmessage = e => finish(JSON.parse(e.data));
            ws.onerror = () => finish({error:'rejected'});
            ws.onclose = () => finish({error:'closed-without-message'});
          });
        }
        const seed = await get('/seed');
        const authenticated = await get('/api/inspect');
        const hiddenCookie = !document.cookie.includes('probe_session');
        const wss = await socket();
        const expire = await get('/expire');
        const expired = await get('/api/inspect');
        const rejectedWSS = await socket();
        return {href:location.href, origin:location.origin, seed, authenticated, hiddenCookie, wss, expire, expired, rejectedWSS};
        """, arguments: [:], in: nil, contentWorld: .page)
        let values = try XCTUnwrap(result as? [String: Any])
        print("InstalledUIOrigin transport (synthetic only): \(values)")
        XCTAssertEqual(values["origin"] as? String, origin.absoluteString)
        XCTAssertEqual(values["href"] as? String, origin.absoluteString + "/")
        XCTAssertEqual(webView.url?.absoluteString, origin.absoluteString + "/")
        XCTAssertGreaterThan(pinnedChallenges, 0, "HTTPS used the exact ephemeral certificate pin")
        XCTAssertEqual(values["hiddenCookie"] as? Bool, true)
        let authenticated = try XCTUnwrap(values["authenticated"] as? [String: Any])
        XCTAssertEqual(authenticated["status"] as? Int, 200)
        XCTAssertEqual(authenticated["type"] as? String, "application/json")
        let body = try XCTUnwrap(authenticated["body"] as? [String: Any])
        XCTAssertEqual(body["fixture"] as? String, "authenticated")
        let fetchHeaders = try XCTUnwrap(body["headers"] as? [String: Any])
        XCTAssertEqual(fetchHeaders["Cookie"] as? String, "probe_session=synthetic-only")
        XCTAssertEqual(fetchHeaders["Sec-Fetch-Site"] as? String, "same-origin")
        XCTAssertEqual(fetchHeaders["Referer"] as? String, origin.absoluteString + "/")
        // GET fetch may omit Origin; WebSocket must send it.
        if let fetchOrigin = fetchHeaders["Origin"] as? String { XCTAssertEqual(fetchOrigin, origin.absoluteString) }
        let wss = try XCTUnwrap(values["wss"] as? [String: Any])
        XCTAssertEqual(wss["fixture"] as? String, "authenticated-wss", "a TLS/cookie failure must fail, never skip")
        let socketHeaders = try XCTUnwrap(wss["headers"] as? [String: Any])
        XCTAssertEqual(socketHeaders["Cookie"] as? String, "probe_session=synthetic-only")
        XCTAssertEqual(socketHeaders["Origin"] as? String, origin.absoluteString)
        let expired = try XCTUnwrap(values["expired"] as? [String: Any])
        XCTAssertEqual(expired["status"] as? Int, 401)
        XCTAssertEqual(expired["type"] as? String, "application/json")
        let rejection = try XCTUnwrap(values["rejectedWSS"] as? [String: Any])
        XCTAssertEqual(rejection["error"] as? String, "rejected")
    }
}
#endif
