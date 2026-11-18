import Foundation

public struct HubScreenStatus: Decodable {
    public let sharing: Bool
    public let hasFrame: Bool
    public let maxAgeMs: Int
    /// Regions an assistant marked on the current share, if any.
    public let highlight: HubScreenHighlight?
    /// Overlays an assistant pinned into a live camera share, if any.
    public let overlay: HubCameraOverlay?
}

/// Normalized regions (0...1, top-left origin) an assistant marked on the
/// shared screen, with a one-line note.
public struct HubScreenHighlight: Decodable, Equatable, Sendable {
    public struct Region: Decodable, Equatable, Sendable {
        public let x: Double
        public let y: Double
        public let width: Double
        public let height: Double
        public let label: String?
    }
    /// An aim line or route: 2 to 6 points, drawn as an arrow, a line or dashes.
    public struct Path: Decodable, Equatable, Sendable {
        public let points: [[Double]]
        public let style: String?
        public let label: String?
        public var drawable: Bool {
            (2...6).contains(points.count) && points.allSatisfy { $0.count == 2 && (0...1).contains($0[0]) && (0...1).contains($0[1]) }
        }
    }
    /// A ring around a target spot; radius is a fraction of the frame width.
    public struct Circle: Decodable, Equatable, Sendable {
        public let x: Double
        public let y: Double
        public let radius: Double
        public let label: String?
        public var drawable: Bool { (0...1).contains(x) && (0...1).contains(y) && radius > 0 && radius <= 0.5 }
    }
    public let id: String
    public let regions: [Region]
    public let paths: [Path]?
    public let circles: [Circle]?
    public let note: String
    public let sequence: Int

    /// Only sane boxes are drawn.
    public var drawable: [Region] {
        regions.prefix(6).filter {
            (0...1).contains($0.x) && (0...1).contains($0.y) && $0.width > 0 && $0.height > 0
                && $0.x + $0.width <= 1.0001 && $0.y + $0.height <= 1.0001
        }
    }
}

/// Native consent owns a single ephemeral share. Frames are dropped while a
/// request is pending; there is no queue, disk outbox or automatic model call.
@MainActor public final class HubLiveScreenSharing {
    public typealias Consent = (UUID, Bool) async throws -> Void
    public typealias Upload = (UUID, Int, HubScreenFrame) async throws -> Void
    private let consent: Consent
    private let upload: Upload
    private let owned: () -> Bool
    private let now: () -> Date
    private var id: UUID?
    private var ended = Set<UUID>()
    private var operation: Task<Void, Never>?
    private var cleanup: Task<Void, Never>?
    private var ready = false
    private var sequence = 0
    private var failures = 0
    private var lastAttempt = Date.distantPast
    public private(set) var status = "Live screen sharing is off."
    public var changed: (() -> Void)?
    public var active: Bool { id != nil }
    public init(consent: @escaping Consent, upload: @escaping Upload, owned: @escaping () -> Bool, now: @escaping () -> Date = Date.init) {
        self.consent = consent; self.upload = upload; self.owned = owned; self.now = now
    }
    private func update(_ value: String) { status = value; changed?() }
    /// Call only after the native Live confirmation AND the system picker.
    public func beginAfterSystemConsent(_ shareID: UUID) {
        guard owned() else { stop(); return }
        if id == shareID { return }
        guard !ended.contains(shareID), ended.count < 64 else { return }
        stop(); id = shareID; ready = false; sequence = 0; failures = 0; lastAttempt = .distantPast
        let priorCleanup = cleanup
        update("Connecting live screen sharing…")
        operation = Task { [weak self] in
            guard let self else { return }
            await priorCleanup?.value
            guard self.id == shareID, self.owned(), !Task.isCancelled else { return }
            do {
                do { try await self.consent(shareID, true) }
                catch let error as URLError where error.code != .cancelled {
                    guard self.id == shareID, self.owned(), !Task.isCancelled else { return }
                    try await self.consent(shareID, true) // Same receipt after an uncertain reply.
                }
                guard self.id == shareID, self.owned(), !Task.isCancelled else { return }
                self.ready = true; self.operation = nil
                self.update("Live sharing is on. Only a recent frame is kept on HUB; no automatic analysis runs.")
            } catch {
                guard self.id == shareID else { return }
                self.stop(); self.update(error as? HubVoiceAPIError == .updateHost ? "Live sharing could not be verified. Sign in again or update HUB on your computer before trying Live again. Voice can continue." : "Live sharing could not connect. Stop and choose Live again; voice can continue.")
            }
        }
    }
    public func offer(_ frame: HubScreenFrame) {
        guard owned() else { stop(); return }
        guard let id, ready, operation == nil, now().timeIntervalSince(lastAttempt) >= 1 else { return }
        let age = now().timeIntervalSince(frame.capturedAt)
        guard age >= 0, age < 5 else { return }
        let sequence = self.sequence; self.sequence += 1; lastAttempt = now()
        operation = Task { [weak self] in
            guard let self else { return }
            do {
                try await self.upload(id, sequence, frame)
                guard self.id == id, self.owned(), !Task.isCancelled else { return }
                self.failures = 0; self.operation = nil
                self.update("Live sharing is on. HUB keeps each recent frame only briefly.")
            } catch {
                guard self.id == id else { return }
                self.operation = nil; self.failures += 1
                if self.failures >= 3 || error as? HubVoiceAPIError == .callUnavailable || error as? HubVoiceAPIError == .signInRequired || error as? HubVoiceAPIError == .updateHost {
                    self.stop(); self.update(error as? HubVoiceAPIError == .updateHost ? "Live sharing stopped. Sign in again or update HUB on your computer before trying Live again." : "Live sharing stopped after a connection problem. Choose Live again when ready.")
                } else { self.update("Waiting for the next fresh frame; nothing is queued or saved.") }
            }
        }
    }
    public func stop() {
        let old = id; id = nil; ready = false; operation?.cancel(); operation = nil
        guard let old else { return }
        ended.insert(old)
        update("Live sharing stopped locally. Any unconfirmed remote frame expires within five seconds.")
        let consent = consent
        let priorCleanup = cleanup
        cleanup = Task {
            await priorCleanup?.value
            do { try await consent(old, false) }
            catch { try? await consent(old, false) } // Tombstone delayed starts; never starts another share.
        }
    }
}
