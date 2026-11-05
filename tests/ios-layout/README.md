# iPhone landscape layout checks

The native test app uses the production routes and anonymous sample data. Its
bundle ID is separate from the installed ClawTab app. The build script changes
its identity, initial route and sample-route authentication guard only inside
the worker snapshot.

Generate the UI-test project from the public repository root:

```sh
xcodegen generate --spec tests/ios-layout/project.yml
```

Then, from `remote`, build on the shared worker:

```sh
~/.agents/scripts/buildctl run --prepare-node \
  --include tests/ios-layout/LayoutTests.xcodeproj \
  --output tests/ios-layout/build/Build/Products/Release-iphonesimulator/ClawTabLayout.app=/private/tmp/clawtab-landscape-app.app \
  --output tests/ios-layout/runner-build/Build/Products=/private/tmp/clawtab-landscape-runner \
  -- sh ../tests/ios-layout/build.sh
```

Install the returned app on a dedicated booted iPhone simulator, then run the
returned `.xctestrun` file with `xcodebuild test-without-building`, specifying
`-destination id=DEVICE_ID -parallel-testing-enabled NO`. This performs no
compilation. Keep Simulator and Device Hub windows closed for background runs.

Run on an ordinary iPhone and iPhone Duo. The test captures jobs, a selected
sample agent, and requests both landscape rotations. Review the screenshot
attachments and `LAYOUT_FRAME` log entries in the result bundle for the actual
orientation, clipped controls, excess margins and terminal height.

The Duo iOS 27.2 simulator cover stayed at 466 by 678 points when XCTest
requested rotation. Its inner display remained black; changing display power
with `simctl` did not move the scene. Cover-screen selection can be checked with
this runner, but inner-display folding and keyboard transitions need separate
runs with working device posture controls.

The lightweight inset regression tests cover full-screen shells, native bars,
split panes and partial safe areas:

```sh
cd remote
node --test scripts/test-landscape-insets.cjs
node --test scripts/test-landscape-components.cjs
```

The component tests cover the single Demo button, smaller landscape terminal
font (8 points), portrait restoration, the live answer bar with and without
Yes all, and sidebar Search and Settings actions. The native runner asserts
that the shell reaches the screen bottom within one point.

For the rendered shell CSS, generate a standalone browser fixture from the
public repository root:

```sh
node tests/mobile-pager-fixture.cjs /private/tmp/clawtab-landscape-shell-fixture.html
```

Load that file in a background bmux pane, set its viewport to 874 by 402, and
evaluate `tests/landscape-shell-browser-check.js`. Repeat at 402 by 874. It checks
the computed font size, line height, footer padding and horizontal overflow.
At the portrait-shaped viewport, set `window.fixture.phoneLandscape = true`
and run it again to verify a narrow split pane still uses landscape sizing.
