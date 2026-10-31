const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { test } = require("node:test")
const ts = require("typescript")
const navigationPath = path.dirname(require.resolve("@react-navigation/native"))
const corePath = path.dirname(require.resolve("@react-navigation/core", { paths: [navigationPath] }))
const { StackRouter } = require(require.resolve("@react-navigation/routers", { paths: [corePath] }))

const elements = (node) => {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!node || typeof node !== "object") return []
  return [node, ...elements(node.props?.children)]
}

function settingsFixture(inModal = false) {
  let navigate = () => {}
  let pushes = []
  let jsx = (type, props) => ({ type, props })
  let dependencies = {
    react: { useEffect: () => {}, useRef: (current) => ({ current }) },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "expo-router": { useRouter: () => ({ push: (route) => pushes.push(route) }) },
    "@react-navigation/native-stack": { createNativeStackNavigator: () => ({ Navigator: "Navigator", Screen: "Screen" }) },
    "expo-router/react-navigation": { useIsFocused: () => true },
    "@react-navigation/native": {
      NavigationContainer: "NavigationContainer", NavigationIndependentTree: "NavigationIndependentTree", DarkTheme: {},
      useIsFocused: () => true, useNavigationContainerRef: () => ({}),
    },
    "@clawtab/shared": { useMachines: () => ({ connected: false, error: null, machines: [] }) },
    "react-native": { Platform: { OS: "ios" }, Text: "Text", View: "View" },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ bottom: 34 }) },
    "../../../src/store/auth": { useAuthStore: (select) => select({ email: "test@example.invalid" }) },
    "../../../src/hooks/useResponsive": { useResponsive: () => ({ isWide: false, isSplitView: false, isIosPadPortrait: false }) },
    "../../../src/components/ApiTokensSection": { ApiTokensSection: "ApiTokensSection" },
    "../../../src/components/MachineNavigation": { EmbeddedMachineNavigation: { Provider: "EmbeddedMachineNavigation" }, MachinePageHistoryProvider: "MachinePageHistoryProvider", MachinePageScreen: "MachinePageScreen" },
    "../../../src/components/MachineSetup": { MachineSetup: "MachineSetup" },
    "../../../src/components/settings/AccountSettings": { AccountSettings: "AccountSettings" },
    "../../../src/components/settings/SharingSettings": { SharingSettings: "SharingSettings" },
    "../../../src/components/settings/TerminalSettings": { TerminalSettings: "TerminalSettings" },
    "../../../src/components/settings/UsageSettings": { UsageSettings: "UsageSettings" },
    "../../../src/components/settings/SettingsPage": {
      SettingsBottomInset: { Provider: "SettingsBottomInset" }, SettingsGroup: "SettingsGroup", SettingsPage: "SettingsPage", SettingsRow: "SettingsRow", styles: {},
    },
    "../../../src/components/settings/navigation": {
      SettingsNavigation: { Provider: "SettingsNavigation" }, SettingsVisibility: { Provider: "SettingsVisibility" }, useSettingsNavigation: () => (name) => navigate(name),
    },
    "../../../src/theme/colors": { colors: {} },
  }
  let source = fs.readFileSync(path.join(__dirname, "../app/(tabs)/(settings)/settings.tsx"), "utf8")
  let compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  let exports = {}
  vm.runInNewContext(compiled, { exports, require: (name) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
    return dependencies[name]
  } })
  let navigator = elements(exports.default({ inModal })).find((element) => element.type === "Navigator")
  let screens = elements(navigator.props.children).filter((element) => element.type === "Screen")
  let options = { routeNames: screens.map((screen) => screen.props.name), routeParamList: {}, routeGetIdList: {} }
  let router = StackRouter({ initialRouteName: navigator.props.initialRouteName })
  let state = router.getInitialState(options)
  navigate = (name) => { state = router.getStateForAction(state, { type: "NAVIGATE", payload: { name } }, options) }
  return {
    pushes,
    current: () => state.routes[state.index].name,
    render: () => {
      let screen = screens.find((screen) => screen.props.name === state.routes[state.index].name)
      let provider = screen.props.children({ navigation: { navigate } })
      let page = elements(provider).find((element) => element.type === "SettingsNavigation").props.children
      return typeof page.type === "function" ? page.type() : page
    },
  }
}

for (let inModal of [false, true]) {
  test(`${inModal ? "embedded settings" : "Settings tab"} opens account controls before Relay setup`, () => {
    let app = settingsFixture(inModal)
    assert.equal(app.current(), "home")
    let account = elements(app.render()).find((element) => element.props.title === "Account")
    assert.ok(account, "Settings Home exposes account settings")
    assert.ok(!account.props.disabled, "Account settings is available while disconnected")
    account.props.onPress()
    assert.equal(app.current(), "account")
    assert.equal(app.render().type, "AccountSettings")
  })
}

test("Settings has one Relay entry separate from Account", () => {
  let app = settingsFixture()
  let rows = elements(app.render()).filter((element) => element.type === "SettingsRow")
  let relay = rows.filter((element) => element.props.title === "Relay")
  assert.equal(relay.length, 1)
  assert.ok(!relay[0].props.disabled, "Relay subscriptions are available while disconnected")
  relay[0].props.onPress()
  assert.deepEqual(app.pushes, ["/workspace"])
  assert.ok(!rows.some((element) => /Account & subscription|Relay workspace|Connect to relay/.test(element.props.title)))
  assert.ok(!elements(app.render()).some((element) => element.props.accessibilityLabel === "About demo mode"))
})
