import Foundation

struct DayClass: Identifiable, Hashable {
    var id: String { "\(cls.id)-\(period)-\(start ?? "")" }
    let cls: EducationClass
    let period: String
    let start: String?
    let end: String?
    let startMin: Int?
    let endMin: Int?
}

/// Next upcoming class used for class-detail hero subtitle.
struct NextClassOccurrence: Hashable {
    let dateKey: String
    let start: String?
    let end: String?
    let period: String
}

struct DaySection: Identifiable, Hashable {
    var id: String { dateKey }
    let dateKey: String
    let typeCode: String?
    let whenLabel: String
    let isToday: Bool
    let nowMinutes: Int
    let classes: [DayClass]

    func isCurrent(_ dayClass: DayClass) -> Bool {
        guard isToday,
              let start = dayClass.startMin,
              let end = dayClass.endMin
        else { return false }
        return nowMinutes >= start && nowMinutes < end
    }

    func isPast(_ dayClass: DayClass) -> Bool {
        guard isToday, let end = dayClass.endMin else { return false }
        return nowMinutes >= end
    }
}

enum EducationScheduleHelper {
    /// Port of `classSections` in education/app.js.
    static func classSections(
        schedule: EducationSchedule?,
        classes: [EducationClass],
        activeClassIdsByDate: [String: [String]]?
    ) -> [DaySection] {
        let schedule = schedule ?? EducationSchedule(
            timezone: nil,
            schoolStart: nil,
            schoolEnd: nil,
            bells: nil,
            weekdayPeriods: nil,
            closedDates: nil,
            dayOverrides: nil
        )
        let now = todayParts()
        let query = ScheduleQuery(schedule: schedule)
        let todayIsSchool = isSchoolDay(now, query: query)

        let day1: YMD?
        let day2: YMD?
        if todayIsSchool {
            day1 = now
            day2 = nextSchoolDay(from: now, query: query, skipToday: true)
        } else {
            day1 = nextSchoolDay(from: now, query: query, skipToday: true)
            day2 = day1.flatMap { nextSchoolDay(from: $0, query: query, skipToday: true) }
        }

        var sections: [DaySection] = []
        if let day1 {
            let allPeriods = isAllPeriodsDay(day1, schedule: schedule)
            let title = daySectionTitle(day1, schedule: schedule)
            sections.append(DaySection(
                dateKey: dateKey(day1),
                typeCode: title.typeCode,
                whenLabel: title.when,
                isToday: todayIsSchool && day1.y == now.y && day1.m == now.m && day1.day == now.day,
                nowMinutes: now.minutes,
                classes: classesForDay(
                    day1,
                    query: query,
                    classes: classes,
                    activeClassIdsByDate: activeClassIdsByDate
                )
            ))
            // A–H days: one panel with every class — skip the following-day box.
            if allPeriods { return sections }
        }
        if let day2 {
            let title = daySectionTitle(day2, schedule: schedule)
            sections.append(DaySection(
                dateKey: dateKey(day2),
                typeCode: title.typeCode,
                whenLabel: title.when,
                isToday: false,
                nowMinutes: now.minutes,
                classes: classesForDay(
                    day2,
                    query: query,
                    classes: classes,
                    activeClassIdsByDate: activeClassIdsByDate
                )
            ))
        }
        return sections
    }

    /// Upcoming classes (skip ones that already ended today), optionally capped.
    static func upcomingClasses(
        sections: [DaySection],
        limit: Int? = nil
    ) -> [(section: DaySection, dayClass: DayClass)] {
        var out: [(DaySection, DayClass)] = []
        for section in sections {
            for dayClass in section.classes {
                if section.isPast(dayClass) { continue }
                out.append((section, dayClass))
                if let limit, out.count >= limit { return out }
            }
        }
        return out
    }

    /// Next class that has not ended yet (today or a future school day).
    /// Port of `nextClassOccurrence` in education/app.js.
    static func nextClassOccurrence(
        cls: EducationClass,
        schedule: EducationSchedule?,
        activeClassIdsByDate: [String: [String]]?
    ) -> NextClassOccurrence? {
        guard let period = cls.period, !period.isEmpty else { return nil }
        let schedule = schedule ?? EducationSchedule(
            timezone: nil,
            schoolStart: nil,
            schoolEnd: nil,
            bells: nil,
            weekdayPeriods: nil,
            closedDates: nil,
            dayOverrides: nil
        )
        let now = todayParts()
        let query = ScheduleQuery(schedule: schedule)
        var day = YMD(y: now.y, m: now.m, day: now.day, weekday: now.weekday)
        for _ in 0..<60 {
            if isSchoolDay(day, query: query) {
                let dayClasses = classesForDay(
                    day,
                    query: query,
                    classes: [cls],
                    activeClassIdsByDate: activeClassIdsByDate
                )
                for m in dayClasses {
                    let isToday = day.y == now.y && day.m == now.m && day.day == now.day
                    if isToday, let end = m.endMin, now.minutes >= end { continue }
                    return NextClassOccurrence(
                        dateKey: dateKey(day),
                        start: m.start,
                        end: m.end,
                        period: m.period
                    )
                }
            }
            day = addDays(day, 1)
        }
        return nil
    }

    private struct YMD {
        var y: Int
        var m: Int
        var day: Int
        var weekday: Int
        var minutes: Int = 0
    }

    /// Closed dates + sorted bells, built once per `classSections` / `nextClassOccurrence`.
    private struct ScheduleQuery {
        let schedule: EducationSchedule
        let closedDates: Set<String>
        let sortedBells: [BellSlot]

        init(schedule: EducationSchedule) {
            self.schedule = schedule
            self.closedDates = Set(schedule.closedDates ?? [])
            self.sortedBells = (schedule.bells ?? []).sorted { $0.slot < $1.slot }
        }
    }

    private static func todayParts(_ date: Date = Date()) -> YMD {
        let cal = Calendar.current
        return YMD(
            y: cal.component(.year, from: date),
            m: cal.component(.month, from: date),
            day: cal.component(.day, from: date),
            weekday: cal.component(.weekday, from: date) - 1,
            minutes: cal.component(.hour, from: date) * 60 + cal.component(.minute, from: date)
        )
    }

    private static func dateKey(_ p: YMD) -> String {
        String(format: "%04d-%02d-%02d", p.y, p.m, p.day)
    }

    private static func addDays(_ p: YMD, _ n: Int) -> YMD {
        let cal = Calendar.current
        let base = cal.date(from: DateComponents(year: p.y, month: p.m, day: p.day))!
        let next = cal.date(byAdding: .day, value: n, to: base)!
        return YMD(
            y: cal.component(.year, from: next),
            m: cal.component(.month, from: next),
            day: cal.component(.day, from: next),
            weekday: cal.component(.weekday, from: next) - 1
        )
    }

    private static func isSchoolDay(_ p: YMD, query: ScheduleQuery) -> Bool {
        if p.weekday == 0 || p.weekday == 6 { return false }
        let key = dateKey(p)
        if query.closedDates.contains(key) { return false }
        if let start = query.schedule.schoolStart, !start.isEmpty, key < start { return false }
        if let end = query.schedule.schoolEnd, !end.isEmpty, key > end { return false }
        return true
    }

    private static func nextSchoolDay(from: YMD, query: ScheduleQuery, skipToday: Bool) -> YMD? {
        var cur = skipToday ? addDays(from, 1) : from
        for _ in 0..<120 {
            if isSchoolDay(cur, query: query) { return cur }
            cur = addDays(cur, 1)
        }
        return nil
    }

    private static func dayOverride(_ p: YMD, schedule: EducationSchedule) -> DayOverride? {
        schedule.dayOverrides?[dateKey(p)]
    }

    private static func isAllPeriodsDay(_ p: YMD, schedule: EducationSchedule) -> Bool {
        dayOverride(p, schedule: schedule)?.allPeriods == true
    }

    private static func periodsForDay(_ p: YMD, schedule: EducationSchedule) -> [String] {
        schedule.weekdayPeriods?[String(p.weekday)] ?? []
    }

    private static func timeToMinutes(_ t: String?) -> Int? {
        guard let t, let match = t.wholeMatch(of: /^(\d{1,2}):(\d{2})$/) else { return nil }
        return Int(match.1)! * 60 + Int(match.2)!
    }

    private static func classesForDay(
        _ p: YMD,
        query: ScheduleQuery,
        classes: [EducationClass],
        activeClassIdsByDate: [String: [String]]?
    ) -> [DayClass] {
        let schedule = query.schedule
        let dayKey = dateKey(p)
        let allowed = activeClassIdsByDate?[dayKey]
        let allowedSet = allowed.map { Set($0) }
        let visible = classes.filter { cls in
            if let allowedSet { return allowedSet.contains(cls.id) }
            return true
        }

        var out: [DayClass] = []
        let override = dayOverride(p, schedule: schedule)
        if let overrideSlots = override?.slots {
            for slot in overrideSlots {
                let period = (slot.period ?? "").uppercased()
                guard !period.isEmpty else { continue }
                guard let cls = classForPeriod(visible, period: period) else { continue }
                out.append(DayClass(
                    cls: cls,
                    period: period,
                    start: slot.start,
                    end: slot.end,
                    startMin: timeToMinutes(slot.start),
                    endMin: timeToMinutes(slot.end)
                ))
            }
        } else {
            let periods = periodsForDay(p, schedule: schedule)
            let bellList = query.sortedBells
            for (i, periodRaw) in periods.enumerated() {
                guard i < bellList.count else { continue }
                let bell = bellList[i]
                let period = periodRaw.uppercased()
                guard let cls = classForPeriod(visible, period: period) else { continue }
                out.append(DayClass(
                    cls: cls,
                    period: period,
                    start: bell.start,
                    end: bell.end,
                    startMin: timeToMinutes(bell.start),
                    endMin: timeToMinutes(bell.end)
                ))
            }
        }
        return out.sorted { ($0.startMin ?? 0) < ($1.startMin ?? 0) }
    }

    private static func classForPeriod(_ visible: [EducationClass], period: String) -> EducationClass? {
        let matches = visible.filter { ($0.period ?? "").uppercased() == period }
        guard !matches.isEmpty else { return nil }
        return matches.first(where: { !$0.isFreePeriod }) ?? matches[0]
    }

    private static func dayTypeCode(_ p: YMD, schedule: EducationSchedule) -> String {
        let override = dayOverride(p, schedule: schedule)
        if let raw = override?.label {
            let fromLabel = raw.unicodeScalars
                .filter { CharacterSet.letters.contains($0) }
                .map { Character($0) }
            let cleaned = String(fromLabel).uppercased()
            if !cleaned.isEmpty { return cleaned }
        }
        let periods: [String]
        if let slots = override?.slots {
            periods = slots.compactMap { ($0.period ?? "").uppercased() }.filter { !$0.isEmpty }
        } else {
            periods = periodsForDay(p, schedule: schedule).map { $0.uppercased() }
        }
        guard !periods.isEmpty else { return "" }
        if periods.count == 1 { return periods[0] }
        return "\(periods[0])\(periods[periods.count - 1])"
    }

    private static func daySectionTitle(_ p: YMD, schedule: EducationSchedule) -> (typeCode: String?, when: String) {
        let type = dayTypeCode(p, schedule: schedule)
        let when = "\(weekdayShort(p.weekday)) \(p.m)/\(p.day)"
        return (type.isEmpty ? nil : type, when)
    }

    private static func weekdayShort(_ weekday: Int) -> String {
        ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][max(0, min(6, weekday))]
    }
}

enum EducationTodoHelpers {
    static func flattenTodos(from tree: EducationTreeResponse?) -> [EducationTodo] {
        var list = tree?.todos ?? []
        for cls in tree?.classes ?? [] {
            list.append(contentsOf: (cls.todos ?? []).map { $0.withClassId(cls.id) })
        }
        for project in tree?.projects ?? [] {
            list.append(contentsOf: (project.todos ?? []).map { $0.withProjectId(project.id) })
        }
        return list
    }

    static func uniqueTodoId(todoId: String, classId: String?, projectId: String?) -> String {
        if let projectId, !projectId.isEmpty { return "p/\(projectId)/\(todoId)" }
        if let classId, !classId.isEmpty { return "\(classId)/\(todoId)" }
        return todoId
    }

    static func todo(
        todoId: String,
        classId: String?,
        projectId: String?,
        from tree: EducationTreeResponse?
    ) -> EducationTodo? {
        todo(id: uniqueTodoId(todoId: todoId, classId: classId, projectId: projectId), from: tree)
    }

    /// Same object as `flattenTodos` + `first(where: id)`, without allocating the full list.
    static func todo(id: String, from tree: EducationTreeResponse?) -> EducationTodo? {
        guard let tree else { return nil }
        if let match = tree.todos?.first(where: { $0.id == id }) {
            return match
        }
        for cls in tree.classes ?? [] {
            for todo in cls.todos ?? [] {
                let tagged = todo.withClassId(cls.id)
                if tagged.id == id { return tagged }
            }
        }
        for project in tree.projects ?? [] {
            for todo in project.todos ?? [] {
                let tagged = todo.withProjectId(project.id)
                if tagged.id == id { return tagged }
            }
        }
        return nil
    }

    static func className(for todo: EducationTodo, in tree: EducationTreeResponse?) -> String? {
        if let projectId = todo.projectId {
            return tree?.projects?.first(where: { $0.id == projectId })?.displayName
        }
        if let classId = todo.classId {
            return tree?.classes?.first(where: { $0.id == classId })?.contextDisplayName
        }
        return nil
    }

    static func openTodos(
        from tree: EducationTreeResponse?,
        typeFilters: Set<String>,
        classId: String?,
        limit: Int
    ) -> [EducationTodo] {
        flattenTodos(from: tree)
            .filter { todo in
                todo.done != true
                    && typeFilters.contains(todo.filterTagKey)
                    && (classId == nil || classId == "" || todo.classId == classId)
            }
            .sorted { $0.dueSortKey < $1.dueSortKey }
            .prefix(limit)
            .map { $0 }
    }

    /// How long a checked-off todo stays visible at the bottom of the widget.
    static let widgetCompletedLinger: TimeInterval = 5 * 60

    /// Most recently completed todo still within the linger window (max one).
    static func recentCompletedTodo(
        from tree: EducationTreeResponse?,
        typeFilters: Set<String>,
        classId: String?,
        asOf: Date = .now,
        within: TimeInterval = widgetCompletedLinger
    ) -> EducationTodo? {
        flattenTodos(from: tree)
            .filter { todo in
                guard todo.done == true,
                      typeFilters.contains(todo.filterTagKey),
                      classId == nil || classId == "" || todo.classId == classId,
                      let completedAt = todo.completedAtDate,
                      completedAt.addingTimeInterval(within) > asOf
                else { return false }
                return true
            }
            .sorted { ($0.completedAt ?? "") > ($1.completedAt ?? "") }
            .first
    }

    /// Open todos plus at most one recently completed (reserves a slot when present).
    static func widgetTodos(
        from tree: EducationTreeResponse?,
        typeFilters: Set<String>,
        classId: String?,
        limit: Int,
        asOf: Date = .now
    ) -> (open: [EducationTodo], recentCompleted: EducationTodo?) {
        let completed = recentCompletedTodo(
            from: tree,
            typeFilters: typeFilters,
            classId: classId,
            asOf: asOf
        )
        let openLimit = completed != nil ? max(0, limit - 1) : limit
        let open = openTodos(
            from: tree,
            typeFilters: typeFilters,
            classId: classId,
            limit: openLimit
        )
        return (open, completed)
    }
}

/// Matches website `/education` type filters (`MA` · `QA` · `HW` · `CW` · `none`).
enum EducationTodoFilter {
    static let orderedTags = ["MA", "QA", "HW", "CW", "none"]
    static var allTags: Set<String> { Set(orderedTags) }

    private static let storageKey = "yl-edu-type-filters"

    static func load() -> Set<String> {
        guard let raw = UserDefaults.standard.array(forKey: storageKey) as? [String],
              !raw.isEmpty
        else { return allTags }
        let known = Set(raw.filter { orderedTags.contains($0) })
        return known.isEmpty ? allTags : known
    }

    static func save(_ filters: Set<String>) {
        UserDefaults.standard.set(orderedTags.filter { filters.contains($0) }, forKey: storageKey)
    }
}

/// Dates panel filters: MA · PathIvy · class-linked non-MA · user-level / other projects (dot).
enum EducationDateFilter {
    static let pathivyProjectId = "pathivy"
    static let homeKeys = ["ma", "pa", "class", "loose"]
    static let classKeys = ["ma", "class"]
    static let pathivyKeys = ["ma", "pa"]
    static let projectKeys = ["ma", "loose"]
    static var allHome: Set<String> { Set(homeKeys) }

    private static let storageKey = "yl-edu-date-filters"

    static func load() -> Set<String> {
        guard let raw = UserDefaults.standard.array(forKey: storageKey) as? [String],
              !raw.isEmpty
        else { return allHome }
        let known = Set(raw.filter { homeKeys.contains($0) })
        return known.isEmpty ? allHome : known
    }

    static func save(_ filters: Set<String>) {
        UserDefaults.standard.set(homeKeys.filter { filters.contains($0) }, forKey: storageKey)
    }
}

/// Unified Dates list row: important date objects + todos with showInDates.
struct EducationDateItem: Identifiable, Hashable {
    enum Source: Hashable {
        case date(EducationDate)
        case todo(EducationTodo)
    }

    let source: Source
    let name: String
    let date: String?
    let time: String?
    let classId: String?
    let className: String?
    let projectId: String?
    let projectName: String?
    let isMA: Bool

    var id: String {
        switch source {
        case .date(let d): return "date:\(d.id)"
        case .todo(let t): return "todo:\(t.id)"
        }
    }

    var filterKey: String {
        if isMA { return "ma" }
        if projectId == EducationDateFilter.pathivyProjectId { return "pa" }
        // Class-linked → grad cap. Other projects + user-level → loose (dot).
        if let classId, !classId.isEmpty, projectId == nil || projectId?.isEmpty == true {
            return "class"
        }
        return "loose"
    }

    var sortKey: String {
        "\(date ?? "9999-99-99")T\(time ?? "99:99")"
    }

    var todoValue: EducationTodo? {
        if case .todo(let t) = source { return t }
        return nil
    }

    var dateValue: EducationDate? {
        if case .date(let d) = source { return d }
        return nil
    }
}

enum EducationDateHelpers {
    static let collapsedLimit = 6

    static func flattenDates(from tree: EducationTreeResponse?) -> [EducationDate] {
        var list = tree?.dates ?? []
        for cls in tree?.classes ?? [] {
            list.append(contentsOf: (cls.dates ?? []).map { $0.withClassId(cls.id) })
        }
        for project in tree?.projects ?? [] {
            list.append(contentsOf: (project.dates ?? []).map { $0.withProjectId(project.id) })
        }
        return list
    }

    /// Same object as `flattenDates` + `first(where: id)`, without allocating the full list.
    static func date(id: String, from tree: EducationTreeResponse?) -> EducationDate? {
        guard let tree else { return nil }
        if let match = tree.dates?.first(where: { $0.id == id }) {
            return match
        }
        for cls in tree.classes ?? [] {
            for date in cls.dates ?? [] {
                let tagged = date.withClassId(cls.id)
                if tagged.id == id { return tagged }
            }
        }
        for project in tree.projects ?? [] {
            for date in project.dates ?? [] {
                let tagged = date.withProjectId(project.id)
                if tagged.id == id { return tagged }
            }
        }
        return nil
    }

    static func contextName(for date: EducationDate, in tree: EducationTreeResponse?) -> String? {
        if let projectId = date.projectId, !projectId.isEmpty {
            return tree?.projects?.first(where: { $0.id == projectId })?.displayName
        }
        if let classId = date.classId, !classId.isEmpty {
            return tree?.classes?.first(where: { $0.id == classId })?.contextDisplayName
        }
        return nil
    }

    static func collectItems(
        from tree: EducationTreeResponse?,
        classId: String? = nil,
        projectId: String? = nil
    ) -> [EducationDateItem] {
        guard let tree else { return [] }
        var items: [EducationDateItem] = []

        if let projectId, !projectId.isEmpty {
            guard let project = tree.projects?.first(where: { $0.id == projectId }) else { return [] }
            for date in project.dates ?? [] {
                let d = date.withProjectId(project.id)
                items.append(
                    EducationDateItem(
                        source: .date(d),
                        name: d.displayName,
                        date: d.date,
                        time: d.time,
                        classId: nil,
                        className: nil,
                        projectId: project.id,
                        projectName: project.displayName,
                        isMA: false
                    )
                )
            }
            for todo in project.todos ?? [] {
                let t = todo.withProjectId(project.id)
                guard t.showsInDates else { continue }
                items.append(
                    EducationDateItem(
                        source: .todo(t),
                        name: t.displayName,
                        date: t.dueDateValue,
                        time: t.dueTimeValue,
                        classId: nil,
                        className: nil,
                        projectId: project.id,
                        projectName: project.displayName,
                        isMA: t.filterTagKey == "MA"
                    )
                )
            }
            return items
        }

        if let classId, !classId.isEmpty {
            guard let cls = tree.classes?.first(where: { $0.id == classId }) else { return [] }
            for date in cls.dates ?? [] {
                let d = date.withClassId(cls.id)
                items.append(
                    EducationDateItem(
                        source: .date(d),
                        name: d.displayName,
                        date: d.date,
                        time: d.time,
                        classId: cls.id,
                        className: cls.contextDisplayName,
                        projectId: nil,
                        projectName: nil,
                        isMA: false
                    )
                )
            }
            for todo in cls.todos ?? [] {
                let t = todo.withClassId(cls.id)
                guard t.showsInDates else { continue }
                items.append(
                    EducationDateItem(
                        source: .todo(t),
                        name: t.displayName,
                        date: t.dueDateValue,
                        time: t.dueTimeValue,
                        classId: cls.id,
                        className: cls.contextDisplayName,
                        projectId: nil,
                        projectName: nil,
                        isMA: t.filterTagKey == "MA"
                    )
                )
            }
            return items
        }

        for date in tree.dates ?? [] {
            items.append(
                EducationDateItem(
                    source: .date(date),
                    name: date.displayName,
                    date: date.date,
                    time: date.time,
                    classId: nil,
                    className: nil,
                    projectId: nil,
                    projectName: nil,
                    isMA: false
                )
            )
        }
        for cls in tree.classes ?? [] {
            for date in cls.dates ?? [] {
                let d = date.withClassId(cls.id)
                items.append(
                    EducationDateItem(
                        source: .date(d),
                        name: d.displayName,
                        date: d.date,
                        time: d.time,
                        classId: cls.id,
                        className: cls.contextDisplayName,
                        projectId: nil,
                        projectName: nil,
                        isMA: false
                    )
                )
            }
        }
        for project in tree.projects ?? [] {
            for date in project.dates ?? [] {
                let d = date.withProjectId(project.id)
                items.append(
                    EducationDateItem(
                        source: .date(d),
                        name: d.displayName,
                        date: d.date,
                        time: d.time,
                        classId: nil,
                        className: nil,
                        projectId: project.id,
                        projectName: project.displayName,
                        isMA: false
                    )
                )
            }
        }
        var classNames: [String: String] = [:]
        for cls in tree.classes ?? [] {
            classNames[cls.id] = cls.contextDisplayName
        }
        var projectNames: [String: String] = [:]
        for project in tree.projects ?? [] {
            projectNames[project.id] = project.displayName
        }
        for todo in EducationTodoHelpers.flattenTodos(from: tree) {
            guard todo.showsInDates else { continue }
            let className: String? = todo.classId.flatMap { classNames[$0] }
            let projectName: String? = todo.projectId.flatMap { projectNames[$0] }
            items.append(
                EducationDateItem(
                    source: .todo(todo),
                    name: todo.displayName,
                    date: todo.dueDateValue,
                    time: todo.dueTimeValue,
                    classId: todo.classId,
                    className: className,
                    projectId: todo.projectId,
                    projectName: projectName,
                    isMA: todo.filterTagKey == "MA"
                )
            )
        }
        return items
    }

    static func visibleItems(
        _ items: [EducationDateItem],
        filters: Set<String>,
        expanded: Bool,
        todayKey: String?
    ) -> [EducationDateItem] {
        let today = todayKey ?? Self.localTodayKey()
        let upcoming = items
            .filter { filters.contains($0.filterKey) }
            .filter { item in
                guard let date = item.date, !date.isEmpty else { return false }
                return date >= today
            }
            .sorted { $0.sortKey < $1.sortKey }
        if expanded { return upcoming }
        return Array(upcoming.prefix(collapsedLimit))
    }

    private static func localTodayKey(_ date: Date = Date()) -> String {
        let cal = Calendar.current
        let y = cal.component(.year, from: date)
        let m = cal.component(.month, from: date)
        let d = cal.component(.day, from: date)
        return String(format: "%04d-%02d-%02d", y, m, d)
    }
}
