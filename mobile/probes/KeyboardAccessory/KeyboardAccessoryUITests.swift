import XCTest

final class KeyboardAccessoryUITests: XCTestCase {
    private let previousLabels = ["Previous", "Previous Form Control", "Previous Field", "Önceki", "Önceki alan"]
    private let nextLabels = ["Next", "Next Form Control", "Next Field", "Sonraki", "Sonraki alan"]
    private let doneLabels = ["Done", "Bitti"]
    override func setUpWithError() throws { continueAfterFailure = false }

    func testInstalledRendererActualHomeAndCompactComposer() throws {
        #if HUB_INSTALLED_UI_PROBE
        let app = XCUIApplication()
        app.launchArguments = ["--installed-renderer", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        defer {
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = "installed-renderer-actual-ios-screen"; screenshot.lifetime = .keepAlways; add(screenshot)
            let tree = XCTAttachment(string: app.debugDescription)
            tree.name = "installed-renderer-public-accessibility"; tree.lifetime = .keepAlways; add(tree)
            let metrics = XCTAttachment(string: app.staticTexts["renderer.metrics"].value as? String ?? "<missing>")
            metrics.name = "installed-renderer-metrics-json"; metrics.lifetime = .keepAlways; add(metrics)
            app.terminate()
        }
        let status = app.staticTexts["renderer.status"]
        XCTAssertTrue(status.waitForExistence(timeout: 20))
        let done = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == 'Renderer ready' OR label == 'Renderer failed'"), object: status)
        XCTAssertEqual(XCTWaiter.wait(for: [done], timeout: 75), .completed)
        let json = try XCTUnwrap(app.staticTexts["renderer.metrics"].value as? String)
        print("Actual installed renderer evidence: \(json)")
        let data = try XCTUnwrap(json.data(using: .utf8))
        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(status.label, "Renderer ready", json)
        XCTAssertEqual(proof["realRendered"] as? Bool, true, json)
        XCTAssertEqual(proof["nativeBridge"] as? Bool, false)
        XCTAssertEqual(proof["nonPersistent"] as? Bool, true)
        XCTAssertEqual(proof["testOnlyCSP"] as? Bool, true)
        XCTAssertEqual((proof["sourceSHA256"] as? String)?.count, 64)
        let renderer = try XCTUnwrap(proof["renderer"] as? [String: Any])
        XCTAssertEqual(renderer["home"] as? Bool, true)
        XCTAssertEqual(renderer["compact"] as? Bool, true)
        let card = try XCTUnwrap(renderer["composer"] as? [String: Any])
        XCTAssertLessThanOrEqual(try XCTUnwrap(card["height"] as? Double), 80)
        for key in ["composer", "menu", "voice", "send"] {
            XCTAssertEqual((renderer[key] as? [String: Any])?["visible"] as? Bool, true, key)
        }
        #else
        throw XCTSkip("Actual exported renderer resource not supplied to this keyboard-only build")
        #endif
    }

    func testEnglishSyntheticTextAndFormAccessory() throws {
        try compare(language: "en", locale: "en_US", text: "Hello keyboard 123")
    }

    func testTurkishSyntheticTextAndFormAccessory() throws {
        try compare(language: "tr", locale: "tr_TR", text: "Merhaba Türkçe ığüşöç İĞÜŞÖÇ 123")
    }

    private func compare(language: String, locale: String, text: String) throws {
        let baseline = try exercise(hub: false, language: language, locale: locale, text: text)
        XCTAssertTrue(baseline.contains(where: previousLabels.contains), "Baseline must expose Previous; absent baseline is inconclusive")
        XCTAssertTrue(baseline.contains(where: nextLabels.contains), "Baseline must expose Next; absent baseline is inconclusive")
        XCTAssertTrue(baseline.contains(where: doneLabels.contains), "Baseline must expose Done; absent baseline is inconclusive")
        let overridden = try exercise(hub: true, language: language, locale: locale, text: text)
        XCTAssertTrue(overridden.isEmpty, "Public override must remove the real form-navigation bar")
    }

    private func exercise(hub: Bool, language: String, locale: String, text: String) throws -> [String] {
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(\(language))", "-AppleLocale", locale]
        if hub { app.launchArguments.append("--hub-web-view") }
        app.launch()
        let prefix = "\(language)-\(hub ? "hub" : "baseline")"
        defer {
            let image = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            image.name = "\(prefix)-keyboard-and-accessory"; image.lifetime = .keepAlways
            add(image)
            let tree = XCTAttachment(string: app.debugDescription)
            tree.name = "\(prefix)-public-accessibility"; tree.lifetime = .keepAlways
            add(tree)
            app.terminate()
        }
        let status = app.staticTexts["probe.status"]
        XCTAssertTrue(status.waitForExistence(timeout: 15))
        XCTAssertTrue(NSPredicate(format: "label BEGINSWITH 'Ready'").evaluate(with: status) ||
                      XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "label BEGINSWITH 'Ready'"), object: status)], timeout: 15) == .completed)
        let editor = app.webViews.textViews.matching(NSPredicate(format: "label == %@", "Keyboard probe editor")).firstMatch
        XCTAssertTrue(editor.waitForExistence(timeout: 10), "Actual WebKit contenteditable is accessible")
        editor.tap() // Real user gesture; JavaScript focus does not prove keyboard presentation.
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), "Software keyboard must actually be shown; disable simulator hardware keyboard before this run")
        // A fresh disposable simulator can show Apple's Slide to Type tutorial
        // over the first keyboard. Dismiss only that observed, informational UI;
        // never mistake its covered baseline toolbar for removal by the product.
        let tutorial = app.staticTexts["Speed up your typing by sliding your finger across the letters to compose a word."]
        let tutorialContinue = app.buttons["Continue"]
        if tutorial.exists && tutorialContinue.exists && tutorialContinue.isHittable {
            tutorialContinue.tap()
            XCTAssertFalse(tutorial.exists)
            editor.tap()
            XCTAssertTrue(app.keyboards.firstMatch.exists)
        }
        editor.typeText(text)
        let typed = app.staticTexts["probe.typed"]
        let preserved = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@ OR label == %@", text, text), object: typed)
        XCTAssertEqual(XCTWaiter.wait(for: [preserved], timeout: 10), .completed, "Typed synthetic Unicode text survives actual keyboard input")
        XCTAssertTrue(app.keyboards.firstMatch.exists, "Keyboard remains shown after typing")

        // Public accessibility labels only. The baseline must actually exhibit
        // the targeted controls, preventing a vacuous pass when keyboard/bar is absent.
        let formLabels = previousLabels + nextLabels + doneLabels
        let buttons = app.buttons.allElementsBoundByIndex.filter { $0.exists && $0.isHittable && formLabels.contains($0.label) }
        let observed = buttons.map(\.label)
        print("\(prefix) visible form controls: \(observed)")
        return observed
    }
}
