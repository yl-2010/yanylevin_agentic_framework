import AppIntents
import Foundation
import WidgetKit

/// Marks an education todo done or not done from the Home Screen widget circle.
/// Lives in the app target and the widget extension (same as `OpenTodoIntent`);
/// iOS drops widget button intents that only exist in the extension.
struct CompleteTodoIntent: AppIntent {
    static var title: LocalizedStringResource = "Complete Todo"
    static var description = IntentDescription("Marks an education todo done or not done.")
    static var isDiscoverable = false
    static var openAppWhenRun = false
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .background }
    @available(iOS 27.0, *)
    static var allowedExecutionTargets: IntentExecutionTargets { [.widgetKitExtension, .main] }

    @Parameter(title: "Todo ID")
    var todoId: String

    @Parameter(title: "Class ID")
    var classId: String?

    @Parameter(title: "Project ID")
    var projectId: String?

    @Parameter(title: "Done")
    var done: Bool

    init() {
        self.todoId = ""
        self.classId = nil
        self.projectId = nil
        self.done = true
    }

    init(todoId: String, classId: String?, projectId: String?, done: Bool = true) {
        self.todoId = todoId
        self.classId = classId.flatMap { $0.isEmpty ? nil : $0 }
        self.projectId = projectId.flatMap { $0.isEmpty ? nil : $0 }
        self.done = done
    }

    func perform() async throws -> some IntentResult {
        guard AppGroupStore.hasFullAccess, let token = AppGroupStore.token else {
            throw CompleteTodoError.notSignedIn
        }
        var query: [URLQueryItem] = []
        if let classId, !classId.isEmpty {
            query.append(URLQueryItem(name: "classId", value: classId))
        }
        if let projectId, !projectId.isEmpty {
            query.append(URLQueryItem(name: "projectId", value: projectId))
        }
        let _: TodoDoneResponse = try await APIClient.shared.request(
            "api/education/todo/\(todoId)/done",
            method: "PATCH",
            body: TodoDoneBody(done: done, classId: classId, projectId: projectId),
            bearer: token,
            query: query
        )
        do {
            let (data, http) = try await APIClient.shared.requestRaw(
                "api/education/data",
                bearer: token
            )
            if (200..<300).contains(http.statusCode) {
                AppGroupStore.cacheEducationData(data, reloadWidgets: false)
            }
        } catch {}
        AppGroupStore.reloadWidgets()
        return .result()
    }
}

private enum CompleteTodoError: LocalizedError {
    case notSignedIn

    var errorDescription: String? {
        switch self {
        case .notSignedIn: return "Sign in with a full-access account in Yan Levin."
        }
    }
}
