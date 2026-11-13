import Foundation
import UIKit
import UserNotifications

/// Remote push registration. Unused while the app is signed with a free Personal Team.
/// A free account cannot provision aps-environment, so nothing calls this.
@MainActor
final class PushRegistration {
    static let shared = PushRegistration()

    private var asked = false
    private var lastDeviceToken = ""
    private var lastLiveKey = ""
    private let sinceKey = "pushDismissedSince"

    private init() {}

    func onForeground() {
        guard AppGroupStore.hasFullAccess else { return }
        if !asked {
            asked = true
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
                DispatchQueue.main.async {
                    UIApplication.shared.registerForRemoteNotifications()
                }
            }
        }
        Task { await syncDismissed() }
    }

    func didRegister(_ deviceToken: Data) async {
        let token = Self.hex(deviceToken)
        guard token != lastDeviceToken else { return }
        guard let bearer = AppGroupStore.token, !bearer.isEmpty else { return }
        let body = DeviceRegisterBody(
            deviceId: Self.deviceId(),
            token: token,
            sandbox: Self.usesSandboxAPNs(),
            idiom: UIDevice.current.userInterfaceIdiom == .pad ? "pad" : "phone",
            name: UIDevice.current.name
        )
        do {
            let _: OkBody = try await APIClient.shared.request(
                "api/push/register",
                method: "POST",
                body: body,
                bearer: bearer
            )
            lastDeviceToken = token
        } catch {
            NSLog("push register: %@", error.localizedDescription)
        }
    }

    func uploadLiveActivity(
        pushToStartToken: String?,
        activityPushToken: String?,
        dayId: String?,
        ended: Bool
    ) async {
        guard AppGroupStore.hasFullAccess, let bearer = AppGroupStore.token, !bearer.isEmpty else { return }
        let key = "\(pushToStartToken ?? "")|\(activityPushToken ?? "")|\(dayId ?? "")|\(ended)"
        guard key != lastLiveKey else { return }
        let body = LiveTokenBody(
            deviceId: Self.deviceId(),
            sandbox: Self.usesSandboxAPNs(),
            pushToStartToken: pushToStartToken,
            activityPushToken: activityPushToken,
            dayId: dayId,
            ended: ended
        )
        do {
            let _: OkBody = try await APIClient.shared.request(
                "api/live-activity/token",
                method: "POST",
                body: body,
                bearer: bearer
            )
            lastLiveKey = key
        } catch {
            NSLog("live activity token: %@", error.localizedDescription)
        }
    }

    func handleRemote(userInfo: [AnyHashable: Any]) {
        Self.removeDelivered(ids: Self.stringList(userInfo["dismiss"]))
    }

    func handleOpened(userInfo: [AnyHashable: Any]) async {
        guard let id = userInfo["id"] as? String, !id.isEmpty else { return }
        await postOpened(id: id)
        let sessionId = (userInfo["sessionId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let url: URL?
        if sessionId.isEmpty {
            url = URL(string: "yanylevin://chat?open=1")
        } else {
            var parts = URLComponents()
            parts.scheme = "yanylevin"
            parts.host = "chat"
            parts.queryItems = [URLQueryItem(name: "sessionId", value: sessionId)]
            url = parts.url
        }
        if let url {
            AppNavigationStore.shared.handleOpenURL(url)
        }
    }

    private func postOpened(id: String) async {
        guard let bearer = AppGroupStore.token, !bearer.isEmpty else { return }
        let body = OpenedBody(id: id, deviceId: Self.deviceId())
        do {
            let _: OkBody = try await APIClient.shared.request(
                "api/push/opened",
                method: "POST",
                body: body,
                bearer: bearer
            )
        } catch {
            NSLog("push opened: %@", error.localizedDescription)
        }
    }

    private func syncDismissed() async {
        guard let bearer = AppGroupStore.token, !bearer.isEmpty else { return }
        let since = UserDefaults.standard.double(forKey: sinceKey)
        do {
            let res: DismissedBody = try await APIClient.shared.request(
                "api/push/dismissed",
                bearer: bearer,
                query: [URLQueryItem(name: "since", value: String(Int(since)))]
            )
            Self.removeDelivered(ids: res.ids ?? [])
            if let now = res.now {
                UserDefaults.standard.set(now, forKey: sinceKey)
            }
        } catch {
            NSLog("push dismissed: %@", error.localizedDescription)
        }
    }

    static func removeDelivered(ids: [String]) {
        let clean = ids.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard !clean.isEmpty else { return }
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: clean)
        center.getDeliveredNotifications { notes in
            let extra = notes.compactMap { note -> String? in
                guard let id = note.request.content.userInfo["id"] as? String, clean.contains(id) else {
                    return nil
                }
                return note.request.identifier
            }
            if !extra.isEmpty {
                UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: extra)
            }
        }
    }

    static func stringList(_ value: Any?) -> [String] {
        if let list = value as? [String] { return list }
        if let list = value as? [Any] {
            return list.compactMap { $0 as? String }
        }
        return []
    }

    private static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    private static func deviceId() -> String {
        let key = "pushDeviceId"
        if let existing = UserDefaults.standard.string(forKey: key), !existing.isEmpty {
            return existing
        }
        let id = UIDevice.current.identifierForVendor?.uuidString ?? UUID().uuidString
        UserDefaults.standard.set(id, forKey: key)
        return id
    }

    /// Xcode installs are development. TestFlight and the App Store are production.
    static func usesSandboxAPNs() -> Bool {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .isoLatin1),
              let range = text.range(of: "<key>aps-environment</key>")
        else {
            #if DEBUG
            return true
            #else
            return false
            #endif
        }
        let tail = text[range.upperBound...].prefix(240)
        return tail.contains("<string>development</string>")
    }
}

final class YanAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in
            await PushRegistration.shared.didRegister(deviceToken)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        NSLog("push register failed: %@", error.localizedDescription)
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        Task { @MainActor in
            PushRegistration.shared.handleRemote(userInfo: userInfo)
            completionHandler(.newData)
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        guard notification.request.content.userInfo["id"] != nil else { return [] }
        return [.banner, .sound]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        await PushRegistration.shared.handleOpened(userInfo: response.notification.request.content.userInfo)
    }
}

private struct DeviceRegisterBody: Encodable {
    let deviceId: String
    let token: String
    let sandbox: Bool
    let idiom: String
    let name: String
}

private struct LiveTokenBody: Encodable {
    let deviceId: String
    let sandbox: Bool
    let pushToStartToken: String?
    let activityPushToken: String?
    let dayId: String?
    let ended: Bool
}

private struct OpenedBody: Encodable {
    let id: String
    let deviceId: String
}

private struct OkBody: Decodable {
    let ok: Bool?
}

private struct DismissedBody: Decodable {
    let ids: [String]?
    let now: Double?
}
