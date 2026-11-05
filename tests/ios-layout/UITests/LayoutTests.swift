import XCTest

final class LayoutTests: XCTestCase {
  let app = XCUIApplication(bundleIdentifier: "cc.clawtab.layout-runtime")
  var details: XCUIElement {
    app.buttons.matching(NSPredicate(format: "label IN %@", ["Agent details", "Open pane overview"])).firstMatch
  }

  func capture(_ name: String) {
    let image = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    image.name = name
    image.lifetime = .keepAlways
    add(image)
    NSLog("LAYOUT_FRAME %@ %@", name, String(describing: app.frame))
  }

  func testLandscapeWorkspace() throws {
    continueAfterFailure = false
    XCUIDevice.shared.orientation = .portrait
    app.launch()
    let demo = app.buttons["About demo mode"].firstMatch
    XCTAssertTrue(demo.waitForExistence(timeout: 30))
    capture("portrait-jobs")
    XCUIDevice.shared.orientation = .landscapeLeft
    sleep(3)
    capture("landscape-jobs")
    XCTAssertTrue(demo.isHittable)
    let agents = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Claude review"))
    // React Native exposes the row as a combined accessibility element.
    // Choose the smallest matching element instead of its containing scroll view.
    var agent: XCUIElement?
    for _ in 0..<6 {
      agent = agents.allElementsBoundByIndex.filter { $0.isHittable }.min {
        $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height
      }
      if let agent, agent.frame.height < 160 { break }
      app.scrollViews.firstMatch.swipeUp()
    }
    let row = try XCTUnwrap(agent, "The sidebar must allow selecting a sample agent")
    XCTAssertLessThan(row.frame.height, 160)
    row.tap()
    sleep(2)
    capture("landscape-agent")
    XCTAssertTrue(details.waitForExistence(timeout: 5))
    XCUIDevice.shared.orientation = .portrait
    sleep(2)
    capture("portrait-selected")
    XCUIDevice.shared.orientation = .landscapeRight
    sleep(2)
    capture("landscape-right-selected")
    XCTAssertTrue(details.exists)
    if app.frame.width > app.frame.height {
      XCTAssertEqual(app.buttons.matching(identifier: "About demo mode").count, 1)
      XCTAssertTrue(app.buttons["Search jobs"].firstMatch.isHittable)
      XCTAssertTrue(app.buttons["Settings"].firstMatch.isHittable)
      XCTAssertGreaterThan(app.webViews.firstMatch.frame.maxY, app.frame.maxY - 1,
        "Landscape shell must use the space previously reserved for the tab bar")
    }
  }
}
