import ActivityKit
import Foundation

struct AgentActivityRow: Codable, Hashable {
    var sessionId: String
    var title: String
    var workingLabel: String
    var startedAt: Date

    init(sessionId: String, title: String, workingLabel: String, startedAt: Date) {
        self.sessionId = sessionId
        self.title = title
        self.workingLabel = workingLabel
        self.startedAt = startedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        title = try c.decode(String.self, forKey: .title)
        workingLabel = try c.decode(String.self, forKey: .workingLabel)
        startedAt = try c.decodeIfPresent(Date.self, forKey: .startedAt) ?? Date()
    }
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
