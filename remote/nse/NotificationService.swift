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

        // Register the dynamic category, then deliver after a short delay
        // to give iOS time to process the registration.
        UNUserNotificationCenter.current().setNotificationCategories(Set([category]))

        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) {
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
