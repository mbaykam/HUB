import Foundation

public enum HubClientConfiguration {
    public static let serverPreferenceKey = "hub.ios.server-origin.v1"
}

public protocol HubPrivateStore {
    func read(_ key: String) throws -> Data?
    func write(_ data: Data, for key: String) throws
    func remove(_ key: String) throws
}

/// Persisted before HTTP admission, so process loss can replay exactly one
/// original receipt instead of creating a second conversation.
public struct HubVoiceAdmission: Codable {
    public let origin: String
    public let requestID: UUID
    public let requestedAt: Int64
    public let sessionID: String?
    public let savedAt: Date
    public init(server: HubServer, requestedAt: Int64, sessionID: String? = nil, requestID: UUID = UUID(), savedAt: Date = Date()) {
        origin = server.origin.absoluteString; self.requestedAt = requestedAt
        self.sessionID = sessionID; self.requestID = requestID; self.savedAt = savedAt
    }
}

public struct HubVoiceCheckpoint: Codable {
    public let origin: String
    public let lease: HubVoiceLease
    public let peerID: String?
    public let savedAt: Date
    public init(server: HubServer, lease: HubVoiceLease, peerID: String?, savedAt: Date = Date()) {
        origin = server.origin.absoluteString; self.lease = lease; self.peerID = peerID; self.savedAt = savedAt
    }
    public enum Recovery: Equatable { case resumeEndedConversation, rejoinOwnedCall, anotherCall, missingPeer }
    public func recovery(status: HubVoiceStatus) -> Recovery {
        guard status.busy else { return .resumeEndedConversation }
        guard let active = status.activeCall, active.callId == lease.callId, active.sessionId == lease.sessionId else { return .anotherCall }
        return peerID == nil ? .missingPeer : .rejoinOwnedCall
    }
    /// A new explicit Speak tap can recover a still-owned call, but never
    /// silently restore an ended conversation unless Resume was chosen.
    public func forExplicitStart(status: HubVoiceStatus, resumeEndedConversation: Bool) -> HubVoiceCheckpoint? {
        !resumeEndedConversation && recovery(status: status) == .resumeEndedConversation ? nil : self
    }
}

/// All values use an origin-scoped private-store key. Only the canonical server
/// address belongs in preferences; cookies and call capabilities never do.
public final class HubDeviceState {
    public enum StateError: Error { case invalidRecord }
    let server: HubServer
    let store: HubPrivateStore
    private let now: () -> Date
    private var authKey: String { "auth:" + server.origin.absoluteString }
    private var voiceKey: String { "voice:" + server.origin.absoluteString }
    private var admissionKey: String { "admission:" + server.origin.absoluteString }

    public init(server: HubServer, store: HubPrivateStore, now: @escaping () -> Date = Date.init) {
        self.server = server; self.store = store; self.now = now
    }
    private struct CookieValue: Codable {
        let name: String, value: String, domain: String, path: String
        let secure: Bool
        let expires: Date?
        init(_ cookie: HTTPCookie) {
            name = cookie.name; value = cookie.value; domain = cookie.domain; path = cookie.path
            secure = cookie.isSecure; expires = cookie.expiresDate
        }
        var cookie: HTTPCookie? {
            var parts: [HTTPCookiePropertyKey: Any] = [.name: name, .value: value, .domain: domain, .path: path]
            if secure { parts[.secure] = "TRUE" }
            if let expires { parts[.expires] = expires }
            return HTTPCookie(properties: parts)
        }
    }
    private struct Session: Codable { let origin: String; let savedAt: Date; let cookies: [CookieValue] }
    private func isAuthCookie(_ cookie: HTTPCookie) -> Bool {
        cookie.name == "CF_Authorization" || cookie.name.hasPrefix("dsh-auth-")
    }
    /// Called only after the authenticated native status probe succeeds.
    public func rememberVerifiedSession(_ cookies: [HTTPCookie]) throws {
        let allowed = server.cookies(cookies, for: server.statusURL, now: now()).filter(isAuthCookie)
        let record = Session(origin: server.origin.absoluteString, savedAt: now(), cookies: allowed.map(CookieValue.init))
        let data = try JSONEncoder().encode(record)
        guard data.count <= 65_536 else { throw StateError.invalidRecord }
        try store.write(data, for: authKey)
    }
    public func cookies() throws -> [HTTPCookie] {
        guard let data = try store.read(authKey) else { return [] }
        guard data.count <= 65_536 else { throw StateError.invalidRecord }
        let record = try JSONDecoder().decode(Session.self, from: data)
        guard record.origin == server.origin.absoluteString else { throw StateError.invalidRecord }
        let age = now().timeIntervalSince(record.savedAt)
        guard age >= -60, age < 86_400 else { return [] }
        return server.cookies(record.cookies.compactMap(\.cookie), for: server.statusURL, now: now()).filter(isAuthCookie)
    }
    public func rememberVoice(_ checkpoint: HubVoiceCheckpoint) throws {
        try validate(checkpoint)
        let data = try JSONEncoder().encode(checkpoint)
        guard data.count <= 65_536 else { throw StateError.invalidRecord }
        try store.write(data, for: voiceKey)
    }
    public func voice() throws -> HubVoiceCheckpoint? {
        guard let data = try store.read(voiceKey) else { return nil }
        guard data.count <= 65_536 else { throw StateError.invalidRecord }
        let value = try JSONDecoder().decode(HubVoiceCheckpoint.self, from: data)
        try validate(value)
        return value
    }
    public func rememberAdmission(_ value: HubVoiceAdmission) throws {
        try validateAdmission(value)
        let data = try JSONEncoder().encode(value)
        guard data.count <= 4096 else { throw StateError.invalidRecord }
        try store.write(data, for: admissionKey)
    }
    public func admission() throws -> HubVoiceAdmission? {
        guard let data = try store.read(admissionKey) else { return nil }
        guard data.count <= 4096 else { throw StateError.invalidRecord }
        let value = try JSONDecoder().decode(HubVoiceAdmission.self, from: data)
        try validateAdmission(value)
        return now().timeIntervalSince(value.savedAt) < 600 ? value : nil
    }
    private func validateAdmission(_ value: HubVoiceAdmission) throws {
        guard value.origin == server.origin.absoluteString, value.requestedAt > 0,
              value.requestedAt <= 9_007_199_254_740_991,
              value.sessionID.map(HubVoiceAPI.validID) ?? true,
              now().timeIntervalSince(value.savedAt) >= -60 else { throw StateError.invalidRecord }
    }
    public func clearAdmission() throws { try store.remove(admissionKey) }
    private func validate(_ value: HubVoiceCheckpoint) throws {
        guard value.origin == server.origin.absoluteString, HubVoiceAPI.validID(value.lease.callId),
              HubVoiceAPI.validID(value.lease.sessionId), value.peerID.map({ !$0.isEmpty && $0.utf8.count <= 128 && !$0.contains("\n") && !$0.contains("\r") }) ?? true,
              now().timeIntervalSince(value.savedAt) >= -60, now().timeIntervalSince(value.savedAt) < 30 * 86_400 else { throw StateError.invalidRecord }
    }
    public func clear() throws {
        if try pushIdentity() != nil { try advancePush(enabled: false) }
        try store.remove(authKey); try store.remove(voiceKey); try clearAdmission()
    }
}
