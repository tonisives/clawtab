import Foundation

// INSERT_NATIVE_TRACE

@main
struct TraceTests {
    static func main() {
        let key = "ClawTabIapTrace.v1"
        let defaults = UserDefaults.standard
        defer { defaults.removeObject(forKey: key) }
        defaults.set([
            ["time": 0, "stage": "expired", "build": "unknown"],
            ["time": Date().timeIntervalSince1970 * 1000, "stage": "old-build", "build": "different"],
        ], forKey: key)
        ClawTabIapTrace.record("native-request-entered")
        let initial = defaults.array(forKey: key) as! [[String: Any]]
        precondition(initial.count == 1)
        precondition(initial[0]["stage"] as? String == "native-request-entered")
        print("PASS: native stages discard expired and previous-build entries")

        DispatchQueue.concurrentPerform(iterations: 120) { _ in
            ClawTabIapTrace.record("storekit-purchase-called")
        }
        ClawTabIapTrace.record("storekit-threw", code: 42)
        let events = defaults.array(forKey: key) as! [[String: Any]]
        precondition(events.count == 100)
        precondition(events.last?["code"] as? Int == 42)
        precondition(events.allSatisfy { Set($0.keys).isSubset(of: ["stage", "time", "build", "code"]) })
        print("PASS: native stages are concurrency-safe, bounded, and contain only approved fields")
    }
}
