import Foundation

public struct HubScreenStatus: Decodable {
    public let sharing: Bool
    public let hasFrame: Bool
    public let maxAgeMs: Int
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
        update("Connecting live screen sharing…")
        operation = Task { [weak self] in
            guard let self else { return }
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
                self.stop(); self.update("Live sharing could not connect. Stop and choose Live again; voice can continue.")
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
                self.update("Live sharing is on. Recent frame available to HUB.")
            } catch {
                guard self.id == id else { return }
                self.operation = nil; self.failures += 1
                if self.failures >= 3 || error as? HubVoiceAPIError == .callUnavailable || error as? HubVoiceAPIError == .signInRequired {
                    self.stop(); self.update("Live sharing stopped after a connection problem. Choose Live again when ready.")
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
        Task {
            do { try await consent(old, false) }
            catch { try? await consent(old, false) } // Tombstone delayed starts; never starts another share.
        }
    }
}
