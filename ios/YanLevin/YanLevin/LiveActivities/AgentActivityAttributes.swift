import ActivityKit
import Foundation

struct AgentActivityRow: Codable, Hashable {
    var sessionId: String
    var title: String
    var workingLabel: String
}

struct AgentActivityAttributes: ActivityAttributes {
    /// One agent Live Activity per app; this stays constant.
    var kind: String

    struct ContentState: Codable, Hashable {
        var agents: [AgentActivityRow]
        var overflowCount: Int
    }

    static let kindValue = "personal-agent"

    static func chatURL(sessionId: String?) -> URL? {
        var comps = URLComponents()
        comps.scheme = "yanylevin"
        comps.host = "chat"
        if let sessionId, !sessionId.isEmpty {
            comps.queryItems = [URLQueryItem(name: "sessionId", value: sessionId)]
        } else {
            comps.queryItems = [URLQueryItem(name: "open", value: "1")]
        }
        return comps.url
    }
}
