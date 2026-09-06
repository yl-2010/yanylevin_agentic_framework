import AppIntents

/// Opens Chat to a Personal Agent thread, or the current Chat tab when `sessionId` is empty.
struct OpenAgentChatIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Agent Chat"
    static var description = IntentDescription("Opens a Personal Agent chat.")
    static var isDiscoverable = false
    static var openAppWhenRun = true

    @Parameter(title: "Session ID")
    var sessionId: String?

    init() {}

    init(sessionId: String?) {
        self.sessionId = sessionId.flatMap { $0.isEmpty ? nil : $0 }
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        AppGroupStore.setPendingOpenChat(sessionId: sessionId)
        #if !WIDGET_EXTENSION
        if let sessionId, !sessionId.isEmpty {
            AppNavigationStore.shared.openChat(sessionId: sessionId)
        } else {
            AppNavigationStore.shared.openExistingChat()
        }
        #endif
        return .result()
    }
}
