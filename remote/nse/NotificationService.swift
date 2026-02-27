import UserNotifications

class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        bestAttemptContent = request.content.mutableCopy() as? UNMutableNotificationContent

        guard let content = bestAttemptContent else {
            contentHandler(request.content)
            return
        }

        guard let clawtab = request.content.userInfo["clawtab"] as? [String: Any],
              let options = clawtab["options"] as? [[String: String]],
              let questionId = clawtab["question_id"] as? String,
              !options.isEmpty
        else {
            contentHandler(content)
            return
        }

        let actions = options.compactMap { option -> UNNotificationAction? in
            guard let number = option["number"], let label = option["label"] else {
                return nil
            }
            return UNNotificationAction(
                identifier: number,
                title: "\(number). \(label)",
                options: []
            )
        }

        if actions.isEmpty {
            contentHandler(content)
            return
        }

        let categoryId = "CLAUDE_QUESTION_\(questionId)"

        let category = UNNotificationCategory(
            identifier: categoryId,
            actions: actions,
            intentIdentifiers: [],
            options: []
        )

        // Register category and wait for completion before delivering.
        // Use a semaphore to ensure setNotificationCategories has been
        // processed before we call contentHandler.
        let semaphore = DispatchSemaphore(value: 0)

        UNUserNotificationCenter.current().getNotificationCategories { existing in
            var categories = existing
            // Remove any stale CLAUDE_QUESTION_ categories to keep the set small
            categories = categories.filter { !$0.identifier.hasPrefix("CLAUDE_QUESTION_") }
            categories.insert(category)
            UNUserNotificationCenter.current().setNotificationCategories(categories)
            semaphore.signal()
        }

        // Wait up to 2 seconds for category registration
        _ = semaphore.wait(timeout: .now() + 2.0)

        content.categoryIdentifier = categoryId
        contentHandler(content)
    }

    override func serviceExtensionTimeWillExpire() {
        if let contentHandler = contentHandler, let content = bestAttemptContent {
            contentHandler(content)
        }
    }
}
