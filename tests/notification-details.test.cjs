const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("../desktop/node_modules/typescript");
const load = (file, modules) => {
  const exports = {};
  const source = fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(compiled, { exports, require: name => modules[name] ?? {} });
  return exports;
};
const jsx = (type, props, key) => ({ type, props, key });

test("notification details retains the selected pane without a second notification navigator", () => {
  const screen = load("remote/app/process/[pane_id].tsx", {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { StyleSheet: { create: value => value } },
    "expo-router": { useLocalSearchParams: () => ({ pane_id: "machine::_pct_12", source: "notifications" }) },
    "@clawtab/shared": { colors: {}, radius: {} },
  });
  const view = screen.default();
  assert.equal(view.props.pane_id, "machine::%12");
  assert.equal(view.key, "machine::%12");
  assert.equal(view.props.preserveTerminal, true);
  assert.equal(view.props.onSelectNotification, undefined);
});

test("details mounts the notification renderer in shell mode and pauses it off screen", () => {
  let focused = true;
  const { ShellSurface } = load("remote/src/components/ShellSurface.tsx", {
    react: { useMemo: callback => callback(), useCallback: callback => callback },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "expo-router/react-navigation": { useIsFocused: () => focused },
    "../lib/capturedShell": { capturedShellSnapshot: (pane, visible) => ({ shell_only: true, pane, visible }), capturedShellCommand: () => "capture" },
    "./MessageSurface": { MessageSurface: "MessageSurface" },
  });
  const view = ShellSurface({ paneId: "machine::%12" });
  assert.equal(view.type, "MessageSurface");
  assert.equal(view.props.snapshot.shell_only, true);
  assert.equal(view.props.selection, "machine::%12");
  assert.equal(view.props.active, true);
  focused = false;
  assert.equal(ShellSurface({ paneId: "machine::%12" }).props.active, false);
});
