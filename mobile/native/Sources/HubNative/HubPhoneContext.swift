import Foundation

/// What the iPhone tells HUB about where it is and what is around it.
public struct HubPhoneContext: Codable, Equatable, Sendable {
    public struct Location: Codable, Equatable, Sendable {
        public var latitude: Double
        public var longitude: Double
        public var accuracyMeters: Double
        public var altitudeMeters: Double?
        public var speedMetersPerSecond: Double?
        public var courseDegrees: Double?
        public init(latitude: Double, longitude: Double, accuracyMeters: Double, altitudeMeters: Double? = nil,
                    speedMetersPerSecond: Double? = nil, courseDegrees: Double? = nil) {
            self.latitude = latitude; self.longitude = longitude; self.accuracyMeters = accuracyMeters
            self.altitudeMeters = altitudeMeters
            self.speedMetersPerSecond = speedMetersPerSecond.flatMap { $0 >= 0 ? $0 : nil }
            self.courseDegrees = courseDegrees.flatMap { $0 >= 0 ? $0 : nil }
        }
    }
    public struct Place: Codable, Equatable, Sendable {
        public var name, street, neighborhood, city, region, postalCode, country, timeZone: String?
        public init(name: String? = nil, street: String? = nil, neighborhood: String? = nil, city: String? = nil,
                    region: String? = nil, postalCode: String? = nil, country: String? = nil, timeZone: String? = nil) {
            self.name = name; self.street = street; self.neighborhood = neighborhood; self.city = city
            self.region = region; self.postalCode = postalCode; self.country = country; self.timeZone = timeZone
        }
    }
    public struct Nearby: Codable, Equatable, Sendable {
        public var name: String
        public var category: String?
        public var distanceMeters: Double?
        public init(name: String, category: String? = nil, distanceMeters: Double? = nil) {
            self.name = name; self.category = category; self.distanceMeters = distanceMeters
        }
    }
    public struct Device: Codable, Equatable, Sendable {
        public var batteryPercent: Double?
        public var charging: Bool?
        public var lowPowerMode: Bool?
        public var network: String?
        public var timeZone: String?
        public var locale: String?
        public var appState: String?
        public init(batteryPercent: Double? = nil, charging: Bool? = nil, lowPowerMode: Bool? = nil, network: String? = nil,
                    timeZone: String? = nil, locale: String? = nil, appState: String? = nil) {
            self.batteryPercent = batteryPercent; self.charging = charging; self.lowPowerMode = lowPowerMode
            self.network = network; self.timeZone = timeZone; self.locale = locale; self.appState = appState
        }
    }

    /// Milliseconds since 1970.
    public var capturedAt: Double
    public var location: Location?
    public var place: Place?
    public var nearby: [Nearby]?
    public var device: Device?
    public var motion: String?

    public init(capturedAt: Date, location: Location? = nil, place: Place? = nil, nearby: [Nearby]? = nil,
                device: Device? = nil, motion: String? = nil) {
        self.capturedAt = (capturedAt.timeIntervalSince1970 * 1000).rounded()
        self.location = location; self.place = place
        self.nearby = nearby.map { Array($0.filter { !$0.name.isEmpty }.prefix(15)) }
        self.device = device; self.motion = motion
    }
}
