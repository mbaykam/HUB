import CoreLocation
import MapKit
import Network
import UIKit
import HubNative

/// The phone as the assistants' sense organ: it reads location, the place
/// name, nearby places and device state, and sends them to HUB when the app
/// opens, every few minutes while it is in use, and whenever an assistant
/// asks for a fresh reading. The user can turn it off in iPhone settings.
@MainActor
final class HubPhoneSense: NSObject, CLLocationManagerDelegate {
    static let shared = HubPhoneSense()
    static let enabledKey = "hub.phone-sense.enabled.v1"

    private let manager = CLLocationManager()
    private let geocoder = CLGeocoder()
    private let pathMonitor = NWPathMonitor()
    private var network = "unknown"
    private var api: HubConversationAPI?
    private var loop: Task<Void, Never>?
    private var locationWaiters: [CheckedContinuation<CLLocation?, Never>] = []
    private var lastSent = Date.distantPast
    private var sending = false

    var enabled: Bool {
        get { UserDefaults.standard.object(forKey: Self.enabledKey) as? Bool ?? true }
        set {
            UserDefaults.standard.set(newValue, forKey: Self.enabledKey)
            if newValue { start() } else { stop() }
        }
    }

    var authorization: CLAuthorizationStatus { manager.authorizationStatus }

    private override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        pathMonitor.pathUpdateHandler = { path in
            let kind = path.status != .satisfied ? "offline"
                : path.usesInterfaceType(.wifi) ? "wifi"
                : path.usesInterfaceType(.cellular) ? "cellular" : "other"
            Task { @MainActor in HubPhoneSense.shared.network = kind }
        }
        pathMonitor.start(queue: DispatchQueue(label: "com.mbaykam.hub.phone-sense"))
        UIDevice.current.isBatteryMonitoringEnabled = true
        let center = NotificationCenter.default
        center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in HubPhoneSense.shared.send(reason: "foreground") }
        }
    }

    /// Called when the app connects to a HUB server.
    func attach(_ api: HubConversationAPI?) {
        // Simulator UI tests use fixture servers and must not raise the location prompt.
        if ProcessInfo.processInfo.arguments.contains("--hub-native-home-fixture") { return }
        self.api = api
        start()
    }

    private func start() {
        guard enabled, api != nil else { return }
        if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
        loop?.cancel()
        loop = Task { [weak self] in
            var tick = 0
            while !Task.isCancelled {
                guard let self else { return }
                // Answer an assistant's request within seconds while HUB runs;
                // otherwise refresh every three minutes (45 four-second ticks).
                let wanted = (try? await self.api?.phoneContextRequested()) ?? false
                if wanted || tick % 45 == 0 { await self.sendNow(force: wanted) }
                tick += 1
                try? await Task.sleep(nanoseconds: 4_000_000_000)
            }
        }
    }

    private func stop() {
        loop?.cancel()
        loop = nil
    }

    func send(reason: String) {
        guard enabled else { return }
        Task { await sendNow(force: false) }
    }

    private func sendNow(force: Bool) async {
        guard enabled, let api, !sending else { return }
        if !force, Date().timeIntervalSince(lastSent) < 60 { return }
        sending = true
        defer { sending = false }
        let context = await capture()
        do {
            try await api.sendPhoneContext(context)
            lastSent = Date()
        } catch {
            // The next tick retries; nothing is shown for a missed reading.
        }
    }

    private func capture() async -> HubPhoneContext {
        let location = await currentLocation()
        var place: HubPhoneContext.Place?
        var nearby: [HubPhoneContext.Nearby]?
        if let location {
            if let mark = try? await geocoder.reverseGeocodeLocation(location).first {
                place = HubPhoneContext.Place(name: mark.name, street: mark.thoroughfare, neighborhood: mark.subLocality,
                                              city: mark.locality, region: mark.administrativeArea, postalCode: mark.postalCode,
                                              country: mark.country, timeZone: mark.timeZone?.identifier)
            }
            nearby = await nearbyPlaces(location)
        }
        let device = UIDevice.current
        let battery = device.batteryLevel >= 0 ? Double(device.batteryLevel * 100) : nil
        let state: String = {
            switch UIApplication.shared.applicationState {
            case .active: return "open"
            case .inactive: return "opening"
            default: return "background"
            }
        }()
        return HubPhoneContext(
            capturedAt: Date(),
            location: location.map {
                HubPhoneContext.Location(latitude: $0.coordinate.latitude, longitude: $0.coordinate.longitude,
                                         accuracyMeters: $0.horizontalAccuracy,
                                         altitudeMeters: $0.verticalAccuracy >= 0 ? $0.altitude : nil,
                                         speedMetersPerSecond: $0.speed, courseDegrees: $0.course)
            },
            place: place,
            nearby: nearby,
            device: HubPhoneContext.Device(batteryPercent: battery,
                                           charging: [.charging, .full].contains(device.batteryState),
                                           lowPowerMode: ProcessInfo.processInfo.isLowPowerModeEnabled,
                                           network: network, timeZone: TimeZone.current.identifier,
                                           locale: Locale.current.identifier, appState: state))
    }

    private func currentLocation() async -> CLLocation? {
        let status = manager.authorizationStatus
        guard status == .authorizedWhenInUse || status == .authorizedAlways else { return nil }
        if let last = manager.location, Date().timeIntervalSince(last.timestamp) < 60, last.horizontalAccuracy <= 100 {
            return last
        }
        return await withCheckedContinuation { continuation in
            locationWaiters.append(continuation)
            if locationWaiters.count == 1 { manager.requestLocation() }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 8_000_000_000)
                self.finishLocation(self.manager.location)
            }
        }
    }

    private func finishLocation(_ location: CLLocation?) {
        let waiters = locationWaiters
        locationWaiters.removeAll()
        for waiter in waiters { waiter.resume(returning: location) }
    }

    private func nearbyPlaces(_ location: CLLocation) async -> [HubPhoneContext.Nearby]? {
        let request = MKLocalPointsOfInterestRequest(center: location.coordinate, radius: 400)
        guard let response = try? await MKLocalSearch(request: request).start() else { return nil }
        return response.mapItems.prefix(12).compactMap { item in
            guard let name = item.name, !name.isEmpty else { return nil }
            let distance = item.placemark.location.map { $0.distance(from: location) }
            let category = item.pointOfInterestCategory.map {
                $0.rawValue.replacingOccurrences(of: "MKPOICategory", with: "")
            }
            return HubPhoneContext.Nearby(name: name, category: category, distanceMeters: distance)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let latest = locations.last
        Task { @MainActor in HubPhoneSense.shared.finishLocation(latest) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in HubPhoneSense.shared.finishLocation(nil) }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in HubPhoneSense.shared.send(reason: "authorization") }
    }
}
