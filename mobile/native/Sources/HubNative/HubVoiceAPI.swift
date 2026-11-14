import Foundation

public struct HubVoiceStatus: Decodable {
    public let enabled: Bool
    public let busy: Bool
    public let serverTime: Int64
    public let activeCall: HubActiveVoiceCall?
}

public struct HubActiveVoiceCall: Decodable {
    public let callId: String
    public let sessionId: String
}

public struct HubVoiceAttention: Decodable {
    public enum Mode: String, Decodable { case active, background }
    public let mode: Mode
    public let wakePhrases: [String]
}
public struct HubOwnedVoiceHealth: Decodable {
    public let callId: String
    public let sessionId: String
    public let status: String
    public let attention: HubVoiceAttention?
    public let inputPaused: Bool?
}

public struct HubVoiceLease: Codable {
    public let callId: String
    public let sessionId: String
    public let iceServers: [HubIceServer]?
}

public struct HubIceServer: Codable {
    public let urls: [String]
    public let username: String?
    public let credential: String?

    enum CodingKeys: String, CodingKey { case urls, username, credential }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let url = try? container.decode(String.self, forKey: .urls) { urls = [url] }
        else { urls = try container.decode([String].self, forKey: .urls) }
        username = try container.decodeIfPresent(String.self, forKey: .username)
        credential = try container.decodeIfPresent(String.self, forKey: .credential)
    }
}

public enum HubVoiceAPIError: Error, Equatable {
    case signInRequired, busy, callUnavailable, admissionExpired, serviceUnavailable, invalidResponse, updateHost
}

final class HubNoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Native-only control plane. Exact endpoints, fresh origin-scoped cookies,
/// no shared cookie jar/cache, no redirect-following, no credentials exposed to JS.
public final class HubVoiceAPI {
    private let server: HubServer
    private let cookies: () async -> [HTTPCookie]
    private let session: URLSession

    public init(server: HubServer, configuration: URLSessionConfiguration = .ephemeral, cookies: @escaping () async -> [HTTPCookie]) {
        self.server = server
        self.cookies = cookies
        let config = configuration.copy() as! URLSessionConfiguration
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCache = nil
        config.timeoutIntervalForRequest = 30
        session = URLSession(configuration: config, delegate: HubNoRedirects(), delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }
    public func invalidate() { session.invalidateAndCancel() }

    static func validID(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 200 && value.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || [45, 46, 95].contains($0)
        }
    }

    private func request(_ action: String, method: String = "GET", body: [String: Any]? = nil, callId: String? = nil, jpeg: Data? = nil, screenHeaders: [String: String] = [:], capturedAt: Date? = nil, presentationID: UUID? = nil, maxBytes: Int = 262_144) async throws -> Data {
        if let callId, !Self.validID(callId) { throw HubVoiceAPIError.invalidResponse }
        // action is private and supplied only by the fixed methods below.
        let url = server.origin.appendingPathComponent("api/hub/voice/\(action)")
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpMethod = method
        request.allHTTPHeaderFields = HTTPCookie.requestHeaderFields(with: server.cookies(await cookies(), for: url))
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(String(server.origin.absoluteString.dropLast()), forHTTPHeaderField: "Origin")
        }
        if let jpeg {
            request.httpBody = jpeg
            request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
            request.setValue(String(server.origin.absoluteString.dropLast()), forHTTPHeaderField: "Origin")
        }
        if action == "screen" {
            request.timeoutInterval = 6
            request.setValue("1", forHTTPHeaderField: "x-hub-voice-screen")
            for (key, value) in screenHeaders { request.setValue(value, forHTTPHeaderField: key) }
            if let capturedAt {
                let age = Date().timeIntervalSince(capturedAt)
                guard age.isFinite, age >= 0, age < 5 else { throw HubVoiceAPIError.invalidResponse }
                request.setValue(String(Int(age * 1000)), forHTTPHeaderField: "x-hub-screen-age-ms")
            }
        }
        if action == "share" { request.setValue("1", forHTTPHeaderField: "x-hub-voice-share") }
        if let callId { request.setValue(callId, forHTTPHeaderField: "x-hub-voice-call") }
        if let presentationID { request.setValue(presentationID.uuidString.lowercased(), forHTTPHeaderField: "x-hub-presentation") }
        try Task.checkCancellation()
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw HubVoiceAPIError.invalidResponse }
        switch response.statusCode {
        case 200: break
        case 300...399, 401, 403: throw HubVoiceAPIError.signInRequired
        case 404, 405: throw action == "screen" ? HubVoiceAPIError.updateHost : HubVoiceAPIError.serviceUnavailable
        case 409: throw HubVoiceAPIError.busy
        case 410: throw HubVoiceAPIError.callUnavailable
        case 400:
            let object = data.count <= 4096 ? (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] : nil
            throw object?["error"] as? String == "expired-admission" ? HubVoiceAPIError.admissionExpired : HubVoiceAPIError.invalidResponse
        default: throw HubVoiceAPIError.serviceUnavailable
        }
        guard response.mimeType == "application/json", data.count <= maxBytes else { throw action == "screen" ? HubVoiceAPIError.updateHost : HubVoiceAPIError.invalidResponse }
        return data
    }

    public func presentation(callID: String) async throws -> HubChatPresentation? {
        let data = try await request("presentation", callId: callID, maxBytes: 4_096)
        return try JSONDecoder().decode(HubChatPresentation.Summary.self, from: data).presentation
    }

    public func presentationDocument(callID: String, id: UUID) async throws -> String {
        let data = try await request("presentation-document", callId: callID, presentationID: id, maxBytes: 10_000_000)
        return try HubChatPresentation.decodeDocument(data)
    }

    public func status() async throws -> HubVoiceStatus {
        let value = try JSONDecoder().decode(HubVoiceStatus.self, from: await request("status"))
        guard value.serverTime > 0 else { throw HubVoiceAPIError.invalidResponse }
        return value
    }

    public func screenConsent(callId: String, shareID: UUID, start: Bool) async throws {
        guard Self.validID(callId) else { throw HubVoiceAPIError.invalidResponse }
        let data = try await request("screen", method: start ? "POST" : "DELETE", body: ["shareId": shareID.uuidString.lowercased()], callId: callId)
        let value = try JSONDecoder().decode(HubScreenStatus.self, from: data)
        guard value.maxAgeMs == 5000, !start || value.sharing else { throw HubVoiceAPIError.invalidResponse }
    }
    public func screenFrame(callId: String, shareID: UUID, sequence: Int, frame: HubScreenFrame) async throws {
        guard Self.validID(callId), sequence >= 0, sequence <= 9_007_199_254_740_991, !frame.jpeg.isEmpty, frame.jpeg.count <= HubScreenFrames.maximumBytes else { throw HubVoiceAPIError.invalidResponse }
        let data = try await request("screen", method: "PUT", callId: callId, jpeg: frame.jpeg, screenHeaders: ["x-hub-screen-share": shareID.uuidString.lowercased(), "x-hub-screen-sequence": String(sequence)], capturedAt: frame.capturedAt)
        let value = try JSONDecoder().decode(HubScreenStatus.self, from: data)
        guard value.sharing, value.hasFrame, value.maxAgeMs == 5000 else { throw HubVoiceAPIError.invalidResponse }
    }

    /// A lost response must reuse the original receipt, never create a second
    /// conversation. The receipt is created before sending and stays stable.
    public func open(serverTime: Int64, sessionId: String? = nil, requestId: UUID = UUID()) async throws -> HubVoiceLease {
        guard serverTime > 0, serverTime <= 9_007_199_254_740_991, sessionId.map(Self.validID) ?? true else { throw HubVoiceAPIError.invalidResponse }
        var body: [String: Any] = ["requestId": requestId.uuidString.lowercased(), "requestedAt": serverTime]
        if let sessionId { body["sessionId"] = sessionId }
        let data: Data
        do { data = try await request("open", method: "POST", body: body) }
        catch let error as URLError where error.code != .cancelled {
            try Task.checkCancellation()
            data = try await request("open", method: "POST", body: body)
        }
        let lease = try JSONDecoder().decode(HubVoiceLease.self, from: data)
        guard Self.validID(lease.callId), Self.validID(lease.sessionId) else { throw HubVoiceAPIError.invalidResponse }
        return lease
    }

    public func recover(_ admission: HubVoiceAdmission) async throws -> HubVoiceLease {
        guard admission.origin == server.origin.absoluteString else { throw HubVoiceAPIError.invalidResponse }
        return try await open(serverTime: admission.requestedAt, sessionId: admission.sessionID, requestId: admission.requestID)
    }

    public func close(callId: String) async throws { _ = try await request("close", method: "POST", body: ["callId": callId]) }
    public func share(callId: String, uploadID: UUID, requestID: UUID) async throws {
        guard Self.validID(callId) else { throw HubVoiceAPIError.invalidResponse }
        let data = try await request("share", method: "POST", body: ["callId": callId, "requestId": requestID.uuidString.lowercased(), "uploads": [uploadID.uuidString.lowercased()], "instruction": "The user explicitly shared this file with the current conversation. Inspect it if supported; say clearly if its contents cannot be read."])
        struct Acceptance: Decodable { let accepted: Bool }
        guard try JSONDecoder().decode(Acceptance.self, from: data).accepted else { throw HubVoiceAPIError.invalidResponse }
    }
    public func interrupt(callId: String) async throws { _ = try await request("interrupt", method: "POST", body: ["callId": callId]) }
    public func ownedHealth(callId: String, sessionId: String) async throws -> HubOwnedVoiceHealth {
        guard Self.validID(callId), Self.validID(sessionId) else { throw HubVoiceAPIError.invalidResponse }
        let value = try JSONDecoder().decode(HubOwnedVoiceHealth.self, from: await request("status", method: "POST", body: ["callId": callId]))
        guard value.callId == callId, value.sessionId == sessionId else { throw HubVoiceAPIError.invalidResponse }
        if let attention = value.attention { try Self.validateAttention(attention) }
        return value
    }
    private static func validateAttention(_ value: HubVoiceAttention) throws {
        guard (1...3).contains(value.wakePhrases.count), value.wakePhrases.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 160 }) else { throw HubVoiceAPIError.invalidResponse }
    }
    @discardableResult public func attention(callId: String, background: Bool) async throws -> HubVoiceAttention {
        guard Self.validID(callId) else { throw HubVoiceAPIError.invalidResponse }
        struct Reply: Decodable { let attention: HubVoiceAttention }
        let value = try JSONDecoder().decode(Reply.self, from: await request("attention", method: "POST", body: ["callId": callId, "mode": background ? "background" : "active"])).attention
        try Self.validateAttention(value)
        guard value.mode == (background ? .background : .active) else { throw HubVoiceAPIError.invalidResponse }
        return value
    }
    public func offer(callId: String, payload: [String: Any], trickle: Bool = false) async throws -> Data {
        let allowed: Set<String> = ["sdp", "type", "pc_id", "restart_pc", "candidates"]
        guard Set(payload.keys).isSubset(of: allowed), !callId.isEmpty else { throw HubVoiceAPIError.invalidResponse }
        return try await request("offer", method: trickle ? "PATCH" : "POST", body: payload, callId: callId)
    }
}
