import SwiftUI
import UIKit

/// SwiftUI `TabView(selection:)` does not publish when the already-selected tab
/// is tapped. This wraps `UITabBarController.delegate` so Chat / Education can
/// react. Returning `false` on a reselect blocks UIKit’s pop-to-root / scroll-to-top.
struct TabReselectObserver: UIViewControllerRepresentable {
    var onReselect: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onReselect: onReselect)
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
        context.coordinator.onReselect = onReselect
        context.coordinator.attach(from: uiViewController)
    }

    final class Coordinator: NSObject, UITabBarControllerDelegate {
        var onReselect: () -> Void
        private weak var original: (any UITabBarControllerDelegate)?
        private var lastReselectUptime: TimeInterval = 0

        init(onReselect: @escaping () -> Void) {
            self.onReselect = onReselect
        }

        func attach(from controller: UIViewController) {
            guard let tab = Self.findTabBarController(from: controller) else { return }
            if tab.delegate === self { return }
            original = tab.delegate
            tab.delegate = self
        }

        private func emitReselect() {
            let now = ProcessInfo.processInfo.systemUptime
            guard now - lastReselectUptime > 0.12 else { return }
            lastReselectUptime = now
            onReselect()
        }

        func tabBarController(
            _ tabBarController: UITabBarController,
            shouldSelect viewController: UIViewController
        ) -> Bool {
            if isReselect(tabBarController, viewController) {
                emitReselect()
                return false
            }
            return original?.tabBarController?(tabBarController, shouldSelect: viewController) ?? true
        }

        func tabBarController(
            _ tabBarController: UITabBarController,
            didSelect viewController: UIViewController
        ) {
            original?.tabBarController?(tabBarController, didSelect: viewController)
        }

        func tabBarController(_ tabBarController: UITabBarController, shouldSelectTab tab: UITab) -> Bool {
            if tabBarController.selectedTab == tab {
                emitReselect()
                return false
            }
            return original?.tabBarController?(tabBarController, shouldSelectTab: tab) ?? true
        }

        func tabBarController(
            _ tabBarController: UITabBarController,
            didSelectTab selectedTab: UITab,
            previousTab: UITab?
        ) {
            original?.tabBarController?(
                tabBarController,
                didSelectTab: selectedTab,
                previousTab: previousTab
            )
        }

        override func responds(to aSelector: Selector) -> Bool {
            if super.responds(to: aSelector) { return true }
            return original?.responds(to: aSelector) ?? false
        }

        override func forwardingTarget(for aSelector: Selector) -> Any? {
            if let original, original.responds(to: aSelector) { return original }
            return nil
        }

        private func isReselect(
            _ tabBarController: UITabBarController,
            _ viewController: UIViewController
        ) -> Bool {
            let current = tabBarController.selectedViewController
            if current === viewController { return true }
            guard let current,
                  let vcs = tabBarController.viewControllers,
                  let currentIndex = vcs.firstIndex(of: current),
                  let nextIndex = vcs.firstIndex(of: viewController)
            else { return false }
            return currentIndex == nextIndex
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
