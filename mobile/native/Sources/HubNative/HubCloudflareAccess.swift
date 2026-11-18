import Foundation

/// A Cloudflare Access service token for one HUB address. With it, Cloudflare
/// admits the app on every request without the interactive login page, and
/// HUB issues its own session cookie behind that gate.
public struct HubAccessToken: Codable, Equatable {
    public let clientID: String
    public let clientSecret: String

    public enum ValidationError: Error { case invalidToken }

    public init(clientID: String, clientSecret: String) throws {
        let id = clientID.trimmingCharacters(in: .whitespacesAndNewlines)
        let secret = clientSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: ".-_"))
        guard id.hasSuffix(".access"), (16...200).contains(id.utf8.count),
              (32...200).contains(secret.utf8.count),
              id.unicodeScalars.allSatisfy(allowed.contains),
              secret.unicodeScalars.allSatisfy(allowed.contains) else { throw ValidationError.invalidToken }
        self.clientID = id
        self.clientSecret = secret
    }

    var headers: [String: String] {
        ["CF-Access-Client-Id": clientID, "CF-Access-Client-Secret": clientSecret]
    }
}

/// The token in use for each HUB origin. Every API session made for that
/// origin sends it; no other host ever receives it.
public enum HubAccessHeaders {
    private static let lock = NSLock()
    private static var tokens: [String: HubAccessToken] = [:]

    public static func use(_ token: HubAccessToken?, for server: HubServer) {
        lock.lock(); defer { lock.unlock() }
        tokens[server.origin.absoluteString] = token
    }

    public static func token(for server: HubServer) -> HubAccessToken? {
        lock.lock(); defer { lock.unlock() }
        return tokens[server.origin.absoluteString]
    }

    /// Adds the token headers to a session that only talks to `server`.
    public static func apply(to configuration: URLSessionConfiguration, server: HubServer) {
        guard let token = token(for: server) else { return }
        var headers = configuration.httpAdditionalHeaders ?? [:]
        for (key, value) in token.headers { headers[key] = value }
        configuration.httpAdditionalHeaders = headers
    }
}

extension HubDeviceState {
    private var accessKey: String { "cf-access:" + server.origin.absoluteString }

    public func rememberAccessToken(_ token: HubAccessToken) throws {
        let data = try JSONEncoder().encode(token)
        guard data.count <= 4096 else { throw StateError.invalidRecord }
        try store.write(data, for: accessKey)
    }

    public func accessToken() throws -> HubAccessToken? {
        guard let data = try store.read(accessKey) else { return nil }
        guard data.count <= 4096 else { throw StateError.invalidRecord }
        let saved = try JSONDecoder().decode(HubAccessToken.self, from: data)
        return try HubAccessToken(clientID: saved.clientID, clientSecret: saved.clientSecret)
    }

    public func clearAccessToken() throws { try store.remove(accessKey) }
}

public enum HubAccessSessionError: Error, Equatable {
    /// Cloudflare refused the token: wrong values, or no Service Auth policy.
    case tokenRejected
    /// HUB answered but issued no session cookie.
    case noSession
    case unavailable
}

/// Uses the service token to pass Cloudflare Access and lets HUB issue its
/// own session cookie, with no web page and no typing.
public enum HubAccessSession {
    public static func issue(server: HubServer, token: HubAccessToken,
                             configuration: URLSessionConfiguration = .ephemeral) async throws -> [HTTPCookie] {
        let config = configuration.copy() as! URLSessionConfiguration
        config.httpShouldSetCookies = false; config.httpCookieStorage = nil; config.urlCache = nil
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 20
        let session = URLSession(configuration: config, delegate: HubNoRedirects(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: server.origin, cachePolicy: .reloadIgnoringLocalCacheData)
        for (key, value) in token.headers { request.setValue(value, forHTTPHeaderField: key) }
        request.setValue("text/html", forHTTPHeaderField: "Accept")
        let response: URLResponse
        do { (_, response) = try await session.data(for: request) } catch { throw HubAccessSessionError.unavailable }
        guard let http = response as? HTTPURLResponse else { throw HubAccessSessionError.unavailable }
        let location = (http.value(forHTTPHeaderField: "Location") ?? "").lowercased()
        // Cloudflare sends a rejected service token to its login page.
        if [401, 403].contains(http.statusCode) || location.contains("cloudflareaccess.com") || location.contains("/cdn-cgi/access/") {
            throw HubAccessSessionError.tokenRejected
        }
        guard (200...399).contains(http.statusCode) else { throw HubAccessSessionError.unavailable }
        let fields = http.allHeaderFields.reduce(into: [String: String]()) { result, item in
            if let key = item.key as? String, let value = item.value as? String { result[key] = value }
        }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: fields, for: server.origin)
            .filter { $0.name.hasPrefix("dsh-auth-") }
        let usable = server.cookies(cookies, for: server.statusURL)
        guard !usable.isEmpty else { throw HubAccessSessionError.noSession }
        return usable
    }
}
