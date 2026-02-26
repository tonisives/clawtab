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
            // No clawtab payload or no options - deliver as-is
            contentHandler(content)
            return
        }

        let actions = options.compactMap { option -> UNNotificationAction? in
            guard let number = option["number"], let label = option["label"] else {
                return nil
            }
            return UNNotificationAction(
                identifier: number,
                title: label,
                options: []
            )
        }

        if actions.isEmpty {
            contentHandler(content)
            return
        }

        // Use a per-question category ID to avoid collisions between concurrent notifications
        let categoryId = "CLAUDE_QUESTION_\(questionId)"

        let category = UNNotificationCategory(
            identifier: categoryId,
            actions: actions,
            intentIdentifiers: [],
            options: []
        )

        // Register this dynamic category, then update the notification to use it
        UNUserNotificationCenter.current().getNotificationCategories { existing in
            var categories = existing
            categories.insert(category)
            UNUserNotificationCenter.current().setNotificationCategories(categories)

            content.categoryIdentifier = categoryId
            contentHandler(content)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        // Deliver whatever we have so far
        if let contentHandler = contentHandler, let content = bestAttemptContent {
            contentHandler(content)
        }
    }
}
