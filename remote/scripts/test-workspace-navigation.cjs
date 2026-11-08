const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

const elements = node => Array.isArray(node) ? node.flatMap(elements)
  : node && typeof node === "object" ? [node, ...elements(node.props?.children)] : [];

function fixture(file, pathname, platform = "web") {
  const destinations = [];
  const jsx = (type, props) => ({ type, props });
  const dependencies = {
    react: { useMemo: fn => fn() },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { Platform: { OS: platform }, Pressable: "Pressable", Text: "Text", View: "View", StyleSheet: { create: value => value } },
    "expo-router": { usePathname: () => pathname, useRouter: () => ({ dismissTo: target => destinations.push(target) }), Stack: Object.assign("Stack", { Screen: "Screen" }) },
    "@clawtab/shared": { colors: {} },
    "../../src/theme/colors": { colors: {} },
    "@expo/vector-icons": { Ionicons: "Ionicons" },
  };
  const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  } });
  return { exports, destinations };
}

for (const platform of ["web", "ios"]) {
  test(`${platform} notification X targets the main view with no prior screen after a refresh`, () => {
    // No dismiss/back methods: a refreshed modal cannot depend on either.
    const app = fixture("app/notifications/_layout.tsx", "/notifications/message/123", platform);
    const screen = elements(app.exports.default()).find(node => node.props?.name === "message/[id]");
    const options = screen.props.options;
    if (platform === "ios") options.unstable_headerRightItems()[0].onPress();
    else options.headerRight().props.onPress();
    assert.deepEqual(app.destinations, ["/(tabs)"]);
  });
}

test("agent details reached directly always expose the main jobs and tabs link", () => {
  const app = fixture("src/components/WorkspaceBreadcrumbs.tsx", "/process/123");
  const nodes = elements(app.exports.WorkspaceBreadcrumbs({ title: "Agent details" }));
  assert.ok(nodes.some(node => node.props?.role === "navigation"));
  const links = nodes.filter(node => node.type === "Pressable");
  assert.equal(links.length, 1);
  links[0].props.onPress();
  assert.deepEqual(app.destinations, ["/(tabs)"]);
});

test("notification agent breadcrumbs can open the inbox or main view without history", () => {
  const app = fixture("src/components/WorkspaceBreadcrumbs.tsx", "/notifications/process/123");
  const links = elements(app.exports.WorkspaceBreadcrumbs({ title: "Agent details" })).filter(node => node.type === "Pressable");
  links[1].props.onPress();
  links[0].props.onPress();
  assert.deepEqual(app.destinations, ["/notifications", "/(tabs)"]);
});

test("split view menu changes sections in place", () => {
  const app = fixture("src/components/WorkspaceBreadcrumbs.tsx", "/");
  const actions = [];
  const links = elements(app.exports.WorkspaceBreadcrumbs({ title: "Agent details", notifications: true,
    onMain: () => actions.push("jobs"), onNotifications: () => actions.push("notifications"),
  })).filter(node => node.type === "Pressable");
  links[0].props.onPress();
  links[1].props.onPress();
  assert.deepEqual(actions, ["jobs", "notifications"]);
  assert.deepEqual(app.destinations, []);
});
