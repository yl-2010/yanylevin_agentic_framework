import AppIntents

/// Destination for the Lock Screen / Control Center Chat control.
/// `OpenIntent` requires a target; a single case keeps Siri from asking.
enum OpenChatTarget: String, AppEnum {
    case newChat

    static var typeDisplayRepresentation = TypeDisplayRepresentation("Chat")
    static var caseDisplayRepresentations: [OpenChatTarget: DisplayRepresentation] = [
        .newChat: "New Chat",
    ]
}

/// Opens the app to a new Personal Agent chat. Must be `OpenIntent` (not a
/// plain `AppIntent` + `openAppWhenRun`) or iOS often flashes the app from the
/// Lock Screen control and immediately returns to SpringBoard.
struct OpenChatIntent: OpenIntent {
    static var title: LocalizedStringResource = "Open Chat"
    static var description = IntentDescription("Opens a new chat.")
    static var authenticationPolicy: IntentAuthenticationPolicy {
        .requiresAuthentication
    }

    @Parameter(title: "Target")
    var target: OpenChatTarget

    init() {
        self.target = .newChat
    }

    init(target: OpenChatTarget) {
        self.target = target
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        AppGroupStore.setPendingNewChat()
        #if !WIDGET_EXTENSION
        AppNavigationStore.shared.openChat(startNew: true)
        #endif
        return .result()
    }
}
