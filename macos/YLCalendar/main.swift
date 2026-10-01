import Foundation
import EventKit

let store = EKEventStore()

enum ToolError: Error {
    case message(String)
}

func fail(_ msg: String) -> Never {
    let payload: [String: Any] = ["ok": false, "error": msg]
    let text = jsonString(payload)
    try? text.write(to: URL(fileURLWithPath: "/tmp/yl-calendar-last.json"), atomically: true, encoding: .utf8)
    print(text)
    exit(1)
}

func jsonString(_ obj: Any) -> String {
    guard JSONSerialization.isValidJSONObject(obj),
          let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
          let s = String(data: data, encoding: .utf8) else {
        return "{\"ok\":false,\"error\":\"json\"}"
    }
    return s
}

func iso(_ date: Date) -> String {
    ISO8601DateFormatter().string(from: date)
}

func parseDate(_ raw: String) -> Date? {
    let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.isEmpty { return nil }
    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = iso.date(from: s) { return d }
    iso.formatOptions = [.withInternetDateTime]
    if let d = iso.date(from: s) { return d }
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(secondsFromGMT: 0)
    f.dateFormat = "yyyy-MM-dd'T'HH:mm:ssXXXXX"
    if let d = f.date(from: s) { return d }
    f.dateFormat = "yyyy-MM-dd"
    return f.date(from: s)
}

func argValue(_ args: [String], _ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func requestAccess() {
    let sem = DispatchSemaphore(value: 0)
    var granted = false
    var errMsg = ""
    if #available(macOS 14.0, *) {
        store.requestFullAccessToEvents { ok, error in
            granted = ok
            errMsg = error?.localizedDescription ?? ""
            sem.signal()
        }
    } else {
        store.requestAccess(to: .event) { ok, error in
            granted = ok
            errMsg = error?.localizedDescription ?? ""
            sem.signal()
        }
    }
    _ = sem.wait(timeout: .now() + 30)
    if !granted {
        fail(errMsg.isEmpty ? "Calendar access denied. Grant Calendar to yl-calendar in System Settings > Privacy & Security." : errMsg)
    }
}

func calendarsJSON() -> [[String: Any]] {
    store.calendars(for: .event).map { cal in
        [
            "id": cal.calendarIdentifier,
            "title": cal.title,
            "type": String(describing: cal.type),
            "allowModify": cal.allowsContentModifications,
            "source": cal.source?.title ?? "",
        ]
    }
}

enum CalMatch {
    case found(EKCalendar)
    case none
    case ambiguous([String])
}

func matchCalendar(id: String?, title: String?, source: String?) -> CalMatch {
    let all = store.calendars(for: .event)
    if let id, !id.isEmpty {
        if let match = all.first(where: { $0.calendarIdentifier == id }) {
            return .found(match)
        }
    }
    var pool = all
    if let source, !source.isEmpty {
        let want = source.lowercased()
        pool = all.filter { ($0.source?.title ?? "").lowercased() == want }
    }
    if let title, !title.isEmpty {
        let want = title.lowercased()
        let exact = pool.filter { $0.title.lowercased() == want }
        if exact.count == 1, let only = exact.first { return .found(only) }
        if exact.count > 1 {
            return .ambiguous(exact.map { $0.source?.title ?? "" })
        }
        if source == nil || source?.isEmpty == true {
            let part = pool.filter { $0.title.lowercased().contains(want) }
            if part.count == 1, let only = part.first { return .found(only) }
            if part.count > 1 {
                return .ambiguous(part.map { $0.source?.title ?? "" })
            }
        }
        return .none
    }
    if let source, !source.isEmpty { return .none }
    if let def = store.defaultCalendarForNewEvents { return .found(def) }
    return .none
}

func requireCalendar(id: String?, title: String?, source: String?) -> EKCalendar {
    switch matchCalendar(id: id, title: title, source: source) {
    case .found(let cal):
        return cal
    case .none:
        fail("no calendar matched")
    case .ambiguous(let sources):
        fail("calendar title matches more than one account (\(sources.joined(separator: ", "))). Pass --source")
    }
}

func findSource(_ name: String) -> EKSource? {
    let want = name.lowercased()
    return store.sources.first { $0.title.lowercased() == want }
}

func participantJSON(_ p: EKParticipant) -> [String: Any] {
    var email = ""
    let raw = p.url.absoluteString
    if !raw.isEmpty {
        email = raw.replacingOccurrences(of: "mailto:", with: "", options: .caseInsensitive)
    }
    return [
        "name": p.name ?? "",
        "email": email,
        "self": p.isCurrentUser,
    ]
}

func eventJSON(_ ev: EKEvent) -> [String: Any] {
    var out: [String: Any] = [
        "id": ev.eventIdentifier ?? "",
        "seriesId": ev.calendarItemExternalIdentifier ?? "",
        "title": ev.title ?? "",
        "calendar": ev.calendar?.title ?? "",
        "calendarId": ev.calendar?.calendarIdentifier ?? "",
        "source": ev.calendar?.source?.title ?? "",
        "allDay": ev.isAllDay,
        "recurring": ev.hasRecurrenceRules,
        "hasAttendees": ev.hasAttendees,
        "start": ev.startDate.map(iso) ?? "",
        "end": ev.endDate.map(iso) ?? "",
    ]
    if let loc = ev.location, !loc.isEmpty { out["location"] = loc }
    if let notes = ev.notes, !notes.isEmpty { out["notes"] = String(notes.prefix(500)) }
    if let url = ev.url?.absoluteString, !url.isEmpty { out["url"] = url }
    if let org = ev.organizer { out["organizer"] = participantJSON(org) }
    if let people = ev.attendees, !people.isEmpty {
        out["attendees"] = people.map(participantJSON)
    }
    return out
}

func calendarJSON(_ cal: EKCalendar) -> [String: Any] {
    [
        "id": cal.calendarIdentifier,
        "title": cal.title,
        "source": cal.source?.title ?? "",
        "allowModify": cal.allowsContentModifications,
    ]
}

func cmdList() {
    print(jsonString(["ok": true, "calendars": calendarsJSON()]))
}

func cmdEvents(_ args: [String]) {
    guard let fromS = argValue(args, "--from"), let toS = argValue(args, "--to"),
          let from = parseDate(fromS), let to = parseDate(toS) else {
        fail("events requires --from and --to ISO dates")
    }
    var cals = store.calendars(for: .event)
    if argValue(args, "--calendar") != nil || argValue(args, "--calendar-id") != nil {
        let match = requireCalendar(
            id: argValue(args, "--calendar-id"),
            title: argValue(args, "--calendar"),
            source: argValue(args, "--source")
        )
        cals = [match]
    }
    let pred = store.predicateForEvents(withStart: from, end: to, calendars: cals)
    let events = store.events(matching: pred).sorted { a, b in
        (a.startDate ?? .distantPast) < (b.startDate ?? .distantPast)
    }
    print(jsonString(["ok": true, "events": events.map(eventJSON)]))
}

func cmdCreate(_ args: [String]) {
    guard let title = argValue(args, "--title"), !title.isEmpty else {
        fail("create requires --title")
    }
    guard let startS = argValue(args, "--start"), let start = parseDate(startS) else {
        fail("create requires --start ISO")
    }
    let allDay = (argValue(args, "--all-day") == "1" || args.contains("--all-day")) && argValue(args, "--all-day") != "0"
    let end = argValue(args, "--end").flatMap(parseDate) ?? start.addingTimeInterval(allDay ? 86400 : 3600)
    let cal = requireCalendar(
        id: argValue(args, "--calendar-id"),
        title: argValue(args, "--calendar"),
        source: argValue(args, "--source")
    )
    if !cal.allowsContentModifications { fail("calendar is read-only: \(cal.title)") }
    let ev = EKEvent(eventStore: store)
    ev.calendar = cal
    ev.title = title
    ev.isAllDay = allDay
    ev.startDate = start
    ev.endDate = end
    if let loc = argValue(args, "--location") { ev.location = loc }
    if let notes = argValue(args, "--notes") { ev.notes = notes }
    if let urlS = argValue(args, "--url"), let u = URL(string: urlS) { ev.url = u }
    do {
        try store.save(ev, span: .thisEvent, commit: true)
        print(jsonString(["ok": true, "event": eventJSON(ev)]))
    } catch {
        fail(error.localizedDescription)
    }
}

func cmdUpdate(_ args: [String]) {
    guard let id = argValue(args, "--id"), let ev = store.event(withIdentifier: id) else {
        fail("update requires a valid --id")
    }
    if let title = argValue(args, "--title") { ev.title = title }
    if args.contains("--all-day") { ev.isAllDay = argValue(args, "--all-day") != "0" }
    if let startS = argValue(args, "--start"), let start = parseDate(startS) { ev.startDate = start }
    if let endS = argValue(args, "--end"), let end = parseDate(endS) { ev.endDate = end }
    if let loc = argValue(args, "--location") { ev.location = loc }
    if let notes = argValue(args, "--notes") { ev.notes = notes }
    if let urlS = argValue(args, "--url"), let u = URL(string: urlS) { ev.url = u }
    if argValue(args, "--calendar") != nil || argValue(args, "--calendar-id") != nil {
        let cal = requireCalendar(
            id: argValue(args, "--calendar-id"),
            title: argValue(args, "--calendar"),
            source: argValue(args, "--source")
        )
        if !cal.allowsContentModifications { fail("calendar is read-only: \(cal.title)") }
        ev.calendar = cal
    }
    let span: EKSpan = argValue(args, "--span") == "future" ? .futureEvents : .thisEvent
    do {
        try store.save(ev, span: span, commit: true)
        print(jsonString(["ok": true, "event": eventJSON(ev)]))
    } catch {
        fail(error.localizedDescription)
    }
}

func cmdCreateCalendar(_ args: [String]) {
    guard let title = argValue(args, "--title"), !title.isEmpty else {
        fail("create-calendar requires --title")
    }
    guard let sourceName = argValue(args, "--source"), !sourceName.isEmpty else {
        fail("create-calendar requires --source")
    }
    guard let source = findSource(sourceName) else {
        fail("no account named \(sourceName)")
    }
    switch matchCalendar(id: nil, title: title, source: sourceName) {
    case .found(let existing):
        print(jsonString(["ok": true, "created": false, "calendar": calendarJSON(existing)]))
        return
    case .ambiguous:
        fail("calendar \(title) already exists more than once on \(sourceName)")
    case .none:
        break
    }
    let cal = EKCalendar(for: .event, eventStore: store)
    cal.title = title
    cal.source = source
    do {
        try store.saveCalendar(cal, commit: true)
        print(jsonString(["ok": true, "created": true, "calendar": calendarJSON(cal)]))
    } catch {
        fail(error.localizedDescription)
    }
}

func cmdRenameCalendar(_ args: [String]) {
    guard let title = argValue(args, "--title"), !title.isEmpty else {
        fail("rename-calendar requires --title")
    }
    let cal = requireCalendar(
        id: argValue(args, "--calendar-id") ?? argValue(args, "--id"),
        title: argValue(args, "--calendar"),
        source: argValue(args, "--source")
    )
    if !cal.allowsContentModifications { fail("calendar is read-only: \(cal.title)") }
    cal.title = title
    do {
        try store.saveCalendar(cal, commit: true)
        print(jsonString(["ok": true, "calendar": calendarJSON(cal)]))
    } catch {
        fail(error.localizedDescription)
    }
}

func cmdDeleteCalendar(_ args: [String]) {
    let cal = requireCalendar(
        id: argValue(args, "--calendar-id") ?? argValue(args, "--id"),
        title: argValue(args, "--calendar"),
        source: argValue(args, "--source")
    )
    if !cal.allowsContentModifications { fail("calendar is read-only: \(cal.title)") }
    let from = Date(timeIntervalSince1970: 0)
    let to = Date(timeIntervalSince1970: 2_200_000_000)
    let pred = store.predicateForEvents(withStart: from, end: to, calendars: [cal])
    let events = store.events(matching: pred)
    if !events.isEmpty && !args.contains("--force") {
        fail("calendar is not empty (\(events.count) events)")
    }
    do {
        try store.removeCalendar(cal, commit: true)
        print(jsonString(["ok": true, "deleted": cal.title, "source": cal.source?.title ?? ""]))
    } catch {
        fail(error.localizedDescription)
    }
}

func cmdGet(_ args: [String]) {
    guard let id = argValue(args, "--id"), !id.isEmpty else {
        fail("get requires --id")
    }
    if let ev = store.event(withIdentifier: id) {
        print(jsonString(["ok": true, "found": true, "event": eventJSON(ev)]))
    } else {
        print(jsonString(["ok": true, "found": false]))
    }
}

func cmdDelete(_ args: [String]) {
    guard let id = argValue(args, "--id"), let ev = store.event(withIdentifier: id) else {
        fail("delete requires a valid --id")
    }
    do {
        try store.remove(ev, span: .thisEvent, commit: true)
        print(jsonString(["ok": true, "deleted": id]))
    } catch {
        fail(error.localizedDescription)
    }
}

let args = Array(CommandLine.arguments.dropFirst())
let cmd = args.first ?? "help"
if cmd == "help" || cmd == "--help" {
    print(jsonString([
        "ok": true,
        "usage": "yl-calendar list | events --from ISO --to ISO [--calendar NAME --source ACCOUNT] | get --id ID | create --title T --start ISO [--end ISO] [--calendar NAME --source ACCOUNT] [--location S] [--url URL] [--notes S] | update --id ID [--calendar NAME --source ACCOUNT] [--span future] | delete --id ID | create-calendar --title T --source ACCOUNT | rename-calendar --calendar NAME --source ACCOUNT --title NEW | delete-calendar --calendar NAME --source ACCOUNT",
    ]))
    exit(0)
}

requestAccess()
switch cmd {
case "list": cmdList()
case "events": cmdEvents(args)
case "get": cmdGet(args)
case "create": cmdCreate(args)
case "update": cmdUpdate(args)
case "delete": cmdDelete(args)
case "create-calendar": cmdCreateCalendar(args)
case "rename-calendar": cmdRenameCalendar(args)
case "delete-calendar": cmdDeleteCalendar(args)
default: fail("unknown command \(cmd)")
}
