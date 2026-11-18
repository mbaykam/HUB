import SwiftUI
import UIKit

/// Whether HUB is on screen. SwiftUI's scenePhase is not delivered reliably to
/// views hosted by this UIKit app, so polling views read this instead.
@MainActor
final class HubAppActivity: ObservableObject {
    static let shared = HubAppActivity()

    @Published private(set) var isActive: Bool
    private var observers: [NSObjectProtocol] = []

    private init() {
        isActive = UIApplication.shared.applicationState != .background
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in HubAppActivity.shared.isActive = true }
        })
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in HubAppActivity.shared.isActive = false }
        })
    }
}
