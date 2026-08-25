import Foundation
import EventKit

let store = EKEventStore()

enum ToolError: Error {
    case message(String)
}

func fail(_ msg: String) -> Never {
    let payload: [String: Any] = ["ok": false, "error": msg]
    print(jsonString(payload))
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

func findCalendar(id: String?, title: String?) -> EKCalendar? {
    let all = store.calendars(for: .event)
    if let id, !id.isEmpty {
        if let match = all.first(where: { $0.calendarIdentifier == id }) { return match }
    }
    if let title, !title.isEmpty {
        let want = title.lowercased()
        if let exact = all.first(where: { $0.title.lowercased() == want }) { return exact }
        if let part = all.first(where: { $0.title.lowercased().contains(want) }) { return part }
    }
    return store.defaultCalendarForNewEvents
}

func eventJSON(_ ev: EKEvent) -> [String: Any] {
    var out: [String: Any] = [
        "id": ev.eventIdentifier ?? "",
        "title": ev.title ?? "",
        "calendar": ev.calendar?.title ?? "",
        "calendarId": ev.calendar?.calendarIdentifier ?? "",
        "allDay": ev.isAllDay,
        "start": ev.startDate.map(iso) ?? "",
        "end": ev.endDate.map(iso) ?? "",
    ]
    if let loc = ev.location, !loc.isEmpty { out["location"] = loc }
    if let notes = ev.notes, !notes.isEmpty { out["notes"] = String(notes.prefix(500)) }
    return out
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
    if let only = argValue(args, "--calendar") {
        if let match = findCalendar(id: only, title: only) {
            cals = [match]
        }
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
    let end = argValue(args, "--end").flatMap(parseDate) ?? start.addingTimeInterval(3600)
    let cal = findCalendar(id: argValue(args, "--calendar-id"), title: argValue(args, "--calendar"))
    guard let cal else { fail("no calendar matched") }
    if !cal.allowsContentModifications { fail("calendar is read-only: \(cal.title)") }
    let ev = EKEvent(eventStore: store)
    ev.calendar = cal
    ev.title = title
    ev.startDate = start
    ev.endDate = end
    ev.isAllDay = argValue(args, "--all-day") == "1" || args.contains("--all-day")
    if let loc = argValue(args, "--location") { ev.location = loc }
    if let notes = argValue(args, "--notes") { ev.notes = notes }
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
    if let startS = argValue(args, "--start"), let start = parseDate(startS) { ev.startDate = start }
    if let endS = argValue(args, "--end"), let end = parseDate(endS) { ev.endDate = end }
    if let loc = argValue(args, "--location") { ev.location = loc }
    if let notes = argValue(args, "--notes") { ev.notes = notes }
    if args.contains("--all-day") { ev.isAllDay = argValue(args, "--all-day") != "0" }
    if let calArg = argValue(args, "--calendar") ?? argValue(args, "--calendar-id"),
       let cal = findCalendar(id: calArg, title: calArg) {
        ev.calendar = cal
    }
    do {
        try store.save(ev, span: .thisEvent, commit: true)
        print(jsonString(["ok": true, "event": eventJSON(ev)]))
    } catch {
        fail(error.localizedDescription)
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
        "usage": "yl-calendar list | events --from ISO --to ISO | create --title T --start ISO [--end ISO] [--calendar NAME] | update --id ID | delete --id ID",
    ]))
    exit(0)
}

requestAccess()
switch cmd {
case "list": cmdList()
case "events": cmdEvents(args)
case "create": cmdCreate(args)
case "update": cmdUpdate(args)
case "delete": cmdDelete(args)
default: fail("unknown command \(cmd)")
}
