import Cocoa
import WebKit

// Isolated WKWebView with Tauri's packaged scheme and production CSP.
// Arguments: built fixture directory, src-tauri/tauri.conf.json.
final class Probe: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKURLSchemeHandler {
  var web: WKWebView!
  var window: NSWindow!
  let root = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
  lazy var csp: String = {
    let data = try! Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
    let json = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
    return ((json["app"] as! [String: Any])["security"] as! [String: Any])["csp"] as! String
  }()
  func applicationDidFinishLaunching(_ notification: Notification) {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    config.userContentController.add(self, name: "out")
    config.setURLSchemeHandler(self, forURLScheme: "tauri")
    let width = CommandLine.arguments.count > 3 ? (Double(CommandLine.arguments[3]) ?? 350) : 350
    let height = CommandLine.arguments.count > 4 ? (Double(CommandLine.arguments[4]) ?? 100) : 100
    web = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: config)
    window = NSWindow(contentRect: web.frame, styleMask: [.titled], backing: .buffered, defer: false)
    window.title = "Oarlock regex worker test"
    window.contentView = web
    window.orderFrontRegardless()
    web.load(URLRequest(url: URL(string: "tauri://localhost/index.html")!))
    DispatchQueue.main.asyncAfter(deadline: .now() + (CommandLine.arguments.count > 5 ? Double(CommandLine.arguments[5]) ?? 10 : 10)) { print("FAILED: webview deadline"); fflush(stdout); exit(1) }
  }
  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    let url = task.request.url!
    let path = root.appendingPathComponent(url.path).standardizedFileURL
    guard path.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: path) else {
      task.didFailWithError(NSError(domain: "RegexProbe", code: 1)); return
    }
    let mime = path.pathExtension == "html" ? "text/html" : "text/javascript"
    let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": mime, "Content-Security-Policy": csp])!
    task.didReceive(response); task.didReceive(data); task.didFinish()
  }
  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    let text = "\(message.body)"
    print(text); fflush(stdout)
    let result = text.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
    exit(result?["passed"] as? Bool == true ? 0 : 1)
  }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let probe = Probe()
app.delegate = probe
app.run()
