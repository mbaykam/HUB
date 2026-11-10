import UIKit
import UserNotifications
import HubNative

/// Native user gestures and Apple callbacks only; never exposed to WebKit.
@MainActor final class HubNotifications: NSObject, UNUserNotificationCenterDelegate {
    static let shared = HubNotifications()
    private var state: HubDeviceState?
    private var api: HubPushAPI?
    private var server: HubServer?
    private var generation = 0
    private var work: Task<Void, Never>?
    var changed: (() -> Void)?
    private(set) var status = "Notifications are off." { didSet { changed?() } }
    var destinationHandler: ((HubNotificationDestination) -> Void)? {
        didSet { if let pending, let destinationHandler { self.pending = nil; destinationHandler(pending) } }
    }
    private var pending: HubNotificationDestination?
    func attach(server: HubServer, state: HubDeviceState) {
        if self.server == server { return }
        generation += 1; work?.cancel()
        self.state = state; self.server = server
        api = HubPushAPI(server: server) { (try? state.cookies()) ?? [] }
        if (try? state.pushIdentity())?.enabled == true {
            status = "Checking saved notification access…"
            enable(requestPermission: false)
        } else { status = "Notifications are off." }
    }
    func show(from view: UIViewController) {
        let screen = HubNotificationSettingsViewController(manager: self) { self.enable(requestPermission: true) }
        view.present(UINavigationController(rootViewController: screen), animated: true)
    }
    private func enable(requestPermission: Bool) {
        guard let api, let state else { status = "Connect and sign in to HUB first."; return }
        generation += 1; let current = generation; work?.cancel()
        status = "Checking HUB notification support…"
        work = Task {
            do {
                let host = try await api.status()
                guard current == generation, !Task.isCancelled else { return }
                guard host.configured else { status = "Apple push is not configured on your HUB yet."; return }
                let center = UNUserNotificationCenter.current()
                var settings = await center.notificationSettings()
                if settings.authorizationStatus == .notDetermined && requestPermission {
                    _ = try await center.requestAuthorization(options: [.alert, .sound, .badge])
                    settings = await center.notificationSettings()
                }
                guard current == generation, !Task.isCancelled else { return }
                guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
                    status = "Notifications are not allowed. You can change this in iPhone Settings."; return
                }
                try state.advancePush(enabled: true)
                status = "Waiting for Apple registration. A signed iPhone build is required."
                UIApplication.shared.registerForRemoteNotifications()
            } catch { if current == generation { status = Self.describe(error) } }
        }
    }
    func received(token: Data) {
        guard let api, let state, (try? state.pushIdentity())?.enabled == true else { return }
        let current = generation
        do {
            let identity = try state.advancePush(enabled: true)
            let environment = Bundle.main.object(forInfoDictionaryKey: "HubPushEnvironment") as? String ?? ""
            work?.cancel()
            work = Task {
                do {
                    _ = try await api.register(identity, token: token, environment: environment)
                    guard current == generation, !Task.isCancelled else { return }
                    status = "Registered with HUB. Delivery on this iPhone has not been verified."
                } catch { if current == generation { status = Self.describe(error) } }
            }
        } catch { status = "Could not save notification access. Unlock your iPhone and retry." }
    }
    func failedRegistration() {
        guard let state, (try? state.pushIdentity())?.enabled == true else { return }
        status = "Apple registration failed. Check signing, connectivity and push permissions, then retry."
    }
    /// Local opt-out is immediate; an offline host must never prevent sign-out.
    func disable() {
        generation += 1; let current = generation; work?.cancel()
        UIApplication.shared.unregisterForRemoteNotifications()
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        guard let state, let server else { status = "Notifications are off."; return }
        do {
            let identity = try state.advancePush(enabled: false)
            // Capture access before logout clears private session state. This
            // short-lived request cannot put credentials back into storage.
            let cookies = try state.cookies()
            let revokeAPI = HubPushAPI(server: server, cookies: { cookies })
            status = "Notifications are off on this iPhone. Revoking HUB registration…"
            Task {
                do { _ = try await revokeAPI.revoke(identity); if current == generation { status = "Notifications are off." } }
                catch { if current == generation { status = "Off on this iPhone. HUB registration could not be revoked while offline; retry Turn off after reconnecting." } }
            }
        } catch { status = "Notifications are off on this iPhone. Unlock and retry to revoke saved HUB registration." }
    }
    func forgetConnection() {
        generation += 1; work?.cancel(); state = nil; api = nil; server = nil
        status = "Notifications are off. Connect to HUB first."
    }
    static func describe(_ error: Error) -> String {
        switch error as? HubPushError {
        case .signInRequired: return "Sign in to HUB again, then retry notifications."
        case .updateHost: return "Update your HUB host before enabling iPhone notifications."
        default: return "Could not reach HUB notifications. Check your connection and retry."
        }
    }
    func receive(_ info: [AnyHashable: Any]) {
        guard let hub = info["hub"], let data = try? JSONSerialization.data(withJSONObject: hub),
              let destination = try? HubNotificationDestination(data: data) else { return }
        if let destinationHandler { destinationHandler(destination) } else { pending = destination }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
            Task { @MainActor in self.receive(response.notification.request.content.userInfo); completionHandler() }
        } else { completionHandler() }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }
}

/// Keep progress and recovery visible while permission/network requests run.
/// An alert action would dismiss precisely when the user needs this feedback.
@MainActor private final class HubNotificationSettingsViewController: UITableViewController {
    private let manager: HubNotifications
    private let enable: () -> Void
    init(manager: HubNotifications, enable: @escaping () -> Void) {
        self.manager = manager; self.enable = enable
        super.init(style: .insetGrouped)
    }
    required init?(coder: NSCoder) { fatalError("Use init(manager:enable:)") }
    override func viewDidLoad() {
        super.viewDidLoad(); title = "Notifications"
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
        manager.changed = { [weak self] in self?.tableView.reloadData() }
        tableView.rowHeight = UITableView.automaticDimension
        tableView.estimatedRowHeight = 56
    }
    override func numberOfSections(in tableView: UITableView) -> Int { 2 }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { section == 0 ? 1 : 3 }
    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? { section == 0 ? "Status" : nil }
    override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
        section == 1 ? "HUB sends generic task alerts. Open an alert to see its conversation after sign-in. Delivery needs a signed iPhone build and Apple push configured on your HUB." : nil
    }
    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = UITableViewCell(style: .default, reuseIdentifier: nil)
        cell.textLabel?.font = .preferredFont(forTextStyle: .body)
        cell.textLabel?.adjustsFontForContentSizeCategory = true
        cell.textLabel?.numberOfLines = 0
        if indexPath.section == 0 {
            cell.textLabel?.text = manager.status; cell.selectionStyle = .none
            cell.accessibilityTraits = [.staticText, .updatesFrequently]
        } else {
            cell.textLabel?.text = ["Enable / retry", "Turn off", "iPhone notification settings"][indexPath.row]
            cell.textLabel?.textColor = indexPath.row == 1 ? .systemRed : .systemBlue
            cell.accessibilityTraits = .button
            if indexPath.row == 2 { cell.accessoryType = .disclosureIndicator }
        }
        return cell
    }
    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        guard indexPath.section == 1 else { return }
        switch indexPath.row {
        case 0: enable()
        case 1: manager.disable()
        default: if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        }
    }
}
