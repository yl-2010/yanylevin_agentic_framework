import SwiftUI
import UIKit

/// iPhone only: the orange beam behind the native prominent Chat tab circle,
/// so it shines through the tab's glass. The tab bar stays fully native; this
/// only slips a non-interactive view in at the back of `UITabBar` and follows
/// the circle's frame (it moves when the bar minimizes or relayouts).
struct YLChatTabGlow: UIViewRepresentable {
    let active: Bool
    let palette: YLPalette

    func makeUIView(context: Context) -> Probe { Probe() }

    func updateUIView(_ probe: Probe, context: Context) {
        probe.update(active: active, palette: palette, scheme: context.environment.colorScheme)
    }

    static func dismantleUIView(_ probe: Probe, coordinator: ()) {
        probe.teardown()
    }

    final class Probe: UIView {
        /// Room around the 62pt circle for the bloom.
        private static let pad: CGFloat = 28
        private var host: UIHostingController<GlowContent>?
        private var link: CADisplayLink?
        private var content = GlowContent(active: false, palette: .standard, scheme: .light, side: 62)
        private var stopWork: DispatchWorkItem?

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
            isHidden = true
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError() }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window == nil { stopTracking() } else if content.active { startTracking() }
        }

        func update(active: Bool, palette: YLPalette, scheme: ColorScheme) {
            content.active = active
            content.palette = palette
            content.scheme = scheme
            host?.rootView = content
            stopWork?.cancel()
            if active {
                startTracking()
            } else if link != nil {
                // Keep following the circle while the beam fades out.
                let work = DispatchWorkItem { [weak self] in self?.stopTracking() }
                stopWork = work
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: work)
            }
        }

        func teardown() {
            stopWork?.cancel()
            stopTracking()
            host?.view.removeFromSuperview()
            host = nil
        }

        private func startTracking() {
            guard link == nil, window != nil else { return }
            let link = CADisplayLink(target: self, selector: #selector(tick))
            link.add(to: .main, forMode: .common)
            self.link = link
            tick()
        }

        private func stopTracking() {
            link?.invalidate()
            link = nil
        }

        @objc private func tick() {
            guard let window, let tabBar = Self.tabBar(in: window),
                  let circle = Self.prominentPlatter(in: tabBar)
            else {
                host?.view.isHidden = true
                return
            }
            let host = ensureHost(in: tabBar)
            let frame = circle.convert(circle.bounds, to: tabBar)
            let side = min(frame.width, frame.height)
            if content.side != side {
                content.side = side
                host.rootView = content
            }
            let target = frame.insetBy(dx: -Self.pad, dy: -Self.pad)
            if host.view.frame != target { host.view.frame = target }
            host.view.isHidden = circle.isHidden || circle.alpha < 0.01
            host.view.alpha = circle.alpha
            if tabBar.subviews.first !== host.view { tabBar.sendSubviewToBack(host.view) }
        }

        private func ensureHost(in tabBar: UITabBar) -> UIHostingController<GlowContent> {
            if let host, host.view.superview === tabBar { return host }
            let host = self.host ?? UIHostingController(rootView: content)
            host.view.backgroundColor = .clear
            host.view.isUserInteractionEnabled = false
            host.safeAreaRegions = []
            host.view.removeFromSuperview()
            tabBar.insertSubview(host.view, at: 0)
            self.host = host
            return host
        }

        private static func tabBar(in window: UIWindow) -> UITabBar? {
            func find(_ vc: UIViewController?) -> UITabBarController? {
                guard let vc else { return nil }
                if let tbc = vc as? UITabBarController { return tbc }
                for child in vc.children {
                    if let tbc = find(child) { return tbc }
                }
                return nil
            }
            return find(window.rootViewController)?.tabBar
        }

        /// The prominent tab's circle is a platter inside the bar's auxiliary view.
        private static func prominentPlatter(in tabBar: UITabBar) -> UIView? {
            for sub in tabBar.subviews where String(describing: type(of: sub)).contains("AuxiliaryView") {
                return sub.subviews.first { String(describing: type(of: $0)).contains("Platter") } ?? sub
            }
            return nil
        }
    }

    struct GlowContent: View {
        var active: Bool
        var palette: YLPalette
        var scheme: ColorScheme
        var side: CGFloat

        var body: some View {
            Color.clear
                .frame(width: side, height: side)
                .ylBorderBeam(cornerRadius: side / 2, active: active, lineWidth: 2.5)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .environment(\.ylPalette, palette)
                .environment(\.colorScheme, scheme)
        }
    }
}
