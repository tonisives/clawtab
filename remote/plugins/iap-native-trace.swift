
// ClawTab: native-purchase-diagnostics-v1
// Only fixed stages and numeric error codes may enter this local, bounded log.
private enum ClawTabIapTrace {
    private static let lock = NSLock()
    private static let key = "ClawTabIapTrace.v1"

    static func record(_ stage: StaticString, code: Int? = nil) {
        lock.lock()
        defer { lock.unlock() }
        let now = Date().timeIntervalSince1970 * 1000
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
        var events = (UserDefaults.standard.array(forKey: key) as? [[String: Any]] ?? []).filter {
            ($0["time"] as? Double ?? 0) > now - 86_400_000 && $0["build"] as? String == build
        }
        var event: [String: Any] = ["stage": String(describing: stage), "time": now, "build": build]
        if let code { event["code"] = code }
        events.append(event)
        UserDefaults.standard.set(Array(events.suffix(100)), forKey: key)
        NSLog("[ClawTabIAP] %@", String(describing: stage))
    }
}
