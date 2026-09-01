import Foundation

/// Canvas LMS web URLs and the Student app's `canvas-courses://` scheme.
enum CanvasLMS {
    static let studentAppScheme = "canvas-courses"

    /// Normalized http(s) Canvas URL, if present.
    static func webURL(from raw: String?) -> URL? {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed) else { return nil }
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return nil
        }
        return url
    }

    /// Same host and path as the web URL, with the Student app scheme.
    static func studentAppURL(from webURL: URL) -> URL? {
        guard let host = webURL.host, !host.isEmpty else { return nil }
        var comps = URLComponents(url: webURL, resolvingAgainstBaseURL: false)
        comps?.scheme = studentAppScheme
        return comps?.url
    }
}

struct EducationTreeResponse: Decodable {
    let ok: Bool?
    let email: String?
    let meta: EducationMeta?
    let schedule: EducationSchedule?
    let classes: [EducationClass]?
    let projects: [EducationProject]?
    let todos: [EducationTodo]?
    let dates: [EducationDate]?
    let todayKey: String?
    let activeClassIdsByDate: [String: [String]]?
    let nowContext: EducationNowContext?
    let error: String?
}

struct EducationNowContext: Decodable {
    let timezone: String?
    let dateKey: String?
    let localTime: String?
    let isSchoolDay: Bool?
    let inClass: Bool?
    let inFreePeriod: Bool?
    let currentClass: EducationNowClass?
    let nextClass: EducationNowClass?
    let previousClass: EducationNowClass?
    let schedulePdf: String?
}

struct EducationNowClass: Decodable {
    let classId: String?
    let name: String?
    let period: String?
    let start: String?
    let end: String?
    let freePeriod: Bool?
}

struct EducationMeta: Decodable {
    let displayName: String?
}

struct EducationContextFile: Decodable, Identifiable, Hashable {
    let name: String
    let size: Int?
    let mtime: String?

    var id: String { name }

    var displayName: String { name }
}

struct EducationSchedule: Decodable {
    let timezone: String?
    let schoolStart: String?
    let schoolEnd: String?
    let bells: [BellSlot]?
    let weekdayPeriods: [String: [String]]?
    let closedDates: [String]?
    let dayOverrides: [String: DayOverride]?
}

struct DayOverride: Decodable {
    let allPeriods: Bool?
    let label: String?
    let slots: [DayOverrideSlot]?

    enum CodingKeys: String, CodingKey {
        case allPeriods, label, slots, meetings
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        allPeriods = try c.decodeIfPresent(Bool.self, forKey: .allPeriods)
        label = try c.decodeIfPresent(String.self, forKey: .label)
        slots =
            try c.decodeIfPresent([DayOverrideSlot].self, forKey: .slots)
            ?? c.decodeIfPresent([DayOverrideSlot].self, forKey: .meetings)
    }
}

struct DayOverrideSlot: Decodable {
    let period: String?
    let start: String?
    let end: String?
}

struct BellSlot: Decodable, Identifiable {
    var id: Int { slot }
    let slot: Int
    let start: String?
    let end: String?
}

struct EducationClass: Decodable, Identifiable, Hashable {
    let id: String
    let name: String?
    let teacher: String?
    let room: String?
    let period: String?
    let freePeriod: Bool?
    let detail: String?
    let files: [EducationContextFile]?
    let todos: [EducationTodo]?
    let dates: [EducationDate]?

    enum CodingKeys: String, CodingKey {
        case id, name, teacher, room, period, freePeriod, files, todos, dates
        case detail = "description"
    }

    var isFreePeriod: Bool { freePeriod == true }

    var descriptionText: String {
        (detail ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Schedule rows: period tag + this name ("Free Period").
    var displayName: String {
        if isFreePeriod { return "Free Period" }
        return name ?? id
    }

    /// Todos / dates / nav: distinct free periods ("Free Period C").
    var contextDisplayName: String {
        if isFreePeriod {
            if let period, !period.isEmpty {
                return "Free Period \(period.uppercased())"
            }
            return "Free Period"
        }
        return displayName
    }
}

struct EducationProject: Decodable, Identifiable, Hashable {
    let id: String
    let name: String?
    let order: Int?
    let detail: String?
    let files: [EducationContextFile]?
    let todos: [EducationTodo]?
    let dates: [EducationDate]?

    enum CodingKeys: String, CodingKey {
        case id, name, order, files, todos, dates
        case detail = "description"
    }

    var displayName: String { name ?? id }

    var descriptionText: String {
        (detail ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

struct EducationTodo: Decodable, Identifiable, Hashable {
    /// Folder id under todos/ (not globally unique across classes/projects).
    let todoId: String
    let name: String?
    let title: String?
    let tag: String?
    let type: String?
    let dueDate: String?
    let dueTime: String?
    let due: String?
    var done: Bool?
    /// ISO timestamp when the todo was checked off (Completed list sorts by this).
    var completedAt: String?
    /// When the todo was added (API may fill from file birthtime when omitted in JSON).
    let createdAt: String?
    /// When true, open todo also appears in Dates. MA defaults on when omitted.
    let showInDates: Bool?
    /// Optional Canvas LMS assignment/page URL — toolbar button only when set.
    let canvasLink: String?
    let classId: String?
    let projectId: String?
    let detail: String?
    let notes: String?
    let files: [EducationContextFile]?
    let kind: String?
    let capsules: [EducationCapsule]?
    let citations: [EducationCitation]?

    enum CodingKeys: String, CodingKey {
        case todoId = "id"
        case name, title, tag, type, dueDate, dueTime, due, done, completedAt, createdAt, showInDates, canvasLink, classId, projectId, notes, files, kind, capsules, citations
        case detail = "description"
    }

    /// Globally unique across user + class + project trees.
    var id: String {
        if let projectId, !projectId.isEmpty { return "p/\(projectId)/\(todoId)" }
        if let classId, !classId.isEmpty { return "\(classId)/\(todoId)" }
        return todoId
    }

    var displayName: String { name ?? title ?? todoId }
    var displayTag: String? {
        let key = filterTagKey
        return key == "none" ? nil : key
    }

    /// Website type-filter key: CW / HW / QA / MA / none.
    var filterTagKey: String {
        let raw = (tag ?? type)?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() ?? ""
        switch raw {
        case "CW", "HW", "QA", "MA": return raw
        default: return "none"
        }
    }

    /// Effective Dates visibility (MA defaults on; others default off).
    var showsInDates: Bool {
        if done == true { return false }
        if let showInDates { return showInDates }
        return filterTagKey == "MA"
    }

    /// Normalized http(s) Canvas URL, if present.
    var canvasURL: URL? { CanvasLMS.webURL(from: canvasLink) }

    var dueDateValue: String? {
        if let dueDate, !dueDate.isEmpty { return dueDate }
        // Legacy single-field due: "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM"
        guard let due, !due.isEmpty else { return nil }
        return String(due.prefix(10))
    }

    var dueTimeValue: String? {
        if let dueTime, !dueTime.isEmpty { return dueTime }
        guard let due, due.count >= 16 else { return nil }
        let slice = String(due.dropFirst(11).prefix(5))
        return slice.contains(":") ? slice : nil
    }

    /// Open TODO order: earliest dueDate first (overdue included), undated last;
    /// same date → timed before date-only; same due → older createdAt above newer;
    /// final tie → id.
    var dueSortKey: String {
        let d = dueDateValue ?? "9999-99-99"
        let t = dueTimeValue ?? "99:99"
        let created = createdAt ?? ""
        return "\(d)T\(t)\t\(created)\t\(id)"
    }

    /// Most recently checked-off first; missing completedAt sorts last.
    var completedSortKey: String {
        completedAt ?? ""
    }

    /// Parsed `completedAt` ISO timestamp (fractional seconds optional).
    var completedAtDate: Date? {
        guard let completedAt, !completedAt.isEmpty else { return nil }
        if let date = Self.completedAtFractional.date(from: completedAt) { return date }
        return Self.completedAtPlain.date(from: completedAt)
    }

    private static let completedAtFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let completedAtPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    var isDailyBriefing: Bool {
        if kind == "dailyBriefing" { return true }
        return !(capsules ?? []).isEmpty
    }

    func withClassId(_ classId: String) -> EducationTodo {
        if let existing = self.classId, !existing.isEmpty { return self }
        return EducationTodo(
            todoId: todoId,
            name: name,
            title: title,
            tag: tag,
            type: type,
            dueDate: dueDate,
            dueTime: dueTime,
            due: due,
            done: done,
            completedAt: completedAt,
            createdAt: createdAt,
            showInDates: showInDates,
            canvasLink: canvasLink,
            classId: classId,
            projectId: projectId,
            detail: detail,
            notes: notes,
            files: files,
            kind: kind,
            capsules: capsules,
            citations: citations
        )
    }

    func withProjectId(_ projectId: String) -> EducationTodo {
        if let existing = self.projectId, !existing.isEmpty { return self }
        return EducationTodo(
            todoId: todoId,
            name: name,
            title: title,
            tag: tag,
            type: type,
            dueDate: dueDate,
            dueTime: dueTime,
            due: due,
            done: done,
            completedAt: completedAt,
            createdAt: createdAt,
            showInDates: showInDates,
            canvasLink: canvasLink,
            classId: classId,
            projectId: projectId,
            detail: detail,
            notes: notes,
            files: files,
            kind: kind,
            capsules: capsules,
            citations: citations
        )
    }

    /// Overall briefing sources: todo-level plus every capsule, unique by name, A–Z.
    var overallCitations: [EducationCitation] {
        let fromTodo = citations ?? []
        let fromCapsules = (capsules ?? []).flatMap(\.citations)
        return EducationCitation.uniquedSorted(fromTodo + fromCapsules)
    }
}

struct EducationCitation: Decodable, Hashable, Identifiable {
    let name: String
    let url: String?

    var id: String { "\(name.lowercased())|\(url ?? "")" }

    var displayName: String { name }

    var link: URL? {
        guard let raw = url?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty,
              let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https"
        else { return nil }
        return url
    }

    enum CodingKeys: String, CodingKey {
        case name, title, source, outlet, url, href
    }

    init(name: String, url: String? = nil) {
        self.name = name
        self.url = url
    }

    init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer(), let raw = try? single.decode(String.self) {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.lowercased().hasPrefix("http://") || trimmed.lowercased().hasPrefix("https://"),
               let parsed = URL(string: trimmed)
            {
                let host = parsed.host?.replacingOccurrences(of: "www.", with: "") ?? trimmed
                name = host
                url = trimmed
            } else {
                name = trimmed
                url = nil
            }
            return
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let named = [
            try c.decodeIfPresent(String.self, forKey: .name),
            try c.decodeIfPresent(String.self, forKey: .title),
            try c.decodeIfPresent(String.self, forKey: .source),
            try c.decodeIfPresent(String.self, forKey: .outlet),
        ]
        .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
        .first { !$0.isEmpty }
        let href = (try c.decodeIfPresent(String.self, forKey: .url)
            ?? c.decodeIfPresent(String.self, forKey: .href))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let hrefOrNil = (href?.isEmpty == false) ? href : nil
        if let named, !named.isEmpty {
            name = named
            url = hrefOrNil
        } else if let hrefOrNil, let parsed = URL(string: hrefOrNil) {
            name = parsed.host?.replacingOccurrences(of: "www.", with: "") ?? hrefOrNil
            url = hrefOrNil
        } else {
            name = ""
            url = hrefOrNil
        }
    }

    static func uniquedSorted(_ items: [EducationCitation]) -> [EducationCitation] {
        var byKey: [String: EducationCitation] = [:]
        var order: [String] = []
        for item in items {
            let label = item.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !label.isEmpty else { continue }
            let key = label.lowercased()
            if let existing = byKey[key] {
                if existing.url == nil, item.url != nil {
                    byKey[key] = EducationCitation(name: existing.name, url: item.url)
                }
            } else {
                byKey[key] = EducationCitation(name: label, url: item.url)
                order.append(key)
            }
        }
        return order
            .compactMap { byKey[$0] }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }
}

struct EducationCapsule: Decodable, Identifiable, Hashable {
    let id: String
    let category: String?
    let title: String?
    let body: String?
    var vote: String?
    let noVote: Bool?
    let citations: [EducationCitation]

    enum CodingKeys: String, CodingKey {
        case id, category, title, body, vote, noVote, citations, sources
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let rawId = try c.decodeIfPresent(String.self, forKey: .id)?.trimmingCharacters(in: .whitespacesAndNewlines)
        id = (rawId?.isEmpty == false) ? rawId! : UUID().uuidString
        category = try c.decodeIfPresent(String.self, forKey: .category)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        body = try c.decodeIfPresent(String.self, forKey: .body)
        vote = try c.decodeIfPresent(String.self, forKey: .vote)
        noVote = try c.decodeIfPresent(Bool.self, forKey: .noVote)
        let fromCitations = (try? c.decodeIfPresent([EducationCitation].self, forKey: .citations)) ?? nil
        let fromSources = (try? c.decodeIfPresent([EducationCitation].self, forKey: .sources)) ?? nil
        citations = EducationCitation.uniquedSorted((fromCitations ?? []) + (fromSources ?? []))
    }

    var displayTitle: String {
        let t = (title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? "Untitled" : t
    }

    var displayBody: String {
        (body ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var citationsContextText: String {
        citations.map { cite in
            if let url = cite.url, !url.isEmpty {
                return "\(cite.displayName): \(url)"
            }
            return cite.displayName
        }.joined(separator: "\n")
    }

    var voteKey: String? {
        if noVote == true { return nil }
        switch (vote ?? "").lowercased() {
        case "up", "down": return (vote ?? "").lowercased()
        default: return nil
        }
    }
}

struct EducationDate: Decodable, Identifiable, Hashable {
    /// Folder id under dates/ (not globally unique across classes/projects).
    let dateId: String
    let name: String?
    let title: String?
    let date: String?
    let time: String?
    let detail: String?
    let notes: String?
    let classId: String?
    let projectId: String?
    let files: [EducationContextFile]?
    /// Optional Canvas LMS event/syllabus URL — toolbar button only when set.
    let canvasLink: String?

    enum CodingKeys: String, CodingKey {
        case dateId = "id"
        case name, title, date, time, notes, classId, projectId, files, canvasLink
        case detail = "description"
    }

    var id: String {
        if let projectId, !projectId.isEmpty { return "p/\(projectId)/\(dateId)" }
        if let classId, !classId.isEmpty { return "\(classId)/\(dateId)" }
        return dateId
    }

    var displayName: String { name ?? title ?? dateId }

    var dateSortKey: String {
        "\(date ?? "9999-99-99")T\(time ?? "99:99")"
    }

    /// Normalized http(s) Canvas URL, if present.
    var canvasURL: URL? { CanvasLMS.webURL(from: canvasLink) }

    func withClassId(_ classId: String) -> EducationDate {
        if let existing = self.classId, !existing.isEmpty { return self }
        return EducationDate(
            dateId: dateId,
            name: name,
            title: title,
            date: date,
            time: time,
            detail: detail,
            notes: notes,
            classId: classId,
            projectId: projectId,
            files: files,
            canvasLink: canvasLink
        )
    }

    func withProjectId(_ projectId: String) -> EducationDate {
        if let existing = self.projectId, !existing.isEmpty { return self }
        return EducationDate(
            dateId: dateId,
            name: name,
            title: title,
            date: date,
            time: time,
            detail: detail,
            notes: notes,
            classId: classId,
            projectId: projectId,
            files: files,
            canvasLink: canvasLink
        )
    }
}

struct TodoDoneBody: Encodable {
    let done: Bool
    let classId: String?
    let projectId: String?

    init(done: Bool, classId: String? = nil, projectId: String? = nil) {
        self.done = done
        self.classId = classId
        self.projectId = projectId
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(done, forKey: .done)
        if let classId, !classId.isEmpty {
            try c.encode(classId, forKey: .classId)
        }
        if let projectId, !projectId.isEmpty {
            try c.encode(projectId, forKey: .projectId)
        }
    }

    enum CodingKeys: String, CodingKey {
        case done, classId, projectId
    }
}

struct TodoDoneResponse: Decodable {
    let ok: Bool?
    let error: String?
}

struct CapsuleVoteBody: Encodable {
    let vote: String?
    let classId: String?
    let projectId: String?

    init(vote: String?, classId: String? = nil, projectId: String? = nil) {
        self.vote = vote
        self.classId = classId
        self.projectId = projectId
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(vote, forKey: .vote)
        if let classId, !classId.isEmpty {
            try c.encode(classId, forKey: .classId)
        }
        if let projectId, !projectId.isEmpty {
            try c.encode(projectId, forKey: .projectId)
        }
    }

    enum CodingKeys: String, CodingKey {
        case vote, classId, projectId
    }
}

struct CapsuleVoteResponse: Decodable {
    let ok: Bool?
    let error: String?
}
