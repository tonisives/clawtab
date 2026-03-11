// Expo config plugin: injects native notification action handler into AppDelegate.
// Works with expo-notifications by registering as a NotificationDelegate.
const { withAppDelegate } = require("expo/config-plugins");

function withNativeAnswer(config) {
  return withAppDelegate(config, (config) => {
    let contents = config.modResults.contents;

    // Add imports
    if (!contents.includes("import UserNotifications")) {
      contents = contents.replace(
        "import Expo",
        "import Expo\nimport UserNotifications\nimport EXNotifications",
      );
    }

    // Add registration call in didFinishLaunchingWithOptions
    contents = contents.replace(
      "return super.application(application, didFinishLaunchingWithOptions: launchOptions)",
      `// Register native answer handler with expo-notifications
    let handler = NativeAnswerHandler()
    objc_setAssociatedObject(self, "nativeAnswerHandler", handler, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    NotificationCenterManager.shared.addDelegate(handler)
    NSLog("[ClawTab] NativeAnswerHandler registered")
    NSLog("[ClawTab] keychain check: access_token=%@, refresh_token=%@, server_url=%@",
      handler.hasKey("clawtab_access_token") ? "YES" : "NO",
      handler.hasKey("clawtab_refresh_token") ? "YES" : "NO",
      handler.hasKey("clawtab_server_url") ? "YES" : "NO")

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)`,
    );

    // Append the NativeAnswerHandler class at the end
    contents += `

class NativeAnswerHandler: NSObject, NotificationDelegate {

  func hasKey(_ key: String) -> Bool {
    return readKeychain(key) != nil
  }

  func didReceive(_ response: UNNotificationResponse, completionHandler: @escaping () -> Void) -> Bool {
    let actionId = response.actionIdentifier
    if actionId == UNNotificationDefaultActionIdentifier || actionId == UNNotificationDismissActionIdentifier {
      return false
    }

    let userInfo = response.notification.request.content.userInfo
    guard let clawtab = userInfo["clawtab"] as? [String: Any],
          let questionId = clawtab["question_id"] as? String,
          let paneId = clawtab["pane_id"] as? String else {
      return false
    }

    // For text input actions, use the typed text as the answer
    let answer: String
    if let textResponse = response as? UNTextInputNotificationResponse {
      answer = textResponse.userText
    } else {
      answer = actionId
    }

    NSLog("[ClawTab] action tapped: question=%@ answer=%@", questionId, answer)

    // Request our own background execution time. The shared completionHandler
    // gets called immediately by EmitterModule and NotificationCenterManager,
    // so we can't rely on it to keep the process alive for our HTTP request.
    let taskId = UIApplication.shared.beginBackgroundTask(withName: "ClawTabAnswer") {
      NSLog("[ClawTab] background task expired")
    }
    NSLog("[ClawTab] background task started: %d", taskId.rawValue)

    postAnswer(questionId: questionId, paneId: paneId, answer: answer) {
      NSLog("[ClawTab] ending background task: %d", taskId.rawValue)
      UIApplication.shared.endBackgroundTask(taskId)
    }

    return true
  }

  private func postAnswer(questionId: String, paneId: String, answer: String, completion: @escaping () -> Void) {
    let serverUrl = readKeychain("clawtab_server_url") ?? "https://relay.clawtab.cc"
    guard let token = readKeychain("clawtab_access_token") else {
      NSLog("[ClawTab] no access token, trying refresh")
      refreshAndPost(serverUrl: serverUrl, questionId: questionId, paneId: paneId, answer: answer, completion: completion)
      return
    }
    doPost(serverUrl: serverUrl, token: token, questionId: questionId, paneId: paneId, answer: answer) { status in
      if status == 401 {
        NSLog("[ClawTab] 401, refreshing")
        self.refreshAndPost(serverUrl: serverUrl, questionId: questionId, paneId: paneId, answer: answer, completion: completion)
      } else {
        NSLog("[ClawTab] answer posted, status=%d", status ?? 0)
        completion()
      }
    }
  }

  private func refreshAndPost(serverUrl: String, questionId: String, paneId: String, answer: String, completion: @escaping () -> Void) {
    guard let rt = readKeychain("clawtab_refresh_token") else {
      NSLog("[ClawTab] no refresh token")
      completion()
      return
    }
    let url = URL(string: "\\(serverUrl)/auth/refresh")!
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: ["refresh_token": rt])
    URLSession.shared.dataTask(with: req) { data, response, error in
      guard let http = response as? HTTPURLResponse, http.statusCode == 200,
            let data = data,
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let newAccess = json["access_token"] as? String,
            let newRefresh = json["refresh_token"] as? String else {
        NSLog("[ClawTab] refresh failed: %@", error?.localizedDescription ?? "bad response")
        completion()
        return
      }
      self.writeKeychain("clawtab_access_token", value: newAccess)
      self.writeKeychain("clawtab_refresh_token", value: newRefresh)
      self.doPost(serverUrl: serverUrl, token: newAccess, questionId: questionId, paneId: paneId, answer: answer) { status in
        NSLog("[ClawTab] answer after refresh, status=%d", status ?? 0)
        completion()
      }
    }.resume()
  }

  private func doPost(serverUrl: String, token: String, questionId: String, paneId: String, answer: String, completion: @escaping (Int?) -> Void) {
    let url = URL(string: "\\(serverUrl)/api/answer")!
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("Bearer \\(token)", forHTTPHeaderField: "Authorization")
    req.httpBody = try? JSONSerialization.data(withJSONObject: [
      "question_id": questionId, "pane_id": paneId, "answer": answer,
    ])
    URLSession.shared.dataTask(with: req) { _, response, error in
      if let error = error { NSLog("[ClawTab] POST error: %@", error.localizedDescription) }
      completion((response as? HTTPURLResponse)?.statusCode)
    }.resume()
  }

  private func readKeychain(_ key: String) -> String? {
    guard let k = key.data(using: .utf8) else { return nil }
    let q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "app:no-auth",
      kSecAttrAccount as String: k, kSecAttrGeneric as String: k,
      kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var r: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &r) == errSecSuccess, let d = r as? Data else {
      NSLog("[ClawTab] keychain read MISS for %@", key)
      return nil
    }
    NSLog("[ClawTab] keychain read HIT for %@", key)
    return String(data: d, encoding: .utf8)
  }

  private func writeKeychain(_ key: String, value: String) {
    guard let k = key.data(using: .utf8), let v = value.data(using: .utf8) else { return }
    let q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "app:no-auth",
      kSecAttrAccount as String: k, kSecAttrGeneric as String: k,
    ]
    let u: [String: Any] = [kSecValueData as String: v]
    if SecItemUpdate(q as CFDictionary, u as CFDictionary) == errSecItemNotFound {
      var a = q; a[kSecValueData as String] = v
      a[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
      SecItemAdd(a as CFDictionary, nil)
    }
  }
}
`;

    config.modResults.contents = contents;
    return config;
  });
}

module.exports = withNativeAnswer;
