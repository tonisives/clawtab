const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const ts = require("typescript")

const loadAnalytics = (hostname = "remote.clawtab.cc", doNotTrack = "0", storageBlocked = false) => {
  const calls = []
  const values = new Map()
  const context = {
    exports: {},
    window: { location: { hostname, href: "https://remote.clawtab.cc/job/private-repository?code=secret#token" }, gtag: (...args) => calls.push(args) },
    navigator: { doNotTrack },
    document: {
      cookie: "ct_entry=%2Farticles%2Fauto-yes",
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
    sessionStorage: {
      getItem: (key) => { if (storageBlocked) throw Error("storage blocked"); return values.get(key) },
      setItem: (key, value) => { if (storageBlocked) throw Error("storage blocked"); values.set(key, value) },
    },
  }
  const source = fs.readFileSync(path.join(__dirname, "../src/lib/analytics.web.ts"), "utf8")
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  vm.runInNewContext(output, context)
  return { api: context.exports, calls, context }
}

const { api, calls, context } = loadAnalytics()
api.initializeWebAnalytics()
api.trackRemoteEvent("login")
api.trackRemoteEvent("remote_pairing_complete")
api.trackConnectedHost()
api.trackConnectedHost()
assert.deepEqual(calls.filter((call) => call[0] === "event").map((call) => call[1]), ["remote_app_view", "login", "remote_pairing_complete", "remote_host_connected"])
assert.equal(calls.find((call) => call[0] === "config")[2].send_page_view, false)
for (const call of calls.filter((call) => call[0] === "event")) {
  assert.equal(call[2].entry_page, "/articles/auto-yes")
  assert.equal(call[2].page_location, "https://remote.clawtab.cc/")
}
assert.ok(!/secret|private-repository|token/.test(JSON.stringify(calls)))
context.document.cookie = "ct_entry=%2Fjob%2Fsecret"
api.trackRemoteEvent("login")
assert.equal(calls.at(-1)[2].entry_page, "/other")
for (const [host, dnt] of [["localhost", "0"], ["self-hosted.example", "0"], ["remote.clawtab.cc", "1"]]) {
  const disabled = loadAnalytics(host, dnt)
  disabled.api.initializeWebAnalytics()
  disabled.api.trackRemoteEvent("login")
  disabled.api.trackConnectedHost()
  assert.equal(disabled.calls.length, 0)
}
const blocked = loadAnalytics("remote.clawtab.cc", "0", true)
blocked.api.trackConnectedHost()
blocked.api.trackConnectedHost()
assert.equal(blocked.calls.filter((call) => call[1] === "remote_host_connected").length, 1)
const optedOut = loadAnalytics()
optedOut.context.navigator.globalPrivacyControl = true
optedOut.api.trackRemoteEvent("login")
assert.equal(optedOut.calls.length, 0)
const queued = loadAnalytics()
delete queued.context.window.gtag
queued.api.initializeWebAnalytics()
assert.equal(Object.prototype.toString.call(queued.context.window.dataLayer[0]), "[object Arguments]")
const unavailable = loadAnalytics()
unavailable.context.document.head.appendChild = () => { throw Error("script unavailable") }
assert.doesNotThrow(() => unavailable.api.initializeWebAnalytics())
assert.doesNotThrow(() => unavailable.api.trackRemoteEvent("login"))
console.log("Web onboarding analytics privacy, opt-out, attribution, and deduplication passed")
