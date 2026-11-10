import Foundation
import ImageIO

public struct HubScreenOwner: Equatable {
    public let server: HubServer
    public let sessionID: String
    public let callID: String
    public init(server: HubServer, sessionID: String, callID: String) throws {
        guard HubVoiceAPI.validID(sessionID), HubVoiceAPI.validID(callID) else { throw HubAttachmentError.wrongConversation }
        self.server = server; self.sessionID = sessionID; self.callID = callID
    }
}

public struct HubScreenFrame {
    public let id: UUID
    public let jpeg: Data
    public let capturedAt: Date
    public let width: Int
    public let height: Int
}

/// Capture adapters call this only after the system's explicit sharing consent.
/// Nothing here records a screen, starts a model, uploads or persists frames.
/// Keep one bounded recent frame in memory; every send needs the current owner.
public actor HubScreenFrames {
    public enum FrameError: Error { case inactive, wrongOwner, stale, invalidImage }
    public static let maximumBytes = 2_000_000
    public static let maximumAge: TimeInterval = 5
    private let now: () -> Date
    private var generation: UUID?
    private var owner: HubScreenOwner?
    private var latest: HubScreenFrame?
    private var paused = false
    public init(now: @escaping () -> Date = Date.init) { self.now = now }
    public func beginAfterSystemConsent(owner: HubScreenOwner) -> UUID {
        let id = UUID(); generation = id; self.owner = owner; latest = nil; paused = false
        return id
    }
    public func accept(jpeg: Data, generation: UUID) throws {
        guard generation == self.generation, !paused, owner != nil else { throw FrameError.inactive }
        guard !jpeg.isEmpty, jpeg.count <= Self.maximumBytes,
              let source = CGImageSourceCreateWithData(jpeg as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetType(source) as String? == "public.jpeg",
              CGImageSourceGetCount(source) == 1,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 1920, height <= 1920,
              width * height <= 3_000_000,
              CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: false] as CFDictionary) != nil else { throw FrameError.invalidImage }
        latest = HubScreenFrame(id: UUID(), jpeg: jpeg, capturedAt: now(), width: width, height: height)
    }
    public func snapshot(generation: UUID, owner: HubScreenOwner) throws -> HubScreenFrame {
        guard generation == self.generation, !paused else { throw FrameError.inactive }
        guard owner == self.owner else { throw FrameError.wrongOwner }
        guard let latest else { throw FrameError.stale }
        let age = now().timeIntervalSince(latest.capturedAt)
        guard age >= 0, age <= Self.maximumAge else { self.latest = nil; throw FrameError.stale }
        return latest
    }
    public func pause(generation: UUID) {
        guard self.generation == generation else { return }
        paused = true; latest = nil
    }
    public func resumeAfterSystemConsent(generation: UUID) {
        guard self.generation == generation else { return }
        paused = false; latest = nil
    }
    public func stop(generation: UUID) {
        guard self.generation == generation else { return }
        self.generation = nil; owner = nil; latest = nil; paused = false
    }
}
