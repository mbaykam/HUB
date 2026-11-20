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
    private var lastAccessRenewal: Date?
    private var sendTask: Task<Void, Never>?
    private var showingHome = true
    private var workspaceAppearance = HubChatPreferences.Appearance.dark
    private var firstAppearance = true
    #if DEBUG && targetEnvironment(simulator)
    private let showHomeFixture = ProcessInfo.processInfo.arguments.contains("--hub-native-home-fixture")
    #endif
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
    private var connectionGeneration = 0
    private var connected = false
    private var chatAttachmentStore: HubAttachmentStore?
    private var chatAttachmentAPI: HubAttachmentAPI?
    private var notificationDestination: HubNotificationDestination?
    private var voice: HubNativeVoice? {
        get { HubAssistantCoordinator.shared.voice }
        set { HubAssistantCoordinator.shared.adopt(newValue) }
    }
    private var deviceState: HubDeviceState?
    private var openChatWhenVoiceConnects = false
    private var openCameraWhenVoiceConnects = false
    private var cameraVision: HubCameraVision?
    private var cameraHost: UIViewController?
    private var keyboardObserver: NSObjectProtocol?
    private var lifecycleObservers: [NSObjectProtocol] = []
    private var pageDeadline: Task<Void, Never>?
    private var pageRecovery = HubPageRecovery()
    private var pageEpoch = 0
    private var inspectingPageEpoch: Int?
    private var activeNavigation: WKNavigation?
    private var showingPageLoad = false
    deinit { networkMonitor?.cancel(); sendTask?.cancel(); probe?.cancel(); pageDeadline?.cancel(); api?.invalidate(); uiAPI?.invalidate(); if let keyboardObserver { NotificationCenter.default.removeObserver(keyboardObserver) }; lifecycleObservers.forEach { NotificationCenter.default.removeObserver($0) } }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        guard showingHome else { return .default }
        switch workspaceAppearance {
        case .dark: return .lightContent
        case .light: return .darkContent
        case .system: return traitCollection.userInterfaceStyle == .dark ? .lightContent : .darkContent
        }
    }

    private func applyWorkspaceAppearance(_ appearance: HubChatPreferences.Appearance) {
        workspaceAppearance = appearance
        guard showingHome else { return }
        let style: UIUserInterfaceStyle
        switch appearance {
        case .dark: style = .dark
        case .light: style = .light
        case .system: style = .unspecified
        }
        overrideUserInterfaceStyle = style
        viewIfLoaded?.window?.overrideUserInterfaceStyle = style
        setNeedsStatusBarAppearanceUpdate()
        navigationController?.setNeedsStatusBarAppearanceUpdate()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        applyWorkspaceAppearance(workspaceAppearance)
        view.backgroundColor = HubHomeView.backgroundColor
        navigationController?.setNavigationBarHidden(true, animated: false)
        lifecycleObservers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.validateForegroundPage() }
        })
        lifecycleObservers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.cancelPageDeadline() }
        })
        lifecycleObservers.append(NotificationCenter.default.addObserver(forName: HubSiriInbox.arrived, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.deliverSiriMessage() }
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
            openChat: { [weak self] id in self?.openChat(id) },
            send: { [weak self] in self?.sendHomeDraft() },
            addTodo: { [weak self] id, title, horizon in
                await self?.changeHomePlanner { try await $0.addTodo(id: id, title: title, horizon: horizon) } ?? false
            },
            completeTodo: { [weak self] item in
                Task { [weak self] in _ = await self?.changeHomePlanner { try await $0.completeTodo(item) } }
            }, restorePlannerItem: { [weak self] item in
                Task { [weak self] in _ = await self?.changeHomePlanner { try await $0.restorePlannerItem(item) } }
            }, savePlannerItem: { [weak self] draft in
                await self?.changeHomePlanner { try await $0.savePlannerItem(draft) } ?? false
            }, removePlannerItem: { [weak self] item in
                await self?.changeHomePlanner { try await $0.removePlannerItem(item) } ?? false
            }, readKnowledgeNote: { [weak self] id in
                guard let self, self.connected, let api = self.conversationAPI else { throw HubAttachmentError.unavailable }
                let generation = self.connectionGeneration
                let note = try await api.knowledgeNote(id: id)
                guard generation == self.connectionGeneration else { throw CancellationError() }
                return note
            }, attachments: { [weak self] in
                guard let self, self.connected, let server = self.server, let upload = self.chatAttachmentAPI else { return nil }
                if self.chatAttachmentStore == nil,
                   let base = try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                          appropriateFor: nil, create: true) {
                    self.chatAttachmentStore = try? HubAttachmentStore(root: base.appendingPathComponent("HubAttachmentOutbox", isDirectory: true))
                }
                guard let store = self.chatAttachmentStore else { return nil }
                return HubChatAttachmentContext(server: server, store: store, upload: upload)
            }, chatAPI: { [weak self] in
                guard let self, self.connected else { return nil }
                return self.conversationAPI
            }, readTasks: { [weak self] in
                guard let self, self.connected, let api = self.conversationAPI else { throw HubAttachmentError.unavailable }
                let generation = self.connectionGeneration
                let tasks = try await api.workspaceTasks()
                guard generation == self.connectionGeneration else { throw CancellationError() }
                return tasks
            }, appearanceChanged: { [weak self] in self?.applyWorkspaceAppearance($0) },
            voiceControl: { [weak self] control in self?.controlVoice(control) })
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
        #if DEBUG && targetEnvironment(simulator)
        if showHomeFixture {
            seedHomeFixture()
            return
        }
        #endif
        if let address = UserDefaults.standard.string(forKey: savedOriginKey), let saved = try? HubServer(address: address) {
            initialServer = saved
            home.connection = .connecting
        }
        HubNotifications.shared.destinationHandler = { [weak self] destination in self?.openNotification(destination) }
        HubNotifications.shared.agendaHandler = { [weak self] in
            guard let self else { return }
            if self.presentedViewController != nil { self.dismiss(animated: true) { self.home.openAgenda = true } }
            else { self.home.openAgenda = true }
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if showingHome { applyWorkspaceAppearance(workspaceAppearance) }
        syncVoiceSummary()
        if firstAppearance {
            let elapsed = Int((ProcessInfo.processInfo.systemUptime - bootstrapStarted) * 1000)
            launchLog.info("Native Home appeared in \(elapsed, privacy: .public) ms")
            #if DEBUG && targetEnvironment(simulator)
            if showHomeFixture {
                firstAppearance = false
                return
            }
            #endif
            if let initialServer { connect(initialServer) }
            initialServer = nil
            firstAppearance = false
            refreshHome()
            monitorHomeNetwork()
        }
    }

    #if DEBUG && targetEnvironment(simulator)
    private func seedHomeFixture() {
        let decoder = JSONDecoder()
        let graph = """
            {"nodes":[{"id":"note-project","title":"Planning a coding project","kind":"note"},
             {"id":"note-device","title":"Mobile development","kind":"note"},
             {"id":"note-research","title":"Research notes","kind":"note"},
             {"id":"archive-1","title":"An earlier conversation","kind":"conversation"}],
             "edges":[{"source":"note-device","target":"note-project"},{"source":"note-project","target":"note-research"}],
             "domains":[{"id":"coding","title":"Coding Projects","status":"active"},
             {"id":"research","title":"Knowledge AI","status":"active"}],
             "memberships":[{"nodeId":"note-project","domainId":"coding"},{"nodeId":"note-device","domainId":"coding"},
             {"nodeId":"note-research","domainId":"research"}]}
            """
        let planner = """
            {"revision":1,"items":[{"id":"11111111-1111-4111-8111-111111111111","title":"Review the weekly plan",
             "kind":"todo","state":"open","horizon":"near","deleted":false,"version":1}]}
            """
        let work = """
            {"byId":{"fixture-work":{"title":"Collect reading notes","running":true,"completed":false,
             "failed":false,"stopped":false,"updatedAt":1794500000000}}}
            """
        home.knowledge = try? decoder.decode(HubHomeKnowledge.self, from: Data(graph.utf8))
        home.planner = try? decoder.decode(HubHomePlanner.self, from: Data(planner.utf8))
        home.work = try? decoder.decode(HubHomeWork.self, from: Data(work.utf8))
        home.conversations = [HubConversationChoice(sessionId: "fixture-work", title: "Collect reading notes", updatedAt: 0)]
        home.connection = .connected
        if Self.voiceBarFixture {
            home.voiceCall = HubVoiceCallSummary(sessionID: "fixture-work", status: "Listening", muted: false,
                                                 hearing: "Can you show me where the reset button is")
        }
        if ProcessInfo.processInfo.arguments.contains("--hub-native-read-fixture"),
           let fixtureServer = try? HubServer(address: "https://hub-workspace-fixture.invalid") {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [HubWorkspaceFixtureProtocol.self]
            let api = HubConversationAPI(server: fixtureServer, configuration: configuration) { [] }
            if ProcessInfo.processInfo.arguments.contains("--hub-native-chat-fixture") {
                api.simulatorChatFrames = HubWorkspaceChatFixture.shared.frames
            }
            conversationAPI = api
            connected = true
        }
    }
    #endif

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
        let epoch = pageEpoch
        inspectingPageEpoch = epoch
        let expression = "!!document.body && (document.body.innerText.trim().length > 0 || !!document.body.querySelector('input,button,iframe'))"
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
            syncVoiceSummary()
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
        sheet.addAction(UIAlertAction(title: "Connection", style: .default) { [weak self] _ in self?.afterOptions { $0.showConnection() } })
        let sense = HubPhoneSense.shared
        sheet.addAction(UIAlertAction(title: sense.enabled ? "Phone context: On" : "Phone context: Off", style: .default) { [weak self] _ in
            self?.afterOptions { controller in
                sense.enabled.toggle()
                controller.showNotice(sense.enabled
                    ? "Assistants can ask for this iPhone's location, nearby places and battery while HUB is open."
                    : "Assistants no longer receive this iPhone's location or surroundings.")
            }
        })
        if server != nil {
            sheet.addAction(UIAlertAction(title: "Cloudflare access token", style: .default) { [weak self] _ in self?.afterOptions { $0.showAccessToken() } })
        }
        sheet.addAction(UIAlertAction(title: showingHome ? "Refresh HUB" : "Retry sign-in", style: .default) { [weak self] _ in
            self?.afterOptions { $0.reload() }
        })
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
        // Set before any API session exists, so every request carries it.
        HubAccessHeaders.use(try? nativeState.accessToken(), for: value)
        lastAccessRenewal = nil
        api?.invalidate()
        uiAPI?.invalidate()
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
        chatAttachmentAPI = HubAttachmentAPI(server: value, cookies: cookies)
        HubPhoneSense.shared.attach(conversationAPI)
        UserDefaults.standard.set(value.origin.absoluteString, forKey: savedOriginKey)
        home.knowledge = nil
        home.planner = nil
        home.plannerSaving = false
        home.plannerError = nil
        home.conversations = nil
        home.work = nil
        home.workUnavailable = false
        home.uncertainChat = nil
        home.sendError = nil
        if !firstAppearance { returnHome() }
    }

    private func refreshHome() {
        #if DEBUG && targetEnvironment(simulator)
        if showHomeFixture { return }
        #endif
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
                self.deliverSiriMessage()
                self.openPendingNotification()
                guard self.showingHome else { return }
                async let knowledge: Void = self.loadHomeKnowledge(conversationAPI, attempt: attempt)
                async let planner: Void = self.loadHomePlanner(conversationAPI, attempt: attempt)
                async let chats: Void = self.loadHomeChats(conversationAPI, attempt: attempt)
                async let work: Void = self.loadHomeWork(conversationAPI, attempt: attempt)
                _ = await (knowledge, planner, chats, work)
                guard !Task.isCancelled, self.showingHome, self.homeState.isCurrent(attempt) else { return }
                self.home.refreshing = false
                let elapsed = Int((ProcessInfo.processInfo.systemUptime - started) * 1000)
                if !self.home.incomplete {
                    self.launchLog.info("Native Home live data ready in \(elapsed, privacy: .public) ms")
                }
                await self.saveWebSession(server)
            } catch {
                guard let self, !Task.isCancelled, self.showingHome else { return }
                // With a saved Cloudflare token, an expired session renews
                // itself instead of showing the sign-in page.
                if Self.needsSignIn(error), await self.renewSessionWithAccessToken(server),
                   !Task.isCancelled, self.showingHome {
                    self.refreshHome()
                    return
                }
                self.homeConnectionFailed(error, attempt: attempt)
            }
        }
    }

    private static func needsSignIn(_ error: Error) -> Bool {
        (error as? HubVoiceAPIError) == .signInRequired || (error as? HubAttachmentError) == .signInRequired
    }

    /// Passes Cloudflare Access with the saved service token and lets HUB issue
    /// a fresh session cookie. At most once a minute, so a refused token never loops.
    private func renewSessionWithAccessToken(_ expected: HubServer) async -> Bool {
        guard let state = deviceState, server == expected, let token = try? state.accessToken() else { return false }
        if let last = lastAccessRenewal, Date().timeIntervalSince(last) < 60 { return false }
        lastAccessRenewal = Date()
        do {
            let cookies = try await HubAccessSession.issue(server: expected, token: token)
            guard server == expected else { return false }
            let store = WKWebsiteDataStore.default().httpCookieStore
            for cookie in cookies {
                await withCheckedContinuation { continuation in store.setCookie(cookie) { continuation.resume() } }
            }
            try? state.rememberVerifiedSession(cookies)
            return true
        } catch HubAccessSessionError.tokenRejected {
            message.text = "Cloudflare did not accept the saved access token. Check it in Options → Cloudflare access token."
            return false
        } catch {
            return false
        }
    }

    private func showAccessToken(error: String? = nil) {
        guard let server, let state = deviceState else { showConnection(); return }
        let saved = (try? state.accessToken()) != nil
        let alert = UIAlertController(
            title: "Cloudflare access token",
            message: error ?? (saved
                ? "A service token is saved. HUB connects without the Cloudflare sign-in page. Enter new values to replace it."
                : "Paste the Client ID and Client Secret of a Cloudflare Access service token. HUB will then connect without the sign-in page. They are kept in this iPhone's Keychain."),
            preferredStyle: .alert)
        alert.addTextField { field in
            field.placeholder = "Client ID (ends in .access)"
            field.autocapitalizationType = .none; field.autocorrectionType = .no
            field.accessibilityLabel = "Cloudflare Client ID"
        }
        alert.addTextField { field in
            field.placeholder = "Client Secret"
            field.isSecureTextEntry = true
            field.autocapitalizationType = .none; field.autocorrectionType = .no
            field.accessibilityLabel = "Cloudflare Client Secret"
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        if saved {
            alert.addAction(UIAlertAction(title: "Remove token", style: .destructive) { [weak self] _ in
                try? state.clearAccessToken()
                HubAccessHeaders.use(nil, for: server)
                self?.connect(server)
            })
        }
        alert.addAction(UIAlertAction(title: "Save", style: .default) { [weak self, weak alert] _ in
            let id = alert?.textFields?.first?.text ?? "", secret = alert?.textFields?.last?.text ?? ""
            guard let self else { return }
            guard let token = try? HubAccessToken(clientID: id, clientSecret: secret) else {
                DispatchQueue.main.async { self.showAccessToken(error: "That does not look like a Cloudflare service token. The Client ID ends in .access.") }
                return
            }
            do { try state.rememberAccessToken(token) } catch {
                DispatchQueue.main.async { self.showAccessToken(error: "The token could not be saved. Unlock this iPhone and try again.") }
                return
            }
            Task { @MainActor in
                HubAccessHeaders.use(token, for: server)
                self.lastAccessRenewal = nil
                do {
                    let cookies = try await HubAccessSession.issue(server: server, token: token)
                    let store = WKWebsiteDataStore.default().httpCookieStore
                    for cookie in cookies {
                        await withCheckedContinuation { continuation in store.setCookie(cookie) { continuation.resume() } }
                    }
                    try? state.rememberVerifiedSession(cookies)
                    self.connect(server)
                    self.returnHome()
                    self.showNotice("Saved. HUB now connects without the Cloudflare sign-in page.")
                } catch HubAccessSessionError.tokenRejected {
                    self.showNotice("Saved, but Cloudflare refused this token. Check that the HUB application has a Service Auth policy that includes this token.")
                } catch {
                    self.connect(server)
                    self.showNotice("Saved. HUB could not be reached just now; it will use the token when it is back.")
                }
            }
        })
        present(alert, animated: true)
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

    private func loadHomeWork(_ api: HubConversationAPI, attempt: UInt64) async {
        do {
            let value = try await api.workActivity()
            guard showingHome, !Task.isCancelled, homeState.isCurrent(attempt) else { return }
            home.work = value
            home.workUnavailable = false
        } catch {
            guard showingHome, !Task.isCancelled, homeState.isCurrent(attempt) else { return }
            home.workUnavailable = true
            if error as? HubAttachmentError == .signInRequired { homeDataFailed(error, attempt: attempt) }
        }
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
        if signIn { home.knowledge = nil; home.planner = nil; home.conversations = nil; home.work = nil }
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
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.lastAccessRenewal = nil
                    if await self.renewSessionWithAccessToken(server) { self.refreshHome() }
                    else { self.loadSignIn(server) }
                }
            }
        case .unavailable, .connected: refreshHome()
        case .connecting: break
        }
    }

    private func openHomeVoice() {
        if home.connection == .connected || voice?.isActive == true { showVoice() }
        else { performHomeConnectionAction() }
    }

    private func openChat(_ id: String) {
        guard !home.sending, let server, let destination = try? HubNotificationDestination(server: server, sessionID: id) else { return }
        if home.uncertainChat == id, connected {
            home.uncertainChat = nil
            home.sendError = nil
        }
        openNotification(destination)
    }

    /// Sends a message spoken to Siri ("Ask HUB") once HUB is connected.
    private func deliverSiriMessage() {
        guard showingHome, home.connection == .connected, !home.sending, home.uncertainChat == nil,
              let text = HubSiriInbox.shared.take() else { return }
        home.draft = text
        sendHomeDraft()
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
                self.home.openNativeChat = HubNativeChatRequest(choice: HubConversationChoice(
                    sessionId: id, title: "New chat", updatedAt: Date().timeIntervalSince1970 * 1000))
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

    private func returnHome(refresh: Bool = true) {
        showingHome = true
        applyWorkspaceAppearance(workspaceAppearance)
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
        syncVoiceSummary()
        if refresh { refreshHome() }
    }

    private func showSignIn() {
        view.endEditing(true)
        if showingHome {
            probe?.cancel()
            _ = homeState.begin(hasServer: server != nil)
        }
        showingHome = false
        overrideUserInterfaceStyle = .unspecified
        view.window?.overrideUserInterfaceStyle = .unspecified
        view.backgroundColor = .systemBackground
        navigationController?.setNeedsStatusBarAppearanceUpdate()
        homeController.view.isHidden = true
        workspaceBar.isHidden = false
        prepareWebView()
    }

    private func loadSignIn(_ server: HubServer) {
        showSignIn()
        preparePageLoad()
        var request = URLRequest(url: server.origin)
        if let token = HubAccessHeaders.token(for: server) {
            request.setValue(token.clientID, forHTTPHeaderField: "CF-Access-Client-Id")
            request.setValue(token.clientSecret, forHTTPHeaderField: "CF-Access-Client-Secret")
        }
        activeNavigation = webView.load(request)
    }

    private func reload() {
        if showingHome { refreshHome(); return }
        if let server { loadSignIn(server) }
        else { returnHome(); showConnection() }
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
            if let server = self.server { HubAccessHeaders.use(nil, for: server) }
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
    /// Mirrors the call into the chat's voice bar and, for a call just started,
    /// takes the user into its conversation as soon as the assistant listens.
    private func voiceChanged(_ model: HubNativeVoice, sheet: UIViewController?) {
        guard voice === model else { return }
        syncVoiceSummary()
        if !model.isActive {
            openChatWhenVoiceConnects = false
            openCameraWhenVoiceConnects = false
            if cameraHost != nil { closeCamera() }
        }
        guard openChatWhenVoiceConnects, model.connectedSessionID != nil,
              let destination = model.conversationDestination() else { return }
        openChatWhenVoiceConnects = false
        let camera = openCameraWhenVoiceConnects
        openCameraWhenVoiceConnects = false
        if let sheet, presentedViewController === sheet, sheet.presentedViewController == nil {
            dismiss(animated: true) { [weak self] in
                self?.openNotification(destination)
                if camera { self?.presentCamera() }
            }
        } else if presentedViewController == nil {
            openNotification(destination)
            if camera { presentCamera() }
        }
    }

    #if DEBUG && targetEnvironment(simulator)
    private static let voiceBarFixture = ProcessInfo.processInfo.arguments.contains("--hub-native-voice-bar-fixture")
    #else
    private static let voiceBarFixture = false
    #endif

    private func syncVoiceSummary() {
        guard !Self.voiceBarFixture else { return }
        let active = voice?.isActive == true
        if home.hasActiveVoice != active { home.hasActiveVoice = active }
        let summary = voice.flatMap { model in
            model.isActive ? HubVoiceCallSummary(sessionID: model.activeSessionID, status: model.status, muted: model.muted, hearing: model.hearing) : nil
        }
        if home.voiceCall != summary { home.voiceCall = summary }
        if cameraVision?.voice != summary { cameraVision?.voice = summary }
    }

    /// The live camera of the current call. Starting it with no call running
    /// starts the call first and opens the camera once HUB listens.
    private func presentCamera() {
        let context = voice?.attachmentContext()
        guard Self.voiceBarFixture || context != nil else {
            openCameraWhenVoiceConnects = true
            showVoice()
            return
        }
        guard cameraHost == nil else { return }
        let vision = HubCameraVision(context: context, fixture: Self.voiceBarFixture && context == nil)
        vision.voice = home.voiceCall
        cameraVision = vision
        let screen = HubCameraCallView(vision: vision, mute: { [weak self] in self?.voice?.toggleMute() }, endCall: { [weak self] in
            self?.closeCamera { [weak self] in self?.voice?.end() }
        }, close: { [weak self] in self?.closeCamera() })
        let host = UIHostingController(rootView: screen)
        host.modalPresentationStyle = .fullScreen
        host.overrideUserInterfaceStyle = .dark
        cameraHost = host
        var presenter: UIViewController = self
        while let next = presenter.presentedViewController, !next.isBeingDismissed { presenter = next }
        presenter.present(host, animated: true)
    }

    /// Lets HUB see this iPhone's screen during the call, from the call bar.
    private func presentScreenSharing() {
        #if canImport(ScreenCaptureKit)
        if #available(iOS 27.0, *) {
            guard let context = voice?.attachmentContext(), let screen = try? HubScreenViewController(context: context) else {
                showVoice()
                return
            }
            var presenter: UIViewController = self
            while let next = presenter.presentedViewController, !next.isBeingDismissed { presenter = next }
            presenter.present(UINavigationController(rootViewController: screen), animated: true)
        }
        #endif
    }

    private func closeCamera(then finish: (() -> Void)? = nil) {
        cameraVision?.stop()
        cameraVision = nil
        guard let host = cameraHost else { finish?(); return }
        cameraHost = nil
        host.dismiss(animated: true, completion: finish)
    }

    private func controlVoice(_ control: HubVoiceCallControl) {
        switch control {
        case .camera: presentCamera()
        case .screen: presentScreenSharing()
        case .open: showVoice()
        case .mute: voice?.toggleMute()
        case .end:
            guard let voice, voice.isActive else { return }
            let alert = UIAlertController(title: "End the voice call?", message: "The conversation stays in your chats.", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Keep talking", style: .cancel))
            alert.addAction(UIAlertAction(title: "End call", style: .destructive) { _ in voice.end() })
            present(alert, animated: true)
        }
    }

    private func presentVoice(api: HubVoiceAPI, server: HubServer, deviceState: HubDeviceState, checkpoint: HubVoiceCheckpoint?, pending: HubVoiceAdmission? = nil, resumeOnlyIfActive: Bool = false) {
        let startsNewCall = voice?.isActive != true
        let model = voice?.isActive == true ? voice! : HubNativeVoice(api: api, server: server, deviceState: deviceState, resume: checkpoint, pendingAdmission: pending, resumeOnlyIfActive: resumeOnlyIfActive)
        voice = model
        if startsNewCall { openChatWhenVoiceConnects = true }
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
        let voiceNavigation = UINavigationController(rootViewController: sheet)
        voiceNavigation.overrideUserInterfaceStyle = overrideUserInterfaceStyle
        present(voiceNavigation, animated: true) { [weak self, weak sheet, weak voiceNavigation] in
            model.changed = { [weak self, weak sheet, weak model, weak voiceNavigation] in
                sheet?.refresh()
                if let model { self?.voiceChanged(model, sheet: voiceNavigation) }
            }
            if !model.isActive { model.start() }
            self?.voiceChanged(model, sheet: voiceNavigation)
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
            }, openDraft: { [weak self] draft in
                guard let self, self.connected, self.connectionGeneration == generation,
                      draft.origin == server.origin.absoluteString else { return }
                self.openChat(draft.sessionID)
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
        if navigationAction.targetFrame == nil { decisionHandler(.cancel); preparePageLoad(); activeNavigation = webView.load(navigationAction.request); return }
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
                self.connected = true
                if !self.showingPageLoad { self.showContent() }
                self.message.text = "Connected · \(expected.origin.host ?? "HUB")"
                await self.saveWebSession(expected)
                guard !Task.isCancelled, generation == self.connectionGeneration else { return }
                self.returnHome()
            } catch {
                guard let self, !Task.isCancelled, generation == self.connectionGeneration else { return }
                self.connected = false
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
        }
    }
    private func openPendingNotification() {
        guard connected, let server, let destination = notificationDestination else { return }
        notificationDestination = nil
        guard destination.server == server else {
            message.text = "This notification belongs to a different HUB. Your connection was not changed."
            return
        }
        if !showingHome { returnHome(refresh: false) }
        let choice = home.conversations?.first(where: { $0.sessionId == destination.sessionID })
            ?? HubConversationChoice(sessionId: destination.sessionID, title: "Conversation", updatedAt: 0)
        home.openNativeChat = HubNativeChatRequest(choice: choice)
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
        showRecovery("Sign-in was interrupted. Tap Retry to continue.")
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

#if DEBUG && targetEnvironment(simulator)
private final class HubWorkspaceFixtureProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        if request.url?.path == "/api/session/cancel", request.httpMethod == "POST" {
            respondToCancellation()
            return
        }
        if request.url?.path == "/api/hub/artifacts", request.httpMethod == "GET",
           request.value(forHTTPHeaderField: "x-hub-session") == "fixture-work",
           request.value(forHTTPHeaderField: "x-hub-daily-use") == "1",
           ProcessInfo.processInfo.arguments.contains("--hub-native-chat-fixture") {
            let id = String(repeating: "c", count: 64)
            if request.value(forHTTPHeaderField: "x-hub-artifact-format") == "file" {
                let fileID = String(repeating: "d", count: 64)
                let bytes = Data("Fixture meeting notes".utf8)
                let metadata: [String: Any] = ["id": fileID, "name": "meeting-notes.txt", "bytes": bytes.count,
                                               "sha256": HubAttachmentStore.digest(bytes)]
                if request.value(forHTTPHeaderField: "x-hub-artifact") == fileID {
                    var file = metadata
                    file["data"] = bytes.base64EncodedString()
                    respond(with: try? JSONSerialization.data(withJSONObject: file))
                } else {
                    respond(with: try? JSONSerialization.data(withJSONObject: ["files": [metadata]]))
                }
            } else if request.value(forHTTPHeaderField: "x-hub-screenshot") == id {
                let image = "iVBORw0KGgoAAAANSUhEUgAAAGAAAAAZCAIAAABB17xmAAAASElEQVR4nO3QMQ0AMAwEseAJj3Iq/DDIVvUHSwfg5OpztVTfD8IDBAgQIEDBAQIECBCg4AABAgQIUHCAAAECBCg4QIAA9UugARgldhmWerIvAAAAAElFTkSuQmCC"
                respond(with: Data(base64Encoded: image), mediaType: "image/png")
            } else {
                respond(with: Data("{\"screenshots\":[{\"id\":\"\(id)\",\"name\":\"Fixture screenshot.png\",\"turn\":1}]}".utf8))
            }
            return
        }
        respond(with: request.url.flatMap(responseData))
    }

    private func respond(with data: Data?, mediaType: String = "application/json") {
        guard let url = request.url, url.host == "hub-workspace-fixture.invalid",
              request.value(forHTTPHeaderField: "Cookie") == nil, let data,
              let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                             headerFields: ["Content-Type": mediaType]) else {
            client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    private func respondToCancellation() {
        guard request.url?.host == "hub-workspace-fixture.invalid",
              request.value(forHTTPHeaderField: "Cookie") == nil,
              ProcessInfo.processInfo.arguments.contains("--hub-native-chat-fixture"),
              let envelope = rpcEnvelope("session/cancel"), let id = envelope["rpcId"] as? String,
              let payload = envelope["payload"] as? [String: Any], let args = payload["args"] as? [String: Any],
              let command = args["request"] as? [String: String], command == ["sessionId": "fixture-work"] else {
            respond(with: nil)
            return
        }
        respond(with: rpcResult(id, value: ["accepted": true]))
        Task {
            try? await Task.sleep(nanoseconds: 900_000_000)
            await HubWorkspaceChatFixture.shared.stop()
        }
    }

    private func responseData(_ url: URL) -> Data? {
        if request.httpMethod == "GET", url.path == "/minke/api/usage" {
            return Data(#"""
            {"updatedAt":"2026-11-14T17:45:00.000Z",
             "codex":{"state":"ready","rateLimits":[{"id":"codex","windows":[{"remainingPercent":42,"windowSeconds":18000}]}]},
             "openRouter":{"state":"ready","usageDaily":1.25,"limit":{"amount":9,"remaining":6,"reset":"weekly"},
                           "account":{"totalCredits":20,"totalUsage":4}},
             "unlid":{"state":"not-configured"},
             "soniox":{"state":"not-configured"},
             "claudeCode":{"state":"ready","observedAt":"2026-11-14T17:40:00.000Z","windows":[
                {"id":"five_hour","usedPercent":34,"resetsAt":1795010400,"status":"allowed"},
                {"id":"seven_day","usedPercent":86,"resetsAt":1795154400,"status":"allowed_warning"}]}}
            """#.utf8)
        }
        if request.httpMethod == "GET", url.path == "/api/hub/projects" {
            return Data(#"""
            {"revision":2,"projects":[
                {"id":"7d3c4d0e-0d55-4e43-9d1e-5a0c4c1f2b11","name":"Thesis","folder":"C:\\Users\\Fixture\\Documents\\HUB Projects\\Thesis",
                 "instructions":"Answer formally.","sessionIds":["fixture-project-chat"],"note":"# Thesis\n\nDraft due 1 March.",
                 "createdAt":0,"updatedAt":0}]}
            """#.utf8)
        }
        if request.httpMethod == "GET", url.path == "/api/hub/voice/profiles" {
            return Data(#"""
            {"revision":3,"selectedId":"216cb7b2-8e8f-48d5-86f9-cf92a29aca14","profiles":[
                {"id":"216cb7b2-8e8f-48d5-86f9-cf92a29aca14","name":"Fixture Vera","instructions":"Use short replies.",
                 "route":{"provider":"fixture","model":"fixture-model"},
                 "speech":{"stt":{"engine":"whisper","model":"base"},"tts":{"engine":"supertonic","model":"supertonic-3","voice":"F5"}},
                 "tools":{"mode":"allow","names":["hub_view_screen"]}}]}
            """#.utf8)
        }
        if request.httpMethod == "GET", url.path == "/api/hub/voice/catalog" {
            if url.query == "provider=fixture" {
                return Data(#"{"models":[{"id":"fixture-model","provider":"fixture","name":"Fixture Voice Model","efforts":[]}]}"#.utf8)
            }
            if url.query == nil {
                return Data(#"{"providers":[{"id":"fixture","name":"Fixture Provider"}],"tools":[{"name":"hub_view_screen","description":"Read one consented frame"}],"speech":{"stt":[],"tts":[]}}"#.utf8)
            }
        }
        if request.httpMethod == "GET", url.path == "/api/hub/characters", url.query == nil,
           request.value(forHTTPHeaderField: "x-hub-characters") == "1" {
            return Data(#"""
            {"revision":7,"mainId":"11111111-1111-4111-8111-111111111111","voiceId":"22222222-2222-4222-8222-222222222222",
             "characters":[
                {"id":"11111111-1111-4111-8111-111111111111","name":"Fixture Mira","avatar":"mint",
                 "description":"Plans the day and keeps work moving","instructions":"Be concise.",
                 "route":{"provider":"fixture","model":"fixture-model"},"tools":{"mode":"inherit"}},
                {"id":"22222222-2222-4222-8222-222222222222","name":"Fixture Vera","avatar":"mint",
                 "description":"Voice companion","instructions":"Use short replies.",
                 "tools":{"mode":"allow","names":["hub_view_screen"]},"delegateTo":"11111111-1111-4111-8111-111111111111"}],
             "tools":[{"name":"hub_view_screen","description":"Read one consented frame"}]}
            """#.utf8)
        }
        if request.httpMethod == "GET", url.path.hasPrefix("/api/hub/presentation"),
           request.value(forHTTPHeaderField: "x-hub-session") == "fixture-work",
           ProcessInfo.processInfo.arguments.contains("--hub-native-canvas-fixture") {
            let id = "5b1c2a9e-7d3f-4c1a-9e2b-0f6d8a4c3e21"
            if url.path == "/api/hub/presentation" {
                return Data("{\"presentation\":{\"id\":\"\(id)\",\"title\":\"Pendulum simulator\",\"kind\":\"app\",\"createdAt\":1763359200000}}".utf8)
            }
            guard request.value(forHTTPHeaderField: "x-hub-presentation") == id else { return nil }
            // A small interactive app like the one HUB made in the voice chat.
            let html = #"""
            <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
            body{margin:0;background:#0b101b;color:#bfcbff;font:14px -apple-system,sans-serif}
            canvas{display:block;width:100%;height:170px}label{display:block;padding:4px 12px}</style></head><body>
            <canvas id="c" width="600" height="340"></canvas>
            <label>Length <input id="l" type="range" min="80" max="300" value="220"></label>
            <script>
            const c=document.getElementById('c'),x=c.getContext('2d'),l=document.getElementById('l');
            let a=1.1,v=0;function step(){const L=+l.value;v+=-9.8/L*Math.sin(a)*0.6;v*=0.999;a+=v;
            x.clearRect(0,0,600,340);const px=300+L*Math.sin(a),py=20+L*Math.cos(a);
            x.strokeStyle='#a8b3cc';x.lineWidth=3;x.beginPath();x.moveTo(300,20);x.lineTo(px,py);x.stroke();
            x.fillStyle='#bfcbff';x.beginPath();x.arc(px,py,18,0,7);x.fill();requestAnimationFrame(step)}step();
            </script></body></html>
            """#
            return try? JSONSerialization.data(withJSONObject: ["document": html])
        }
        if request.httpMethod == "GET", url.path == "/api/hub/goals",
           request.value(forHTTPHeaderField: "x-hub-goals") == "1" {
            return Data(#"""
            {"characters":[],"goals":[
                {"id":"hub-goal-fixture","title":"Plan the autumn release","state":"active","status":"working",
                 "updatedAt":1763359200000,"objective":"Ship the release notes and the checklist.","revision":2,
                 "plan":[{"id":"m1","title":"Collect changes","status":"done"},
                         {"id":"m2","title":"Draft release notes","status":"working"},
                         {"id":"m3","title":"Review with the team","status":"pending"}],
                 "checkpoint":{"summary":"Changes from the last three weeks are collected.","nextAction":"Draft the release notes."}}]}
            """#.utf8)
        }
        if request.httpMethod == "GET", url.path == "/api/hub/schedule",
           request.value(forHTTPHeaderField: "x-hub-schedule") == "1" {
            return Data(#"""
            {"revision":4,"heartbeat":{"enabled":true,"everyMinutes":60,"start":"08:00","end":"23:00","timezone":"Europe/Istanbul",
              "checklist":"Anything due today in my planner I have not done\nReplies I am waiting for in mail","nextAt":1763445600000,
              "last":{"at":1763442000000,"status":"completed","text":"Nothing needed your attention."}},
             "jobs":[
              {"id":"job-reminder","name":"Test screen sharing","kind":"reminder","text":"Start a call and share your screen with HUB.",
               "when":{"kind":"once","at":1763449200000},"enabled":true,"state":"active","status":"scheduled","nextAt":1763449200000},
              {"id":"job-task","name":"Weekday news brief","kind":"task","text":"Find the three most important tech headlines and summarize them.",
               "when":{"kind":"daily","hour":8,"minute":30,"days":[1,2,3,4,5],"timezone":"Europe/Istanbul"},"enabled":true,"state":"active",
               "status":"scheduled","nextAt":1763530200000,"last":{"at":1763443800000,"status":"completed","text":"Sent three headlines."}}]}
            """#.utf8)
        }
        if request.httpMethod == "GET", url.path == "/api/hub/automations",
           request.value(forHTTPHeaderField: "x-hub-automations") == "1" {
            return Data(#"""
            {"revision":1,"automations":[
                {"id":"routine-fixture","title":"Morning brief","state":"active","status":"scheduled",
                 "updatedAt":1763359200000,"nextAt":1763445600000,"prompt":"Summarize today's agenda and open to-dos."}]}
            """#.utf8)
        }
        if request.httpMethod == "GET", url.path == "/api/hub/character-request",
           url.query == "characterId=11111111-1111-4111-8111-111111111111" {
            return Data(#"""
            {"record":{"characterId":"11111111-1111-4111-8111-111111111111","sessionId":"fixture-work","at":1763359200000,"bytes":118,
                       "json":"{\n  \"model\": \"fixture-model\",\n  \"system\": \"Be concise.\",\n  \"messages\": [\n    {\"role\": \"user\", \"content\": \"Fixture request\"}\n  ]\n}"},
             "boundary":"Complete HUB request at LLM dispatch, before provider-adapter translation.",
             "retention":"Latest conversational request per character since this host started; kept in memory only."}
            """#.utf8)
        }
        if url.path == "/api/settings/describe", request.httpMethod == "POST" {
            return settingsDescription()
        }
        if url.path == "/api/hub/skills", request.httpMethod == "GET",
           request.value(forHTTPHeaderField: "x-hub-skills") == "1" {
            let skill = #"""
            {"id":"fixture-skill","name":"weekly-review","title":"Weekly review","description":"Review progress",
             "requiredTools":["read"],"hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
             "content":"Gather the latest updates."}
            """#
            if url.query == "name=weekly-review" { return Data("{\"skill\":\(skill)}".utf8) }
            if url.query == nil { return Data("{\"skills\":[\(skill)],\"issues\":[]}".utf8) }
            return nil
        }
        guard url.path == "/api/hub/memory", request.httpMethod == "GET",
              request.value(forHTTPHeaderField: "x-hub-memory") == "1" else { return nil }
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let view = query.first { $0.name == "view" }?.value
        let id = query.first { $0.name == "id" }?.value
        switch (view, id) {
        case ("search", nil):
            let term = query.first { $0.name == "q" }?.value
            if term?.localizedCaseInsensitiveContains("choosing the tools") == true {
                return Data(#"{"nodes":[{"id":"note-project","title":"Planning a coding project","kind":"note"}]}"#.utf8)
            }
            return Data(#"{"nodes":[]}"#.utf8)
        case ("note", "note-project"):
            return Data(#"""
            {"id":"note-project","title":"Planning a coding project","kind":"note",
             "content":"## First release\n\nSketch the first release before choosing the tools.\n\n```swift\nlet firstRelease = true\n```",
             "sources":[{"id":"fixture-source","completedAt":1794500000000,"channel":"import","reason":"Planning evidence",
                         "evidence":{"quote":"The release plan starts with a sketch."}}]}
            """#.utf8)
        case ("source", "fixture-source"):
            return Data(#"{"id":"fixture-source","content":"The release plan starts with a sketch."}"#.utf8)
        case ("activity", nil):
            return Data(#"""
            {"state":"ready","enabled":true,"total":1,"lastStartedAt":1794499999000,"lastFinishedAt":1794500000000,
             "entries":[{"id":"fixture-pass","status":"review","updatedAt":1794500000000,"startedAt":1794499999000,
                         "finishedAt":1794500000000,"attempts":1,"changes":[],"warnings":[],
                         "source":{"channel":"pwa","recordId":"note-project"}}],"historyNotice":"No recent activity"}
            """#.utf8)
        case ("review", "fixture-pass"):
            return Data(#"""
            {"source":{"content":"Sketch the first release before choosing the tools."},"stale":false,
             "reviewHash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
             "plan":{"decision":"organize","reason":"Keep a sourced record","tags":["planning"],
                     "memories":[{"title":"First release planning","category":"projects","evidence":"Sketch the first release"}]}}
            """#.utf8)
        default:
            return nil
        }
    }

    private func settingsDescription() -> Data? {
        guard let envelope = rpcEnvelope("settings/describe"), let rpcID = envelope["rpcId"] as? String else { return nil }
        let namespaces: [[String: Any]] = [
            ["ns": "ui-theme", "revision": 1, "value": ["fontSize": 16, "preference": "dark"]],
            ["ns": "ui-conversation", "revision": 1, "value": ["busyEnter": "steer"]],
            ["ns": "ui-chat", "revision": 1, "value": ["transcriptView": "compact"]],
            ["ns": "locale", "revision": 1, "value": ["preference": "en"]],
        ]
        return rpcResult(rpcID, value: ["writable": true, "namespaces": namespaces])
    }

    private func rpcEnvelope(_ method: String) -> [String: Any]? {
        let body: Data
        if let bytes = request.httpBody {
            body = bytes
        } else if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4_096)
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0, count < buffer.count else { return nil }
            body = Data(buffer.prefix(count))
        } else {
            return nil
        }
        guard let envelope = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
              envelope["type"] as? String == "client-request", envelope["method"] as? String == method else { return nil }
        return envelope
    }

    private func rpcResult(_ id: String, value: [String: Any]) -> Data? {
        return try? JSONSerialization.data(withJSONObject: [
            "type": "server-response", "rpcId": id,
            "result": ["ok": true, "value": value],
        ])
    }
}

private actor HubWorkspaceChatFixture {
    static let shared = HubWorkspaceChatFixture()
    private typealias Stream = AsyncThrowingStream<Data, Error>
    private var observers: [UUID: Stream.Continuation] = [:]
    private var stopped = false
    private let end = #"{"type":"turn/end","seq":4,"data":{"reason":{"kind":"aborted","reason":{"kind":"user"}}}}"#

    nonisolated func frames(_ session: String) -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { continuation in
            guard session == "fixture-work" else {
                continuation.finish(throwing: URLError(.resourceUnavailable))
                return
            }
            let id = UUID()
            let registration = Task { await self.register(id, continuation: continuation) }
            continuation.onTermination = { _ in
                registration.cancel()
                Task { await self.remove(id) }
            }
        }
    }

    private func register(_ id: UUID, continuation: Stream.Continuation) {
        guard !Task.isCancelled else { return }
        let initial = #"""
        {"type":"snapshot","records":[
         {"event":{"type":"user/message","seq":1,"data":{"source":{"kind":"user"},"content":[{"type":"text","text":"Fixture request"}]}}},
         {"event":{"type":"turn/start","seq":2,"data":{}}},
         {"event":{"type":"assistant/chunk","seq":3,"data":{"chunk":{"type":"text-delta","index":0,"text":"Collecting fixture references…"}}}}
        ]}
        """#
        if case .terminated = continuation.yield(Data(initial.utf8)) { return }
        if stopped { continuation.yield(Data("{\"type\":\"event\",\"event\":\(end)}".utf8)) }
        observers[id] = continuation
    }

    private func remove(_ id: UUID) { observers.removeValue(forKey: id) }

    func stop() {
        guard !stopped else { return }
        stopped = true
        let update = Data("{\"type\":\"event\",\"event\":\(end)}".utf8)
        for observer in observers.values { observer.yield(update) }
    }
}
#endif
