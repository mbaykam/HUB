import UIKit
import WebKit
import SafariServices
import SwiftUI
import os
import Network
import HubNative

/// Both installed static UI and remote HUB use a plain, unprivileged web view. No Capacitor
/// bridge, script message handler, injected cookie, or agent-controlled native API.
final class HubConnectionViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private let savedOriginKey = HubClientConfiguration.serverPreferenceKey
    private var server: HubServer?
    private var webView: WKWebView!
    private let home = HubHomeModel()
    private var homeState = HubHomeState()
    private var homeController: UIHostingController<HubHomeView>!
    private let workspaceBar = UIStackView()
    private var conversationAPI: HubConversationAPI?
    private var sendTask: Task<Void, Never>?
    private var showingHome = true
    private var signingIn = false
    private var firstAppearance = true
    private var initialServer: HubServer?
    private let bootstrapStarted = ProcessInfo.processInfo.systemUptime
    private var networkMonitor: NWPathMonitor?
    private var networkWasAvailable: Bool?
    private let launchLog = Logger(subsystem: "com.mbaykam.hub", category: "HomeLaunch")
    private let message = UILabel()
    private let recovery = UIStackView()
    private let recoveryVoice = UIButton(type: .system)
    private var probe: Task<Void, Never>?
    private var api: HubVoiceAPI?
    private var uiAPI: HubInstalledUIAPI?
    private var installedUI: HubInstalledUI?
    private var usingInstalledUI = false
    private var preferRemoteUI = false
    private var installedProcessRecoveries = 0
    private var connectionGeneration = 0
    private var connected = false
    private var notificationDestination: HubNotificationDestination?
    private var voice: HubNativeVoice? {
        get { HubAssistantCoordinator.shared.voice }
        set { HubAssistantCoordinator.shared.adopt(newValue) }
    }
    private var deviceState: HubDeviceState?
    private var keyboardObserver: NSObjectProtocol?
    private var lifecycleObservers: [NSObjectProtocol] = []
    private var pageDeadline: Task<Void, Never>?
    private var pageRecovery = HubPageRecovery()
    private var pageEpoch = 0
    private var inspectingPageEpoch: Int?
    private var activeNavigation: WKNavigation?
    private var showingPageLoad = false
    deinit { networkMonitor?.cancel(); sendTask?.cancel(); probe?.cancel(); pageDeadline?.cancel(); api?.invalidate(); uiAPI?.invalidate(); if let keyboardObserver { NotificationCenter.default.removeObserver(keyboardObserver) }; lifecycleObservers.forEach { NotificationCenter.default.removeObserver($0) } }

    override var preferredStatusBarStyle: UIStatusBarStyle { showingHome ? .lightContent : .default }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = HubHomeView.backgroundColor
        navigationController?.setNavigationBarHidden(true, animated: false)
        lifecycleObservers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.validateForegroundPage() }
        })
        lifecycleObservers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.cancelPageDeadline() }
        })
        message.font = .preferredFont(forTextStyle: .caption1)
        message.adjustsFontForContentSizeCategory = true
        message.textColor = .secondaryLabel
        message.textAlignment = .center
        message.numberOfLines = 0
        message.text = "Connect to your HUB to get started."
        message.accessibilityTraits = .updatesFrequently
        let connectButton = UIButton(type: .system)
        connectButton.setTitle("Connect to HUB", for: .normal)
        connectButton.addAction(UIAction { [weak self] _ in self?.showConnection() }, for: .touchUpInside)
        let retryButton = UIButton(type: .system)
        retryButton.setTitle("Retry", for: .normal)
        retryButton.addAction(UIAction { [weak self] _ in self?.reload() }, for: .touchUpInside)
        recovery.axis = .vertical
        recovery.spacing = 16
        recovery.translatesAutoresizingMaskIntoConstraints = false
        recoveryVoice.setTitle("Open voice controls", for: .normal)
        recoveryVoice.addAction(UIAction { [weak self] _ in self?.showVoice() }, for: .touchUpInside)
        recoveryVoice.isHidden = true
        let recoveryControls: [UIView] = [message, connectButton, retryButton, recoveryVoice]
        recoveryControls.forEach { recovery.addArrangedSubview($0) }
        workspaceBar.translatesAutoresizingMaskIntoConstraints = false
        workspaceBar.alignment = .center
        workspaceBar.isLayoutMarginsRelativeArrangement = true
        workspaceBar.layoutMargins = UIEdgeInsets(top: 0, left: 14, bottom: 0, right: 14)
        let homeButton = UIButton(type: .system)
        homeButton.setTitle("‹ Home", for: .normal)
        homeButton.addAction(UIAction { [weak self] _ in self?.returnHome() }, for: .touchUpInside)
        workspaceBar.addArrangedSubview(homeButton)
        let spacer = UIView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        homeButton.setContentHuggingPriority(.required, for: .horizontal)
        workspaceBar.addArrangedSubview(spacer)
        view.addSubview(workspaceBar)
        view.addSubview(recovery)
        NSLayoutConstraint.activate([
            workspaceBar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            workspaceBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            workspaceBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            workspaceBar.heightAnchor.constraint(equalToConstant: 44),
            recovery.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
            recovery.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            recovery.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24)
        ])
        workspaceBar.isHidden = true
        recovery.isHidden = true

        let screen = HubHomeView(model: home, connect: { [weak self] in self?.performHomeConnectionAction() },
            voice: { [weak self] in self?.openHomeVoice() }, options: { [weak self] in self?.showOptions() },
            workspace: { [weak self] in self?.openWorkspace() },
            openChat: { [weak self] id in self?.openChat(id) },
            send: { [weak self] in self?.sendHomeDraft() },
            addTodo: { [weak self] id, title in
                await self?.changeHomePlanner { try await $0.addTodo(id: id, title: title) } ?? false
            },
            completeTodo: { [weak self] item in
                Task { [weak self] in _ = await self?.changeHomePlanner { try await $0.completeTodo(item) } }
            }, readKnowledgeNote: { [weak self] id in
                guard let self, self.connected, let api = self.conversationAPI else { throw HubAttachmentError.unavailable }
                let generation = self.connectionGeneration
                let note = try await api.knowledgeNote(id: id)
                guard generation == self.connectionGeneration else { throw CancellationError() }
                return note
            }, readChat: { [weak self] id in
                guard let self, self.connected, let api = self.conversationAPI else { throw HubAttachmentError.unavailable }
                let generation = self.connectionGeneration
                let snapshot = try await api.chatSnapshot(sessionID: id)
                guard generation == self.connectionGeneration else { throw CancellationError() }
                return snapshot
            }, readTasks: { [weak self] in
                guard let self, self.connected, let api = self.conversationAPI else { throw HubAttachmentError.unavailable }
                let generation = self.connectionGeneration
                let tasks = try await api.workspaceTasks()
                guard generation == self.connectionGeneration else { throw CancellationError() }
                return tasks
            })
        let controller = UIHostingController(rootView: screen)
        homeController = controller
        addChild(controller)
        controller.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(controller.view)
        NSLayoutConstraint.activate([
            controller.view.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            controller.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            controller.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            controller.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        controller.didMove(toParent: self)
        if let address = UserDefaults.standard.string(forKey: savedOriginKey), let saved = try? HubServer(address: address) {
            initialServer = saved
            home.connection = .connecting
        }
        HubNotifications.shared.destinationHandler = { [weak self] destination in self?.openNotification(destination) }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        home.hasActiveVoice = voice?.isActive == true
        if firstAppearance {
            let elapsed = Int((ProcessInfo.processInfo.systemUptime - bootstrapStarted) * 1000)
            launchLog.info("Native Home appeared in \(elapsed, privacy: .public) ms")
            if let initialServer { connect(initialServer) }
            initialServer = nil
            firstAppearance = false
            refreshHome()
            monitorHomeNetwork()
        }
    }

    private func monitorHomeNetwork() {
        let monitor = NWPathMonitor()
        networkMonitor = monitor
        monitor.pathUpdateHandler = { [weak self] path in
            let available = path.status == .satisfied
            Task { @MainActor [weak self] in
                guard let self else { return }
                let restored = self.networkWasAvailable == false && available
                self.networkWasAvailable = available
                if restored, self.showingHome, self.home.connection == .unavailable,
                   UIApplication.shared.applicationState == .active {
                    self.refreshHome()
                }
            }
        }
        monitor.start(queue: DispatchQueue(label: "com.mbaykam.hub.connectivity"))
    }

    private func prepareWebView() {
        guard webView == nil else { return }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.applicationNameForUserAgent = "HUBiOS/0.2"
        // Do not add native message handlers to this configuration.
        webView = HubWebView(frame: .zero, configuration: config)
        if let resources = Bundle.main.resourceURL {
            installedUI = try? HubInstalledUI.load(from: resources.appendingPathComponent("public/installed-ui", isDirectory: true))
        }
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground
        webView.allowsBackForwardNavigationGestures = true
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.keyboardDismissMode = .interactive
        hideKeyboardShortcuts(in: webView)
        keyboardObserver = NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in guard let self, let webView = self.webView else { return }; self.hideKeyboardShortcuts(in: webView) }
        }
        view.insertSubview(webView, belowSubview: recovery)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: workspaceBar.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(true, animated: false)
    }

    private func showContent() { recovery.isHidden = true; webView.isHidden = false }
    // Public UIKit API only: no private WebKit classes, method replacement or
    // privileged script access to the remote page.
    private func hideKeyboardShortcuts(in view: UIView) {
        view.inputAssistantItem.leadingBarButtonGroups = []
        view.inputAssistantItem.trailingBarButtonGroups = []
        for child in view.subviews { hideKeyboardShortcuts(in: child) }
    }
    private func showRecovery(_ text: String) {
        cancelPageDeadline(); showingPageLoad = false
        activeNavigation = nil
        probe?.cancel(); connected = false
        webView?.stopLoading()
        message.text = text; recoveryVoice.isHidden = voice?.isActive != true
        recovery.isHidden = false; webView.isHidden = true
    }
    private func cancelPageDeadline() { pageDeadline?.cancel(); pageDeadline = nil; pageRecovery.cancel() }
    private func watchPage(timeout: UInt64) {
        pageDeadline?.cancel()
        pageEpoch = pageRecovery.begin()
        let epoch = pageEpoch
        pageDeadline = Task { [weak self] in
            for _ in 0..<timeout {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard !Task.isCancelled, let self, UIApplication.shared.applicationState != .background else { return }
                self.inspectVisiblePage()
            }
            guard !Task.isCancelled, let self, UIApplication.shared.applicationState != .background,
                  self.pageRecovery.expired(epoch) else { return }
            self.showRecovery("HUB did not finish opening. Check your connection, then tap Retry. Your conversations stay on HUB.")
        }
    }
    private func preparePageLoad() {
        probe?.cancel(); connected = false; showingPageLoad = true
        message.text = "Opening HUB…"
        recoveryVoice.isHidden = voice?.isActive != true
        recovery.isHidden = false
        // Keep WebKit onscreen so its real renderer can receive animation frames.
        webView.isHidden = false
        watchPage(timeout: 25)
    }
    private func inspectVisiblePage() {
        // During provisional navigation, WebKit still exposes the old document.
        // Its contents must not satisfy the new page's opening deadline.
        guard !webView.isLoading, pageDeadline != nil, inspectingPageEpoch != pageEpoch else { return }
        let epoch = pageEpoch, installed = usingInstalledUI
        inspectingPageEpoch = epoch
        let expression = installed
            ? "Array.from(document.querySelectorAll('[data-hub-home-nav],[data-composer-card]')).some(element => {const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility === 'visible';})"
            : "!!document.body && (document.body.innerText.trim().length > 0 || !!document.body.querySelector('input,button,iframe,canvas,video'))"
        webView.evaluateJavaScript(expression) { [weak self] value, _ in
            guard let self else { return }
            if self.inspectingPageEpoch == epoch { self.inspectingPageEpoch = nil }
            guard !self.webView.isLoading, value as? Bool == true, self.pageRecovery.visible(epoch) else { return }
            self.pageDeadline?.cancel(); self.pageDeadline = nil
            if self.showingPageLoad { self.showingPageLoad = false; self.showContent() }
        }
    }
    private func validateForegroundPage() {
        guard !firstAppearance else { return }
        if showingHome {
            home.hasActiveVoice = voice?.isActive == true
            refreshHome()
            return
        }
        guard isViewLoaded, view.window != nil, let server, recovery.isHidden || showingPageLoad else { return }
        // Inspect first; never reload a healthy page or a user's current draft.
        watchPage(timeout: showingPageLoad ? 25 : 8)
        webView.setNeedsLayout()
        inspectVisiblePage()
        if let url = webView.url, server.contains(url), !webView.isLoading { checkConnection(server) }
    }
    private func showNotice(_ text: String) {
        message.text = text
        guard presentedViewController == nil else { return }
        let alert = UIAlertController(title: "HUB", message: text, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }
    private func showOptions() {
        let sheet = UIAlertController(title: "iPhone", message: message.text, preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: voice?.isActive == true ? "Open voice controls" : "Voice", style: .default) { [weak self] _ in self?.afterOptions { $0.showVoice() } })
        sheet.addAction(UIAlertAction(title: "Files", style: .default) { [weak self] _ in self?.afterOptions { $0.showSharedFiles() } })
        sheet.addAction(UIAlertAction(title: "Notifications", style: .default) { [weak self] _ in self?.afterOptions { HubNotifications.shared.show(from: $0) } })
        if showingHome, connected {
            sheet.addAction(UIAlertAction(title: "Open workspace", style: .default) { [weak self] _ in
                self?.afterOptions { $0.openWorkspace() }
            })
        }
        sheet.addAction(UIAlertAction(title: "Connection", style: .default) { [weak self] _ in self?.afterOptions { $0.showConnection() } })
        sheet.addAction(UIAlertAction(title: usingInstalledUI ? "Reload from HUB" : "Reload", style: .default) { [weak self] _ in self?.afterOptions {
            if $0.usingInstalledUI, let server = $0.server {
                $0.preferRemoteUI = true
                $0.connected = false
                $0.loadRemote(server.origin)
            } else { $0.reload() }
        } })
        sheet.addAction(UIAlertAction(title: "Sign out on this iPhone", style: .destructive) { [weak self] _ in self?.afterOptions { $0.confirmSignOut() } })
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.safeAreaInsets.top, width: 1, height: 1)
        present(sheet, animated: true)
    }
    private func afterOptions(_ action: @escaping (HubConnectionViewController) -> Void) {
        dismiss(animated: true) { [weak self] in guard let self else { return }; action(self) }
    }

    private func showConnection(error: String? = nil, address: String? = nil) {
        guard !home.sending else { return }
        guard voice?.isActive != true else { showEndVoiceFirst(); return }
        let sheet = UIAlertController(title: "Connect to HUB", message: error ?? "Enter your secure HUB address. Sign in on the next screen; your session stays on this iPhone.", preferredStyle: .alert)
        sheet.addTextField { field in
            field.placeholder = "https://hub.example.com"
            field.text = address ?? self.server?.origin.absoluteString
            field.keyboardType = .URL
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
            field.accessibilityLabel = "Secure HUB address"
        }
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        sheet.addAction(UIAlertAction(title: "Connect", style: .default) { [weak self, weak sheet] _ in
            let value = sheet?.textFields?.first?.text ?? ""
            guard let candidate = try? HubServer(address: value) else {
                DispatchQueue.main.async { self?.showConnection(error: "Use an HTTPS address with no login token, password, or extra path.", address: value) }
                return
            }
            self?.connect(candidate)
        })
        present(sheet, animated: true)
    }

    private func connect(_ value: HubServer) {
        if let server, server != value {
            HubNotifications.shared.disable()
            home.draft = ""
        }
        connectionGeneration += 1
        probe?.cancel()
        connected = false
        server = value
        let nativeState = HubDeviceState(server: value, store: HubKeychainStore())
        deviceState = nativeState
        api?.invalidate()
        uiAPI?.invalidate()
        preferRemoteUI = false
        installedProcessRecoveries = 0
        let cookies: () async -> [HTTPCookie] = {
            await withCheckedContinuation { continuation in
                DispatchQueue.main.async {
                    if UIApplication.shared.applicationState == .background {
                        continuation.resume(returning: (try? nativeState.cookies()) ?? [])
                    } else {
                        WKWebsiteDataStore.default().httpCookieStore.getAllCookies {
                            continuation.resume(returning: $0)
                        }
                    }
                }
            }
        }
        api = HubVoiceAPI(server: value, cookies: cookies)
        uiAPI = HubInstalledUIAPI(server: value, cookies: cookies)
        conversationAPI = HubConversationAPI(server: value, cookies: cookies)
        UserDefaults.standard.set(value.origin.absoluteString, forKey: savedOriginKey)
        home.knowledge = nil
        home.planner = nil
        home.plannerSaving = false
        home.plannerError = nil
        home.conversations = nil
        home.uncertainChat = nil
        home.sendError = nil
        if !firstAppearance { returnHome() }
    }

    private func refreshHome() {
        guard showingHome, !home.sending, !home.plannerSaving else { return }
        let started = ProcessInfo.processInfo.systemUptime
        let attempt = homeState.begin(hasServer: server != nil)
        connected = false
        home.connection = homeState.connection
        home.refreshing = false
        home.incomplete = false
        guard let server, let uiAPI, let conversationAPI else { return }
        probe?.cancel()
        probe = Task { [weak self] in
            do {
                _ = try await uiAPI.compatibility()
                guard let self, !Task.isCancelled, self.showingHome,
                      self.homeState.resolve(.connected, attempt: attempt) else { return }
                self.connected = true
                self.home.connection = .connected
                self.home.refreshing = true
                self.message.text = "Connected"
                self.openPendingNotification()
                guard self.showingHome else { return }
                async let knowledge: Void = self.loadHomeKnowledge(conversationAPI, attempt: attempt)
                async let planner: Void = self.loadHomePlanner(conversationAPI, attempt: attempt)
                async let chats: Void = self.loadHomeChats(conversationAPI, attempt: attempt)
                _ = await (knowledge, planner, chats)
                guard !Task.isCancelled, self.showingHome, self.homeState.isCurrent(attempt) else { return }
                self.home.refreshing = false
                let elapsed = Int((ProcessInfo.processInfo.systemUptime - started) * 1000)
                if !self.home.incomplete {
                    self.launchLog.info("Native Home live data ready in \(elapsed, privacy: .public) ms")
                }
                await self.saveWebSession(server)
            } catch {
                guard let self, !Task.isCancelled, self.showingHome else { return }
                self.homeConnectionFailed(error, attempt: attempt)
            }
        }
    }

    private func loadHomeKnowledge(_ api: HubConversationAPI, attempt: UInt64) async {
        do {
            let value = try await api.knowledge()
            if showingHome, !Task.isCancelled, homeState.isCurrent(attempt) { home.knowledge = value }
        } catch { homeDataFailed(error, attempt: attempt) }
    }

    private func loadHomePlanner(_ api: HubConversationAPI, attempt: UInt64) async {
        do {
            let value = try await api.planner()
            if showingHome, !Task.isCancelled, homeState.isCurrent(attempt), !home.plannerSaving,
               (value.revision ?? 0) >= (home.planner?.revision ?? 0) { home.planner = value }
        } catch { homeDataFailed(error, attempt: attempt) }
    }

    private func changeHomePlanner(_ operation: (HubConversationAPI) async throws -> HubHomePlanner) async -> Bool {
        guard showingHome, home.connection == .connected, !home.plannerSaving,
              let conversationAPI else { return false }
        let generation = connectionGeneration
        home.plannerSaving = true
        home.plannerError = nil
        defer { if generation == connectionGeneration { home.plannerSaving = false } }
        do {
            let planner = try await operation(conversationAPI)
            guard generation == connectionGeneration else { return false }
            home.planner = planner
            return true
        } catch {
            guard generation == connectionGeneration else { return false }
            if error as? HubAttachmentError == .signInRequired {
                let attempt = homeState.begin(hasServer: true)
                homeConnectionFailed(error, attempt: attempt)
            } else {
                home.plannerError = "Could not confirm the change. Check your planner before trying again."
                if let planner = try? await conversationAPI.planner(), generation == connectionGeneration {
                    home.planner = planner
                }
            }
            return false
        }
    }

    private func loadHomeChats(_ api: HubConversationAPI, attempt: UInt64) async {
        do {
            let value = try await api.list()
            if showingHome, !Task.isCancelled, homeState.isCurrent(attempt) { home.conversations = value.conversations }
        } catch { homeDataFailed(error, attempt: attempt) }
    }

    private func homeDataFailed(_ error: Error, attempt: UInt64) {
        guard showingHome, !Task.isCancelled, homeState.isCurrent(attempt) else { return }
        if error as? HubAttachmentError == .signInRequired {
            let next = homeState.begin(hasServer: server != nil)
            homeConnectionFailed(error, attempt: next)
        } else {
            home.incomplete = true
        }
    }

    private func homeConnectionFailed(_ error: Error, attempt: UInt64) {
        let signIn = (error as? HubVoiceAPIError) == .signInRequired
            || (error as? HubAttachmentError) == .signInRequired
        guard homeState.resolve(signIn ? .signInRequired : .unavailable, attempt: attempt) else { return }
        connected = false
        home.connection = homeState.connection
        home.refreshing = false
        if signIn { home.knowledge = nil; home.planner = nil; home.conversations = nil }
    }

    private func saveWebSession(_ expected: HubServer) async {
        let generation = connectionGeneration
        let cookies: [HTTPCookie] = await withCheckedContinuation { continuation in
            WKWebsiteDataStore.default().httpCookieStore.getAllCookies { continuation.resume(returning: $0) }
        }
        guard !Task.isCancelled, server == expected, generation == connectionGeneration, let state = deviceState else { return }
        do { try state.rememberVerifiedSession(cookies) }
        catch { message.text = "Connected. Sign-in could not be saved on this iPhone." }
        HubNotifications.shared.attach(server: expected, state: state)
    }

    private func performHomeConnectionAction() {
        switch home.connection {
        case .needsSetup: showConnection()
        case .signInRequired:
            if let server {
                signingIn = true
                loadRemote(server.origin)
            }
        case .unavailable, .connected: refreshHome()
        case .connecting: break
        }
    }

    private func openHomeVoice() {
        if home.connection == .connected || voice?.isActive == true { showVoice() }
        else { performHomeConnectionAction() }
    }

    private func openWorkspace() {
        guard !home.sending else { return }
        guard connected, let server else { performHomeConnectionAction(); return }
        loadHub(server)
    }

    private func openChat(_ id: String) {
        guard !home.sending, let server, let destination = try? HubNotificationDestination(server: server, sessionID: id) else { return }
        if home.uncertainChat == id, connected {
            home.uncertainChat = nil
            home.sendError = nil
        }
        openNotification(destination)
    }

    private func sendHomeDraft() {
        guard showingHome, home.connection == .connected, !home.sending, home.uncertainChat == nil,
              let conversationAPI, !home.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let draft = home.draft
        let generation = connectionGeneration
        home.sending = true
        home.sendError = nil
        sendTask = Task { [weak self] in
            do {
                let id = try await conversationAPI.sendNewChat(draft)
                guard let self, generation == self.connectionGeneration else { return }
                self.home.sending = false
                self.home.draft = ""
                self.openChat(id)
            } catch {
                guard let self, generation == self.connectionGeneration else { return }
                self.home.sending = false
                switch error as? HubChatSendError {
                case .unknownDelivery(let id):
                    self.home.uncertainChat = id
                    self.home.sendError = "Delivery could not be confirmed. Open the conversation before sending again."
                case .signInRequired:
                    let attempt = self.homeState.begin(hasServer: true)
                    self.homeConnectionFailed(HubVoiceAPIError.signInRequired, attempt: attempt)
                case .invalidDraft:
                    self.home.sendError = "This message is too long."
                default:
                    self.home.sendError = "The message could not be sent. Your text is still here."
                }
            }
        }
    }

    private func returnHome() {
        signingIn = false
        showingHome = true
        view.backgroundColor = HubHomeView.backgroundColor
        navigationController?.setNeedsStatusBarAppearanceUpdate()
        activeNavigation = nil
        cancelPageDeadline()
        probe?.cancel()
        webView?.stopLoading()
        webView?.isHidden = true
        recovery.isHidden = true
        workspaceBar.isHidden = true
        homeController.view.isHidden = false
        home.hasActiveVoice = voice?.isActive == true
        refreshHome()
    }

    private func showWorkspace() {
        view.endEditing(true)
        if showingHome {
            probe?.cancel()
            _ = homeState.begin(hasServer: server != nil)
        }
        showingHome = false
        view.backgroundColor = .systemBackground
        navigationController?.setNeedsStatusBarAppearanceUpdate()
        homeController.view.isHidden = true
        workspaceBar.isHidden = false
        prepareWebView()
    }

    private func loadHub(_ value: HubServer) {
        showWorkspace()
        // Only static, checksum-verified resources from the signed app are used.
        // The selected HTTPS origin and WebKit's own cookie store remain intact;
        // there is no native fetch proxy, JS bridge or restored user snapshot.
        if !preferRemoteUI, let installedUI {
            preparePageLoad()
            usingInstalledUI = true
            activeNavigation = webView.loadHTMLString(installedUI.html, baseURL: value.origin)
        } else { loadRemote(value.origin) }
    }
    private func loadRemote(_ url: URL) {
        showWorkspace()
        preparePageLoad()
        usingInstalledUI = false
        activeNavigation = webView.load(URLRequest(url: url))
    }

    private func reload() {
        if showingHome { refreshHome(); return }
        if server == nil { showConnection(); return }
        installedProcessRecoveries = 0
        showContent()
        if (!connected || usingInstalledUI), let server { loadHub(server); return }
        if let url = webView.url, server?.contains(url) == true { webView.reload() }
        else if let server { loadHub(server) }
    }

    private func confirmSignOut() {
        guard !home.sending, !home.plannerSaving else { return }
        guard voice?.isActive != true else { showEndVoiceFirst(); return }
        let alert = UIAlertController(title: "Sign out on this iPhone?", message: "Your conversations, files and settings on HUB will stay intact.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Sign out", style: .destructive) { [weak self] _ in
            guard let self else { return }
            self.connectionGeneration += 1
            self.cancelPageDeadline()
            self.probe?.cancel()
            HubNotifications.shared.disable()
            do { try self.deviceState?.clear() }
            catch { self.showNotice("Sign-out could not clear saved access. Unlock this iPhone and try again."); return }
            HubNotifications.shared.forgetConnection()
            self.connected = false
            self.webView?.stopLoading()
            self.server = nil
            UserDefaults.standard.removeObject(forKey: self.savedOriginKey)
            let store = WKWebsiteDataStore.default().httpCookieStore
            store.getAllCookies { cookies in
                let group = DispatchGroup()
                for cookie in cookies { group.enter(); store.delete(cookie) { group.leave() } }
                group.notify(queue: .main) {
                    // Destroy the old web view, including its active sockets and
                    // media, instead of merely hiding a still-running signed-in page.
                    self.api?.invalidate(); self.uiAPI?.invalidate()
                    self.view.window?.rootViewController = HubWorkspaceNavigationController(rootViewController: HubConnectionViewController())
                }
            }
        })
        present(alert, animated: true)
    }

    private func showVoice(resumeLastConversation: Bool = false) {
        guard let api, let server, let deviceState else { showConnection(); return }
        guard connected || voice?.isActive == true else {
            showConnection(error: "Complete HUB sign-in before starting voice.")
            return
        }
        let pending: HubVoiceAdmission? = voice?.isActive == true ? nil : (try? deviceState.admission())
        let saved: HubVoiceCheckpoint? = pending == nil && voice?.isActive != true ? (try? deviceState.voice()) : nil
        presentVoice(api: api, server: server, deviceState: deviceState, checkpoint: saved, pending: pending, resumeOnlyIfActive: !resumeLastConversation)
    }
    private func presentVoice(api: HubVoiceAPI, server: HubServer, deviceState: HubDeviceState, checkpoint: HubVoiceCheckpoint?, pending: HubVoiceAdmission? = nil, resumeOnlyIfActive: Bool = false) {
        let model = voice?.isActive == true ? voice! : HubNativeVoice(api: api, server: server, deviceState: deviceState, resume: checkpoint, pendingAdmission: pending, resumeOnlyIfActive: resumeOnlyIfActive)
        voice = model
        let sheet = HubVoiceViewController(voice: model, restart: { [weak self] in
            self?.dismiss(animated: true) { [weak self] in self?.showVoice(resumeLastConversation: true) }
        }) { [weak self, weak model] in
            guard let self else { return }
            guard let destination = model?.conversationDestination() else {
                self.showNotice("Wait for voice to connect before opening its conversation.")
                return
            }
            self.dismiss(animated: true) { [weak self] in self?.openNotification(destination) }
        }
        present(UINavigationController(rootViewController: sheet), animated: true) { [weak self, weak sheet] in
            model.changed = { [weak sheet] in
                sheet?.refresh()
            }
            if !model.isActive { model.start() }
        }
    }
    private func showEndVoiceFirst() {
        let alert = UIAlertController(title: "A voice conversation is active", message: "Open Voice and end the conversation before changing the server or signing out.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }
    private func showSharedFiles() {
        guard connected, let server, let state = deviceState else { showNotice("Sign in to HUB before choosing a file conversation."); return }
        let generation = connectionGeneration
        do {
            let screen = try HubSharedFilesViewController(server: server, state: state, stillConnected: { [weak self] in
                self?.connected == true && self?.connectionGeneration == generation && self?.server == server
            }, openDraft: { [weak self] url in
                guard let self, self.connected, self.connectionGeneration == generation, server.contains(url) else { return }
                self.loadRemote(url)
            })
            present(UINavigationController(rootViewController: screen), animated: true)
        } catch { showNotice("Files are unavailable. Unlock the iPhone and check the app's sharing setup; HUB's normal file button remains available.") }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard !showingHome, let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        let mainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        if let server, server.contains(url), URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains(where: { $0.name == "hubNative" }) == true {
            decisionHandler(.cancel)
            guard presentedViewController == nil else { return }
            let source = navigationAction.sourceFrame.request.url
            let sourceIsMain = navigationAction.sourceFrame.isMainFrame
            let isLink = navigationAction.navigationType == .linkActivated
            if HubVoiceNavigation.requestsVoice(url: url, source: source, server: server, sourceIsMainFrame: sourceIsMain, targetIsMainFrame: mainFrame, isLink: isLink) {
                if connected || voice?.isActive == true { showVoice() }
                else { showConnection(error: "Complete HUB sign-in before starting voice.") }
            }
            else if HubVoiceNavigation.requestsOptions(url: url, source: source, server: server, sourceIsMainFrame: sourceIsMain, targetIsMainFrame: mainFrame, isLink: isLink) { showOptions() }
            return
        }
        if !mainFrame {
            decisionHandler(["https", "blob", "about", "data"].contains(url.scheme?.lowercased() ?? "") ? .allow : .cancel)
            return
        }
        guard url.scheme?.lowercased() == "https", url.user == nil, url.password == nil else { decisionHandler(.cancel); return }
        if navigationAction.navigationType == .linkActivated && connected && server?.contains(url) != true {
            decisionHandler(.cancel)
            present(SFSafariViewController(url: url), animated: true)
            return
        }
        if server?.contains(url) != true {
            connected = false
            probe?.cancel()
            message.text = "Complete sign-in to connect to HUB."
        }
        // HTTPS authentication redirects may visit Access and the chosen identity
        // provider. Native API requests still target only the exact selected HUB.
        if navigationAction.targetFrame == nil { decisionHandler(.cancel); preparePageLoad(); usingInstalledUI = false; activeNavigation = webView.load(navigationAction.request); return }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if !showingHome, navigation !== activeNavigation { preparePageLoad(); activeNavigation = navigation }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard !showingHome else { decisionHandler(.cancel); return }
        if let response = navigationResponse.response as? HTTPURLResponse,
           HubPageRecovery.failedHTTP(status: response.statusCode, mainFrame: navigationResponse.isForMainFrame) {
            decisionHandler(.cancel)
            showRecovery("HUB returned HTTP \(response.statusCode). Retry or check Connection to sign in again.")
            return
        }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !showingHome, navigation === activeNavigation else { return }
        inspectVisiblePage()
        guard let server, let url = webView.url, server.contains(url) else {
            message.text = "Complete sign-in to connect to HUB."
            return
        }
        checkConnection(server)
    }

    private func checkConnection(_ expected: HubServer) {
        let generation = connectionGeneration
        probe?.cancel()
        guard let api else { return }
        probe = Task { [weak self] in
            do {
                _ = try await api.status()
                guard let self, !Task.isCancelled, generation == self.connectionGeneration,
                      let url = self.webView.url, expected.contains(url) else { return }
                if self.usingInstalledUI, let installedUI = self.installedUI, let uiAPI = self.uiAPI {
                    let compatibility = try await uiAPI.compatibility()
                    guard !Task.isCancelled, generation == self.connectionGeneration else { return }
                    if compatibility != installedUI.manifest.compatibility {
                        // Keep the normal authenticated PWA available when a
                        // newer host requires a different installed renderer.
                        self.preferRemoteUI = true
                        self.loadRemote(expected.origin)
                        return
                    }
                }
                self.connected = true
                if !self.showingPageLoad { self.showContent() }
                self.message.text = "Connected · \(expected.origin.host ?? "HUB")"
                await self.saveWebSession(expected)
                guard !Task.isCancelled, generation == self.connectionGeneration else { return }
                if self.signingIn {
                    self.returnHome()
                    return
                }
                self.openPendingNotification()
            } catch {
                guard let self, !Task.isCancelled, generation == self.connectionGeneration else { return }
                self.connected = false
                if self.usingInstalledUI, error as? HubVoiceAPIError == .signInRequired {
                    // Authentication is completed in the original HTTPS gate,
                    // never in a local imitation or through copied login tokens.
                    self.preferRemoteUI = true
                    self.loadRemote(expected.origin)
                    return
                }
                self.message.text = error as? HubVoiceAPIError == .signInRequired
                    ? "Sign in to HUB, then choose Reload."
                    : "Connection interrupted. Check Connection or choose Reload."
            }
        }
    }

    private func openNotification(_ destination: HubNotificationDestination) {
        notificationDestination = destination
        guard !firstAppearance else { return }
        guard !home.sending else { return }
        if connected {
            openPendingNotification()
        } else if showingHome {
            if home.connection != .connecting { performHomeConnectionAction() }
        } else if let server, !signingIn {
            loadHub(server)
        }
    }
    private func openPendingNotification() {
        guard connected, let server, let destination = notificationDestination else { return }
        notificationDestination = nil
        guard let url = try? destination.url(for: server) else {
            message.text = "This notification belongs to a different HUB. Your connection was not changed."
            return
        }
        loadRemote(url)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { if navigation === activeNavigation { showFailure(error) } }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { if navigation === activeNavigation { showFailure(error) } }
    private func showFailure(_ error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { showRecovery("Could not open HUB. Check your connection, then retry or choose another connection.") }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard !showingHome else { return }
        cancelPageDeadline()
        connected = false
        if UIApplication.shared.applicationState != .background, let server, installedUI != nil, !preferRemoteUI, installedProcessRecoveries < 1 {
            installedProcessRecoveries += 1
            // Fresh Home, not a cached conversation or a restored screen.
            showContent(); loadHub(server)
        } else { showRecovery("HUB needs to reconnect. Tap Retry to continue.") }
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        var parts = URLComponents()
        parts.scheme = origin.protocol; parts.host = origin.host
        if origin.port != 0 { parts.port = origin.port }
        let trusted = parts.url.map { server?.contains($0) == true } ?? false
        // Keep one audio owner in this app, including with an older PWA. Camera
        // uploads still use the standard prompt; web/agent frames get no mic.
        if type == .microphone || type == .cameraAndMicrophone {
            decisionHandler(.deny)
            if trusted && frame.isMainFrame { showNotice("Use the Speak button in HUB for iPhone audio.") }
        } else { decisionHandler(trusted && frame.isMainFrame ? .prompt : .deny) }
    }
}
