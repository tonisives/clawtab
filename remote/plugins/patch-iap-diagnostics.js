let fs = require("node:fs")
let path = require("node:path")
let helper = fs.readFileSync(path.join(__dirname, "iap-native-trace.swift"), "utf8")
let marker = "// ClawTab: native-purchase-diagnostics-v1"
let sceneAnchor = "        return try await product.purchase(confirmIn: scene, options: options)"

// Exact single-occurrence anchors: fail visibly when the vendor implementation changes.
let purchaseInsertions = [
  ["    public func requestPurchase(_ params: RequestPurchaseProps) async throws -> RequestPurchaseResult? {", '\n        ClawTabIapTrace.record("native-request-entered")\n        defer { ClawTabIapTrace.record("native-request-exited") }'],
  ["        let iosProps = try resolveIOSPurchaseProps(from: params)", '\n        ClawTabIapTrace.record("native-connection-ready")'],
  ["        let product = try await storeProduct(for: sku)", '\n        ClawTabIapTrace.record("native-product-ready")'],
  ["        let options = try StoreKitTypesBridge.purchaseOptions(from: iosProps, product: product)", '\n        ClawTabIapTrace.record("native-options-ready")'],
  ["        let result: StoreKit.Product.PurchaseResult", '\n        ClawTabIapTrace.record("native-preflight-returned")'],
  ["            // Enhanced error handling for promotional offers", '\n            ClawTabIapTrace.record("storekit-threw", code: (error as NSError).code)'],
  ["        switch result {\n        case .success(let verification):", '\n            ClawTabIapTrace.record("storekit-success")'],
  ["        case .userCancelled:\n            let error = makePurchaseError(code: .userCancelled, productId: sku)", '\n            ClawTabIapTrace.record("storekit-cancelled")'],
  ["        case .pending:\n            let error = makePurchaseError(code: .deferredPayment, productId: sku)", '\n            ClawTabIapTrace.record("storekit-pending")'],
]
let otherInsertions = [
  ["        guard let scene = activeWindowScene() else {", '\n            ClawTabIapTrace.record("scene-missing")'],
  [sceneAnchor, null],
  ["            let listeners = state.snapshotPurchaseUpdated(isDuplicate: isDuplicate)", '\n            ClawTabIapTrace.record("native-update-listeners", code: listeners.count)\n            if isDuplicate { ClawTabIapTrace.record("native-update-duplicate") }'],
  ["        guard !Self.suppressPurchaseErrorEmission else { return }", '\n        ClawTabIapTrace.record("native-error-emitted")'],
  ["            let listeners = state.snapshotPurchaseError()", '\n            ClawTabIapTrace.record("native-error-listeners", code: listeners.count)'],
]
let insertions = [...purchaseInsertions, ...otherInsertions]

let sceneCall = `        if scene.activationState == .foregroundActive {
            ClawTabIapTrace.record("scene-foreground-active")
        } else {
            ClawTabIapTrace.record("scene-not-foreground-active")
        }
        if scene.windows.contains(where: { $0.isKeyWindow && $0.rootViewController?.presentedViewController != nil }) {
            ClawTabIapTrace.record("scene-has-presented-controller")
        }
        ClawTabIapTrace.record("storekit-purchase-called")
        return try await product.purchase(confirmIn: scene, options: options)`

let patchIapDiagnostics = (source) => {
  // Strip our exact additions before reapplying so upgrades to the patch stay idempotent.
  let markerPosition = source.indexOf(marker)
  if (markerPosition >= 0) source = source.slice(0, markerPosition).trimEnd() + "\n"
  source = source.replace(sceneCall, sceneAnchor)
  for (let [anchor, addition] of insertions) {
    if (addition) source = source.replace(anchor + addition, anchor)
  }
  let requestStart = source.indexOf(insertions[0][0])
  let requestEnd = source.indexOf("    /// Buy the currently promoted product.", requestStart)
  if (requestStart < 0 || requestEnd < 0) throw new Error("IAP diagnostics: purchase method boundaries changed")
  let request = source.slice(requestStart, requestEnd)
  let other = source.slice(requestEnd)
  for (let [index, [anchor, addition]] of insertions.entries()) {
    let section = index < purchaseInsertions.length ? request : other
    if (section.split(anchor).length !== 2) {
      throw new Error("IAP diagnostics: native source changed; review stage anchors before building")
    }
    section = section.replace(anchor, addition ? anchor + addition : sceneCall)
    if (index < purchaseInsertions.length) request = section
    else other = section
  }
  source = source.slice(0, requestStart) + request + other
  for (let stage of ["start", "completed", "timeout; continuing purchase"]) {
    let label = `subscription-preflight-${stage}`
    source = source.replace(`NSLog("[ClawTabIAP] ${label}")`, `ClawTabIapTrace.record("${label}")`)
  }
  return source.trimEnd() + "\n" + helper
}

module.exports = { patchIapDiagnostics, purchaseInsertions, otherInsertions }
