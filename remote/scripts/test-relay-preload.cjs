const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const ts = require("typescript")
const flush = () => new Promise(setImmediate)
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function load(file, modules) {
  const exports = {}
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src", file), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  vm.runInNewContext(code, { exports, require: name => { assert.ok(name in modules, name); return modules[name] } })
  return exports
}

test("Relay preloading deduplicates requests and keeps each account's initial state separate", async () => {
  const pending = deferred(), calls = []
  const cache = load("lib/relaySubscriptionCache.ts", { "../api/client": {
    getSubscriptionStatus: (_signal, userId) => { calls.push(userId); return pending.promise },
    rentalApi: async () => ({ enabled: true, eligible: true, workspace: null }),
  } })
  const first = cache.loadRelaySubscription("one")
  assert.equal(cache.loadRelaySubscription("one"), first)
  assert.equal(cache.cachedRelaySubscription("two"), null)
  const status = { subscribed: true, hosted_workspace_eligible: true }
  pending.resolve(status); await first
  assert.equal(cache.cachedRelaySubscription("one"), status)
  assert.equal(await cache.loadRelaySubscription("one"), status)
  assert.deepEqual(calls, ["one"])
  await cache.loadRelayWorkspace("one")
  assert.equal(cache.cachedRelayWorkspace("one").enabled, true)
  assert.equal(cache.cachedRelayWorkspace("two"), null)
})

test("failed preloading can retry and a forced refresh updates cached subscription state", async () => {
  let attempts = 0
  const cache = load("lib/relaySubscriptionCache.ts", { "../api/client": { getSubscriptionStatus: async () => {
    if (++attempts === 1) throw Error("offline")
    return { subscribed: attempts === 2 }
  } } })
  await assert.rejects(cache.loadRelaySubscription("one"), /offline/)
  assert.equal((await cache.loadRelaySubscription("one")).subscribed, true)
  assert.equal((await cache.loadRelaySubscription("one", true)).subscribed, false)
  assert.equal(cache.cachedRelaySubscription("one").subscribed, false)
})

function navigationFixture(method = "push") {
  const subscription = deferred(), workspace = deferred(), calls = []
  let user = { userId: "one" }
  const auth = select => select(user)
  auth.getState = () => user
  const router = Object.fromEntries(["prefetch", "push", "dismissTo"].map(action => [action, route => calls.push([action, route])]))
  const { useOpenRelay } = load("hooks/useOpenRelay.ts", {
    react: { useRef: current => ({ current }), useCallback: fn => fn, useEffect: fn => fn() },
    "expo-router": { useRouter: () => router },
    "../store/auth": { useAuthStore: auth },
    "../lib/relaySubscriptionCache": { loadRelaySubscription: () => subscription.promise, loadRelayWorkspace: () => workspace.promise },
  })
  return { open: useOpenRelay(method), calls, subscription, workspace, switchAccount: () => { user = { userId: "two" } } }
}
for (const method of ["push", "dismissTo"]) test(`Relay ${method} waits for both data sources before starting the transition`, async () => {
  const app = navigationFixture(method)
  const navigation = app.open()
  await app.open()
  assert.equal(app.calls.length, 0)
  app.subscription.resolve({ hosted_workspace_eligible: true }); await flush()
  assert.equal(app.calls.length, 0, "workspace content is still loading")
  app.workspace.resolve({ enabled: true }); await navigation
  assert.equal(app.calls.at(-1)[0], method)
  assert.ok(app.calls.slice(0, -1).every(([action, route]) => action === "prefetch" && route === "/workspace"))
  assert.equal(app.calls.filter(([action]) => action === method).length, 1)
})

test("a preload from a previous account cannot open Relay after switching accounts", async () => {
  const app = navigationFixture()
  const navigation = app.open()
  app.switchAccount()
  app.subscription.resolve({ hosted_workspace_eligible: false }); await navigation
  assert.equal(app.calls.length, 0)
})
