import Foundation

/// The last conversational request HUB sent to a model for one character,
/// exactly as dispatched. HUB keeps it in memory only.
public struct HubCharacterRequest: Decodable, Equatable, Sendable {
    public struct Record: Decodable, Equatable, Sendable {
        public let characterId: String
        public let sessionId: String
        /// Milliseconds since 1970.
        public let at: Double
        public let json: String?
        public let unavailable: String?
    }

    public let record: Record?
    /// What the request contains and what providers do not expose.
    public let boundary: String
    public let retention: String
}

/// Result of queueing earlier HUB conversations for Knowledge.
public struct HubKnowledgeHistoryImport: Decodable, Equatable, Sendable {
    public let queued: Int
    public let duplicates: Int
    public let skipped: Int
}

/// What HUB hands the phone for one voice-typing take: the fixed recognition
/// endpoint and the first socket message, which carries a key that expires in
/// minutes. The stored Soniox key never reaches the phone.
public struct HubDictationSession: Equatable, Sendable {
    public static let endpoint = URL(string: "wss://stt-rt.soniox.com/transcribe-websocket")!
    public static let sampleRate: Double = 16_000

    public let url: URL
    /// JSON text sent as the first socket message.
    public let configuration: String

    public init(data: Data) throws {
        guard data.count <= 8_192,
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              value["url"] as? String == Self.endpoint.absoluteString,
              let config = value["config"] as? [String: Any],
              let key = config["api_key"] as? String, (8...512).contains(key.utf8.count),
              config["audio_format"] as? String == "pcm_s16le",
              (config["sample_rate"] as? NSNumber)?.doubleValue == Self.sampleRate,
              (config["num_channels"] as? NSNumber)?.intValue == 1,
              let model = config["model"] as? String, !model.isEmpty,
              let encoded = try? JSONSerialization.data(withJSONObject: config, options: [.sortedKeys]),
              let text = String(data: encoded, encoding: .utf8) else {
            throw HubAttachmentError.invalidResponse
        }
        url = Self.endpoint
        configuration = text
    }
}

/// Builds the typed text from recognition messages. Confirmed words arrive
/// once and are kept; words still being recognized are replaced by each new
/// message, so the composer can show them live.
public struct HubDictationTranscript: Equatable, Sendable {
    public enum Failure: Error, Equatable {
        /// The recognition service refused or ended the take (balance, access, limits).
        case service
        case malformed
    }

    public private(set) var confirmed = ""
    public private(set) var pending = ""
    public private(set) var finished = false

    public init() {}

    public var text: String {
        (confirmed + pending).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public mutating func receive(_ data: Data) throws {
        guard data.count <= 262_144,
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw Failure.malformed
        }
        if value["error_code"] != nil || value["error_type"] != nil || value["error_message"] != nil {
            throw Failure.service
        }
        var live = ""
        for case let token as [String: Any] in value["tokens"] as? [Any] ?? [] {
            guard let word = token["text"] as? String,
                  token["translation_status"] as? String != "translation",
                  !(word.hasPrefix("<") && word.hasSuffix(">")) else { continue }
            if token["is_final"] as? Bool == true { confirmed += word } else { live += word }
        }
        pending = live
        if value["finished"] as? Bool == true {
            finished = true
            pending = ""
        }
        if confirmed.utf8.count > 20_000 { throw Failure.service }
    }

    /// Adds dictated text after what was already in the composer.
    public static func join(_ existing: String, _ dictated: String) -> String {
        let spoken = dictated.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !spoken.isEmpty else { return existing }
        guard let last = existing.last else { return spoken }
        return last.isWhitespace ? existing + spoken : existing + " " + spoken
    }
}
