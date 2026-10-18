let fs = require("node:fs")
let path = require("node:path")
let { patchIapDiagnostics } = require("./patch-iap-diagnostics")

let marker = "// ClawTab: bounded-subscription-preflight-v1"
let methodStart = "    private func preflightInactiveUnfinishedSubscriptions(productId: String) async {"
let methodEnd = "    private func isInactiveSubscriptionTransaction("
let replacement = fs.readFileSync(path.join(__dirname, "iap-subscription-preflight.swift"), "utf8")

let patchIapPreflight = (source) => {
  let start = source.indexOf(methodStart)
  let end = source.indexOf(methodEnd, start)
  let method = source.slice(start, end)
  if (start < 0 || end < 0 || (!method.includes(marker) && !method.includes("await withTaskGroup("))) {
    throw new Error("IAP preflight fix: OpenIAP source changed; review the native patch before building")
  }
  return source.slice(0, start) + replacement + "\n" + source.slice(end)
}

let patchInstalledPod = (podsRoot) => {
  let relativePath = "packages/apple/Sources/OpenIapModule.swift"
  let candidates = ["OpenIAP", "openiap"].map((name) => path.join(podsRoot, name, relativePath))
  let sourcePath = candidates.find((candidate) => fs.existsSync(candidate))
  if (!sourcePath) throw new Error("IAP preflight fix: installed OpenIAP source not found")
  let source = fs.readFileSync(sourcePath, "utf8")
  let patched = patchIapDiagnostics(patchIapPreflight(source))
  if (patched !== source) {
    // CocoaPods downloads sources read-only. Preserve the original permissions.
    let mode = fs.statSync(sourcePath).mode
    try {
      fs.chmodSync(sourcePath, mode | 0o200)
      fs.writeFileSync(sourcePath, patched)
    } finally {
      fs.chmodSync(sourcePath, mode)
    }
  }
  process.stdout.write("IAP native preflight timeout patch verified\n")
  process.stdout.write("IAP native purchase diagnostics v1 verified\n")
}

if (require.main === module) {
  if (!process.argv[2]) throw new Error("Usage: node patch-iap-preflight.js <Pods directory>")
  patchInstalledPod(path.resolve(process.argv[2]))
}

module.exports = { patchIapPreflight, patchInstalledPod }
