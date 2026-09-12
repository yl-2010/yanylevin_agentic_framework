import UIKit
import HomeKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    static var shared: AppDelegate?
    private var started = false

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        AppDelegate.shared = self
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
            guard !HomeCLI.finished else { return }
            HomeCLI.fail("timeout: HomeKit did not become ready in 60s. Grant HomeKit to yl-home in System Settings > Privacy & Security.")
        }
        return true
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
        config.delegateClass = HeadlessSceneDelegate.self
        return config
    }

    func startHomeKitIfNeeded() {
        guard !started else { return }
        started = true
        HomeCLI.run()
    }
}

/// Tiny window so TCC can prompt (macOS 26.4+ crashes if HomeKit starts with no scene).
final class HeadlessSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        #if targetEnvironment(macCatalyst)
        windowScene.sizeRestrictions?.minimumSize = CGSize(width: 1, height: 1)
        windowScene.sizeRestrictions?.maximumSize = CGSize(width: 1, height: 1)
        #endif
        let window = UIWindow(windowScene: windowScene)
        window.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
        window.rootViewController = UIViewController()
        window.alpha = 0
        window.isHidden = false
        self.window = window
        AppDelegate.shared?.startHomeKitIfNeeded()
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        #if targetEnvironment(macCatalyst)
        if let windowScene = scene as? UIWindowScene {
            for window in windowScene.windows {
                window.isHidden = true
            }
        }
        #endif
    }
}
