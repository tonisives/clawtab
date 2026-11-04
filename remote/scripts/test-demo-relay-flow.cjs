const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { test } = require("node:test")
const ts = require("typescript")

function load(file, modules, globals = {}) {
  const exports = {}
  const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8")
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(compiled, { exports, URL, ...globals, require: name => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`)
    return modules[name]
  } })
  return exports
}

test("custom relay is saved and used for subsequent API requests", async () => {
  const values = new Map(), calls = []
  const api = load("src/api/client.ts", {
    "../lib/analytics": { trackRemoteEvent() {} },
    "../lib/storage": { getItem: async key => values.get(key), setItem: async (key, value) => values.set(key, value), deleteItem: async key => values.delete(key) },
  }, { fetch: async url => { calls.push(url); return { ok: true, json: async () => [] } } })
  assert.equal(await api.setServerUrl(" https://relay.example.com/ "), "https://relay.example.com")
  await api.clearTokens()
  assert.equal(await api.getServerUrl(), "https://relay.example.com")
  await api.getDevices()
  assert.equal(calls[0], "https://relay.example.com/devices")
  for (const invalid of ["ftp://relay.example.com", "https://user:pass@relay.example.com", "https://relay.example.com?token=abc", "https://relay.example.com#fragment", "invalid"]) {
    await assert.rejects(api.setServerUrl(invalid))
    assert.equal(await api.getServerUrl(), "https://relay.example.com")
  }
})

test("demo notification and task actions remain inert", async () => {
  const jsx = (type, props) => ({ type, props })
  let state
  const { useDemoMessages } = load("src/demo/messages.ts", {
    zustand: { create: init => {
      const set = update => { state = { ...state, ...update(state) } }
      state = init(set)
      const useStore = select => select(state)
      useStore.getState = () => state
      return useStore
    } },
  })
  const pushes = []
  const { DemoMessageInbox } = load("src/components/DemoMessageInbox.tsx", {
    react: { useMemo: callback => callback() },
    "react/jsx-runtime": { jsx },
    "react-native": { Platform: { OS: "ios" } },
    "expo-router": { useRouter: () => ({ push: route => pushes.push(route) }) },
    "@clawtab/shared": { messagePending: record => record.status === "pending" },
    "../demo/messages": { useDemoMessages },
    "../lib/messageTodosController": { isMessageTodoCommand: command => command.op.startsWith("todo") },
    "../lib/messageSurfaceController": { messageSurfaceController: () => ({ execute: () => assert.fail("Task reached the live message controller") }) },
    "../lib/messagePresentation": { surfaceRecord: record => record },
    "./MessageSurface": { MessageSurface: "MessageSurface" },
  })
  const { snapshot, onCommand } = DemoMessageInbox({}).props
  assert.equal(snapshot.todos.items.length, 1)
  const task = snapshot.todos.items[0]
  const result = await onCommand({ op: "todo_update", id: task.id, checked: true })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].checked, false)
  await onCommand({ op: "todo_focus", id: task.id })
  assert.equal(pushes.length, 0)
  assert.equal(snapshot.demo, true)
  assert.equal(snapshot.records[0].details_available, false)
  await onCommand({ op: "respond", id: snapshot.records[0].id, action_id: "decide" })
  await onCommand({ op: "dismiss", id: snapshot.records[0].id })
  assert.equal(state.records[0].status, "pending")
})

test("machine setup follows Relay and its card opens the self-hosted connection form", () => {
  let relayComplete = false, expanded = false
  const pushes = [], jsx = (type, props) => ({ type, props })
  const elements = node => Array.isArray(node) ? node.flatMap(elements) : node && typeof node === "object" ? [node, ...elements(node.props?.children)] : []
  const modules = {
    react: { useState: () => [expanded, update => { expanded = update(expanded) }] },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Platform: { OS: "web" }, Pressable: "Pressable", ScrollView: "ScrollView", View: "View", Text: "Text", StyleSheet: { create: value => value } },
    "expo-router": { useRouter: () => ({ push: route => pushes.push(route) }) },
    "@expo/vector-icons": { Ionicons: "Ionicons" },
    "@clawtab/shared": { colors: {} },
    "../hooks/useSetupProgress": { useSetupProgress: () => ({ relayComplete }) },
  }
  const relay = load("src/components/RelayWelcome.tsx", modules)
  const { DemoOverview } = load("src/components/DemoOverview.tsx", { ...modules, "./RelayWelcome": relay })
  assert.ok(!elements(DemoOverview({ onConnect() {} })).some(node => node.props?.children === "Connect your computer"))
  assert.ok(!elements(relay.AdvancedSetupOptions()).some(node => node.props?.title === "Connect a machine"))
  assert.ok(!elements(relay.RelayWelcome({})).some(node => node.type === "Pressable"))
  const toggle = elements(relay.AdvancedSetupOptions()).find(node => node.props?.accessibilityLabel === "Advanced setup")
  assert.equal(toggle.props.accessibilityState.expanded, false)
  assert.ok(!elements(relay.AdvancedSetupOptions()).some(node => node.props?.children === "Connect your own relay"))
  toggle.props.onPress()
  assert.equal(elements(relay.AdvancedSetupOptions()).find(node => node.props?.accessibilityLabel === "Advanced setup").props.accessibilityState.expanded, true)
  const button = elements(relay.AdvancedSetupOptions()).find(node => node.type === "Pressable" && elements(node).some(child => child.props?.children === "Connect your own relay"))
  button.props.onPress()
  assert.equal(pushes[0], "/connect-relay")
  assert.ok(!elements(relay.AdvancedSetupOptions()).some(node => node.props?.title === "Host your own relay"))
  relayComplete = true
  assert.ok(elements(DemoOverview({ onConnect() {} })).some(node => node.props?.children === "Connect your computer"))
  assert.ok(elements(relay.AdvancedSetupOptions()).some(node => node.props?.title === "Connect a machine"))
})


test("demo agent answers stay pending and use the inert renderer", async () => {
  const jsx = (type, props) => ({ type, props })
  const { DemoQuestionSurface } = load("src/components/DemoQuestionSurface.tsx", {
    react: { useMemo: callback => callback(), useCallback: callback => callback },
    "react/jsx-runtime": { jsx },
    "./MessageSurface": { MessageSurface: "MessageSurface" },
  })
  const question = { question_id: "demo-question", pane_id: "demo-pane", options: [{ number: "1", label: "Yes" }] }
  const { snapshot, onCommand } = DemoQuestionSurface({ question, output: "Sample output" }).props
  assert.equal(snapshot.demo, true)
  for (const command of [{ op: "respond", action_id: "1" }, { op: "auto_yes" }, { op: "dismiss" }]) {
    await onCommand({ ...command, id: question.question_id })
    assert.equal(snapshot.records[0].status, "pending")
    assert.equal(snapshot.records[0].id, question.question_id)
  }
})
