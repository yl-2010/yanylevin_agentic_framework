import Foundation
import WidgetKit

/// Shared container for the app + education widgets (`group.com.example.personalagent`).
enum AppGroupStore {
    static let suiteName = "group.com.example.personalagent"

    private static let tokenKey = "mobileSessionJWT"
    private static let emailKey = "sessionEmail"
    private static let nameKey = "sessionName"
    private static let accessKey = "sessionAccess"
    private static let educationDataKey = "educationTreeJSON"
    private static let pendingNewChatKey = "pendingOpenNewChat"
    private static let pendingOpenTodoKey = "pendingOpenTodoJSON"

    private static let cachedDefaults: UserDefaults? = {
        guard FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: suiteName) != nil else {
            return nil
        }
        return UserDefaults(suiteName: suiteName)
    }()

    /// False when the App Group entitlement isn’t provisioned (typical without Apple Developer Program).
    static var isAvailable: Bool { cachedDefaults != nil }

    static var defaults: UserDefaults? { cachedDefaults }

    static var hasFullAccess: Bool {
        guard let defaults else { return false }
        return defaults.string(forKey: accessKey) == "full" && !(token ?? "").isEmpty
    }

    static var token: String? {
        let value = defaults?.string(forKey: tokenKey)
        return (value?.isEmpty == false) ? value : nil
    }

    static var email: String? {
        defaults?.string(forKey: emailKey)
    }

    static var name: String? {
        let value = defaults?.string(forKey: nameKey)
        return (value?.isEmpty == false) ? value : nil
    }

    static var use24Hour: Bool {
        false
    }

    static func saveSession(token: String, email: String, name: String, access: String) {
        guard let defaults else { return }
        defaults.set(token, forKey: tokenKey)
        defaults.set(email, forKey: emailKey)
        defaults.set(name, forKey: nameKey)
        defaults.set(access, forKey: accessKey)
        reloadWidgets()
    }

    static func clearSession() {
        guard let defaults else { return }
        defaults.removeObject(forKey: tokenKey)
        defaults.removeObject(forKey: emailKey)
        defaults.removeObject(forKey: nameKey)
        defaults.removeObject(forKey: accessKey)
        defaults.removeObject(forKey: educationDataKey)
        reloadWidgets()
    }

    static func cacheEducationData(_ data: Data, reloadWidgets: Bool = true) {
        guard let defaults else { return }
        defaults.set(data, forKey: educationDataKey)
        if reloadWidgets {
            Self.reloadWidgets()
        }
    }

    static func loadCachedEducationTree() -> EducationTreeResponse? {
        guard let data = defaults?.data(forKey: educationDataKey) else { return nil }
        return try? APIClient.decoder.decode(EducationTreeResponse.self, from: data)
    }

    static func reloadWidgets() {
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// Lock Screen / Control Center Chat control. Written from the widget
    /// extension when the intent cannot reach `AppNavigationStore`.
    /// Stored as a timestamp so a leftover flag cannot revive hours later, and
    /// `synchronize()` so the app process sees the write on cold launch.
    static func setPendingNewChat() {
        guard let defaults else { return }
        defaults.set(Date().timeIntervalSince1970, forKey: pendingNewChatKey)
        defaults.synchronize()
    }

    static func hasPendingNewChat() -> Bool {
        guard let defaults else { return false }
        let raw = defaults.object(forKey: pendingNewChatKey)
        let stamp: TimeInterval
        if let value = raw as? TimeInterval, value > 1 {
            stamp = value
        } else if let flag = raw as? Bool, flag {
            stamp = Date().timeIntervalSince1970
        } else {
            return false
        }
        return Date().timeIntervalSince1970 - stamp < 120
    }

    static func consumePendingNewChat() -> Bool {
        guard hasPendingNewChat(), let defaults else { return false }
        defaults.removeObject(forKey: pendingNewChatKey)
        defaults.synchronize()
        return true
    }

    /// Widget text tap. Written from the extension when the intent cannot reach
    /// `AppNavigationStore`. Same 2-minute stamp window as the Chat control.
    static func setPendingOpenTodo(todoId: String, classId: String?, projectId: String?) {
        guard let defaults else { return }
        let pending = PendingOpenTodo(
            todoId: todoId,
            classId: emptyToNil(classId),
            projectId: emptyToNil(projectId),
            stamp: Date().timeIntervalSince1970
        )
        guard let data = try? JSONEncoder().encode(pending) else { return }
        defaults.set(data, forKey: pendingOpenTodoKey)
        defaults.synchronize()
    }

    static func consumePendingOpenTodo() -> PendingOpenTodo? {
        guard let defaults, let data = defaults.data(forKey: pendingOpenTodoKey) else { return nil }
        defaults.removeObject(forKey: pendingOpenTodoKey)
        defaults.synchronize()
        guard let pending = try? JSONDecoder().decode(PendingOpenTodo.self, from: data) else { return nil }
        guard Date().timeIntervalSince1970 - pending.stamp < 120 else { return nil }
        return pending
    }

    static func hasPendingOpenTodo() -> Bool {
        guard let defaults, let data = defaults.data(forKey: pendingOpenTodoKey),
              let pending = try? JSONDecoder().decode(PendingOpenTodo.self, from: data)
        else { return false }
        return Date().timeIntervalSince1970 - pending.stamp < 120
    }

    private static func emptyToNil(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }
}

struct PendingOpenTodo: Equatable, Codable {
    var todoId: String
    var classId: String?
    var projectId: String?
    var stamp: TimeInterval
}
