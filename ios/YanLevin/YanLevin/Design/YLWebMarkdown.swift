import SwiftUI
import WebKit

/// Site markdown + KaTeX 0.16.22, same files as /education.
struct YLWebMarkdownText: View {
    let source: String
    let fg: Color
    let accent: Color
    @State private var height: CGFloat = 24

    var body: some View {
        YLWebMarkdownView(source: source, fg: fg, accent: accent, height: $height)
            .frame(height: height)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct YLWebMarkdownView: UIViewRepresentable {
    let source: String
    let fg: Color
    let accent: Color
    @Binding var height: CGFloat

    func makeCoordinator() -> Coordinator {
        Coordinator(height: $height)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(context.coordinator, name: "ylHeight")
        let prefs = WKWebpagePreferences()
        prefs.allowsContentJavaScript = true
        config.defaultWebpagePreferences = prefs

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.isScrollEnabled = false
        web.scrollView.bounces = false
        web.scrollView.backgroundColor = .clear
        context.coordinator.webView = web
        context.coordinator.load(source: source, fg: fg, accent: accent)
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        context.coordinator.webView = web
        context.coordinator.load(source: source, fg: fg, accent: accent)
    }

    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
        web.configuration.userContentController.removeScriptMessageHandler(forName: "ylHeight")
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var height: Binding<CGFloat>
        weak var webView: WKWebView?
        private var lastKey = ""

        init(height: Binding<CGFloat>) {
            self.height = height
        }

        func load(source: String, fg: Color, accent: Color) {
            let key = "\(source)\u{1e}\(Self.cssHex(fg))\u{1e}\(Self.cssHex(accent))"
            guard key != lastKey else { return }
            lastKey = key
            guard let css = Bundle.main.url(forResource: "katex.min", withExtension: "css") else { return }
            let html = Self.pageHTML(source: source, fg: fg, accent: accent)
            webView?.loadHTMLString(html, baseURL: css.deletingLastPathComponent())
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            let value: CGFloat
            if let n = message.body as? CGFloat {
                value = n
            } else if let n = message.body as? Double {
                value = CGFloat(n)
            } else if let n = message.body as? Int {
                value = CGFloat(n)
            } else {
                return
            }
            let next = max(24, ceil(value))
            DispatchQueue.main.async {
                if abs(self.height.wrappedValue - next) > 0.5 {
                    self.height.wrappedValue = next
                }
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard navigationAction.navigationType == .linkActivated,
                  let url = navigationAction.request.url
            else {
                decisionHandler(.allow)
                return
            }
            decisionHandler(.cancel)
            UIApplication.shared.open(Self.resolvedURL(url))
        }

        private static func resolvedURL(_ url: URL) -> URL {
            if url.scheme == "http" || url.scheme == "https" || url.scheme == "mailto" {
                return url
            }
            let path = url.path
            if path.hasPrefix("/education") {
                var parts = URLComponents(string: "https://yanylevin.com")
                parts?.path = path
                parts?.query = url.query
                parts?.fragment = url.fragment
                if let abs = parts?.url { return abs }
            }
            return url
        }

        private static func cssHex(_ color: Color) -> String {
            let ui = UIColor(color)
            var r: CGFloat = 0
            var g: CGFloat = 0
            var b: CGFloat = 0
            var a: CGFloat = 0
            ui.getRed(&r, green: &g, blue: &b, alpha: &a)
            return String(format: "#%02X%02X%02X", Int((r * 255).rounded()), Int((g * 255).rounded()), Int((b * 255).rounded()))
        }

        private static func pageHTML(source: String, fg: Color, accent: Color) -> String {
            let payload = Data(source.utf8).base64EncodedString()
            let fgHex = cssHex(fg)
            let accentHex = cssHex(accent)
            return """
            <!DOCTYPE html>
            <html>
            <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
            <link rel="stylesheet" href="katex.min.css">
            <style>
              :root { --fg: \(fgHex); --accent: \(accentHex); }
              html, body {
                margin: 0;
                padding: 0;
                background: transparent;
                color: var(--fg);
                font: 17px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
                -webkit-text-size-adjust: 100%;
                word-wrap: break-word;
                overflow-wrap: anywhere;
                overflow-x: hidden;
              }
              .md-body { word-break: break-word; }
              .md-body > :first-child { margin-top: 0; }
              .md-body > :last-child { margin-bottom: 0; }
              .md-body p { margin: 0 0 0.55em; }
              .md-body h1, .md-body h2, .md-body h3, .md-body h4, .md-body h5, .md-body h6 {
                margin: 0.7em 0 0.35em; line-height: 1.25;
              }
              .md-body h1 { font-size: 20px; font-weight: 700; }
              .md-body h2 { font-size: 17px; font-weight: 600; }
              .md-body h3, .md-body h4, .md-body h5, .md-body h6 { font-size: 15px; font-weight: 600; }
              .md-body ul, .md-body ol { margin: 0.3em 0 0.55em; padding-left: 1.25em; }
              .md-body li { margin: 0.12em 0; }
              .md-body code {
                font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                font-size: 0.9em;
                background: color-mix(in srgb, currentColor 10%, transparent);
                padding: 0.08em 0.28em;
                border-radius: 4px;
              }
              .md-body pre {
                margin: 0.45em 0;
                overflow-x: auto;
                white-space: pre;
                background: color-mix(in srgb, currentColor 8%, transparent);
                padding: 0.7em 0.8em;
                border-radius: 10px;
              }
              .md-body pre code { font-size: 0.86em; background: none; padding: 0; }
              .md-body a { color: var(--accent); }
              .md-body blockquote {
                margin: 0.4em 0;
                padding-left: 0.75em;
                border-left: 2px solid currentColor;
                opacity: 0.88;
              }
              .md-body hr {
                border: 0;
                border-top: 1px solid currentColor;
                opacity: 0.22;
                margin: 0.7em 0;
              }
              .md-body table { border-collapse: collapse; font-size: 0.92em; }
              .md-body th, .md-body td {
                border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
                padding: 0.22em 0.5em;
                text-align: left;
                vertical-align: top;
              }
              .md-body img { max-width: 100%; height: auto; }
              .md-math { font-style: italic; color: inherit; white-space: nowrap; }
              .md-math .katex, .md-math .katex *,
              .md-math-block .katex, .md-math-block .katex * {
                color: inherit;
                word-break: normal;
                overflow-wrap: normal;
              }
              .md-math:not(.md-math--display) .katex { font-size: 1.05em; white-space: nowrap; }
              .md-math:has(.katex), .md-math-block { font-style: normal; }
              .md-math-block, .md-math--display {
                display: block;
                box-sizing: border-box;
                max-width: 100%;
                min-width: 0;
                margin: 0.85rem 0;
                padding: 0.1rem 0;
                overflow-x: auto;
                overflow-y: hidden;
                text-align: center;
                white-space: nowrap;
                font-style: normal;
                background: transparent;
                border: 0;
                box-shadow: none;
                -webkit-overflow-scrolling: touch;
              }
              .md-math-block .katex, .md-math--display .katex { white-space: nowrap; font-style: normal; }
              .md-math-block .katex-display, .md-math--display .katex-display {
                margin: 0.15em 0;
                overflow: visible;
                text-align: center;
              }
            </style>
            </head>
            <body>
            <div class="md-body" id="out"></div>
            <script src="katex.min.js"></script>
            <script src="markdown.js"></script>
            <script>
              function decodeB64(s) {
                const bin = atob(s);
                const bytes = Uint8Array.from(bin, function (c) { return c.charCodeAt(0); });
                return new TextDecoder().decode(bytes);
              }
              function postHeight() {
                const root = document.documentElement;
                const h = Math.ceil(Math.max(root.scrollHeight, document.body.scrollHeight, 24));
                if (window.webkit && window.webkit.messageHandlers.ylHeight) {
                  window.webkit.messageHandlers.ylHeight.postMessage(h);
                }
              }
              document.getElementById("out").innerHTML = YLMarkdown.render(decodeB64("\(payload)"));
              if (document.fonts && document.fonts.ready) {
                document.fonts.ready.then(postHeight);
              }
              window.addEventListener("load", postHeight);
              postHeight();
              setTimeout(postHeight, 50);
              setTimeout(postHeight, 200);
            </script>
            </body>
            </html>
            """
        }
    }
}
