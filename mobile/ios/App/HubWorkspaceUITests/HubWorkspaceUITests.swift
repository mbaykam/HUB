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
        XCTAssertTrue(add.exists && voice.exists && send.exists)
        XCTAssertLessThanOrEqual(add.frame.maxX, voice.frame.minX)
        XCTAssertLessThanOrEqual(voice.frame.maxX, send.frame.minX)
        capture("Home")
        add.tap()
        XCTAssertTrue(app.buttons["Choose character"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Research…"].exists)
        XCTAssertTrue(app.buttons["Files"].exists)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.16)).tap()
        let closedMenu = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.buttons["Choose character"])
        XCTAssertEqual(XCTWaiter.wait(for: [closedMenu], timeout: 5), .completed)

        app.buttons["Chat history"].tap()
        XCTAssertTrue(app.staticTexts["Recents"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Collect reading notes"].exists)
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

        let composer = app.textFields["hub.home.draft"]
        composer.tap()
        let hide = app.buttons["Hide keyboard"]
        XCTAssertTrue(hide.waitForExistence(timeout: 5))
        composer.typeText("Fixture draft")
        XCTAssertEqual(composer.value as? String, "Fixture draft")
        capture("Composer keyboard")
        hide.tap()
        let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: hide)
        XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed)
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
        XCTAssertEqual(graph.value as? String, "2D")
        capture("Knowledge graph")
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
        app.buttons["Timing and attempts"].tap()
        XCTAssertTrue(app.staticTexts["1 model attempts"].exists)
        app.buttons["Timing and attempts"].tap()
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
        app.buttons["Settings"].tap()
        let general = app.descendants(matching: .any)["hub.settings.general"].firstMatch
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
        app.buttons["Edit"].tap()
        let name = app.textFields["Name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        XCTAssertEqual(name.value as? String, "Fixture Vera")
        let model = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@ OR value == %@", "Fixture Voice Model", "Fixture Voice Model")).firstMatch
        XCTAssertTrue(model.waitForExistence(timeout: 5))
        XCTAssertEqual(app.webViews.count, 0)
        capture("Voice personality")
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
        XCTAssertTrue(more.exists && voice.exists && stop.exists)
        XCTAssertLessThanOrEqual(more.frame.maxX, voice.frame.minX)
        XCTAssertLessThanOrEqual(voice.frame.maxX, stop.frame.minX)
        capture("Conversation before Stop")
        let draft = app.textFields["hub.chat.draft"]
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

    @MainActor
    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
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
