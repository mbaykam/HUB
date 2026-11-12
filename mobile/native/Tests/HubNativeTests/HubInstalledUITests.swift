import Foundation
import CryptoKit
import XCTest
@testable import HubNative

private final class InstalledUIFixture: URLProtocol {
    static var respond: ((URLRequest) -> (Int, String, String))!
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (code, type, body) = Self.respond(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": type])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class HubInstalledUITests: XCTestCase {
    private let html = Data("<!doctype html><div id=app>Isolated synthetic renderer</div>".utf8)
    private func manifest() -> [String: Any] {
        ["schema": 1, "profile": "hub-installed-web-v1", "compatibility": String(repeating: "a", count: 64), "graphRevision": String(repeating: "b", count: 12),
         "document": ["file": "document.html", "bytes": html.count, "sha256": SHA256.hash(data: html).map { String(format: "%02x", $0) }.joined()],
         "resources": ["memory-graph-browser.js", "voice-browser.js"].map { ["file": $0, "bytes": 1, "sha256": String(repeating: "c", count: 64), "embedded": true] as [String: Any] },
         "packages": ["@deepseek-ai/dsh-ui", "@lencx/minke-harness-overlay"]]
    }
    func testOnlyCompleteHashVerifiedSignedResourcesAreUsable() throws {
        let original = manifest()
        let accepted = try HubInstalledUI(manifest: JSONSerialization.data(withJSONObject: original), document: html)
        XCTAssertEqual(accepted.html, String(data: html, encoding: .utf8))
        XCTAssertEqual(accepted.manifest.compatibility, String(repeating: "a", count: 64))
        for (key, value) in [("schema", 2), ("profile", "foreign"), ("compatibility", "not-a-hash"), ("packages", ["duplicate", "duplicate"]), ("resources", [])] as [(String, Any)] {
            var invalid = original; invalid[key] = value
            XCTAssertThrowsError(try HubInstalledUI(manifest: JSONSerialization.data(withJSONObject: invalid), document: html), key)
        }
        XCTAssertThrowsError(try HubInstalledUI(manifest: JSONSerialization.data(withJSONObject: original), document: html + Data("modified".utf8)))
        var path = original; path["document"] = ["file": "../document.html", "bytes": html.count, "sha256": String(repeating: "a", count: 64)]
        XCTAssertThrowsError(try HubInstalledUI(manifest: JSONSerialization.data(withJSONObject: path), document: html))
    }
    func testBundleReaderRejectsSymbolicManifestInsteadOfReadingAnotherDirectory() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let data = try JSONSerialization.data(withJSONObject: manifest())
        try data.write(to: root.appendingPathComponent("source.json"))
        try html.write(to: root.appendingPathComponent("document.html"))
        try FileManager.default.createSymbolicLink(atPath: root.appendingPathComponent("manifest.json").path, withDestinationPath: root.appendingPathComponent("source.json").path)
        XCTAssertThrowsError(try HubInstalledUI.load(from: root))
    }
    func testCompatibilityChecksKeepCookiesScopedAndRejectLoginOrMalformedResponses() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [InstalledUIFixture.self]
        let api = HubInstalledUIAPI(server: try HubServer(address: "https://hub.example.com"), configuration: config) {
            [HTTPCookie(properties: [.domain: "hub.example.com", .path: "/api/hub/ui", .name: "session", .value: "synthetic", .secure: "TRUE"])!,
             HTTPCookie(properties: [.domain: "foreign.example.com", .path: "/", .name: "foreign", .value: "never-send"])!]
        }
        defer { api.invalidate() }
        InstalledUIFixture.respond = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://hub.example.com/api/hub/ui/status")
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "session=synthetic")
            return (200, "application/json", "{\"schema\":1,\"compatibility\":\"\(String(repeating: "a", count: 64))\"}")
        }
        let compatibility = try await api.compatibility()
        XCTAssertEqual(compatibility, String(repeating: "a", count: 64))
        for (status, type, body) in [(200, "text/html", "<html>Login</html>"), (302, "text/html", "Sign in"), (401, "application/json", "{}"), (200, "application/json", "{\"schema\":true,\"compatibility\":\"x\"}"), (200, "application/json", "{}"), (200, "application/json", String(repeating: " ", count: 4097))] {
            InstalledUIFixture.respond = { _ in (status, type, body) }
            do { _ = try await api.compatibility(); XCTFail("Invalid response accepted") } catch {}
        }
    }
}
