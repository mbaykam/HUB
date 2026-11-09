import Foundation

public struct HubPushIdentity: Codable, Equatable {
    public let id: UUID
    public let generation: Int64
    public let enabled: Bool
    public init(id: UUID = UUID(), generation: Int64 = 1, enabled: Bool) {
        self.id = id; self.generation = generation; self.enabled = enabled
    }
}

extension HubDeviceState {
    /// Kept as a disabled tombstone on logout, so delayed requests cannot revive
    /// an older generation. Token values are never persisted on the phone.
    public func pushIdentity() throws -> HubPushIdentity? {
        guard let data = try store.read("push:" + server.origin.absoluteString) else { return nil }
        guard data.count < 1024 else { throw StateError.invalidRecord }
        let value = try JSONDecoder().decode(HubPushIdentity.self, from: data)
        guard value.generation > 0, value.generation < 9_007_199_254_740_991 else { throw StateError.invalidRecord }
        return value
    }
    @discardableResult public func advancePush(enabled: Bool) throws -> HubPushIdentity {
        let old = try pushIdentity()
        let next = HubPushIdentity(id: old?.id ?? UUID(), generation: (old?.generation ?? 0) + 1, enabled: enabled)
        guard next.generation < 9_007_199_254_740_991 else { throw StateError.invalidRecord }
        try store.write(JSONEncoder().encode(next), for: "push:" + server.origin.absoluteString)
        return next
    }
}
