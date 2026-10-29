import UIKit

/// Physical display corner radius in points, without the private
/// `_displayCornerRadius`. Values come from Xcode's simulator device profiles
/// (`DeviceCornerRadius` in each `.simdevicetype` capabilities.plist).
enum YLDisplayCorner {
    static var radius: CGFloat { cached }

    private static let cached: CGFloat = {
        let id = modelIdentifier
        if let known = table[id] { return known }
        return fallback(for: id)
    }()

    private static var modelIdentifier: String {
        if let sim = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] {
            return sim
        }
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
    }

    /// Unknown (newer) models: assume the latest shape for the family.
    private static func fallback(for id: String) -> CGFloat {
        let major = Int(id.drop { !$0.isNumber }.prefix { $0.isNumber }) ?? 0
        // Home-button devices have square display corners and no bottom inset.
        let window = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first
        if (window?.safeAreaInsets.bottom ?? 0) == 0 { return 0 }
        if UIDevice.current.userInterfaceIdiom == .pad {
            return major >= 16 ? 30 : 18
        }
        return major >= 17 ? 62 : 55
    }

    private static let table: [String: CGFloat] = {
        var t: [String: CGFloat] = [:]
        func set(_ ids: [String], _ r: CGFloat) { for id in ids { t[id] = r } }
        // iPhone
        set(["iPhone10,3", "iPhone10,6", "iPhone11,2", "iPhone11,4", "iPhone11,6",
             "iPhone12,3", "iPhone12,5"], 39)
        set(["iPhone11,8", "iPhone12,1"], 41.5)
        set(["iPhone13,1", "iPhone14,4"], 44)
        set(["iPhone13,2", "iPhone13,3"], 47)
        set(["iPhone14,2", "iPhone14,5", "iPhone14,7", "iPhone17,5", "iPhone18,5"], 47.33)
        set(["iPhone13,4"], 53)
        set(["iPhone14,3", "iPhone14,8"], 53.33)
        set(["iPhone15,2", "iPhone15,3", "iPhone15,4", "iPhone15,5", "iPhone16,1",
             "iPhone16,2", "iPhone17,3", "iPhone17,4"], 55)
        set(["iPhone17,1", "iPhone17,2", "iPhone18,1", "iPhone18,2", "iPhone18,3",
             "iPhone18,4"], 62)
        // iPad (Wi-Fi and cellular siblings)
        set(["iPad8,1", "iPad8,2", "iPad8,3", "iPad8,4", "iPad8,5", "iPad8,6", "iPad8,7",
             "iPad8,8", "iPad8,9", "iPad8,10", "iPad8,11", "iPad8,12",
             "iPad11,3", "iPad11,4", "iPad13,1", "iPad13,2",
             "iPad13,4", "iPad13,5", "iPad13,6", "iPad13,7", "iPad13,8", "iPad13,9",
             "iPad13,10", "iPad13,11", "iPad13,16", "iPad13,17",
             "iPad14,3", "iPad14,4", "iPad14,5", "iPad14,6",
             "iPad14,8", "iPad14,9", "iPad14,10", "iPad14,11",
             "iPad15,3", "iPad15,4", "iPad15,5", "iPad15,6",
             "iPad16,8", "iPad16,9", "iPad16,10", "iPad16,11"], 18)
        set(["iPad14,1", "iPad14,2", "iPad16,1", "iPad16,2"], 21.5)
        set(["iPad13,18", "iPad13,19", "iPad15,7", "iPad15,8"], 25)
        set(["iPad16,3", "iPad16,4", "iPad16,5", "iPad16,6",
             "iPad17,1", "iPad17,2", "iPad17,3", "iPad17,4"], 30)
        return t
    }()
}
