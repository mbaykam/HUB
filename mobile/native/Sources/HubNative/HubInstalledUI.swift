import Foundation
import CryptoKit

/// Signed app resources only. This never reads a downloaded update, a user's
/// conversation, a web snapshot, or a saved draft.
public struct HubInstalledUI {
    public enum ResourceError: Error { case invalidManifest, invalidDocument }
    public struct Manifest: Decodable {
        public let schema: Int
        public let profile: String
        public let compatibility: String
        public let graphRevision: String
        public let document: Resource
        public let resources: [Resource]
        public let packages: [String]
    }
    public struct Resource: Decodable {
        public let file: String
        public let sha256: String
        public let bytes: Int
        public let embedded: Bool?
    }
    public let manifest: Manifest
    public let html: String

    private static func hex(_ text: String, count: Int) -> Bool {
        text.utf8.count == count && text.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    public init(manifest data: Data, document: Data) throws {
        guard data.count <= 131_072,
              let manifest = try? JSONDecoder().decode(Manifest.self, from: data),
              manifest.schema == 1, manifest.profile == "hub-installed-web-v1",
              Self.hex(manifest.compatibility, count: 64), Self.hex(manifest.graphRevision, count: 12),
              manifest.document.file == "document.html", manifest.document.embedded != true,
              Self.hex(manifest.document.sha256, count: 64),
              manifest.document.bytes > 0, manifest.document.bytes <= 64 * 1024 * 1024,
              !manifest.packages.isEmpty, manifest.packages.count <= 200,
              Set(manifest.packages).count == manifest.packages.count,
              manifest.packages.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 160 && $0.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || [45, 46, 47, 64, 95].contains($0) } }),
              manifest.resources.count == 2,
              Set(manifest.resources.map(\.file)) == Set(["memory-graph-browser.js", "voice-browser.js"]),
              manifest.resources.allSatisfy({ $0.embedded == true && $0.bytes > 0 && $0.bytes <= 32 * 1024 * 1024 && Self.hex($0.sha256, count: 64) })
        else { throw ResourceError.invalidManifest }
        guard document.count == manifest.document.bytes,
              SHA256.hash(data: document).map({ String(format: "%02x", $0) }).joined() == manifest.document.sha256,
              let html = String(data: document, encoding: .utf8), html.hasPrefix("<!doctype html>")
        else { throw ResourceError.invalidDocument }
        self.manifest = manifest
        self.html = html
    }

    public static func load(from directory: URL) throws -> HubInstalledUI {
        func read(_ name: String, limit: Int) throws -> Data {
            let file = directory.appendingPathComponent(name)
            let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true,
                  let size = values.fileSize, size > 0, size <= limit else { throw ResourceError.invalidManifest }
            return try Data(contentsOf: file, options: .mappedIfSafe)
        }
        return try HubInstalledUI(manifest: read("manifest.json", limit: 131_072), document: read("document.html", limit: 64 * 1024 * 1024))
    }
}

/// Read-only compatibility check. Cookies stay native, origin/path-scoped,
/// and never enter the installed document or a shared cookie jar.
public final class HubInstalledUIAPI {
    private let server: HubServer
    private let cookies: () async -> [HTTPCookie]
    private let session: URLSession
    public init(server: HubServer, configuration: URLSessionConfiguration = .ephemeral, cookies: @escaping () async -> [HTTPCookie]) {
        self.server = server; self.cookies = cookies
        let config = configuration.copy() as! URLSessionConfiguration
        config.httpShouldSetCookies = false; config.httpCookieStorage = nil; config.urlCache = nil; config.urlCredentialStorage = nil
        config.timeoutIntervalForRequest = 8
        session = URLSession(configuration: config, delegate: HubNoRedirects(), delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }
    public func invalidate() { session.invalidateAndCancel() }
    public func compatibility() async throws -> String {
        let url = server.origin.appendingPathComponent("api/hub/ui/status")
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        for (key, value) in HTTPCookie.requestHeaderFields(with: server.cookies(await cookies(), for: url)) { request.setValue(value, forHTTPHeaderField: key) }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.url == url else { throw HubVoiceAPIError.invalidResponse }
        if [301, 302, 303, 307, 308, 401, 403].contains(http.statusCode) { throw HubVoiceAPIError.signInRequired }
        struct Status: Decodable { let schema: Int; let compatibility: String }
        guard http.statusCode == 200, http.mimeType == "application/json", data.count <= 4096,
              let body = try? JSONDecoder().decode(Status.self, from: data), body.schema == 1
        else { throw HubVoiceAPIError.invalidResponse }
        let value = body.compatibility
        guard
              value.utf8.count == 64, value.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) })
        else { throw HubVoiceAPIError.invalidResponse }
        return value
    }
}
