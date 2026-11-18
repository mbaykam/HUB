import Foundation

/// Which notifications reach this iPhone, and when.
public struct HubPushPreferences: Codable, Equatable, Sendable {
    public struct Quiet: Codable, Equatable, Sendable {
        public var enabled: Bool
        public var start: String
        public var end: String
        public init(enabled: Bool, start: String, end: String) { self.enabled = enabled; self.start = start; self.end = end }
    }
    public static let kinds = ["reply", "task", "approval", "reminder", "brief", "assistant", "goal", "automation"]
    public var kinds: [String: Bool]
    public var quiet: Quiet
    public var timeZone: String
    public var briefTime: String
    public var reminderMinutes: Int

    public init(kinds: [String: Bool], quiet: Quiet, timeZone: String, briefTime: String, reminderMinutes: Int) {
        self.kinds = kinds; self.quiet = quiet; self.timeZone = timeZone; self.briefTime = briefTime; self.reminderMinutes = reminderMinutes
    }

    public static let standard = HubPushPreferences(kinds: Dictionary(uniqueKeysWithValues: kinds.map { ($0, true) }),
                                                    quiet: Quiet(enabled: false, start: "22:30", end: "07:30"),
                                                    timeZone: TimeZone.current.identifier, briefTime: "08:00", reminderMinutes: 15)

    public func allows(_ kind: String) -> Bool { kinds[kind] ?? true }

    /// "22:30" as a date today, for time pickers.
    public static func date(_ clock: String, calendar: Calendar = .current) -> Date {
        let parts = clock.split(separator: ":").compactMap { Int($0) }
        return calendar.date(bySettingHour: parts.first ?? 8, minute: parts.count > 1 ? parts[1] : 0, second: 0, of: Date()) ?? Date()
    }

    public static func clock(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }
}

/// What a delivered notification is about, read from its "hubNote" payload.
public struct HubPushNote: Equatable, Sendable {
    public let kind: String
    public let status: String
    public let goalID: String?
    public let approvalID: String?
    public let revision: Int?
    public let itemID: String?

    public init?(_ value: Any?) {
        guard let object = value as? [String: Any], let kind = object["kind"] as? String,
              kind.count <= 24, kind.allSatisfy({ $0.isLetter }) else { return nil }
        self.kind = kind
        status = object["status"] as? String ?? "info"
        let id = { (key: String) -> String? in
            guard let text = object[key] as? String, !text.isEmpty, text.count <= 200 else { return nil }
            return text
        }
        goalID = id("goalId")
        approvalID = id("approvalId")
        itemID = id("itemId")
        revision = (object["revision"] as? NSNumber)?.intValue
    }
}

/// A web app on the user's Apps page.
public struct HubApp: Decodable, Identifiable, Equatable, Sendable {
    public struct Share: Decodable, Equatable, Sendable {
        public let slug: String
        public let url: String
        public let createdAt: Double
        public let expiresAt: Double?
        public let anonymous: Bool
    }
    public let id: String
    public let title: String
    public let description: String
    public let icon: String
    public let color: String
    public let createdAt: Double
    public let updatedAt: Double
    public let bytes: Int
    public let shares: [Share]
}

public struct HubAppsSnapshot: Decodable, Equatable, Sendable {
    public struct Sharing: Decodable, Equatable, Sendable { public let accountKey: Bool }
    public struct Result: Decodable, Equatable, Sendable { public let note: String?; public let url: String? }
    public let apps: [HubApp]
    public let sharing: Sharing
    public let result: Result?
}
