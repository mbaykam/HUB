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
    /// The chat on screen right now; its own replies don't need a banner.
    var visibleSessionID: String?
    /// Opens Home's agenda, for reminders and the morning brief.
    var agendaHandler: (() -> Void)? {
        didSet { if pendingAgenda, let agendaHandler { pendingAgenda = false; agendaHandler() } }
    }
    private var pendingAgenda = false

    /// Turns notifications on from Settings, asking for permission if needed.
    func turnOn() { enable(requestPermission: true) }

    /// Whether this iPhone opted in to HUB notifications.
    var isOn: Bool { (try? state?.pushIdentity())?.enabled == true }

    func preferences() async throws -> HubPushPreferences {
        guard let api else { throw HubPushError.unavailable }
        return try await api.status().preferences ?? .standard
    }

    func save(_ preferences: HubPushPreferences) async throws -> HubPushPreferences {
        guard let api else { throw HubPushError.unavailable }
        var value = preferences
        value.timeZone = TimeZone.current.identifier
        return try await api.save(value).preferences ?? value
    }

    func sendTest() async throws {
        guard let api else { throw HubPushError.unavailable }
        _ = try await api.sendTest()
    }

    /// The buttons each kind of notification offers on the lock screen.
    static func registerCategories() {
        func action(_ id: String, _ title: String, _ icon: String, _ options: UNNotificationActionOptions = []) -> UNNotificationAction {
            UNNotificationAction(identifier: id, title: title, options: options, icon: UNNotificationActionIcon(systemImageName: icon))
        }
        let reply = UNTextInputNotificationAction(identifier: "hub.reply", title: "Reply", options: [.authenticationRequired],
                                                  icon: UNNotificationActionIcon(systemImageName: "arrowshape.turn.up.left"),
                                                  textInputButtonTitle: "Send", textInputPlaceholder: "Message HUB")
        let open = action("hub.open", "Open", "arrow.up.forward.app", [.foreground])
        let approve = action("hub.approve", "Approve", "checkmark.circle", [.authenticationRequired])
        let deny = action("hub.deny", "Deny", "xmark.circle", [.authenticationRequired, .destructive])
        let snooze = action("hub.snooze", "Remind me in 10 min", "clock")
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: "HUB_REPLY", actions: [reply, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: "HUB_APPROVAL", actions: [approve, deny, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: "HUB_REMINDER", actions: [snooze, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: "HUB_OPEN", actions: [open], intentIdentifiers: []),
        ])
    }

    func receive(_ info: [AnyHashable: Any]) {
        if let note = HubPushNote(info["hubNote"]), note.kind == "brief" || note.kind == "reminder" || Self.homeOnly(info) {
            if let agendaHandler { agendaHandler() } else { pendingAgenda = true }
            return
        }
        guard let hub = info["hub"], let data = try? JSONSerialization.data(withJSONObject: hub),
              let destination = try? HubNotificationDestination(data: data) else { return }
        if let destinationHandler { destinationHandler(destination) } else { pending = destination }
    }

    /// Notifications about HUB itself (the agenda, a test) rather than a chat.
    private static func homeOnly(_ info: [AnyHashable: Any]) -> Bool {
        let session = (info["hub"] as? [String: Any])?["sessionId"] as? String ?? ""
        return session == "hub-agenda" || session.hasPrefix("hub-notification-")
    }

    private enum Response { case reply(String), decide(approve: Bool), snooze }

    /// Runs a lock-screen button: send the reply, decide the approval or snooze,
    /// even when HUB is not open. Failures come back as a notification.
    private func perform(_ response: Response, notification: UNNotification) async {
        let info = notification.request.content.userInfo
        guard let hub = info["hub"] as? [String: Any], let origin = hub["origin"] as? String,
              let sessionID = hub["sessionId"] as? String, let server = try? HubServer(address: origin) else { return }
        let state = HubDeviceState(server: server, store: HubKeychainStore())
        let api = HubConversationAPI(server: server) { (try? state.cookies()) ?? [] }
        let background = UIApplication.shared.beginBackgroundTask(withName: "HUB notification action")
        defer { UIApplication.shared.endBackgroundTask(background) }
        do {
            switch response {
            case .reply(let text):
                let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !message.isEmpty else { return }
                try await api.sendChat(message, sessionID: sessionID)
            case .decide(let approve):
                guard let note = HubPushNote(info["hubNote"]), let goal = note.goalID, let approval = note.approvalID,
                      let revision = note.revision else { throw HubAttachmentError.invalidResponse }
                try await api.changeWorkspaceTask(approve ? .approve : .deny, id: goal, revision: revision, routine: false, approvalID: approval)
                await Self.notice(approve ? "Approved" : "Denied", body: notification.request.content.title, thread: sessionID)
            case .snooze:
                let content = notification.request.content.mutableCopy() as? UNMutableNotificationContent ?? UNMutableNotificationContent()
                let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 600, repeats: false)
                try await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "hub.snooze." + UUID().uuidString, content: content, trigger: trigger))
            }
        } catch {
            await Self.notice("Couldn't reach HUB", body: "Open HUB to try again.", thread: sessionID)
        }
    }

    private static func notice(_ title: String, body: String, thread: String) async {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.threadIdentifier = thread
        content.interruptionLevel = .passive
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "hub.notice." + UUID().uuidString, content: content, trigger: nil))
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let notification = response.notification
        let text = (response as? UNTextInputNotificationResponse)?.userText
        let action = response.actionIdentifier
        Task { @MainActor in
            switch action {
            case UNNotificationDefaultActionIdentifier, "hub.open": self.receive(notification.request.content.userInfo)
            case "hub.reply": await self.perform(.reply(text ?? ""), notification: notification)
            case "hub.approve": await self.perform(.decide(approve: true), notification: notification)
            case "hub.deny": await self.perform(.decide(approve: false), notification: notification)
            case "hub.snooze": await self.perform(.snooze, notification: notification)
            default: break
            }
            completionHandler()
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let session = (notification.request.content.userInfo["hub"] as? [String: Any])?["sessionId"] as? String
        Task { @MainActor in
            // A reply to the chat being read is already on screen.
            let showing = session != nil && session == self.visibleSessionID && UIApplication.shared.applicationState == .active
            completionHandler(showing ? [.list] : [.banner, .list, .sound])
        }
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
