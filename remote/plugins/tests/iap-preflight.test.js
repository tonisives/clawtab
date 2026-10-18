let assert = require("node:assert/strict")
let fs = require("node:fs")
let os = require("node:os")
let path = require("node:path")
let { spawnSync } = require("node:child_process")
let { test } = require("node:test")
let { patchIapPreflight, patchInstalledPod } = require("../patch-iap-preflight")
let { addIosDeploymentTargetPatch, addIapPreflightPatch } = require("../withIapPreflightFix")
let { patchIapDiagnostics, purchaseInsertions, otherInsertions } = require("../patch-iap-diagnostics")

let sourceFixture = `import Foundation
    private func preflightInactiveUnfinishedSubscriptions(productId: String) async {
        let outcome = await withTaskGroup(of: Outcome.self) { group in }
    }

    private func isInactiveSubscriptionTransaction(_ transaction: Transaction) -> Bool {
        return false
    }
`

let diagnosticsFixture = sourceFixture + purchaseInsertions.map(([anchor]) => anchor).join("\n")
  + "\n    /// Buy the currently promoted product.\n"
  + otherInsertions.map(([anchor]) => anchor).join("\n") + "\n"

test("diagnostic stages cover the StoreKit handoff and callbacks and remain idempotent", () => {
  let patched = patchIapDiagnostics(patchIapPreflight(diagnosticsFixture))
  assert.equal(patchIapDiagnostics(patchIapPreflight(patched)), patched)
  assert.ok(patched.indexOf('record("storekit-purchase-called")') < patched.indexOf("return try await product.purchase("))
  assert.ok(patched.includes('record("native-update-listeners", code: listeners.count)'))
  assert.ok(patched.includes('record("subscription-preflight-start")'))
  assert.ok(patched.includes('record("storekit-threw", code: (error as NSError).code)'))
  assert.throws(() => patchIapDiagnostics(diagnosticsFixture.replace("product.purchase(confirmIn:", "product.purchaseChanged(confirmIn:")), /source changed/)
})

test("native patch replaces only the preflight method and is idempotent", () => {
  let patched = patchIapPreflight(sourceFixture)
  assert.ok(patched.startsWith("import Foundation\n"))
  assert.ok(patched.endsWith(sourceFixture.slice(sourceFixture.indexOf("    private func isInactive"))))
  assert.ok(patched.includes("AsyncStream<SubscriptionPreflightOutcome>"))
  assert.ok(!patched.includes("withTaskGroup"))
  assert.equal(patchIapPreflight(patched), patched)
})

test("an unexpected upstream implementation fails the build instead of silently skipping the fix", () => {
  assert.throws(() => patchIapPreflight("different source"), /source changed/)
  assert.throws(() => patchIapPreflight(sourceFixture.replace("await withTaskGroup(", "await changed(")), /source changed/)
})

test("Expo installs the patch inside CocoaPods post_install once", () => {
  let podfile = "target 'ClawTab' do\n  post_install do |installer|\n    react_native_post_install(installer)\n  end\nend\n"
  let patched = addIapPreflightPatch(podfile)
  assert.ok(patched.includes("installer.sandbox.root.to_s"))
  assert.ok(patched.indexOf("patch_script") < patched.indexOf("react_native_post_install"))
  assert.equal(addIapPreflightPatch(patched), patched)
  assert.throws(() => addIapPreflightPatch("unexpected podfile"), /hook not found/)
})

test("Expo raises legacy CocoaPods deployment targets to the app minimum once", () => {
  let podfile = "target 'ClawTab' do\n  post_install do |installer|\n    react_native_post_install(installer)\n  end\nend\n"
  let patched = addIosDeploymentTargetPatch(podfile)
  assert.ok(patched.includes("podfile_properties['ios.deploymentTarget'] || '16.4'"))
  assert.ok(patched.includes("Gem::Version.new(configured_target) < Gem::Version.new(minimum_ios_version)"))
  assert.ok(patched.indexOf("minimum_ios_version") < patched.indexOf("react_native_post_install"))
  assert.equal(addIosDeploymentTargetPatch(patched), patched)
  assert.throws(() => addIosDeploymentTargetPatch("unexpected podfile"), /hook not found/)
})

test("patches a read-only installed pod and preserves its permissions", (t) => {
  let temporary = fs.mkdtempSync(path.join(os.tmpdir(), "clawtab-iap-pod-test-"))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  let sourcePath = path.join(temporary, "openiap/packages/apple/Sources/OpenIapModule.swift")
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
  fs.writeFileSync(sourcePath, diagnosticsFixture, { mode: 0o444 })
  patchInstalledPod(temporary)
  patchInstalledPod(temporary)
  assert.ok(fs.readFileSync(sourcePath, "utf8").includes("bounded-subscription-preflight-v1"))
  assert.equal(fs.statSync(sourcePath).mode & 0o777, 0o444)
})

test("native Swift reproduction, timeout, cancellation, and late completion", { skip: process.platform !== "darwin" }, (t) => {
  let temporary = fs.mkdtempSync(path.join(os.tmpdir(), "clawtab-iap-swift-test-"))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  let replacement = fs.readFileSync(path.join(__dirname, "../iap-subscription-preflight.swift"), "utf8")
  let harness = fs.readFileSync(path.join(__dirname, "preflight-harness.swift"), "utf8")
    .replace("    // INSERT_PATCHED_PREFLIGHT", replacement)
  let sourcePath = path.join(temporary, "PreflightTests.swift")
  let binaryPath = path.join(temporary, "preflight-tests")
  fs.writeFileSync(sourcePath, harness)
  let compilation = spawnSync("xcrun", [
    "swiftc", "-j4", "-parse-as-library", "-module-cache-path", path.join(temporary, "module-cache"),
    sourcePath, "-o", binaryPath,
  ], { encoding: "utf8", timeout: 60_000 })
  assert.equal(compilation.status, 0, compilation.stderr || String(compilation.error))
  let execution = spawnSync(binaryPath, [], { encoding: "utf8", timeout: 10_000 })
  assert.equal(execution.status, 0, execution.stderr || String(execution.error))
  assert.equal(execution.stdout.match(/PASS:/g)?.length, 5, execution.stdout)
  process.stdout.write(execution.stdout)
})

test("native trace retention, concurrency, and privacy", { skip: process.platform !== "darwin" }, (t) => {
  let temporary = fs.mkdtempSync(path.join(os.tmpdir(), "clawtab-iap-trace-test-"))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  let helper = fs.readFileSync(path.join(__dirname, "../iap-native-trace.swift"), "utf8")
  let harness = fs.readFileSync(path.join(__dirname, "trace-harness.swift"), "utf8")
    .replace("// INSERT_NATIVE_TRACE", helper)
  let sourcePath = path.join(temporary, "TraceTests.swift")
  let binaryPath = path.join(temporary, "trace-tests")
  fs.writeFileSync(sourcePath, harness)
  let compilation = spawnSync("xcrun", [
    "swiftc", "-j4", "-parse-as-library", "-module-cache-path", path.join(temporary, "module-cache"),
    sourcePath, "-o", binaryPath,
  ], { encoding: "utf8", timeout: 60_000 })
  assert.equal(compilation.status, 0, compilation.stderr || String(compilation.error))
  let execution = spawnSync(binaryPath, [], { encoding: "utf8", timeout: 10_000 })
  assert.equal(execution.status, 0, execution.stderr || String(execution.error))
  assert.equal(execution.stdout.match(/PASS:/g)?.length, 2, execution.stdout)
  process.stdout.write(execution.stdout)
})
