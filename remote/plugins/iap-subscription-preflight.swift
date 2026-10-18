    private func preflightInactiveUnfinishedSubscriptions(productId: String) async {
        // ClawTab: bounded-subscription-preflight-v1
        // A task group waits for every child, even after cancelAll(). StoreKit
        // can ignore cancellation while enumerating or finishing transactions.
        NSLog("[ClawTabIAP] subscription-preflight-start")
        let (events, continuation) = AsyncStream<SubscriptionPreflightOutcome>.makeStream(
            bufferingPolicy: .bufferingOldest(1)
        )
        let cleanup = Task { [weak self] in
            if let self {
                await self.finishInactiveUnfinishedSubscriptions(productId: productId)
            }
            continuation.yield(.completed)
            continuation.finish()
        }
        let timeout = Task {
            do {
                try await Task.sleep(nanoseconds: Self.subscriptionPreflightTimeoutNanoseconds)
                continuation.yield(.timedOut)
                continuation.finish()
            } catch {
                // Cancellation means cleanup completed or the caller went away.
            }
        }
        continuation.onTermination = { @Sendable _ in
            cleanup.cancel()
            timeout.cancel()
        }
        var iterator = events.makeAsyncIterator()
        let outcome = await iterator.next() ?? .completed
        continuation.finish()
        cleanup.cancel()
        timeout.cancel()

        if case .timedOut = outcome {
            NSLog("[ClawTabIAP] subscription-preflight-timeout; continuing purchase")
        } else {
            NSLog("[ClawTabIAP] subscription-preflight-completed")
        }
    }
