import Foundation

/// A user-selected HTTPS authority, never an authentication URL or a credential.
/// Shared by the app target and the small platform-independent Swift test target.
public struct HubServer: Equatable {
    public let origin: URL

    public enum ValidationError: Error { case invalidAddress }

    public init(address: String) throws {
        let value = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.contains("\\"),
              !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              var parts = URLComponents(string: value),
              parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.percentEncodedPath.isEmpty || parts.percentEncodedPath == "/",
              parts.port == nil || (1...65535).contains(parts.port!),
              !host.contains("%") else { throw ValidationError.invalidAddress }
        parts.scheme = "https"
        parts.host = host.lowercased()
        parts.path = "/"
        if parts.port == 443 { parts.port = nil }
        guard let origin = parts.url else { throw ValidationError.invalidAddress }
        self.origin = origin
    }

    public func contains(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https" &&
        url.host?.lowercased() == origin.host?.lowercased() &&
        (url.port ?? 443) == (origin.port ?? 443) &&
        url.user == nil && url.password == nil
    }

    public var statusURL: URL { origin.appendingPathComponent("api/hub/voice/status") }

    /// Restrict native cookie use to this one authority and an actual request path.
    /// Cookies stay native; no string is passed to a page or written to preferences.
    public func cookies(_ cookies: [HTTPCookie], for url: URL, now: Date = Date()) -> [HTTPCookie] {
        guard contains(url), let host = url.host?.lowercased() else { return [] }
        return cookies.filter { cookie in
            let domain = cookie.domain.lowercased()
            let domainMatches = domain.hasPrefix(".")
                ? host == String(domain.dropFirst()) || host.hasSuffix(domain)
                : host == domain
            let path = cookie.path
            let pathMatches = url.path == path ||
                (url.path.hasPrefix(path) && (path.hasSuffix("/") || url.path.dropFirst(path.count).hasPrefix("/")))
            return domainMatches && pathMatches && (cookie.expiresDate.map { $0 > now } ?? true)
        }
    }
}
