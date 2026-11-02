import XCTest

final class InlineSelectionTests: XCTestCase {
    func testInlineColoredAndPlainSelection() {
        let app = XCUIApplication(bundleIdentifier: "cc.clawtab.selection-runtime")
        app.launch()
        exerciseInlineSelection(app)
        app.buttons["Plain"].tap()
        exerciseInlineSelection(app)
    }

    private func exerciseInlineSelection(_ app: XCUIApplication) {
        let output = app.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Selection")).firstMatch
        XCTAssertTrue(output.waitForExistence(timeout: 20), app.debugDescription)
        output.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        let point = output.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 20, dy: 8))
        point.press(forDuration: 1.2)
        let copy = app.menuItems["Copy"].firstMatch
        XCTAssertTrue(copy.waitForExistence(timeout: 5), "Inline selection must produce a native Copy menu: \(app.debugDescription)")
        copy.tap()
        app.buttons["Read clipboard"].tap()
        XCTAssertEqual(app.staticTexts["Clipboard contents"].value as? String, "Selection")
    }
}

final class RuntimeSelectionTests: XCTestCase {
    func testNativeSelectionInNotificationsAndDetails() {
        let app = XCUIApplication(bundleIdentifier: "cc.clawtab.selection-runtime")
        app.launch()
        exerciseSelection(app, keyboard: true)
        app.buttons["Details"].tap()
        exerciseSelection(app, keyboard: false)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        exerciseSelection(app, keyboard: false)
    }

    private func exerciseSelection(_ app: XCUIApplication, keyboard: Bool) {
        let output = app.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Selection")).firstMatch
        XCTAssertTrue(output.waitForExistence(timeout: 20), app.debugDescription)
        if keyboard {
            output.tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        }
        output.press(forDuration: 1)
        let text = app.textViews["Message text"]
        XCTAssertTrue(text.waitForExistence(timeout: 5), "Long press must open the native selection control: \(app.debugDescription)")
        XCTAssertFalse(app.keyboards.firstMatch.exists, "Read-only selection must not open the keyboard")
        // Exercise UIKit's own selection and Copy menu, rather than setting a DOM range.
        let point = text.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 30, dy: 20))
        point.press(forDuration: 1.1)
        let copy = app.menuItems["Copy"].firstMatch
        XCTAssertTrue(copy.waitForExistence(timeout: 5), app.debugDescription)
        copy.tap()
        app.buttons["Done"].tap()
        app.buttons["Read clipboard"].tap()
        let clipboard = app.staticTexts["Clipboard contents"]
        let copied = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            clipboard.label == "Selection" || clipboard.value as? String == "Selection"
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [copied], timeout: 5), .completed, app.debugDescription)
    }
}
