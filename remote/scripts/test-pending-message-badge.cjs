const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

function load(file, dependencies) {
  const source = fs.readFileSync(path.join(__dirname, "../src", file), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  } });
  return exports;
}

function fixture(version = 26) {
  const state = { questions: [], records: [], detectedProcesses: [], demo: false, demoRecords: [] };
  const messages = load("store/messages.ts", {
    "@react-native-async-storage/async-storage": {},
    zustand: { create: () => () => {} },
    "@clawtab/shared": { resourceKey: (machine, id) => `${machine}:${id}` },
    "../lib/notifications": {},
  });
  const { usePendingMessageCount } = load("hooks/usePendingMessageCount.ts", {
    "@clawtab/shared": { messagePending: record => !record.ignored && !record.dismissed_at && ["pending", "delivering"].includes(record.status) },
    "../store/jobs": { useJobsStore: select => select(state) },
    "../store/messages": { ...messages, useMessageStore: select => select(state) },
    "../store/notifications": { useNotificationStore: select => select(state) },
    "./useDemoMode": { useDemoMode: () => state.demo },
    "../demo/messages": { useDemoMessages: select => select({ records: state.demoRecords }) },
  });
  const pushes = [];
  const { TabScreenStack } = load("components/TabScreenStack.tsx", {
    "react/jsx-runtime": { jsx: (type, props) => ({ type, props }) },
    "expo-router": { Stack: { Screen: "Screen" }, useRouter: () => ({ push: route => pushes.push(route) }) },
    "react-native": { Platform: { OS: "ios", Version: version } },
    "../hooks/useResponsive": { useResponsive: () => ({ isIosPhone: true }) },
    "../theme/colors": { colors: {} },
    "./NotificationsMenuButton": { NotificationsMenuButton: "NotificationsMenuButton" },
    "../hooks/usePendingMessageCount": { usePendingMessageCount },
  });
  return { state, pushes, count: usePendingMessageCount, options: () => TabScreenStack({ screen: "index", title: "ClawTab" }).props.screenOptions };
}

const record = (id, extra = {}) => ({ id, machine_id: "mac", status: "pending", request: { source: {}, data: {} }, ...extra });

test("demo pending count stays separate from live messages and follows local review decisions", () => {
  const app = fixture();
  app.state.records = [record("live-a"), record("live-b")];
  app.state.questions = [{ question_id: "live-question" }];
  app.state.demoRecords = [record("demo-x-post")];
  app.state.demo = true;
  assert.equal(app.count(), 1);
  assert.equal(app.options().unstable_headerRightItems()[0].badge.value, 1);
  app.state.demoRecords = [record("demo-x-post", { status: "answered" })];
  assert.equal(app.count(), 0);
  app.state.demo = false;
  assert.equal(app.count(), 3);
});

test("native bell shows four pending messages and clears its badge when resolved", () => {
  const app = fixture();
  app.state.records = [1, 2, 3, 4].map(id => record(id));
  const button = app.options().unstable_headerRightItems()[0];
  assert.equal(button.badge.value, 4);
  assert.equal(button.accessibilityLabel, "4 pending notifications");
  button.onPress();
  assert.deepEqual(app.pushes, ["/notifications"]);
  app.state.records = app.state.records.map(item => ({ ...item, status: "answered" }));
  assert.equal(app.options().unstable_headerRightItems()[0].badge, undefined);
});

test("count combines messages, questions and alerts without counting represented items twice", () => {
  const app = fixture();
  app.state.questions = [{ question_id: "mac:q1" }];
  app.state.records = [
    record(1, { request: { source: {}, data: { question_id: "q1" } } }),
    record(2), record(3, { ignored: true }), record(4, { dismissed_at: "today" }),
    record(5, { status: "answered" }),
    record(6, { request: { source: { pane_id: "mac:p1" }, data: { event: "agent_alert" } } }),
  ];
  app.state.detectedProcesses = [
    { pane_id: "mac:p1", _agent_alert: "represented" },
    { pane_id: "mac:p2", _agent_alert: "waiting" },
    { pane_id: "mac:p3", _agent_alert: " " },
  ];
  assert.equal(app.count(), 4);
});

test("older iOS uses the existing count button", () => {
  const app = fixture("18.6");
  assert.equal(app.options().headerRight().props.countOnly, true);
  assert.equal(app.options().unstable_headerRightItems, undefined);
});
