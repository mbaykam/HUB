import CoreGraphics
import XCTest

final class HubWorkspaceUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    @MainActor
    func testNativeHomeDrawersPlannerAndKeyboard() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--hub-native-home-fixture", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()

        XCTAssertTrue(app.staticTexts["Knowledge"].waitForExistence(timeout: 20))
        XCTAssertEqual(app.webViews.count, 0)
        let add = app.buttons["More actions"]
        let voice = app.buttons["Speak"]
        let send = app.buttons["hub.home.send"]
        let dictate = app.buttons["hub.home.dictate"]
        XCTAssertTrue(add.exists && dictate.exists && voice.exists && send.exists)
        XCTAssertEqual(dictate.label, "Type with your voice")
        XCTAssertLessThanOrEqual(add.frame.maxX, dictate.frame.minX)
        XCTAssertLessThanOrEqual(dictate.frame.maxX, voice.frame.minX)
        XCTAssertLessThanOrEqual(voice.frame.maxX, send.frame.minX)
        capture("Home")
        // Home keeps Knowledge compact: no graph controls, just the domain strip.
        XCTAssertFalse(app.buttons["Zoom in"].exists)
        add.tap()
        XCTAssertTrue(app.buttons["Choose character"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Research…"].exists)
        XCTAssertTrue(app.buttons["Files"].exists)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
        let menuClosed = { XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.buttons["Choose character"]) }
        if XCTWaiter.wait(for: [menuClosed()], timeout: 4) != .completed {
            capture("Menu still open")
            if add.isHittable { add.tap() }
        }
        XCTAssertEqual(XCTWaiter.wait(for: [menuClosed()], timeout: 5), .completed)

        app.buttons["Chat history"].tap()
        XCTAssertTrue(app.buttons["hub.history.fixture-work"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["New chat"].exists)
        XCTAssertFalse(app.images["star"].exists)
        capture("Chat history")
        app.buttons["Close panel"].tap()
        app.buttons["Workspace tools"].tap()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 5))
        capture("Workspace tools")
        app.buttons["Close panel"].tap()

        let todos = app.buttons["hub.planner.todos"]
        if !todos.isHittable { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(todos.waitForExistence(timeout: 7))
        let todo = app.buttons["hub.planner.todo.11111111-1111-4111-8111-111111111111"]
        XCTAssertTrue(todo.waitForExistence(timeout: 5))
        app.buttons["hub.planner.agenda"].tap()
        XCTAssertTrue(app.staticTexts["No plans for this day."].waitForExistence(timeout: 5))
        todos.tap()
        XCTAssertTrue(todo.waitForExistence(timeout: 5))

        let composer = app.descendants(matching: .any)["hub.home.draft"].firstMatch
        composer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Hide keyboard"].exists, "Home puts the keyboard away by scrolling, not a button")
        composer.typeText("Fixture draft")
        XCTAssertEqual(composer.value as? String, "Fixture draft")
        capture("Composer keyboard")
        // Scrolling the page (here, a drag on a visible card) puts the keyboard away.
        // Drag inside the visible part of the page, above the keyboard and composer.
        func dragPage(from start: CGFloat, to end: CGFloat) {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: start))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: end)))
        }
        dragPage(from: 0.32, to: 0.18)
        let keyboard = app.keyboards.firstMatch
        let gone = { XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: keyboard) }
        if XCTWaiter.wait(for: [gone()], timeout: 5) != .completed {
            capture("Keyboard after scroll")
            dragPage(from: 0.18, to: 0.36)
        }
        XCTAssertEqual(XCTWaiter.wait(for: [gone()], timeout: 5), .completed)
        XCTAssertEqual(composer.value as? String, "Fixture draft")
    }

    @MainActor
    func testNativeKnowledgeShowsNoteSourceAndCurationEvidence() {
        let app = readFixtureApp()
        let explore = app.buttons["Explore knowledge"]
        XCTAssertTrue(explore.waitForExistence(timeout: 20))
        explore.tap()

        let graph = app.buttons["Graph view"]
        XCTAssertTrue(graph.waitForExistence(timeout: 5))
        XCTAssertEqual(graph.value as? String, "Brain")
        sleep(2)
        capture("Knowledge brain")
        graph.tap()
        let flat = app.buttons["2D"]
        XCTAssertTrue(flat.waitForExistence(timeout: 5))
        flat.tap()
        XCTAssertEqual(graph.value as? String, "2D")
        capture("Knowledge graph")
        // The graph's zoom buttons change the zoom.
        let zoomIn = app.buttons["Zoom in"].firstMatch
        XCTAssertTrue(zoomIn.waitForExistence(timeout: 5))
        XCTAssertEqual(zoomIn.value as? String, "100%")
        zoomIn.tap()
        XCTAssertEqual(zoomIn.value as? String, "125%")
        app.buttons["Fit graph"].firstMatch.tap()
        XCTAssertEqual(zoomIn.value as? String, "100%")
        let search = app.textFields["Find records"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("choosing the tools")
        let record = app.buttons["hub.knowledge.record.note-project"]
        if !record.isHittable { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(record.waitForExistence(timeout: 5))
        record.tap()
        let source = app.staticTexts["Sketch the first release before choosing the tools."]
        XCTAssertTrue(source.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["First release"].exists)
        XCTAssertTrue(app.buttons["Copy code"].exists)
        XCTAssertTrue(app.buttons["Connections and sources"].exists)
        XCTAssertEqual(app.webViews.count, 0)
        let sources = app.buttons["Sources"]
        if !sources.isHittable { app.scrollViews.firstMatch.swipeUp() }
        sources.tap()
        XCTAssertTrue(app.staticTexts["Planning evidence"].waitForExistence(timeout: 5))
        app.buttons["Import"].tap()
        XCTAssertTrue(app.navigationBars["Original source"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["The release plan starts with a sketch."].waitForExistence(timeout: 5))
        app.navigationBars["Original source"].buttons["Done"].tap()
        if !app.buttons["Local graph"].isHittable { app.scrollViews.firstMatch.swipeDown() }
        app.buttons["Local graph"].tap()
        let allKnowledge = app.buttons["hub.knowledge.leave-local-graph"]
        XCTAssertTrue(allKnowledge.waitForExistence(timeout: 5))
        capture("Knowledge local graph")
        allKnowledge.tap()
        app.buttons["Done"].tap()

        app.buttons["Workspace tools"].tap()
        app.buttons["Activity"].tap()
        let review = app.buttons["Review proposed changes"]
        XCTAssertTrue(review.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Read source record"].exists)
        capture("Knowledge AI activity")
        let details = app.buttons["Details"].firstMatch
        details.tap()
        XCTAssertTrue(app.staticTexts["1 model attempts"].waitForExistence(timeout: 3))
        details.tap()
        review.tap()
        let memories = app.buttons["Memories"]
        XCTAssertTrue(memories.waitForExistence(timeout: 5))
        memories.tap()
        XCTAssertTrue(app.staticTexts["First release planning"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Sketch the first release"].exists)
        XCTAssertEqual(app.webViews.count, 0)
        capture("Knowledge review")
    }

    @MainActor
    func testNativeGeneralSettingsDisplaySharedHUBPreferences() {
        let app = readFixtureApp()
        let tools = app.buttons["Workspace tools"]
        XCTAssertTrue(tools.waitForExistence(timeout: 20))
        tools.tap()
        // The drawer slides in; tapping Settings mid-animation can miss it, so
        // wait until it is hittable and retry once if the sheet did not open.
        let settings = app.buttons["Settings"].firstMatch
        let general = app.descendants(matching: .any)["hub.settings.general"].firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 8))
        if !waitUntilHittable(settings, timeout: 8) {
            // Diagnostics for a panel button that exists but reports not hittable.
            capture("Settings not hittable")
            print("HUB-DIAG settings frame=\(settings.frame) window=\(app.windows.firstMatch.frame) hittable=\(settings.isHittable)")
            settings.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        } else {
            settings.tap()
        }
        if !general.waitForExistence(timeout: 8), waitUntilHittable(settings, timeout: 3) {
            settings.tap()
        }
        XCTAssertTrue(general.waitForExistence(timeout: 8))
        general.tap()

        XCTAssertTrue(app.staticTexts["Appearance"].waitForExistence(timeout: 5))
        for value in ["Dark", "English", "Conversation text size · 16", "Steer current turn", "Compact"] {
            let preference = app.descendants(matching: .any)
                .matching(NSPredicate(format: "label CONTAINS %@ OR value == %@", value, value)).firstMatch
            if !preference.exists { app.swipeUp() }
            XCTAssertTrue(preference.exists, "Missing preference \(value)")
        }
        XCTAssertEqual(app.webViews.count, 0)
        capture("General settings")

        app.navigationBars["General"].buttons["Settings"].tap()
        let personalities = app.descendants(matching: .any)["hub.settings.voice-personalities"].firstMatch
        if !personalities.isHittable { app.swipeUp() }
        XCTAssertTrue(personalities.waitForExistence(timeout: 5))
        personalities.tap()
        let menu = app.buttons["Options for Fixture Vera"]
        XCTAssertTrue(menu.waitForExistence(timeout: 5))
        menu.tap()
        let edit = app.buttons["Edit"].firstMatch
        XCTAssertTrue(edit.waitForExistence(timeout: 5))
        edit.tap()
        let name = app.textFields["Name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        XCTAssertEqual(name.value as? String, "Fixture Vera")
        let model = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@ OR value == %@", "Fixture Voice Model", "Fixture Voice Model")).firstMatch
        XCTAssertTrue(model.waitForExistence(timeout: 5))
        XCTAssertEqual(app.webViews.count, 0)
        capture("Voice personality")

        app.navigationBars["Edit personality"].buttons["Cancel"].tap()
        app.navigationBars["Voice personalities"].buttons["Settings"].tap()
        let usage = app.descendants(matching: .any)["hub.settings.usage"].firstMatch
        if !usage.isHittable { app.swipeUp() }
        XCTAssertTrue(usage.waitForExistence(timeout: 5))
        usage.tap()
        let claude = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", "86% used", "86% used")).firstMatch
        XCTAssertTrue(claude.waitForExistence(timeout: 5), "Claude Code limits are shown")
        capture("Claude Code limits")
        let remaining = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", "42%", "42%")).firstMatch
        XCTAssertTrue(remaining.waitForExistence(timeout: 5))
        let updated = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Updated ")).firstMatch
        XCTAssertTrue(updated.exists)
        let credit = app.staticTexts["Account credits"].firstMatch
        if !credit.isHittable { app.swipeUp() }
        XCTAssertTrue(credit.exists)
        XCTAssertEqual(app.webViews.count, 0)
        capture("Usage limits")
    }

    @MainActor
    func testProjectsSitAtTheTopOfTheHistoryPanelWithoutFolderPicking() {
        let app = readFixtureApp(extraArguments: [])
        let history = app.buttons["Chat history"]
        XCTAssertTrue(history.waitForExistence(timeout: 20))
        history.tap()
        let project = app.buttons["hub.project.7d3c4d0e-0d55-4e43-9d1e-5a0c4c1f2b11"]
        XCTAssertTrue(project.waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["hub.projects.new"].exists)
        XCTAssertFalse(app.buttons["New workspace"].exists)
        // Projects come before the dated history.
        let chat = app.buttons["hub.history.fixture-work"]
        XCTAssertTrue(chat.waitForExistence(timeout: 5))
        XCTAssertLessThan(project.frame.minY, chat.frame.minY)
        project.tap()
        XCTAssertTrue(app.buttons["hub.history.fixture-project-chat"].waitForExistence(timeout: 5))
        capture("Projects")
        app.buttons["Options for Thesis"].tap()
        app.buttons["Instructions and note"].tap()
        XCTAssertTrue(app.textViews["hub.project.note"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Folder on your PC"].exists)
        capture("Project instructions and note")
        app.buttons["Cancel"].tap()
        app.buttons["hub.projects.toggle"].tap()
        XCTAssertFalse(project.waitForExistence(timeout: 1))
    }

    @MainActor
    func testNativeChatStopWaitsForTheTurnToEndAndKeepsTheDraft() {
        let app = readFixtureApp(extraArguments: ["--hub-native-chat-fixture"])
        let history = app.buttons["Chat history"]
        XCTAssertTrue(history.waitForExistence(timeout: 20))
        history.tap()
        let conversation = app.buttons["hub.history.fixture-work"]
        XCTAssertTrue(conversation.waitForExistence(timeout: 5))
        conversation.tap()
        XCTAssertTrue(app.staticTexts["Collecting fixture references…"].waitForExistence(timeout: 6))
        XCTAssertTrue(app.images["Fixture screenshot.png"].waitForExistence(timeout: 6))
        XCTAssertTrue(app.buttons["Save screenshot to Files"].exists)

        let more = app.buttons["hub.chat.more"], voice = app.buttons["hub.chat.voice"], stop = app.buttons["hub.chat.stop"]
        let dictate = app.buttons["hub.chat.dictate"]
        XCTAssertTrue(more.exists && dictate.exists && voice.exists && stop.exists)
        XCTAssertLessThanOrEqual(more.frame.maxX, dictate.frame.minX)
        XCTAssertLessThanOrEqual(dictate.frame.maxX, voice.frame.minX)
        XCTAssertLessThanOrEqual(voice.frame.maxX, stop.frame.minX)
        capture("Conversation before Stop")
        let draft = app.descendants(matching: .any)["hub.chat.draft"].firstMatch
        draft.tap()
        draft.typeText("Keep this draft")
        let dismissKeyboard = app.buttons["Hide keyboard"]
        XCTAssertTrue(dismissKeyboard.exists)
        stop.tap()
        XCTAssertTrue(app.staticTexts["Turn stopped"].waitForExistence(timeout: 8))
        XCTAssertFalse(stop.exists)
        XCTAssertFalse(dismissKeyboard.exists)
        XCTAssertFalse(app.staticTexts["Collecting fixture references…"].exists)
        XCTAssertEqual(draft.value as? String, "Keep this draft")
        XCTAssertTrue(app.buttons["hub.chat.send"].isEnabled)
        XCTAssertEqual(app.webViews.count, 0)
        capture("Conversation after Stop")
        // The trajectory is one button in the header, not a second tab.
        XCTAssertFalse(app.segmentedControls.firstMatch.exists, "No Chat/Trajectory tab bar")
        app.buttons["hub.chat.trajectory"].tap()
        XCTAssertTrue(app.buttons["Back to chat"].waitForExistence(timeout: 3))
        sleep(1)
        capture("Trajectory")
        app.buttons["Back to chat"].tap()

        more.tap()
        app.buttons["Conversation outputs"].tap()
        let file = app.buttons["hub.chat.output.\(String(repeating: "d", count: 64))"]
        XCTAssertTrue(file.waitForExistence(timeout: 5))
        file.tap()
        XCTAssertTrue(app.staticTexts["Fixture meeting notes"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Save to Files"].exists)
        XCTAssertTrue(app.buttons["Share output"].exists)
        XCTAssertEqual(app.webViews.count, 0)
        capture("Conversation file output")
    }

    @MainActor
    func testNativeKnowledgeSkillsFindsExistingWorkflows() {
        let app = readFixtureApp()
        let explore = app.buttons["Explore knowledge"]
        XCTAssertTrue(explore.waitForExistence(timeout: 20))
        explore.tap()
        app.buttons["Manage Knowledge"].tap()
        app.buttons["Skills"].tap()
        let search = app.textFields["Find a skill"]
        XCTAssertTrue(search.waitForExistence(timeout: 8))
        search.tap()
        search.typeText("Weekly")
        let skill = app.buttons["hub.knowledge.skill.weekly-review"]
        XCTAssertTrue(skill.waitForExistence(timeout: 5))
        skill.tap()
        XCTAssertTrue(app.navigationBars["Edit skill"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.textViews["Workflow instructions"].value as? String, "Gather the latest updates.")
        XCTAssertFalse(app.textFields["Stable skill name"].isEnabled)
        XCTAssertFalse(app.buttons["Save"].isEnabled)
        XCTAssertEqual(app.webViews.count, 0)
        capture("Knowledge Skills")
    }

    /// A visual the model made with hub_present opens as a canvas in the chat
    /// and runs its own script.
    @MainActor
    func testChatShowsAnInteractiveVisualFromTheModel() {
        let app = readFixtureApp(extraArguments: ["--hub-native-chat-fixture", "--hub-native-canvas-fixture", "--hub-native-voice-bar-fixture"])
        let history = app.buttons["Chat history"]
        XCTAssertTrue(history.waitForExistence(timeout: 20))
        history.tap()
        let conversation = app.buttons["hub.history.fixture-work"]
        XCTAssertTrue(conversation.waitForExistence(timeout: 5))
        conversation.tap()
        let title = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "Pendulum simulator")).firstMatch
        let found = title.waitForExistence(timeout: 15)
        capture("Chat canvas state")
        if !found, app.buttons["Open canvas"].exists { app.buttons["Open canvas"].tap() }
        XCTAssertTrue(found || title.waitForExistence(timeout: 5), "Canvas title")
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.sliders.firstMatch.waitForExistence(timeout: 10), "The visual's own controls are shown")
        sleep(1)
        capture("Chat canvas")
        app.buttons["Expand canvas"].tap()
        sleep(1)
        capture("Chat canvas expanded")
        // Closing the visual leaves a card in the chat that opens it again.
        app.buttons["Hide canvas"].tap()
        let reopen = app.buttons["hub.chat.visual.reopen"]
        if !reopen.waitForExistence(timeout: 3) { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(reopen.waitForExistence(timeout: 5))
        capture("Chat canvas closed")
        reopen.tap()
        XCTAssertTrue(app.buttons["Hide canvas"].waitForExistence(timeout: 5))
        // A running voice call sits at the bottom within thumb reach, with the
        // user's words live and the only camera button.
        let bar = app.buttons["hub.voice.bar"]
        XCTAssertTrue(bar.exists)
        XCTAssertTrue(app.buttons["End voice call"].exists)
        XCTAssertGreaterThan(bar.frame.midY, app.windows.firstMatch.frame.height * 0.6, "The call bar is at the bottom")
        XCTAssertTrue(app.descendants(matching: .any)["hub.voice.hearing"].exists, "What the user says shows live")
        XCTAssertFalse(app.buttons["hub.chat.video"].exists, "One camera button during a call")
        capture("Call bar")

        // Video: the live camera with HUB's overlays (a stand-in scene here,
        // since the simulator has no camera).
        app.buttons["hub.voice.video"].tap()
        let close = app.buttons["hub.camera.close"]
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        sleep(2)
        capture("Video call overlays")
        app.buttons["Show what HUB sees"].tap()
        sleep(1)
        capture("Video call marks")
        close.tap()
        XCTAssertTrue(app.buttons["Hide canvas"].waitForExistence(timeout: 5))

        // In a chat, the right edge opens the tools and the left edge the history;
        // a second left-edge swipe goes back Home.
        func edgeSwipe(from x: CGFloat, to endX: CGFloat) {
            app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: 0.55))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: endX, dy: 0.55)))
        }
        edgeSwipe(from: 0.995, to: 0.3)
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 5))
        app.buttons["Close panel"].tap()
        edgeSwipe(from: 0.005, to: 0.7)
        XCTAssertTrue(app.buttons["New chat"].waitForExistence(timeout: 5))
        capture("History over a chat")
        edgeSwipe(from: 0.005, to: 0.7)
        XCTAssertTrue(app.buttons["Explore knowledge"].waitForExistence(timeout: 5))
    }

    /// Screenshots of the task and settings screens for visual review. A
    /// screen that cannot be reached is skipped; the tour asserts nothing.
    @MainActor
    func testNativeScreenTourForVisualReview() {
        let app = readFixtureApp()
        let tools = app.buttons["Workspace tools"]
        guard tools.waitForExistence(timeout: 20) else { return }
        tools.tap()
        let tasks = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Tasks")).firstMatch
        if waitUntilHittable(tasks, timeout: 6) {
            tasks.tap()
            sleep(3)
            capture("Tasks")
            let done = app.buttons["Done"].firstMatch
            guard done.exists, done.isHittable else { return }
            done.tap()
            guard waitUntilHittable(tools, timeout: 6) else { return }
            tools.tap()
        }
        let settings = app.buttons["Settings"].firstMatch
        let general = app.descendants(matching: .any)["hub.settings.general"].firstMatch
        guard waitUntilHittable(settings, timeout: 8) else { return }
        settings.tap()
        if !general.waitForExistence(timeout: 8), waitUntilHittable(settings, timeout: 3) { settings.tap() }
        guard general.waitForExistence(timeout: 8) else { return }
        capture("Settings")
        for title in ["Models & providers", "Instructions", "Tools", "Speech", "Knowledge AI", "Telegram"] {
            let row = app.buttons[title].firstMatch
            guard row.exists, row.isHittable else { continue }
            row.tap()
            sleep(3)
            capture(title)
            let back = app.navigationBars.buttons["Settings"].firstMatch
            guard back.exists, back.isHittable else { return }
            back.tap()
            guard general.waitForExistence(timeout: 5) else { return }
        }
        // Characters last: it goes three screens deep.
        let characters = app.buttons["Characters"].firstMatch
        guard characters.exists, characters.isHittable else { return }
        characters.tap()
        let mira = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Fixture Mira")).firstMatch
        guard mira.waitForExistence(timeout: 6) else { capture("Characters"); return }
        capture("Characters")
        mira.tap()
        sleep(2)
        capture("Character editor")
        let modelTab = app.buttons["Model"].firstMatch
        if modelTab.waitForExistence(timeout: 3) {
            modelTab.tap()
            let choose = app.descendants(matching: .any)["hub.character.model"].firstMatch
            if choose.waitForExistence(timeout: 8) {
                choose.tap()
                sleep(1)
                capture("Character model picker")
                let back = app.navigationBars["Model"].buttons.firstMatch
                if back.exists { back.tap(); sleep(1) }
            } else {
                capture("Character model tab")
            }
        }
        app.swipeUp()
        let lastRequest = app.buttons["Last model request"].firstMatch
        guard lastRequest.waitForExistence(timeout: 4), lastRequest.isHittable else { capture("Character editor end"); return }
        lastRequest.tap()
        sleep(3)
        capture("Last model request")
    }

    @MainActor
    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    private func waitUntilHittable(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let hittable = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND hittable == true"), object: element)
        return XCTWaiter.wait(for: [hittable], timeout: timeout) == .completed
    }

    @MainActor
    private func readFixtureApp(extraArguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--hub-native-home-fixture", "--hub-native-read-fixture",
                               "-AppleLanguages", "(en)", "-AppleLocale", "en_US"] + extraArguments
        app.launch()
        return app
    }
}
