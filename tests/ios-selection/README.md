# Native shell selection regression

This small UIKit app loads the production mobile shell document. XCTest sends
real long presses and drags the iOS selection handle. It checks notification
and details layouts, opening the shell keyboard first, and pushing details then
returning to notifications. No account, relay, PTY or tmux pane is used.

Generate the fixture and Xcode project on the host:

```sh
node tests/ios-selection/fixture.cjs
xcodegen generate --spec tests/ios-selection/project.yml
```

Compile on the shared build worker from the public repository root:

```sh
~/.agents/scripts/buildctl run \
  --include tests/ios-selection/App/fixture.html \
  --include tests/ios-selection/ShellSelection.xcodeproj \
  --output tests/ios-selection/build/Build/Products=/private/tmp/clawtab-selection-products \
  -- /bin/sh -c 'export DEVELOPER_DIR="$BUILD_SERVICE_XCODE_DEVELOPER_DIR"; xcodebuild -quiet -project tests/ios-selection/ShellSelection.xcodeproj -scheme ShellSelection -destination "generic/platform=iOS Simulator" -derivedDataPath tests/ios-selection/build -jobs 4 build-for-testing'
```

Use a dedicated simulator created with `xcrun simctl create`, then boot it with
`simctl bootstatus DEVICE_ID -b`. No Simulator window needs to be opened. Run
the returned `.xctestrun` using `xcodebuild test-without-building -xctestrun PATH
-destination id=DEVICE_ID -parallel-testing-enabled NO`. This step does no
compilation. Shut down and delete the dedicated simulator afterwards.

The app's `--legacy-web-input` launch argument restores the hidden WebView
textarea. On iOS 26.5 that configuration reproduces the original failure:
selection succeeds before typing, but the first long press after opening the
keyboard establishes no range. With the separate native input the same press
selects a word, and dragging its handle extends the range.
