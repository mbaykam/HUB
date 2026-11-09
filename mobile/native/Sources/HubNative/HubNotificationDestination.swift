import Foundation

/// Notifications identify a read-only conversation destination, never an
/// arbitrary URL, task command, automatic microphone action or new server.
public struct HubNotificationDestination {
    public enum DestinationError: Error { case invalidPayload, differentServer }
    public let server: HubServer
    public let sessionID: String
    private struct Payload: Decodable { let version: Int; let kind: String; let origin: String; let sessionId: String }
    public init(data: Data) throws {
        guard data.count <= 2048,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["version", "kind", "origin", "sessionId"] else { throw DestinationError.invalidPayload }
        let payload = try JSONDecoder().decode(Payload.self, from: data)
        guard payload.version == 1, payload.kind == "session", HubVoiceAPI.validID(payload.sessionId) else { throw DestinationError.invalidPayload }
        server = try HubServer(address: payload.origin)
        sessionID = payload.sessionId
    }
    public func url(for configuredServer: HubServer) throws -> URL {
        guard configuredServer == server else { throw DestinationError.differentServer }
        var value = URLComponents(url: server.origin, resolvingAgainstBaseURL: false)!
        value.queryItems = [URLQueryItem(name: "hubSession", value: sessionID)]
        return value.url!
    }
}
