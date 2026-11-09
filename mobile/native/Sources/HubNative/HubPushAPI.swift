import Foundation

public struct HubPushStatus: Decodable {
    public let version: Int
    public let configured: Bool
    public let devices: Int
    public let pending: Int
}

public enum HubPushError: Error { case signInRequired, updateHost, invalidResponse, unavailable }

/// Fixed, authenticated native endpoint; no arbitrary URL or redirect capability.
public final class HubPushAPI {
    private let server: HubServer
    private let cookies: () async -> [HTTPCookie]
    private let session: URLSession
    public init(server: HubServer, configuration: URLSessionConfiguration = .ephemeral, cookies: @escaping () async -> [HTTPCookie]) {
        self.server = server; self.cookies = cookies
        let config = configuration.copy() as! URLSessionConfiguration
        config.httpShouldSetCookies = false; config.httpCookieStorage = nil; config.urlCache = nil
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 30
        session = URLSession(configuration: config, delegate: HubNoRedirects(), delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }
    public func status() async throws -> HubPushStatus { try await request(nil) }
    public func register(_ identity: HubPushIdentity, token: Data, environment: String) async throws -> HubPushStatus {
        guard identity.enabled, (16...256).contains(token.count), ["development", "production"].contains(environment) else { throw HubPushError.invalidResponse }
        return try await request(["action": "register", "device": ["id": identity.id.uuidString.lowercased(), "generation": identity.generation, "token": token.map { String(format: "%02x", $0) }.joined(), "environment": environment]])
    }
    public func revoke(_ identity: HubPushIdentity) async throws -> HubPushStatus {
        guard !identity.enabled else { throw HubPushError.invalidResponse }
        return try await request(["action": "revoke", "deviceId": identity.id.uuidString.lowercased(), "generation": identity.generation])
    }
    private func request(_ body: [String: Any]?) async throws -> HubPushStatus {
        let url = server.origin.appendingPathComponent("api/hub/notifications")
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.allHTTPHeaderFields = HTTPCookie.requestHeaderFields(with: server.cookies(await cookies(), for: url))
        request.setValue("1", forHTTPHeaderField: "x-hub-native-push")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpMethod = "POST"; request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(String(server.origin.absoluteString.dropLast()), forHTTPHeaderField: "Origin")
        }
        try Task.checkCancellation()
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw HubPushError.invalidResponse }
        switch response.statusCode {
        case 200: break
        case 300...399, 401, 403: throw HubPushError.signInRequired
        case 404: throw HubPushError.updateHost
        default: throw HubPushError.unavailable
        }
        guard response.mimeType == "application/json", data.count <= 4096 else { throw HubPushError.invalidResponse }
        let result = try JSONDecoder().decode(HubPushStatus.self, from: data)
        guard result.version == 1, result.devices >= 0, result.pending >= 0 else { throw HubPushError.invalidResponse }
        return result
    }
}
