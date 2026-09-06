import ActivityKit
import Foundation

struct ClassActivityAssignment: Codable, Hashable {
    var todoId: String
    var classId: String?
    var tag: String
    var name: String
}

struct ClassActivityAttributes: ActivityAttributes {
    var classId: String

    struct ContentState: Codable, Hashable {
        var classId: String
        var className: String
        var period: String
        var start: String
        var end: String
        var assignments: [ClassActivityAssignment]
        var overflowCount: Int
    }

    static func classURL(id: String) -> URL? {
        var comps = URLComponents()
        comps.scheme = "yanylevin"
        comps.host = "class"
        comps.queryItems = [URLQueryItem(name: "id", value: id)]
        return comps.url
    }
}
