// Expo config plugin: injects native notification action handler into AppDelegate.
// Survives prebuild regeneration.
const { withAppDelegate } = require("expo/config-plugins");

function withNativeAnswer(config) {
  return withAppDelegate(config, (config) => {
    let contents = config.modResults.contents;

    // Add import if not present
    if (!contents.includes("import UserNotifications")) {
      contents = contents.replace(
        "import Expo",
        "import Expo\nimport UserNotifications",
      );
    }

    // Add UNUserNotificationCenterDelegate conformance
    contents = contents.replace(
      "public class AppDelegate: ExpoAppDelegate {",
      "public class AppDelegate: ExpoAppDelegate, UNUserNotificationCenterDelegate {",
    );

    // Add delegate assignment in didFinishLaunchingWithOptions, before the return
    contents = contents.replace(
      "return super.application(application, didFinishLaunchingWithOptions: launchOptions)",
      `UNUserNotificationCenter.current().delegate = self

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)`,
    );

    // Add the handler methods and helpers before the closing brace of AppDelegate
    const handlerCode = `
  // MARK: - Native notification action handler (injected by with-native-answer plugin)

  public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let actionId = response.actionIdentifier
    if actionId == UNNotificationDefaultActionIdentifier || actionId == UNNotificationDismissActionIdentifier {
      completionHandler()
      return
    }

    let userInfo = response.notification.request.content.userInfo
    guard let clawtab = userInfo["clawtab"] as? [String: Any],
          let questionId = clawtab["question_id"] as? String,
          let paneId = clawtab["pane_id"] as? String else {
      completionHandler()
      return
    }

    NSLog("[ClawTab] action tapped: question=%@ answer=%@", questionId, actionId)
    nativePostAnswer(questionId: questionId, paneId: paneId, answer: actionId, completion: completionHandler)
  }

  public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .list, .sound])
  }

  private func nativePostAnswer(questionId: String, paneId: String, answer: String, completion: @escaping () -> Void) {
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
      kSecAttrService as String: "app",
      kSecAttrAccount as String: k, kSecAttrGeneric as String: k,
      kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var r: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &r) == errSecSuccess, let d = r as? Data else { return nil }
    return String(data: d, encoding: .utf8)
  }

  private func writeKeychain(_ key: String, value: String) {
    guard let k = key.data(using: .utf8), let v = value.data(using: .utf8) else { return }
    let q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "app",
      kSecAttrAccount as String: k, kSecAttrGeneric as String: k,
    ]
    let u: [String: Any] = [kSecValueData as String: v]
    if SecItemUpdate(q as CFDictionary, u as CFDictionary) == errSecItemNotFound {
      var a = q; a[kSecValueData as String] = v
      a[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
      SecItemAdd(a as CFDictionary, nil)
    }
  }
`;

    // Insert before the last closing brace of the AppDelegate class
    // Find "}\n\nclass ReactNativeDelegate" and insert before it
    contents = contents.replace(
      "}\n\nclass ReactNativeDelegate",
      `${handlerCode}}\n\nclass ReactNativeDelegate`,
    );

    config.modResults.contents = contents;
    return config;
  });
}

module.exports = withNativeAnswer;
