import UIKit
import WebKit

/// 餐饮日报 iOS 壳：WKWebView 加载内置的离线日报，
/// 并把「分享 / 数据源 / 状态栏 / 外链」这几件网页做不到的事交给原生。
final class WebViewController: UIViewController {

    private let remoteKey = "canyin.remote"
    private let statusBarLightKey = "canyin.statusbar.light"

    private var webView: WKWebView!
    private var didFallback = false

    private var remoteURL: String {
        UserDefaults.standard.string(forKey: remoteKey) ?? ""
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        return UserDefaults.standard.bool(forKey: statusBarLightKey) ? .darkContent : .lightContent
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.userContentController.add(self, name: "appBridge")
        config.userContentController.addUserScript(WKUserScript(
            source: Self.bridgeShim(remote: remoteURL),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))

        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.backgroundColor = UIColor(red: 0.949, green: 0.953, blue: 0.945, alpha: 1)

        view.backgroundColor = webView.backgroundColor
        view.addSubview(webView)

        loadInitial()
    }

    // MARK: - 加载

    private func loadInitial() {
        didFallback = false
        let remote = remoteURL
        if !remote.isEmpty, let url = URL(string: remote),
           let scheme = url.scheme, scheme.hasPrefix("http") {
            webView.load(URLRequest(url: url))
        } else {
            loadBundled()
        }
    }

    private func loadBundled() {
        guard let file = Bundle.main.url(forResource: "index", withExtension: "html",
                                        subdirectory: "www") else {
            assertionFailure("内置页面缺失：www/index.html")
            return
        }
        webView.loadFileURL(file, allowingReadAccessTo: file.deletingLastPathComponent())
    }

    /// 远端打不开就退回内置离线版，保证任何时候都能看。
    private func fallbackToBundled() {
        guard !didFallback, !remoteURL.isEmpty else { return }
        didFallback = true
        loadBundled()
    }

    // MARK: - JS 桥（与 Android 端同名同形，页面代码两端通用）

    private static func bridgeShim(remote: String) -> String {
        let payload = (try? JSONSerialization.data(withJSONObject: [remote],
                                                   options: []))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
        return """
        (function () {
          var remote = \(payload)[0];
          function post(action, value) {
            try { window.webkit.messageHandlers.appBridge.postMessage({ action: action, value: value }); }
            catch (e) {}
          }
          window.AppBridge = {
            isApp: function () { return true; },
            appVersion: function () { return "1.0"; },
            getRemote: function () { return remote; },
            setRemote: function (u) { remote = u || ""; post("setRemote", remote); },
            reload: function () { post("reload", ""); },
            share: function (text) { post("share", text); },
            setStatusBarColor: function (hex) { post("setStatusBarColor", hex); }
          };
        })();
        """
    }

    // MARK: - 外链

    private func openOutside(_ url: URL) -> Bool {
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "file" || scheme == "data" || scheme == "about" {
            return false
        }
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
        return true
    }
}

// MARK: - WKNavigationDelegate

extension WebViewController: WKNavigationDelegate {

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        if url.isFileURL || url.scheme == "about" {
            decisionHandler(.allow)
            return
        }
        // 页面本身（远端数据源）留在 App 内，其他链接跳系统浏览器 / 微信
        if let host = url.host, host == URL(string: remoteURL)?.host {
            decisionHandler(.allow)
            return
        }
        if navigationAction.navigationType == .linkActivated || navigationAction.targetFrame == nil {
            if openOutside(url) {
                decisionHandler(.cancel)
                return
            }
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        fallbackToBundled()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fallbackToBundled()
    }
}

// MARK: - WKUIDelegate（prompt / alert / target=_blank）

extension WebViewController: WKUIDelegate {

    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, url.scheme?.hasPrefix("http") == true {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "知道了", style: .default) { _ in
            completionHandler()
        })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: prompt, message: nil, preferredStyle: .alert)
        alert.addTextField { field in
            field.text = defaultText
            field.keyboardType = .URL
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
        }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in
            completionHandler(nil)
        })
        alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in
            completionHandler(alert.textFields?.first?.text ?? "")
        })
        present(alert, animated: true)
    }
}

// MARK: - 桥接消息

extension WebViewController: WKScriptMessageHandler {

    func userContentController(_ userContentController: WKUserContentController,
                              didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }
        let value = body["value"] as? String ?? ""

        switch action {
        case "setRemote":
            UserDefaults.standard.set(value, forKey: remoteKey)
        case "reload":
            loadInitial()
        case "share":
            let controller = UIActivityViewController(activityItems: [value],
                                                      applicationActivities: nil)
            if let pop = controller.popoverPresentationController {
                pop.sourceView = view
                pop.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY, width: 1, height: 1)
            }
            present(controller, animated: true)
        case "setStatusBarColor":
            let hex = value.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
            if hex.count == 6, let rgb = UInt32(hex, radix: 16) {
                let r = CGFloat((rgb >> 16) & 0xFF) / 255.0
                let g = CGFloat((rgb >> 8) & 0xFF) / 255.0
                let b = CGFloat(rgb & 0xFF) / 255.0
                let luminance = 0.299 * r + 0.587 * g + 0.114 * b
                UserDefaults.standard.set(luminance > 0.6, forKey: statusBarLightKey)
                view.backgroundColor = UIColor(red: r, green: g, blue: b, alpha: 1)
                setNeedsStatusBarAppearanceUpdate()
            }
        default:
            break
        }
    }
}
