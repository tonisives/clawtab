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

        // Keep the relay-assigned static category (CLAUDE_Q2/Q3/Q4) which is
        // pre-registered by the main app at startup. Dynamic category registration
        // from the NSE races with notification display and loses reliably.
        //
        // Instead, append the option labels to the body so the user can see them
        // in the notification itself (long press or expanded view).
        guard let clawtab = content.userInfo["clawtab"] as? [String: Any],
              let options = clawtab["options"] as? [[String: Any]],
              !options.isEmpty else {
            contentHandler(content)
            return
        }

        let buttonCount = min(options.count, 4)
        var labels: [String] = []
        for i in 0..<buttonCount {
            let opt = options[i]
            guard let number = opt["number"] as? String,
                  let label = opt["label"] as? String else { continue }
            labels.append("\(number). \(label)")
        }

        if !labels.isEmpty {
            let existing = content.body
            content.body = existing + "\n" + labels.joined(separator: "  |  ")
        }

        contentHandler(content)
    }

    override func serviceExtensionTimeWillExpire() {
        if let contentHandler = contentHandler, let content = bestAttemptContent {
            contentHandler(content)
        }
    }
}
