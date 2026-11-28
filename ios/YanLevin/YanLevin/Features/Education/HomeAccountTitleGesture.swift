import SwiftUI
import UIKit

/// Three taps in the blank space to the right of the large Home title.
/// The first and the third have to land within 0.5 seconds. Nothing is drawn.
struct HomeAccountTitleGesture: UIViewRepresentable {
    var armed: Bool
    var onOpen: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onOpen: onOpen)
    }

    func makeUIView(context: Context) -> AnchorView {
        let view = AnchorView()
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear
        view.onMoveToWindow = { [weak coordinator = context.coordinator] anchor in
            coordinator?.attach(from: anchor)
        }
        return view
    }

    func updateUIView(_ uiView: AnchorView, context: Context) {
        context.coordinator.onOpen = onOpen
        context.coordinator.setArmed(armed)
        context.coordinator.attach(from: uiView)
    }

    final class AnchorView: UIView {
        var onMoveToWindow: ((UIView) -> Void)?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard window != nil else { return }
            onMoveToWindow?(self)
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var onOpen: () -> Void
        private var armed = false
        private var taps: [TimeInterval] = []
        private weak var hostView: UIView?
        private var recognizer: UITapGestureRecognizer?

        init(onOpen: @escaping () -> Void) {
            self.onOpen = onOpen
        }

        deinit {
            if let recognizer, let hostView {
                hostView.removeGestureRecognizer(recognizer)
            }
        }

        func setArmed(_ armed: Bool) {
            if !armed {
                taps.removeAll()
            }
            self.armed = armed
        }

        func attach(from anchor: UIView) {
            guard let nav = anchor.nearestNavigationController, let host = nav.view else { return }
            guard hostView !== host else { return }
            if let recognizer, let old = hostView {
                old.removeGestureRecognizer(recognizer)
            }
            let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap))
            tap.numberOfTapsRequired = 1
            tap.numberOfTouchesRequired = 1
            tap.cancelsTouchesInView = false
            tap.delaysTouchesBegan = false
            tap.delaysTouchesEnded = false
            tap.delegate = self
            host.addGestureRecognizer(tap)
            recognizer = tap
            hostView = host
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldReceive touch: UITouch
        ) -> Bool {
            guard armed, let host = gestureRecognizer.view else { return false }
            let point = touch.location(in: host)
            if let hit = host.hitTest(point, with: nil), hit is UIControl {
                return false
            }
            guard let title = homeTitleLabel(in: host) else { return false }
            let titleFrame = title.convert(title.bounds, to: host)
            let inRow = point.y >= titleFrame.minY - 6 && point.y <= titleFrame.maxY + 8
            let rightOfTitle = point.x > titleFrame.maxX + 4
            let onScreen = point.x < host.bounds.maxX - 2
            return inRow && rightOfTitle && onScreen
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            true
        }

        @objc private func handleTap() {
            guard armed else { return }
            let now = ProcessInfo.processInfo.systemUptime
            taps.removeAll { now - $0 > 0.5 }
            taps.append(now)
            guard taps.count >= 3, let first = taps.first, now - first <= 0.5 else { return }
            taps.removeAll()
            onOpen()
        }

        /// The large left-aligned Home title, not a "Home" string inside the scroll view.
        private func homeTitleLabel(in root: UIView) -> UILabel? {
            var match: UILabel?
            var matchY = CGFloat.greatestFiniteMagnitude
            func walk(_ view: UIView) {
                if let label = view as? UILabel,
                   label.text == "Home",
                   !label.isHidden,
                   label.alpha > 0.01,
                   label.font.pointSize >= 30,
                   label.bounds.width > 8,
                   !isInsideScrollView(label) {
                    let frame = label.convert(label.bounds, to: root)
                    if frame.minY < 280, frame.minY < matchY {
                        match = label
                        matchY = frame.minY
                    }
                }
                for child in view.subviews {
                    walk(child)
                }
            }
            walk(root)
            return match
        }

        private func isInsideScrollView(_ view: UIView) -> Bool {
            var current: UIView? = view.superview
            while let node = current {
                if node is UIScrollView { return true }
                current = node.superview
            }
            return false
        }
    }
}

private extension UIView {
    var nearestNavigationController: UINavigationController? {
        var responder: UIResponder? = self
        while let current = responder {
            if let nav = current as? UINavigationController {
                return nav
            }
            responder = current.next
        }
        return nil
    }
}
