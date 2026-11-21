import AppKit
import WebKit

final class Bench: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let app = NSApplication.shared
    var webview: WKWebView!
    var timeout: Timer?
    func start(_ url: URL) {
        let content = WKUserContentController()
        content.add(self, name: "qa")
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController = content
        webview = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: config)
        webview.navigationDelegate = self
        timeout = Timer.scheduledTimer(withTimeInterval: 90, repeats: false) { _ in
            fputs("WKWebView timeout\n", stderr); exit(2)
        }
        webview.load(URLRequest(url: url))
        app.run()
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let result = message.body as? String else { fputs("Invalid QA result\n", stderr); exit(2) }
        print(result); fflush(stdout)
        timeout?.invalidate()
        exit(0)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fputs("Navigation error: \(error)\n", stderr); exit(2)
    }
}
guard CommandLine.arguments.count == 2, let url = URL(string: CommandLine.arguments[1]), url.host == "127.0.0.1" else {
    fputs("Expected loopback test URL\n", stderr); exit(2)
}
let bench = Bench()
bench.start(url)
