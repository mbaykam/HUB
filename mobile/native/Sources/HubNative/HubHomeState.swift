import Foundation

public enum HubHomeConnection: Equatable, Sendable {
    case needsSetup
    case connecting
    case connected
    case signInRequired
    case unavailable
}

/// Each attempt belongs to one selected server. An old response must not
/// replace a newer state after switching servers, signing out, or retrying.
public struct HubHomeState: Equatable, Sendable {
    public private(set) var connection: HubHomeConnection = .needsSetup
    private var generation: UInt64 = 0

    public init() {}

    public mutating func begin(hasServer: Bool) -> UInt64 {
        generation &+= 1
        connection = hasServer ? .connecting : .needsSetup
        return generation
    }

    @discardableResult
    public mutating func resolve(_ result: HubHomeConnection, attempt: UInt64) -> Bool {
        guard isCurrent(attempt), connection == .connecting else { return false }
        switch result {
        case .connected, .signInRequired, .unavailable:
            connection = result
            return true
        case .needsSetup, .connecting:
            return false
        }
    }

    public func isCurrent(_ attempt: UInt64) -> Bool {
        attempt == generation
    }
}
