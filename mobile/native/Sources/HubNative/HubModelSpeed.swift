import Foundation

/// How fast each model answers, measured on this phone: the time from sending
/// a message to the first words of the reply (time to first token, network
/// included) and the writing speed after that (output tokens per second).
public struct HubModelSpeed: Codable, Equatable {
    public struct Sample: Codable, Equatable {
        public let firstToken: Double
        public let tokensPerSecond: Double?
        public let at: Double
        public init(firstToken: Double, tokensPerSecond: Double?, at: Double) {
            self.firstToken = firstToken
            self.tokensPerSecond = tokensPerSecond
            self.at = at
        }
    }

    public struct Summary: Equatable, Identifiable {
        public let model: String
        public let count: Int
        public let firstToken: Double
        public let tokensPerSecond: Double?
        public var id: String { model }
    }

    public private(set) var samples: [String: [Sample]] = [:]
    public static let keep = 20

    public init() {}

    /// Adds one reply. A reply with too few tokens or too short a stream to
    /// measure still counts for first-token time.
    public mutating func record(model: String, sentAt: Date, firstTokenAt: Date, endedAt: Date, outputTokens: Int?) {
        let wait = firstTokenAt.timeIntervalSince(sentAt)
        guard !model.isEmpty, wait.isFinite, wait >= 0, wait < 600 else { return }
        let streaming = endedAt.timeIntervalSince(firstTokenAt)
        let rate = outputTokens.flatMap { tokens -> Double? in
            guard tokens >= 20, streaming >= 0.4 else { return nil }
            return Double(tokens) / streaming
        }
        var list = samples[model] ?? []
        list.append(Sample(firstToken: wait, tokensPerSecond: rate, at: endedAt.timeIntervalSince1970))
        samples[model] = Array(list.suffix(Self.keep))
    }

    /// Median values per model, most used first.
    public var summaries: [Summary] {
        samples.compactMap { model, list -> Summary? in
            guard !list.isEmpty else { return nil }
            let rates = list.compactMap(\.tokensPerSecond)
            return Summary(model: model, count: list.count, firstToken: Self.median(list.map(\.firstToken)),
                           tokensPerSecond: rates.isEmpty ? nil : Self.median(rates))
        }
        .sorted { $0.count != $1.count ? $0.count > $1.count : $0.model < $1.model }
    }

    static func median(_ values: [Double]) -> Double {
        let sorted = values.sorted()
        guard !sorted.isEmpty else { return 0 }
        let mid = sorted.count / 2
        return sorted.count % 2 == 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    }

    // MARK: Saved on this phone

    private static let key = "hub.modelSpeed.v1"

    public static func load(_ defaults: UserDefaults = .standard) -> HubModelSpeed {
        guard let data = defaults.data(forKey: key), let value = try? JSONDecoder().decode(HubModelSpeed.self, from: data) else { return HubModelSpeed() }
        return value
    }

    public func save(_ defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(self) { defaults.set(data, forKey: Self.key) }
    }
}
