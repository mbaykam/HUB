import Foundation

public struct HubPlannerDraft {
    public enum Kind: String, CaseIterable { case todo, event }

    public let id: String
    public let version: Int
    public var kind: Kind
    public var title: String
    public var details: String
    public var horizon: HubHomePlanner.Horizon
    public var timeZone: String
    public var date: Date?
    public var start: Date?
    public var end: Date?

    public init(item: HubHomePlanner.Item? = nil, kind: Kind, horizon: HubHomePlanner.Horizon) {
        id = item?.id ?? UUID().uuidString.lowercased()
        version = item?.version ?? 0
        self.kind = item.flatMap { Kind(rawValue: $0.kind) } ?? kind
        title = item?.title ?? ""
        details = item?.details ?? ""
        self.horizon = item.flatMap { HubHomePlanner.Horizon(rawValue: $0.horizon ?? "") } ?? horizon
        timeZone = item?.timeZone ?? TimeZone.current.identifier
        if let text = item?.date {
            let formatter = DateFormatter()
            formatter.calendar = Calendar(identifier: .gregorian)
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(identifier: timeZone)
            formatter.dateFormat = "yyyy-MM-dd"
            date = formatter.date(from: text)
        }
        start = Self.parseInstant(item?.start)
        end = Self.parseInstant(item?.end)
    }

    public static func parseInstant(_ value: String?) -> Date? {
        guard let value else { return nil }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = parser.date(from: value) { return parsed }
        parser.formatOptions = [.withInternetDateTime]
        return parser.date(from: value)
    }
}
