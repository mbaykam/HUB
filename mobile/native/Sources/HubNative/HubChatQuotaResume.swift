import Foundation
#if canImport(SwiftUI)
import SwiftUI
#endif

/// Per-conversation preference. No global default or agent tool can opt a chat in.
public struct HubChatQuotaResume: Decodable, Equatable {
    public enum State: String, Decodable {
        case idle, waiting, dispatching, consumed, cancelled
        case waitingUnknown = "waiting-unknown"
        case needsReview = "needs-review"
    }
    public let sessionId: String
    public let revision: Int
    public let enabled: Bool
    public let eligible: Bool
    public let state: State
    public let endSeq: Int?
    public let provider: String?
    public let model: String?
    /// Absolute epoch milliseconds, only when actually reported by the provider.
    public let resetsAt: Double?
    public let reason: String?

    public var resetDate: Date? { resetsAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
    public var statusText: String {
        switch state {
        case .idle: return enabled ? "Enabled for this chat’s next subscription limit." : "Off for this chat."
        case .waiting: return resetDate == nil ? "Subscription availability was confirmed. Waiting to continue once." : "Waiting for the subscription’s reported reset."
        case .waitingUnknown: return "Waiting. The provider has not reported a reset time; HUB checks usage without sending model requests."
        case .dispatching: return "Submitting one continuation on the same subscription model."
        case .consumed: return "One continuation was submitted. This is not a completion receipt."
        case .cancelled: return "The saved continuation was cancelled."
        case .needsReview: return "Review required. An action or submission has an uncertain outcome and will not be repeated automatically."
        }
    }
}

public extension HubConversationAPI {
    func chatQuotaResume(sessionID: String) async throws -> HubChatQuotaResume {
        guard HubVoiceAPI.validID(sessionID) else { throw HubAttachmentError.invalidResponse }
        let data = try await requestData("api/hub/chat-resume", headers: ["x-hub-chat-resume": "1"],
                                         query: [URLQueryItem(name: "sessionId", value: sessionID)], maxBytes: 16_384)
        return try Self.decodeQuotaResume(data, sessionID: sessionID)
    }

    /// Call only from a direct, explicit user's toggle gesture. Never from
    /// model output, a background refresh, migration or restored local state.
    func setChatQuotaResume(sessionID: String, revision: Int, enabled: Bool) async throws -> HubChatQuotaResume {
        guard HubVoiceAPI.validID(sessionID), revision >= 0 else { throw HubAttachmentError.invalidResponse }
        let body = try JSONSerialization.data(withJSONObject: ["sessionId": sessionID, "revision": revision, "enabled": enabled])
        let data = try await requestData("api/hub/chat-resume", headers: ["x-hub-chat-resume": "1"], body: body, maxBytes: 16_384)
        return try Self.decodeQuotaResume(data, sessionID: sessionID)
    }

    /// Invalidate the pending checkpoint on an explicit Stop, including when
    /// the ordinary chat controller is already idle. Preference stays enabled.
    func cancelChatQuotaResume(sessionID: String, revision: Int) async throws -> HubChatQuotaResume {
        guard HubVoiceAPI.validID(sessionID), revision >= 0 else { throw HubAttachmentError.invalidResponse }
        let body = try JSONSerialization.data(withJSONObject: ["sessionId": sessionID, "revision": revision, "action": "cancel"])
        let data = try await requestData("api/hub/chat-resume", headers: ["x-hub-chat-resume": "1"], body: body, maxBytes: 16_384)
        return try Self.decodeQuotaResume(data, sessionID: sessionID)
    }

    private static func decodeQuotaResume(_ data: Data, sessionID: String) throws -> HubChatQuotaResume {
        let value = try JSONDecoder().decode(HubChatQuotaResume.self, from: data)
        guard value.sessionId == sessionID, value.revision >= 0,
              value.resetsAt.map({ $0.isFinite && $0 > 0 && $0 < 8_640_000_000_000_000 }) ?? true,
              value.endSeq.map({ $0 >= 0 }) ?? true else { throw HubAttachmentError.invalidResponse }
        return value
    }
}

#if canImport(SwiftUI)
/// Embed in a chat settings sheet with .id(sessionID), never in global settings.
/// The server value is authoritative; loading or a failed save never enables it.
public struct HubChatQuotaResumeView: View {
    private let api: HubConversationAPI
    private let sessionID: String
    @State private var value: HubChatQuotaResume?
    @State private var busy = false
    @State private var error: String?

    public init(api: HubConversationAPI, sessionID: String) { self.api = api; self.sessionID = sessionID }

    public var body: some View {
        Section {
            Toggle("Resume when subscription limit resets", isOn: Binding(
                get: { value?.enabled ?? false },
                set: { enabled in Task { await save(enabled) } }
            ))
            .disabled(busy || value == nil || (value?.eligible != true && value?.enabled != true))
            .frame(minHeight: 44)
            if let value {
                Text(value.statusText).font(.footnote).foregroundStyle(.secondary)
                if let date = value.resetDate, value.state == .waiting {
                    Text(date, style: .date).font(.footnote)
                    Text(date, style: .time).font(.footnote)
                }
                if !value.eligible { Text("Available only for a top-level Claude or Codex subscription chat.").font(.footnote).foregroundStyle(.secondary) }
            } else if busy { ProgressView("Loading chat setting…") }
            if let error {
                Text(error).font(.footnote).foregroundStyle(.red)
                Button("Reload setting") { Task { await load() } }.frame(minHeight: 44).disabled(busy)
            }
        } footer: {
            Text("Off by default. Continues once on the same provider and model using recorded results, not the original prompt. Does not grant permission for purchases, messages or other external actions. A new message, model change or Stop cancels pending continuation. HUB must be running.")
        }
        .task(id: sessionID) { await load() }
    }

    @MainActor private func load() async {
        guard !busy else { return }; busy = true; error = nil
        defer { busy = false }
        do { value = try await api.chatQuotaResume(sessionID: sessionID) }
        catch { self.error = "Chat setting unavailable. Nothing was enabled; reload to check." }
    }

    @MainActor private func save(_ enabled: Bool) async {
        guard !busy, let current = value, current.enabled != enabled else { return }
        busy = true; error = nil
        defer { busy = false }
        do { value = try await api.setChatQuotaResume(sessionID: sessionID, revision: current.revision, enabled: enabled) }
        catch {
            // An interrupted response may still have committed. Read back once;
            // never blindly retry an optimistic mutation or display fake success.
            self.error = "Could not confirm the change. Reload before trying again."
            if let fresh = try? await api.chatQuotaResume(sessionID: sessionID) { value = fresh }
        }
    }
}
#endif
