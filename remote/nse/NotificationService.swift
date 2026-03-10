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

        // Extract options from the clawtab payload to create action buttons
        // with real labels (e.g. "1. Yes" instead of just "1")
        guard let clawtab = content.userInfo["clawtab"] as? [String: Any],
              let options = clawtab["options"] as? [[String: Any]],
              !options.isEmpty else {
            contentHandler(content)
            return
        }

        var actions: [UNNotificationAction] = []

        // Show up to 4 button actions (iOS limit)
        let buttonCount = min(options.count, 4)
        for i in 0..<buttonCount {
            let opt = options[i]
            guard let number = opt["number"] as? String,
                  let label = opt["label"] as? String else { continue }
            actions.append(UNNotificationAction(
                identifier: number,
                title: "\(number). \(label)",
                options: []
            ))
        }

        // Use a per-question category so each notification gets its own labels
        let categoryId = "CLAUDE_DYN_\(clawtab["question_id"] as? String ?? UUID().uuidString)"
        let category = UNNotificationCategory(
            identifier: categoryId,
            actions: actions,
            intentIdentifiers: [],
            options: []
        )

        // Register the dynamic category and update the notification to use it
        let center = UNUserNotificationCenter.current()
        center.getNotificationCategories { existing in
            var categories = existing
            categories.insert(category)
            center.setNotificationCategories(categories)

            content.categoryIdentifier = categoryId
            contentHandler(content)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        if let contentHandler = contentHandler, let content = bestAttemptContent {
            contentHandler(content)
        }
    }
}
