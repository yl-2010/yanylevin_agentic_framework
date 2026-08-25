import Foundation

/// Natural due/event phrasing matching `/education` `formatNaturalWhen`.
enum NaturalWhen {
    private static let weekdaysShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    private static let weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    private static let monthsFull = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    ]

    /// Compact list-row phrasing (“3:30 pm tomorrow”, “Fri Aug 28th”, …).
    static func format(date dateStr: String?, time timeStr: String?, use24Hour: Bool = false) -> String {
        guard let target = parseYmd(dateStr) else {
            return timeStr.map { formatTime($0, use24Hour: use24Hour) } ?? ""
        }

        let now = todayParts()
        let calendar = Calendar.current
        let targetDate = calendar.date(from: DateComponents(year: target.y, month: target.m, day: target.day))!
        let targetWeekday = calendar.component(.weekday, from: targetDate) - 1
        let delta = daysBetween(now, target)
        let clock = timeStr.map { formatTime($0, use24Hour: use24Hour) } ?? ""
        let dayAbbr = weekdaysShort[targetWeekday]

        let weekStart = addDays(now.y, now.m, now.day, -now.weekday)
        let weekOffset = daysBetween(weekStart, target)
        let inThisOrNextWeek = weekOffset >= 0 && weekOffset <= 13

        if delta == 0 {
            return clock.isEmpty ? "today" : "\(clock) today"
        }
        if delta == 1 {
            return clock.isEmpty ? "tomorrow" : "\(clock) tomorrow"
        }
        if delta == -1 {
            return clock.isEmpty ? "yesterday" : "\(clock) yesterday"
        }

        let showYear = target.y != now.y
        let showMonth = target.m != now.m || target.y != now.y || delta < 0
        let dayPart = showMonth
            ? "\(months[target.m - 1]) \(ordinal(target.day))"
            : "the \(ordinal(target.day))"
        let yearPart = showYear ? ", \(target.y)" : ""
        let dateCore = "\(dayPart)\(yearPart)"
        let dated = inThisOrNextWeek ? "\(dayAbbr) \(dateCore)" : dateCore

        if delta < -1 {
            return dated
        }
        if !clock.isEmpty {
            return "\(clock) on \(dated)"
        }
        return dated
    }

    /// Class-detail subtitle: “11:10–11:40 today”, “11:10–11:40 on Sept 2nd”, …
    /// Port of `formatNextClassWhen` in education/app.js.
    static func formatNextClassWhen(
        dateKey: String?,
        start: String?,
        end: String?,
        use24Hour: Bool = false
    ) -> String {
        let startClock = start.map { formatTime($0, use24Hour: use24Hour) } ?? ""
        let endClock = end.map { formatTime($0, use24Hour: use24Hour) } ?? ""
        let range: String
        if !startClock.isEmpty && !endClock.isEmpty {
            range = "\(startClock)–\(endClock)"
        } else if !startClock.isEmpty {
            range = startClock
        } else {
            range = endClock
        }
        guard let target = parseYmd(dateKey) else { return range }

        let now = todayParts()
        let delta = daysBetween(now, target)
        if delta == 0 { return range.isEmpty ? "today" : "\(range) today" }
        if delta == 1 { return range.isEmpty ? "tomorrow" : "\(range) tomorrow" }

        let calendar = Calendar.current
        let targetDate = calendar.date(from: DateComponents(year: target.y, month: target.m, day: target.day))!
        let dayAbbr = weekdaysShort[calendar.component(.weekday, from: targetDate) - 1]
        let showYear = target.y != now.y
        let showMonth = target.m != now.m || target.y != now.y
        let dayPart = showMonth
            ? "\(months[target.m - 1]) \(ordinal(target.day))"
            : "the \(ordinal(target.day))"
        let yearPart = showYear ? ", \(target.y)" : ""
        let weekStart = addDays(now.y, now.m, now.day, -now.weekday)
        let weekOffset = daysBetween(weekStart, target)
        let inThisOrNextWeek = weekOffset >= 0 && weekOffset <= 13
        let dateCore = "\(dayPart)\(yearPart)"
        let dated = inThisOrNextWeek ? "\(dayAbbr) \(dateCore)" : dateCore
        if range.isEmpty { return dated }
        return "\(range) on \(dated)"
    }

    /// Expanded detail phrasing (“08:00 on Friday, August 28th (Today)”).
    static func formatDetail(date dateStr: String?, time timeStr: String?, use24Hour: Bool = false) -> String {
        guard let target = parseYmd(dateStr) else {
            return timeStr.map { formatTime($0, use24Hour: use24Hour) } ?? ""
        }

        let now = todayParts()
        let calendar = Calendar.current
        let targetDate = calendar.date(from: DateComponents(year: target.y, month: target.m, day: target.day))!
        let delta = daysBetween(now, target)
        let clock = timeStr.map { formatTime($0, use24Hour: use24Hour) } ?? ""
        let weekday = weekdays[calendar.component(.weekday, from: targetDate) - 1]
        let month = monthsFull[target.m - 1]
        let day = ordinal(target.day)
        let yearPart = target.y != now.y ? ", \(target.y)" : ""
        var relative = ""
        if delta == 0 { relative = " (Today)" }
        else if delta == 1 { relative = " (Tomorrow)" }
        else if delta == -1 { relative = " (Yesterday)" }

        let dated = "\(weekday), \(month) \(day)\(yearPart)\(relative)"
        if !clock.isEmpty {
            return "\(clock) on \(dated)"
        }
        return dated
    }

    // MARK: - Helpers

    private struct YMD {
        var y: Int
        var m: Int
        var day: Int
        var weekday: Int
    }

    private static func parseYmd(_ s: String?) -> YMD? {
        guard let s, let match = s.wholeMatch(of: /^(\d{4})-(\d{2})-(\d{2})$/) else { return nil }
        let y = Int(match.1)!
        let m = Int(match.2)!
        let day = Int(match.3)!
        let calendar = Calendar.current
        guard let date = calendar.date(from: DateComponents(year: y, month: m, day: day)) else { return nil }
        return YMD(y: y, m: m, day: day, weekday: calendar.component(.weekday, from: date) - 1)
    }

    private static func todayParts() -> YMD {
        let now = Date()
        let calendar = Calendar.current
        return YMD(
            y: calendar.component(.year, from: now),
            m: calendar.component(.month, from: now),
            day: calendar.component(.day, from: now),
            weekday: calendar.component(.weekday, from: now) - 1
        )
    }

    private static func addDays(_ y: Int, _ m: Int, _ day: Int, _ n: Int) -> YMD {
        let calendar = Calendar.current
        let base = calendar.date(from: DateComponents(year: y, month: m, day: day))!
        let next = calendar.date(byAdding: .day, value: n, to: base)!
        return YMD(
            y: calendar.component(.year, from: next),
            m: calendar.component(.month, from: next),
            day: calendar.component(.day, from: next),
            weekday: calendar.component(.weekday, from: next) - 1
        )
    }

    private static func daysBetween(_ a: YMD, _ b: YMD) -> Int {
        let calendar = Calendar.current
        let da = calendar.date(from: DateComponents(year: a.y, month: a.m, day: a.day))!
        let db = calendar.date(from: DateComponents(year: b.y, month: b.m, day: b.day))!
        return calendar.dateComponents([.day], from: da, to: db).day ?? 0
    }

    private static func ordinal(_ n: Int) -> String {
        let v = n % 100
        if (11...13).contains(v) { return "\(n)th" }
        switch n % 10 {
        case 1: return "\(n)st"
        case 2: return "\(n)nd"
        case 3: return "\(n)rd"
        default: return "\(n)th"
        }
    }

    private static func formatTime(_ t: String, use24Hour: Bool) -> String {
        guard let match = t.wholeMatch(of: /^(\d{1,2}):(\d{2})$/) else { return t }
        let h24 = Int(match.1)!
        let mi = Int(match.2)!
        if use24Hour {
            return String(format: "%02d:%02d", h24, mi)
        }
        let ap = h24 >= 12 ? "pm" : "am"
        let h12 = h24 % 12 == 0 ? 12 : h24 % 12
        return String(format: "%d:%02d %@", h12, mi, ap)
    }
}
