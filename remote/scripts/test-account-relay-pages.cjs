const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { test } = require("node:test")
const ts = require("typescript")

const jsx = (type, props) => ({ type, props })
const elements = (node) => Array.isArray(node) ? node.flatMap(elements) : node && typeof node === "object" ? [node, ...elements(node.props?.children)] : []
const settings = { SettingsPage: "SettingsPage", SettingsGroup: "SettingsGroup", SettingsRow: "SettingsRow", SettingsButton: "SettingsButton", styles: {} }
const native = { Platform: { OS: "ios" }, View: "View", Text: "Text", Pressable: "Pressable", ActivityIndicator: "ActivityIndicator", StyleSheet: { create: (styles) => styles }, AppState: { addEventListener: () => ({ remove() {} }) } }

function fixture(file, dependencies) {
  let state = [], index = 0, effects = [], mounted = false
  let react = {
    useState: (initial) => {
      let key = index++
      if (!(key in state)) state[key] = initial
      return [state[key], (value) => { state[key] = typeof value === "function" ? value(state[key]) : value }]
    },
    useRef: (initial) => {
      let key = index++
      if (!(key in state)) state[key] = { current: initial }
      return state[key]
    },
    useEffect: (effect) => { if (!mounted) effects.push(effect) },
  }
  let modules = { react, "react/jsx-runtime": { jsx, jsxs: jsx }, "react-native": native, "./SettingsPage": settings, "../../theme/colors": { colors: {} }, "../../theme/spacing": { spacing: { md: 12 } }, ...dependencies }
  let source = fs.readFileSync(path.join(__dirname, "../src/components/settings", file), "utf8")
  let compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  let exports = {}
  vm.runInNewContext(compiled, { exports, setInterval: () => 1, clearInterval() {}, require: (name) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`)
    return modules[name]
  } })
  let Component = Object.values(exports)[0]
  return () => {
    index = 0
    let tree = Component()
    if (!mounted) { mounted = true; effects.forEach((effect) => effect()) }
    return tree
  }
}

function accountFixture() {
  let calls = [], confirmations = []
  let render = fixture("AccountSettings.tsx", {
    "expo-router": { useRouter: () => ({ replace: (route) => calls.push(route) }) },
    "../../store/auth": { useAuthStore: (select) => select({ email: "test@example.invalid", logout: async () => calls.push("logout") }) },
    "../../api/client": { deleteAccount: async () => calls.push("delete") },
    "../../lib/platform": { confirm: (_title, _message, callback) => confirmations.push(callback), alertError: assert.fail },
  })
  return { render, calls, confirmations }
}

test("Account keeps sign-out independent of Relay subscriptions", async () => {
  let { render, calls, confirmations } = accountFixture()
  let tree = render()
  let signOut = elements(tree).find((node) => node.props.title === "Sign out")
  assert.ok(signOut)
  assert.ok(!elements(tree).some((node) => node.props.title === "Delete account"))
  assert.ok(!elements(tree).some((node) => /subscription|Subscribe|Restore/.test(node.props.title ?? "")))
  signOut.props.onPress()
  await confirmations.shift()()
  assert.deepEqual(calls, ["logout", "/login"])
})

test("Delete account remains in the bottom Danger Zone with confirmation", async () => {
  let { render, calls, confirmations } = accountFixture()
  let tree = render()
  let dangerZone = elements(tree).find((node) => node.type === "Pressable")
  dangerZone.props.onPress()
  tree = render()
  let deletion = elements(tree).find((node) => node.props.title === "Delete account")
  assert.ok(deletion)
  assert.ok(elements(tree.props.children.at(-1)).includes(deletion), "Delete account remains in the last section")
  deletion.props.onPress()
  confirmations.shift()()
  await confirmations.shift()()
  assert.deepEqual(calls.slice(-3), ["delete", "logout", "/login"])
})

async function relayFixture(subscription) {
  let calls = []
  let user = { userId: "test-user" }
  let useAuthStore = (select) => select(user)
  useAuthStore.getState = () => user
  let render = fixture("RelaySubscription.tsx", {
    "@clawtab/shared": { HostedWorkspacePanel: "HostedWorkspacePanel", machineState: () => ({ connected: true }), reconnectMachines() {} },
    "../../hooks/useIap": { useIap: () => ({ available: true, price: "US$6.99", activation: 0, diagnostic: "StoreKit fixture", restore: async () => ({ status: "cancelled" }) }) },
    "expo-router": { useRouter: () => ({ push: (route) => calls.push(route) }) },
    "../../store/auth": { useAuthStore },
    "../../api/client": { getSubscriptionStatus: async () => subscription, createPortal: async () => ({ url: "https://billing.example.invalid/portal" }), rentalApi: {} },
    "../../lib/platform": { openUrl: async (url) => calls.push(url), alertError: assert.fail },
    "../RelayWelcome": { RelayWelcome: "RelayWelcome" },
  })
  render()
  await new Promise(setImmediate)
  return { tree: render(), calls }
}

test("Relay contains subscribe, restore, and diagnostics for an inactive subscription", async () => {
  let { tree } = await relayFixture({ subscribed: false, hosted_workspace_eligible: false })
  let buttons = elements(tree).filter((node) => node.type === "SettingsButton")
  assert.ok(buttons.some((node) => node.props.title.startsWith("Subscribe")))
  assert.ok(buttons.some((node) => node.props.title === "Restore Purchases"))
  assert.ok(buttons.some((node) => node.props.title === "View purchase diagnostics"))
})

for (let provider of ["apple", "stripe"]) {
  test(`Relay retains ${provider} billing management with an active hosted workspace`, async () => {
    let { tree, calls } = await relayFixture({ subscribed: true, hosted_workspace_eligible: true, provider })
    assert.ok(elements(tree).some((node) => node.type === "HostedWorkspacePanel"))
    let manage = elements(tree).find((node) => node.props.title === "Manage subscription")
    assert.ok(manage)
    await manage.props.onPress()
    assert.deepEqual(calls, [provider === "apple" ? "https://apps.apple.com/account/subscriptions" : "https://billing.example.invalid/portal"])
  })
}

test("Relay opens connected machines for relay access included with a box", async () => {
  let { tree, calls } = await relayFixture({ subscribed: true, hosted_workspace_eligible: false, relay_included: true, provider: null })
  let machines = elements(tree).find((node) => node.props.title === "Open your connected machines")
  assert.ok(machines)
  machines.props.onPress()
  assert.deepEqual(calls, ["/machines"])
})
