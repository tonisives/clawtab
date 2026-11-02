import UIKit
import WebKit

@main
final class App: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds)
        let notifications = ProcessInfo.processInfo.arguments.contains("--notifications")
        window?.rootViewController = UINavigationController(rootViewController: SelectionController(shellOnly: !notifications))
        window?.makeKeyAndVisible()
        return true
    }
}

final class SelectionController: UIViewController, WKScriptMessageHandler, UIScrollViewDelegate {
    private let status = UILabel()
    private let input = UITextView()
    private var web: WKWebView!
    private let shellOnly: Bool

    init(shellOnly: Bool) { self.shellOnly = shellOnly; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("Use init(shellOnly:)") }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = shellOnly ? "Details" : "Notifications"
        navigationItem.backButtonTitle = "Back"
        if !shellOnly { navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Details", style: .plain, target: self, action: #selector(openDetails)) }
        view.backgroundColor = .black
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "probe")
        let nativeKeyboard = !ProcessInfo.processInfo.arguments.contains("--legacy-web-input")
        config.userContentController.addUserScript(WKUserScript(source: "window.__nativeKeyboard = \(nativeKeyboard); window.__shellOnly = \(shellOnly);", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: .zero, configuration: config)
        web.scrollView.isScrollEnabled = false
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.delegate = self
        status.textColor = .white
        status.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        status.accessibilityIdentifier = "Selection status"
        input.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
        input.alpha = 0
        input.autocorrectionType = .no
        input.autocapitalizationType = .none
        view.addSubview(input)
        for child in [status, web!] {
            child.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(child)
        }
        NSLayoutConstraint.activate([
            status.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            status.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            status.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            status.heightAnchor.constraint(equalToConstant: 32),
            web.topAnchor.constraint(equalTo: status.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            web.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        ])
        let url = Bundle.main.url(forResource: "fixture", withExtension: "html")!
        web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        // Match react-native-webview's scrollEnabled=false behavior.
        scrollView.bounds = web.bounds
    }

    @objc private func openDetails() { navigationController?.pushViewController(SelectionController(shellOnly: true), animated: false) }
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        input.resignFirstResponder()
        web.evaluateJavaScript("window.nfn.receive({type:'mobile_visibility',active:false})", completionHandler: nil)
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        web.evaluateJavaScript("window.nfn?.receive({type:'mobile_visibility',active:true});setTimeout(window.reportSelection,150)", completionHandler: nil)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if let value = message.body as? String { status.text = value }
        if let value = message.body as? [String: Any] {
            if value["native"] as? String == "shell_keyboard" {
                if value["active"] as? Bool == true { input.becomeFirstResponder() }
                else { input.resignFirstResponder() }
            }
            if value["native"] as? String == "selection_gesture", value["active"] as? Bool == true { input.resignFirstResponder() }
        }
    }
}
