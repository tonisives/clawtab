import XCTest

final class InlineSelectionTests: XCTestCase {
    func testInlineColoredSelection() {
        let app = XCUIApplication(bundleIdentifier: "cc.clawtab.selection-runtime")
        app.launch()
        exerciseInlineSelection(app)
    }
    func testInlinePlainSelection() {
        let app = XCUIApplication(bundleIdentifier: "cc.clawtab.selection-runtime")
        app.launch()
        app.buttons["Plain"].tap()
        exerciseInlineSelection(app)
    }

    private func exerciseInlineSelection(_ app: XCUIApplication) {
        app.buttons["Clear"].tap()
        let output = app.webViews.staticTexts.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", "Selection", "Selection starts here")).firstMatch
        XCTAssertTrue(output.waitForExistence(timeout: 20), app.debugDescription)
        output.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        let point = output.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 20, dy: 8))
        point.press(forDuration: 1.2)
        let copy = app.menuItems["Copy"].firstMatch
        XCTAssertTrue(copy.waitForExistence(timeout: 5), "Inline selection must produce a native Copy menu: \(app.debugDescription)")
        copy.tap()
        app.buttons["Read clipboard"].tap()
        XCTAssertEqual(app.staticTexts["Clipboard contents"].firstMatch.value as? String, "Selection")
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

    func testLongOutputOpensAtTouchedWord() {
        let app = XCUIApplication(bundleIdentifier: "cc.clawtab.selection-runtime")
        app.launch()
        app.buttons["Long"].tap()
        let target = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Target selected at the bottom")).firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 20), app.debugDescription)
        let point = target.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 1)).withOffset(CGVector(dx: 24, dy: -25))
        point.press(forDuration: 0.7)
        let text = app.textViews["Message text"]
        XCTAssertTrue(text.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertFalse(app.staticTexts["Touch and hold to select text, then drag the handles and tap Copy."].exists)
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.lifetime = .keepAlways
        add(attachment)
        let copy = app.menuItems["Copy"].firstMatch
        if !copy.exists { text.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.9)).press(forDuration: 1) }
        XCTAssertTrue(copy.waitForExistence(timeout: 5), app.debugDescription)
        copy.tap()
        let initialTop = text.frame.minY
        app.scrollViews.firstMatch.swipeDown()
        XCTAssertGreaterThan(text.frame.minY, initialTop + 10, "The selection view remains manually scrollable")
        app.buttons["Done"].tap()
        app.buttons["Read clipboard"].tap()
        XCTAssertFalse((app.staticTexts["Clipboard contents"].firstMatch.value as? String ?? "").isEmpty)
    }

    private func exerciseSelection(_ app: XCUIApplication, keyboard: Bool) {
        app.buttons["Clear"].tap()
        let output = app.webViews.staticTexts.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", "Selection", "Selection starts here")).firstMatch
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
        let clipboard = app.staticTexts["Clipboard contents"].firstMatch
        let copied = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            clipboard.label == "Selection" || clipboard.value as? String == "Selection"
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [copied], timeout: 5), .completed, app.debugDescription)
    }
}
