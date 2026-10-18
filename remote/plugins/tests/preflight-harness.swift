import Foundation

actor CleanupGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var released = false
    private(set) var started = false
    private(set) var finished = false

    func wait() async {
        started = true
        if !released {
            // Deliberately ignores cancellation, like a stalled StoreKit call.
            await withCheckedContinuation { continuation = $0 }
        }
        finished = true
    }

    func release() {
        released = true
        continuation?.resume()
        continuation = nil
    }
}

actor Completion {
    private(set) var finished = false
    func finish() { finished = true }
}

final class PreflightHarness: @unchecked Sendable {
    private static let subscriptionPreflightTimeoutNanoseconds: UInt64 = 20_000_000
    private enum SubscriptionPreflightOutcome { case completed, timedOut }
    let gate = CleanupGate()

    private func finishInactiveUnfinishedSubscriptions(productId: String) async {
        await gate.wait()
    }

    // INSERT_PATCHED_PREFLIGHT

    func run() async {
        await preflightInactiveUnfinishedSubscriptions(productId: "test-subscription")
    }

    func legacyPreflight() async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.gate.wait() }
            group.addTask {
                try? await Task.sleep(nanoseconds: Self.subscriptionPreflightTimeoutNanoseconds)
            }
            await group.next()
            group.cancelAll()
        }
    }
}

@main
struct PreflightTests {
    static func waitFor(_ predicate: () async -> Bool) async {
        for _ in 0..<200 {
            if await predicate() { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        fatalError("Native preflight did not settle within one second")
    }

    static func main() async {
        let original = PreflightHarness()
        let originalCompletion = Completion()
        let originalTask = Task {
            await original.legacyPreflight()
            await originalCompletion.finish()
        }
        await waitFor { await original.gate.started }
        try? await Task.sleep(nanoseconds: 80_000_000)
        let originalReturned = await originalCompletion.finished
        precondition(!originalReturned, "Original task-group timeout unexpectedly returned")
        await original.gate.release()
        await originalTask.value
        print("PASS: reproduced original timeout waiting for cancelled cleanup")

        let stalled = PreflightHarness()
        let stalledCompletion = Completion()
        let stalledTask = Task {
            await stalled.run()
            await stalledCompletion.finish()
        }
        await waitFor { await stalledCompletion.finished }
        let cleanupFinished = await stalled.gate.finished
        precondition(!cleanupFinished, "Test must keep cleanup suspended beyond the deadline")
        await stalled.gate.release()
        await stalledTask.value
        await waitFor { await stalled.gate.finished }
        print("PASS: patched timeout returns before non-cooperative cleanup completes")

        let immediate = PreflightHarness()
        await immediate.gate.release()
        await immediate.run()
        let immediateFinished = await immediate.gate.finished
        precondition(immediateFinished)
        print("PASS: successful cleanup completes normally")

        let cancelled = PreflightHarness()
        let cancelledCompletion = Completion()
        let cancelledTask = Task {
            await cancelled.run()
            await cancelledCompletion.finish()
        }
        await waitFor { await cancelled.gate.started }
        cancelledTask.cancel()
        await waitFor { await cancelledCompletion.finished }
        await cancelled.gate.release()
        await cancelledTask.value
        print("PASS: caller cancellation releases the waiter")

        // Let late completions run; they must not resume a continuation twice.
        try? await Task.sleep(nanoseconds: 50_000_000)
        print("PASS: late cleanup completion is safe")
    }
}
