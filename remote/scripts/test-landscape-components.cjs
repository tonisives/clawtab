const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const elements = node => Array.isArray(node) ? node.flatMap(elements)
  : node && typeof node === "object" ? [node, ...elements(node.props?.children)] : [];

function fixture() {
  let landscape = false, searches = 0;
  const routes = [], jsx = (type, props) => ({ type, props });
  const modules = {
    react: { useState: value => [value, () => {}], useRef: value => ({ current: value }), useEffect() {} },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Platform: { OS: "ios" }, View: "View", Text: "Text", TextInput: "TextInput", Pressable: "Pressable", StyleSheet: { create: styles => styles } },
    "expo-router": { useRouter: () => ({ push: route => routes.push(route) }) },
    "@expo/vector-icons": { Ionicons: "Ionicons" },
    "@clawtab/shared": { colors: {}, JobKindIcon: "JobKindIcon", XtermLog: "XtermLog", JobListView: "JobListView", kindForProcess: () => "shell" },
    "../hooks/useResponsive": { useResponsive: () => ({ isIosPhone: true, isIosPhoneLandscape: landscape }) },
    "../demo/data": { DEMO_JOBS: [], DEMO_STATUSES: [], DEMO_PROCESSES: [], demoQuestionForSelection: () => undefined },
    "../demo/shell": { demoShell: () => ({ output: "Sample output", placeholder: "Prompt", model: "Sample model" }) },
    "../store/jobFilter": { useJobFilterStore: select => select({ query: "", setQuery() {}, openSearch: () => searches++ }) },
    "../../../shared/src/machines/Onboarding": { MachineModal: "MachineModal" },
    "./DemoQuestionSurface": { DemoQuestionSurface: "DemoQuestionSurface" },
    "./DemoDetailsContent": { DemoDetailsContent: "DemoDetailsContent" },
    "./NotificationsMenuButton": { NotificationsMenuButton: "NotificationsMenuButton" },
  };
  const load = name => {
    const exports = {};
    const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, `../src/components/${name}.tsx`), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    vm.runInNewContext(source, { exports, require: name => {
      assert.ok(name in modules, `Unexpected dependency: ${name}`);
      return modules[name];
    } });
    return exports[name];
  };
  return { load, routes, setLandscape: value => landscape = value, searches: () => searches };
}

test("landscape shell omits its duplicate Demo button and reduces terminal text; portrait restores both", () => {
  const f = fixture(), Pane = f.load("DemoAgentPane");
  for (const landscape of [false, true, false]) {
    f.setLandscape(landscape);
    const nodes = elements(Pane({ id: "sample", kind: "process", onShowOverview() {} }));
    assert.equal(nodes.filter(node => node.props?.accessibilityLabel === "About demo mode").length, landscape ? 0 : 1);
    assert.equal(nodes.find(node => node.type === "XtermLog").props.fontSize, landscape ? 8 : undefined);
    assert.ok(nodes.some(node => node.props?.accessibilityLabel === "Agent details"));
  }
});

test("landscape sidebar keeps one Demo action plus working Search and Settings controls", () => {
  const f = fixture(), List = f.load("DemoJobList");
  f.setLandscape(true);
  const list = List({ embedded: true, onConnect() {} });
  const nodes = elements(list.props.headerContent);
  assert.equal(nodes.filter(node => node.props?.accessibilityLabel === "About demo mode").length, 1);
  nodes.find(node => node.props?.accessibilityLabel === "Search jobs").props.onPress();
  nodes.find(node => node.props?.accessibilityLabel === "Settings").props.onPress();
  assert.equal(f.searches(), 1);
  assert.deepEqual(f.routes, ["/settings"]);
  f.setLandscape(false);
  const portrait = elements(List({ embedded: true, onConnect() {} }).props.headerContent);
  assert.ok(!portrait.some(node => node.props?.accessibilityLabel === "Search jobs"));
});

test("live answer bar removes the landscape spacer and restores portrait insets", () => {
  let dimensions = { width: 874, height: 402 };
  const platform = { OS: "ios", isPad: false };
  const jsx = (type, props) => ({ type, props });
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../../shared/src/components/JobDetailView/Options.tsx"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const modules = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { View: "View", Text: "Text", TouchableOpacity: "Button", ScrollView: "ScrollView", Platform: platform, useWindowDimensions: () => dimensions },
    "../../util/jobs": { isFreetextOption: () => false, questionOptionLabel: option => option.label },
    "./styles": { styles: {} },
  };
  vm.runInNewContext(source, { exports, require: name => { assert.ok(name in modules, name); return modules[name]; } });
  for (const [width, height, isPad, os, expectedPadding] of [
    [874, 402, false, "ios", 0],
    [402, 874, false, "ios", 31],
    [874, 402, true, "ios", 31],
    [874, 402, false, "android", 31],
  ]) {
    dimensions = { width, height }; platform.isPad = isPad; platform.OS = os;
    for (const auto of [false, true]) {
      let measured, sent;
      const bar = exports.OptionButtons({ options: [{ number: "1", label: "Yes" }], bottomInset: 21,
        onSend: value => sent = value, onHeightChange: value => measured = value,
        onToggleAutoYes: auto ? () => {} : undefined });
      bar.props.onLayout();
      assert.equal(measured, 62 + (auto ? 54 : 0) + expectedPadding);
      const nodes = elements(bar);
      nodes.find(node => node.type === "Button").props.onPress();
      assert.equal(sent, "1");
      if (auto) {
        const row = nodes.filter(node => node.type === "ScrollView")[1];
        assert.equal(row.props.contentContainerStyle[1].paddingBottom, expectedPadding);
      } else {
        assert.equal(nodes.at(-1).props.style.height, expectedPadding);
      }
    }
  }
});

test("terminal renderer accepts eight-point text and refits only when the size changes", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../shared/src/components/XtermLog.tsx"), "utf8");
  const operation = source.match(/window\.setTerminalFontSize = function\(size\) \{[\s\S]*?\n\};/)[0];
  let fits = 0, resizes = 0;
  const context = { window: {}, term: { options: { fontSize: 12 } }, fitScreen: () => fits++, reportResize: () => resizes++ };
  vm.runInNewContext(operation, context);
  context.window.setTerminalFontSize(8);
  assert.equal(context.term.options.fontSize, 8);
  assert.equal(fits, 1); assert.equal(resizes, 1);
  context.window.setTerminalFontSize(8);
  assert.equal(fits, 1);
  context.window.setTerminalFontSize(12);
  assert.equal(context.term.options.fontSize, 12);
  assert.equal(fits, 2);
});
