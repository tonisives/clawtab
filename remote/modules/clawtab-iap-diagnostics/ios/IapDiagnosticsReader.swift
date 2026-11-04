import Foundation

enum IapDiagnosticsReader {
    static let stages: Set<String> = [
        "native-request-entered", "native-request-exited", "native-connection-ready",
        "native-product-ready", "native-options-ready", "native-preflight-returned",
        "storekit-threw", "storekit-success", "storekit-cancelled", "storekit-pending",
        "scene-missing", "scene-foreground-active", "scene-not-foreground-active",
        "scene-has-presented-controller", "storekit-purchase-called", "native-update-listeners",
        "native-update-duplicate", "native-error-emitted", "native-error-listeners",
        "subscription-preflight-start", "subscription-preflight-completed",
        "subscription-preflight-timeout; continuing purchase"
    ]

    static func read() -> String {
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
        let cutoff = Date().timeIntervalSince1970 * 1000 - 86_400_000
        let events = UserDefaults.standard.array(forKey: "ClawTabIapTrace.v1") as? [[String: Any]] ?? []
        let formatter = ISO8601DateFormatter()
        return events.filter {
            ($0["time"] as? Double ?? 0) > cutoff && $0["build"] as? String == build
        }.suffix(40).compactMap { event -> String? in
            guard let stage = event["stage"] as? String, stages.contains(stage),
                  let time = event["time"] as? Double else { return nil }
            let stamp = formatter.string(from: Date(timeIntervalSince1970: time / 1000))
            let code = (event["code"] as? Int).map { " code=\($0)" } ?? ""
            return "\(stamp) \(stage)\(code)"
        }.joined(separator: "\n")
    }
}
