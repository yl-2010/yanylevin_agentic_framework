import AppIntents

/// Opens the app to an education class page (Live Activity banner).
struct OpenClassIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Class"
    static var description = IntentDescription("Opens an education class.")
    static var isDiscoverable = false
    static var openAppWhenRun = true

    @Parameter(title: "Class ID")
    var classId: String

    init() {
        self.classId = ""
    }

    init(classId: String) {
        self.classId = classId
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        AppGroupStore.setPendingOpenClass(classId: classId)
        #if !WIDGET_EXTENSION
        AppNavigationStore.shared.openEducationClass(classId: classId)
        #endif
        return .result()
    }
}
