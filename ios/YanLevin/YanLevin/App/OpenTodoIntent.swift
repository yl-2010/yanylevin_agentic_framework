import AppIntents

/// Opens the app to a specific education todo. Home Screen widget text uses this;
/// the circle uses `CompleteTodoIntent` and does not open the app.
struct OpenTodoIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Todo"
    static var description = IntentDescription("Opens an education todo.")
    static var isDiscoverable = false
    static var openAppWhenRun = true

    @Parameter(title: "Todo ID")
    var todoId: String

    @Parameter(title: "Class ID")
    var classId: String?

    @Parameter(title: "Project ID")
    var projectId: String?

    init() {}

    init(todoId: String, classId: String?, projectId: String?) {
        self.todoId = todoId
        self.classId = classId.flatMap { $0.isEmpty ? nil : $0 }
        self.projectId = projectId.flatMap { $0.isEmpty ? nil : $0 }
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        AppGroupStore.setPendingOpenTodo(
            todoId: todoId,
            classId: classId,
            projectId: projectId
        )
        #if !WIDGET_EXTENSION
        AppNavigationStore.shared.openEducationTodo(
            todoId: todoId,
            classId: classId,
            projectId: projectId
        )
        #endif
        return .result()
    }
}
