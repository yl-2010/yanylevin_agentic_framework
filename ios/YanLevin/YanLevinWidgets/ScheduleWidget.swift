import SwiftUI
import WidgetKit

struct ScheduleEntry: TimelineEntry {
    let date: Date
    let authorized: Bool
    let appGroupReady: Bool
    let sections: [DaySection]
    let upcoming: [(section: DaySection, dayClass: DayClass)]
}

struct ScheduleProvider: TimelineProvider {
    func placeholder(in context: Context) -> ScheduleEntry {
        ScheduleEntry(date: .now, authorized: true, appGroupReady: true, sections: [], upcoming: [])
    }

    func getSnapshot(in context: Context, completion: @escaping (ScheduleEntry) -> Void) {
        Task {
            completion(await makeEntry())
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ScheduleEntry>) -> Void) {
        Task {
            let entry = await makeEntry()
            let next = Calendar.current.date(byAdding: .minute, value: 15, to: Date()) ?? Date().addingTimeInterval(900)
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }

    private func makeEntry() async -> ScheduleEntry {
        guard AppGroupStore.isAvailable else {
            return ScheduleEntry(date: .now, authorized: false, appGroupReady: false, sections: [], upcoming: [])
        }
        guard AppGroupStore.hasFullAccess else {
            return ScheduleEntry(date: .now, authorized: false, appGroupReady: true, sections: [], upcoming: [])
        }
        let tree = await WidgetEducationLoader.loadTree()
            ?? AppGroupStore.loadCachedEducationTree()
        let sections = EducationScheduleHelper.classSections(
            schedule: tree?.schedule,
            classes: tree?.classes ?? [],
            activeClassIdsByDate: tree?.activeClassIdsByDate
        )
        let upcoming = EducationScheduleHelper.upcomingClasses(sections: sections, limit: 8)
        return ScheduleEntry(
            date: .now,
            authorized: true,
            appGroupReady: true,
            sections: sections,
            upcoming: upcoming
        )
    }
}

struct ScheduleWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ScheduleEntry

    var body: some View {
        Group {
            if !entry.appGroupReady {
                messageView(
                    title: "Schedule",
                    body: "Widgets need App Groups. That requires an Apple Developer Program account — then enable group.com.example.personalagent for the app + widget."
                )
            } else if !entry.authorized {
                messageView(
                    title: "Schedule",
                    body: "Open Yan Levin and sign in with a full-access account."
                )
            } else if family == .systemLarge {
                largeSchedule
            } else {
                compactSchedule(limit: 4, showTime: family == .systemMedium)
            }
        }
        .foregroundStyle(WidgetTheme.fg)
        .padding(12)
        .containerBackground(for: .widget) {
            widgetBackground
        }
    }

    private func messageView(title: String, body: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.headline.weight(.bold))
                .foregroundStyle(WidgetTheme.fg)
            Text(body)
                .font(.caption)
                .foregroundStyle(WidgetTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private func compactSchedule(limit: Int, showTime: Bool) -> some View {
        let rows = Array(entry.upcoming.prefix(limit))
        return VStack(alignment: .leading, spacing: 6) {
            Text("Schedule")
                .font(.headline.weight(.bold))
                .foregroundStyle(WidgetTheme.fg)
            if rows.isEmpty {
                Text("No upcoming classes")
                    .font(.caption)
                    .foregroundStyle(WidgetTheme.muted)
            } else {
                ForEach(Array(rows.enumerated()), id: \.offset) { _, item in
                    HStack(spacing: 8) {
                        Text(item.dayClass.period)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(WidgetTheme.accent)
                            .frame(width: 14, alignment: .leading)
                        Text(item.dayClass.cls.displayName)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(WidgetTheme.fg)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        if showTime, let start = item.dayClass.start {
                            Text(formatTime(start))
                                .font(.caption2)
                                .foregroundStyle(WidgetTheme.muted)
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var largeSchedule: some View {
        let grouped = largeGroups
        return VStack(alignment: .leading, spacing: 10) {
            Text("Schedule")
                .font(.headline.weight(.bold))
                .foregroundStyle(WidgetTheme.fg)
            if grouped.isEmpty {
                Text("No upcoming classes")
                    .font(.caption)
                    .foregroundStyle(WidgetTheme.muted)
            } else {
                ForEach(Array(grouped.enumerated()), id: \.offset) { _, group in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            if let code = group.section.typeCode {
                                Text(code)
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(WidgetTheme.accent)
                            }
                            Text(group.section.whenLabel)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(WidgetTheme.muted)
                        }
                        ForEach(group.classes) { dayClass in
                            HStack(spacing: 8) {
                                Text(dayClass.period)
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(WidgetTheme.accent)
                                    .frame(width: 14, alignment: .leading)
                                Text(dayClass.cls.displayName)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(WidgetTheme.fg)
                                    .lineLimit(1)
                                Spacer(minLength: 0)
                                if let start = dayClass.start {
                                    Text(formatTime(start))
                                        .font(.caption2)
                                        .foregroundStyle(WidgetTheme.muted)
                                }
                            }
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// Up to 8 upcoming classes, split by website day sections.
    private var largeGroups: [(section: DaySection, classes: [DayClass])] {
        var remaining = 8
        var out: [(DaySection, [DayClass])] = []
        for section in entry.sections {
            guard remaining > 0 else { break }
            let dayClasses = section.classes.filter { !section.isPast($0) }
            guard !dayClasses.isEmpty else { continue }
            let slice = Array(dayClasses.prefix(remaining))
            out.append((section, slice))
            remaining -= slice.count
        }
        return out
    }

    private var widgetBackground: some View {
        LinearGradient(
            colors: [WidgetTheme.bg0, WidgetTheme.bg1],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    private func formatTime(_ t: String) -> String {
        NaturalWhen.format(date: nil, time: t, use24Hour: AppGroupStore.use24Hour)
    }
}

struct ScheduleWidget: Widget {
    let kind = "YanLevinScheduleWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ScheduleProvider()) { entry in
            ScheduleWidgetView(entry: entry)
        }
        .configurationDisplayName("Schedule")
        .description("Upcoming classes from Education. Requires a signed-in full-access account.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
