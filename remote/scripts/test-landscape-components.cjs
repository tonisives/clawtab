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
    assert.equal(nodes.find(node => node.type === "XtermLog").props.fontSize, landscape ? 10 : undefined);
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
