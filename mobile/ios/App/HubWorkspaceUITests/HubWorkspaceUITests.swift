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
        search.typeText("Planning")
        let record = app.buttons["Planning a coding project"]
        if !record.isHittable { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(record.waitForExistence(timeout: 5))
        record.tap()
        let source = app.staticTexts["Sketch the first release before choosing the tools."]
        XCTAssertTrue(source.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Connections and sources"].exists)
        XCTAssertEqual(app.webViews.count, 0)
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
        let general = app.buttons["General"]
        XCTAssertTrue(general.waitForExistence(timeout: 5))
        general.tap()

        XCTAssertTrue(app.staticTexts["Appearance"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Dark"].exists)
        XCTAssertTrue(app.staticTexts["English"].exists)
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Conversation text size · 16")).firstMatch.exists)
        XCTAssertTrue(app.staticTexts["Steer current turn"].exists)
        XCTAssertTrue(app.staticTexts["Compact"].exists)
        XCTAssertEqual(app.webViews.count, 0)
        capture("General settings")
    }

    @MainActor
    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    private func readFixtureApp() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--hub-native-home-fixture", "--hub-native-read-fixture",
                               "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        return app
    }
}
