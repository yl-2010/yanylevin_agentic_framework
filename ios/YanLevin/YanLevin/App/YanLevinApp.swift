import SwiftUI
import UIKit

@main
struct YanLevinApp: App {
    @StateObject private var auth = AuthStore.shared
    @StateObject private var theme = ThemeStore()
    @StateObject private var educationFocus = EducationFocusStore()
    @StateObject private var nav = AppNavigationStore.shared
    @Environment(\.scenePhase) private var scenePhase
    @State private var showLaunchCover = true

    init() {
        UIWindow.appearance().backgroundColor = UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(YLTheme.darkBg0)
                : UIColor(YLTheme.lightBg0)
        }
        PhoneLocationReporter.shared.restoreFromAppGroup()
    }

    var body: some Scene {
        WindowGroup {
            ZStack {
                RootTabView()
                if showLaunchCover {
                    AppLoadingScreen()
                        .transition(.opacity)
                }
            }
            .environmentObject(auth)
            .environmentObject(theme)
            .environmentObject(educationFocus)
            .environmentObject(nav)
            .preferredColorScheme(theme.preferredColorScheme)
            .tint(YLTheme.accent)
            .onAppear {
                YLHaptics.prepareSession()
                nav.consumePendingNewChatIfNeeded()
                nav.consumePendingOpenTodoIfNeeded()
                DispatchQueue.main.async {
                    withAnimation(.easeOut(duration: 0.32)) {
                        showLaunchCover = false
                    }
                }
            }
            .onOpenURL { url in
                auth.handleOpenURL(url)
                nav.handleOpenURL(url)
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    YLHaptics.prepareSession()
                    nav.consumePendingNewChatIfNeeded()
                    nav.consumePendingOpenTodoIfNeeded()
                }
                PhoneLocationReporter.shared.handleScenePhase(phase)
            }
        }
    }
}
