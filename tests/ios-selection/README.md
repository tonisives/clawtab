# Native shell selection regression

`remote/tests/selection-runtime.tsx` runs the production React Native
`MessageSurface` in a native navigation stack, using captured fixture output.
`RuntimeSelectionTests` holds the shell, selects text in the native control,
copies through the iOS edit menu, and checks the clipboard in notifications,
details and after returning. No account, relay, PTY or tmux pane is used.

Build this app on the shared worker, from `remote`:

```sh
~/.agents/scripts/buildctl run --prepare-node \
  --output tests/ios-selection/runtime-build/Build/Products/Release-iphonesimulator/ClawTabSelection.app=/private/tmp/clawtab-selection-runtime.app \
  -- sh ../tests/ios-selection/build-runtime.sh
```

The script changes the app identity and entry point inside the worker snapshot.
Install the returned app on the dedicated simulator with `simctl install`.
Build the UI runner as below, then run with
`-only-testing:ShellSelectionUITests/RuntimeSelectionTests`.

The separate UIKit fixture isolates the HTML renderer. Its tests send real
long presses and drag WebKit's selection handle, without the React Native
WebView or navigation components.

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
Use `-skip-testing:ShellSelectionUITests/RuntimeSelectionTests` for just the
UIKit fixture tests, also skipping `ShellSelectionUITests/InlineSelectionTests`.

The app's `--legacy-web-input` launch argument restores the hidden WebView
textarea. On iOS 26.5 that configuration reproduces the original failure:
selection succeeds before typing, but the first long press after opening the
keyboard establishes no range. With the separate native input the same press
selects a word, and dragging its handle extends the range.

The runtime suite also opens 150 lines of output at a touched word near the
bottom and captures its initial selection position. The selection view has no
instruction block above the text.

For notification paging, generate `node tests/mobile-pager-fixture.cjs` and run
`tests/mobile-pager-browser-check.js` in that page using the background browser.
It sends touch events with snapshots arriving before the drag threshold and
during animation, then checks same-shell arrivals, superseded pages and list
position.

The iOS selector fits its read-only UITextView to the measured text and uses
an outer ScrollView for scrolling. Its initial offset is applied with
`animated: false` while hidden, then the native selection receives focus.
The first visible frames must already show the touched line. A screenshot
after XCTest waits for idle cannot establish that the transition is stationary;
record the dedicated simulator with `simctl io DEVICE recordVideo` and inspect
the first visible frames. Keep recordings on the mounted external media volume.
