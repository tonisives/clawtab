import XCTest

final class SelectionTests: XCTestCase {
    func testDetailsSelection() { exerciseSelection(launch(), keyboard: false) }
    func testDetailsAfterOpeningKeyboard() { exerciseSelection(launch(), keyboard: true) }
    func testNotificationAfterOpeningKeyboard() { exerciseSelection(launch(notifications: true), keyboard: true) }
    func testDetailsAndReturnToNotifications() {
        let app = launch(notifications: true)
        exerciseSelection(app, keyboard: true)
        app.navigationBars.buttons["Details"].tap()
        exerciseSelection(app, keyboard: true)
        app.navigationBars.buttons["Back"].tap()
        exerciseSelection(app, keyboard: true)
    }

    private func launch(notifications: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        if notifications { app.launchArguments = ["--notifications"] }
        app.launch()
        return app
    }

    private func state(_ app: XCUIApplication) -> [String: Any] {
        let label = app.staticTexts["Selection status"].label
        return (try? JSONSerialization.jsonObject(with: Data(label.utf8))) as? [String: Any] ?? [:]
    }

    private func exerciseSelection(_ app: XCUIApplication, keyboard: Bool) {
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in self.state(app)["ready"] as? Bool == true }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 15), .completed)
        var before = state(app)
        let web = app.webViews.firstMatch
        var point = web.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: before["x"] as? Double ?? 28, dy: before["y"] as? Double ?? 16))
        if keyboard {
            point.tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
            before = state(app)
            point = web.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: before["x"] as? Double ?? 28, dy: before["y"] as? Double ?? 16))
        }
        point.press(forDuration: 1.2)
        let selected = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in (self.state(app)["length"] as? Int ?? 0) > 0 }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [selected], timeout: 5), .completed, "Real iOS long press must select text: \(state(app))")
        let initial = state(app)
        guard (initial["length"] as? Int ?? 0) > 0, let end = initial["end"] as? [String: Double] else { return }
        let handle = web.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: end["x"]! + 1, dy: end["y"]! + 5))
        let destination = web.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 180, dy: (before["y"] as? Double ?? 16) + 40))
        handle.press(forDuration: 0.2, thenDragTo: destination)
        let expanded = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in (self.state(app)["length"] as? Int ?? 0) > (initial["length"] as? Int ?? 0) }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [expanded], timeout: 5), .completed, "Native selection handle must extend the range: \(state(app))")
    }
}
