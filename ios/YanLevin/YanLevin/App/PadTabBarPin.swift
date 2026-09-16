import SwiftUI
import UIKit

/// iPad `.sidebarAdaptable` TabView starts as the top pill (we ask for that),
/// but UIKit still restores `UITabSidebar` / landscape-sidebar on a warm
/// foreground. Cold launch looks right because those keys are stripped before
/// TabView builds; leaving the app and coming back does not. Force the pill
/// again on resume. The sidebar toggle still works after that.
struct PadTabBarPin: UIViewControllerRepresentable {
    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIViewController(context: Context) -> UIViewController {
        let controller = UIViewController()
        controller.view.isUserInteractionEnabled = false
        controller.view.backgroundColor = .clear
        DispatchQueue.main.async {
            context.coordinator.attach(from: controller)
        }
        return controller
    }

    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {
        context.coordinator.attach(from: uiViewController)
    }

    static func clearPersistedSidebarState() {
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: "com.apple.UIKit.UISplitViewController.Root")
        defaults.removeObject(forKey: "com.apple.UIKit.UITabSidebar")
    }

    final class Coordinator {
        /// True = top pill. Set from the sidebar toggle while the scene is
        /// active, outside the post-resume pin window. Home / app switch
        /// always snaps back to the pill.
        private var userWantsTabBar = true
        private var applying = false
        private var pinningUntil = Date.distantPast
        private var pinWork: [DispatchWorkItem] = []
        private var hiddenObservation: NSKeyValueObservation?
        private var notifications: [NSObjectProtocol] = []
        private weak var tabBarController: UITabBarController?

        init() {
            let center = NotificationCenter.default
            notifications = [
                center.addObserver(
                    forName: UIApplication.willEnterForegroundNotification,
                    object: nil,
                    queue: .main
                ) { [weak self] _ in
                    self?.pinAfterResume(resetToTabBar: true)
                },
                center.addObserver(
                    forName: UIApplication.didBecomeActiveNotification,
                    object: nil,
                    queue: .main
                ) { [weak self] _ in
                    self?.pinAfterResume(resetToTabBar: false)
                }
            ]
        }

        deinit {
            hiddenObservation?.invalidate()
            pinWork.forEach { $0.cancel() }
            notifications.forEach { NotificationCenter.default.removeObserver($0) }
        }

        func attach(from controller: UIViewController) {
            guard AdaptiveLayout.isPad else { return }
            guard let tab = Self.findTabBarController(from: controller) else { return }
            if tabBarController === tab, hiddenObservation != nil { return }
            tabBarController = tab
            observeHidden(on: tab)
            pinAfterResume(resetToTabBar: false)
        }

        private func observeHidden(on tab: UITabBarController) {
            hiddenObservation?.invalidate()
            hiddenObservation = tab.sidebar.observe(\.isHidden, options: [.new]) { [weak self] sidebar, _ in
                self?.sidebarHiddenDidChange(sidebar.isHidden)
            }
        }

        private func pinAfterResume(resetToTabBar: Bool) {
            PadTabBarPin.clearPersistedSidebarState()
            if resetToTabBar {
                userWantsTabBar = true
            }
            pinningUntil = Date().addingTimeInterval(2.0)
            applyPreferred()
            pinWork.forEach { $0.cancel() }
            pinWork = [0.05, 0.2, 0.5, 1.0, 1.8].map { delay in
                let work = DispatchWorkItem { [weak self] in
                    self?.applyPreferred()
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
                return work
            }
        }

        private func sidebarHiddenDidChange(_ hidden: Bool) {
            if applying { return }
            if Date() < pinningUntil {
                if hidden != userWantsTabBar {
                    applyPreferred()
                }
                return
            }
            guard UIApplication.shared.applicationState == .active else {
                applyPreferred()
                return
            }
            userWantsTabBar = hidden
        }

        private func applyPreferred() {
            guard let tab = tabBarController else { return }
            let wantHidden = userWantsTabBar
            guard tab.sidebar.isHidden != wantHidden else { return }
            applying = true
            tab.sidebar.isHidden = wantHidden
            applying = false
        }

        private static func findTabBarController(from controller: UIViewController) -> UITabBarController? {
            if let tab = controller as? UITabBarController { return tab }
            if let tab = controller.tabBarController { return tab }
            var parent = controller.parent
            while let current = parent {
                if let tab = current as? UITabBarController { return tab }
                if let tab = current.tabBarController { return tab }
                parent = current.parent
            }
            guard let root = controller.view.window?.rootViewController
                    ?? controller.viewIfLoaded?.window?.rootViewController
            else { return nil }
            return deepestTab(from: root)
        }

        private static func deepestTab(from root: UIViewController) -> UITabBarController? {
            if let tab = root as? UITabBarController { return tab }
            for child in root.children {
                if let found = deepestTab(from: child) { return found }
            }
            if let presented = root.presentedViewController {
                return deepestTab(from: presented)
            }
            return root.tabBarController
        }
    }
}
