import SwiftUI

enum RootTab: Hashable {
    case home
    case fitness
    case chat
    case education
    case account

    static func defaultTab(fullAccess: Bool) -> RootTab {
        fullAccess ? .chat : .home
    }

    /// iOS 27 TabView crashes if selection points at a tab that is not in the
    /// current set (Apple 164516837). Signed-in chrome has no Home; guests have
    /// no Fitness / Education.
    static func clamped(_ tab: RootTab, fullAccess: Bool) -> RootTab {
        if fullAccess {
            return tab == .home ? .chat : tab
        }
        switch tab {
        case .fitness, .education: return .home
        default: return tab
        }
    }
}

/// App entry behavior:
/// - Cold launch from the app icon → Chat tab, fresh Personal Agent thread
///   (ChatView starts fresh whenever it first enters the Personal Agent).
/// - Warm foreground from the app icon → untouched; picks up where it left off.
/// - Lock-screen Chat control / `yanylevin://chat` → always Chat tab + fresh
///   thread, warm or cold, via the `chatHandoffStartNew` handoff below
///   (backed by the App Group pending flag when the intent runs out of process).
/// - Todo widget title tap / `yanylevin://todo` → Education tab, that todo's
///   expanded view (circle tap checks the item without opening the app).
@MainActor
final class AppNavigationStore: ObservableObject {
    static let shared = AppNavigationStore()

    @Published var selectedTab: RootTab

    private init() {
        selectedTab = RootTab.defaultTab(fullAccess: AppGroupStore.hasFullAccess)
    }

    /// Keep `selectedTab` inside the tabs the current auth state actually shows.
    /// Call this in the same turn as `AuthStore.session` changes; `onChange` is
    /// too late (the TabView has already laid out).
    func adoptAccess(fullAccess: Bool) {
        if fullAccess {
            if selectedTab == .home {
                selectedTab = .chat
            }
            return
        }
        selectedTab = .home
    }

    @Published var chatHandoffID = UUID()
    @Published var chatHandoffAttachments: [PendingChatAttachment] = []
    @Published var chatHandoffPreferPersonalAgent = false
    @Published var chatHandoffStartNew = false
    /// Widget / `yanylevin://todo` handoff until Education has a tree to open.
    @Published var educationTodoHandoff: PendingOpenTodo?
    /// Bumped when the user taps the already-selected tab (UIKit intercept).
    @Published var tabReselectGeneration = 0

    func openChat(startNew: Bool = false) {
        selectedTab = .chat
        guard startNew else { return }
        chatHandoffPreferPersonalAgent = true
        chatHandoffStartNew = true
        chatHandoffID = UUID()
    }

    func noteTabReselect() {
        tabReselectGeneration += 1
    }

    func handleOpenURL(_ url: URL) {
        guard url.scheme == "yanylevin" else { return }
        if url.host == "chat" {
            openChat(startNew: true)
            return
        }
        if url.host == "todo" {
            openEducationTodo(from: url)
        }
    }

    func openEducationTodo(from url: URL) {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func val(_ name: String) -> String? {
            items.first(where: { $0.name == name })?.value.flatMap { $0.isEmpty ? nil : $0 }
        }
        guard let todoId = val("id") else {
            selectedTab = .education
            return
        }
        openEducationTodo(todoId: todoId, classId: val("classId"), projectId: val("projectId"))
    }

    func openEducationTodo(todoId: String, classId: String?, projectId: String?) {
        selectedTab = .education
        educationTodoHandoff = PendingOpenTodo(
            todoId: todoId,
            classId: classId.flatMap { $0.isEmpty ? nil : $0 },
            projectId: projectId.flatMap { $0.isEmpty ? nil : $0 },
            stamp: Date().timeIntervalSince1970
        )
    }

    func consumePendingNewChatIfNeeded() {
        if educationTodoHandoff != nil || AppGroupStore.hasPendingOpenTodo() { return }
        if chatHandoffStartNew {
            _ = AppGroupStore.consumePendingNewChat()
            selectedTab = .chat
            return
        }
        guard AppGroupStore.consumePendingNewChat() else { return }
        openChat(startNew: true)
    }

    func consumePendingOpenTodoIfNeeded() {
        if educationTodoHandoff != nil {
            selectedTab = .education
            _ = AppGroupStore.consumePendingOpenTodo()
            return
        }
        guard let pending = AppGroupStore.consumePendingOpenTodo() else { return }
        selectedTab = .education
        educationTodoHandoff = pending
    }

    func openPersonalAgent(attaching files: [PendingChatAttachment]) {
        chatHandoffAttachments = files
        chatHandoffPreferPersonalAgent = true
        chatHandoffID = UUID()
        openChat()
    }
}

struct RootTabView: View {
    @EnvironmentObject private var auth: AuthStore
    @EnvironmentObject private var theme: ThemeStore
    @EnvironmentObject private var nav: AppNavigationStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.colorScheme) private var colorScheme
    @State private var didApplyAuthorizedDefault = false

    var body: some View {
        Group {
            if AdaptiveLayout.isPhone {
                phoneTabView
            } else {
                padTabView
            }
        }
        .modifier(AdaptiveTabStyleModifier(isRegularWidth: AdaptiveLayout.isRegularWidth(horizontalSizeClass)))
        .modifier(LiquidTabBarModifier(selectedTab: nav.selectedTab))
        .background {
            TabReselectObserver {
                nav.noteTabReselect()
            }
        }
        .background(YLTheme.pageFill(colorScheme).ignoresSafeArea())
        // Keyboard avoidance is owned by `ylKeyboardAccessory` (UIKit guide pin).
        .ignoresSafeArea(.keyboard, edges: .bottom)
        .onAppear { applyAuthorizedDefaultIfNeeded() }
        .onChange(of: auth.hasFullAccess) { _, full in
            nav.adoptAccess(fullAccess: full)
            if full {
                applyAuthorizedDefaultIfNeeded()
            } else {
                didApplyAuthorizedDefault = false
            }
        }
    }

    /// Never hand TabView a tag that is missing from this auth state's tabs.
    private var tabSelection: Binding<RootTab> {
        Binding(
            get: { RootTab.clamped(nav.selectedTab, fullAccess: auth.hasFullAccess) },
            set: { nav.selectedTab = $0 }
        )
    }

    /// Same tabs as before. Chat is the iOS 27 prominent slot so it sits in
    /// its own circle on the trailing edge.
    private var phoneTabView: some View {
        TabView(selection: tabSelection) {
            if auth.hasFullAccess {
                Tab("Account", systemImage: "person.crop.circle", value: RootTab.account) {
                    AccountView()
                }
                Tab("Fitness", systemImage: "dumbbell.fill", value: RootTab.fitness) {
                    GymView()
                }
                Tab("Education", systemImage: "graduationcap.fill", value: RootTab.education) {
                    EducationView()
                }
            } else {
                Tab("Home", systemImage: "house.fill", value: RootTab.home) {
                    HomeView()
                }
                Tab("Account", systemImage: "person.crop.circle", value: RootTab.account) {
                    AccountView()
                }
            }
            if #available(iOS 27, *) {
                Tab(
                    "Chat",
                    systemImage: "bubble.left.and.bubble.right.fill",
                    value: RootTab.chat,
                    role: .prominent
                ) {
                    ChatView()
                }
            } else {
                Tab(
                    "Chat",
                    systemImage: "bubble.left.and.bubble.right.fill",
                    value: RootTab.chat
                ) {
                    ChatView()
                }
            }
        }
    }

    private var padTabView: some View {
        TabView(selection: tabSelection) {
            if auth.hasFullAccess {
                AccountView()
                    .tabItem { Label("Account", systemImage: "person.crop.circle") }
                    .tag(RootTab.account)

                GymView()
                    .tabItem { Label("Fitness", systemImage: "dumbbell.fill") }
                    .tag(RootTab.fitness)

                EducationView()
                    .tabItem { Label("Education", systemImage: "graduationcap.fill") }
                    .tag(RootTab.education)

                ChatView()
                    .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right.fill") }
                    .tag(RootTab.chat)
            } else {
                HomeView()
                    .tabItem { Label("Home", systemImage: "house.fill") }
                    .tag(RootTab.home)

                ChatView()
                    .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right.fill") }
                    .tag(RootTab.chat)

                AccountView()
                    .tabItem { Label("Account", systemImage: "person.crop.circle") }
                    .tag(RootTab.account)
            }
        }
    }

    /// Full-access sessions open on Chat; tab bar order is Account → Fitness → Education.
    private func applyAuthorizedDefaultIfNeeded() {
        guard auth.hasFullAccess, !didApplyAuthorizedDefault else { return }
        didApplyAuthorizedDefault = true
        nav.consumePendingOpenTodoIfNeeded()
        // Keep Account/Chat if the user is mid sign-in or already browsing
        // (lock-screen Chat or a widget todo tap). Only rewrite leftover Home.
        if nav.selectedTab == .home {
            nav.selectedTab = .chat
        }
    }
}

private struct AdaptiveTabStyleModifier: ViewModifier {
    let isRegularWidth: Bool

    func body(content: Content) -> some View {
        if isRegularWidth {
            content.tabViewStyle(.sidebarAdaptable)
        } else {
            content
        }
    }
}

private struct LiquidTabBarModifier: ViewModifier {
    let selectedTab: RootTab

    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            // Chat is the prominent tab, so minimizing it duplicates the chat
            // icon on both circles. Education is the only tab where collapse
            // looks right (cap on the left, chat on the right).
            content
                .tabBarMinimizeBehavior(selectedTab == .education ? .onScrollDown : .never)
        } else {
            content
        }
    }
}

extension View {
    /// Scroll this `ScrollView` to the top when the user re-taps `tab`.
    func tabReselectScrollToTop(for tab: RootTab) -> some View {
        modifier(TabReselectScrollToTopModifier(tab: tab))
    }
}

private struct TabReselectScrollToTopModifier: ViewModifier {
    @EnvironmentObject private var nav: AppNavigationStore
    let tab: RootTab
    @State private var scrollPosition = ScrollPosition(edge: .top)

    func body(content: Content) -> some View {
        content
            .scrollPosition($scrollPosition)
            .onChange(of: nav.tabReselectGeneration) { _, _ in
                guard nav.selectedTab == tab else { return }
                withAnimation(.spring(response: 0.38, dampingFraction: 0.86)) {
                    scrollPosition.scrollTo(edge: .top)
                }
            }
    }
}
