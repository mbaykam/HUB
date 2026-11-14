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
        app.buttons["Close panel"].tap()
        app.buttons["Workspace tools"].tap()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 5))
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
        hide.tap()
        let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: hide)
        XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed)
        XCTAssertEqual(composer.value as? String, "Fixture draft")
    }
}
