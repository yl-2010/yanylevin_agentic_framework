import UIKit

/// Finger-follows the software keyboard from a horizontal history-drawer drag.
/// iOS will not scrub the keys from a horizontal pan, so this translates the
/// keyboard host (and the composer, via the accessory chrome) by the same
/// 0…1 progress as the drawer.
@MainActor
enum YLKeyboardScrub {
    private static weak var chrome: YLKeyboardAccessoryChrome?
    private static weak var keyboardHost: UIView?
    private static var coverage: CGFloat = 0
    private static var keyboardFrame: CGRect = .zero
    private static var active = false

    static func register(_ chrome: YLKeyboardAccessoryChrome) {
        self.chrome = chrome
    }

    static func unregister(_ chrome: YLKeyboardAccessoryChrome) {
        if self.chrome === chrome {
            self.chrome = nil
        }
    }

    static var canBegin: Bool {
        chrome?.keyboardScrubMetrics() != nil
    }

    static func begin() {
        active = true
        guard let chrome else { return }
        guard let metrics = chrome.keyboardScrubMetrics() else { return }
        coverage = metrics.coverage
        keyboardFrame = metrics.frame
        chrome.beginKeyboardScrub(lift: metrics.lift)
        keyboardHost = findKeyboardHost(matching: metrics.frame, chrome: chrome)
    }

    static func setProgress(_ raw: CGFloat) {
        guard active else { return }
        let p = min(max(raw, 0), 1)
        chrome?.setKeyboardScrubProgress(p)
        if keyboardHost == nil, let chrome, keyboardFrame.height > 1 {
            keyboardHost = findKeyboardHost(matching: keyboardFrame, chrome: chrome)
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        keyboardHost?.transform = CGAffineTransform(translationX: 0, y: p * coverage)
        CATransaction.commit()
    }

    static func commitHide() {
        guard active else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        UIView.setAnimationsEnabled(false)
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil
        )
        keyboardHost?.transform = .identity
        chrome?.endKeyboardScrub(resetTransform: true, keyboardHidden: true)
        UIView.setAnimationsEnabled(true)
        CATransaction.commit()
        keyboardHost = nil
        active = false
        coverage = 0
        keyboardFrame = .zero
    }

    static func cancel() {
        guard active else { return }
        setProgress(0)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        keyboardHost?.transform = .identity
        CATransaction.commit()
        chrome?.endKeyboardScrub(resetTransform: true)
        keyboardHost = nil
        active = false
        coverage = 0
        keyboardFrame = .zero
    }

    /// Picks the view whose on-screen frame matches the last keyboard end
    /// frame. Skips the accessory chrome and anything that would slide the
    /// whole app. Falls back to a non-key window that overlaps the keys.
    private static func findKeyboardHost(
        matching keyboardScreenFrame: CGRect,
        chrome: YLKeyboardAccessoryChrome
    ) -> UIView? {
        guard keyboardScreenFrame.height > 20 else { return nil }
        var best: UIView?
        var bestScore = CGFloat.greatestFiniteMagnitude

        func consider(_ view: UIView) {
            if view === chrome || view.isDescendant(of: chrome) { return }
            if chrome.isDescendant(of: view) { return }
            let frame = view.convert(view.bounds, to: nil)
            guard frame.height > 30 else { return }
            if frame.height > keyboardScreenFrame.height * 1.8 { return }
            let score = abs(frame.minY - keyboardScreenFrame.minY)
                + abs(frame.maxY - keyboardScreenFrame.maxY)
                + abs(frame.height - keyboardScreenFrame.height)
            guard score < bestScore else { return }
            bestScore = score
            best = view
        }

        func walk(_ view: UIView) {
            consider(view)
            for sub in view.subviews { walk(sub) }
        }

        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            for window in windowScene.windows {
                walk(window)
            }
        }

        if bestScore < 160, let best { return best }

        guard let chromeWindow = chrome.window else { return nil }
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            for window in windowScene.windows {
                if window === chromeWindow || window.isHidden || window.alpha < 0.01 {
                    continue
                }
                let frame = window.convert(window.bounds, to: nil)
                let overlap = frame.intersection(keyboardScreenFrame)
                if overlap.height > keyboardScreenFrame.height * 0.5 {
                    return window
                }
            }
        }
        return nil
    }
}
