import SwiftUI

struct ChatHistorySection: Identifiable, Equatable {
    let id: String
    let title: String
    let showAge: Bool
    let chats: [AgentChatListItem]
}

enum ChatISODate {
    private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// Grouping + relative ages re-run on every history-drag frame; formatter
    /// parsing is far too slow for that, so memoize by raw string.
    private static let cacheLock = NSLock()
    private static var cache: [String: Date] = [:]

    static func parse(_ raw: String) -> Date? {
        cacheLock.lock()
        let hit = cache[raw]
        cacheLock.unlock()
        if let hit { return hit }
        guard let parsed = fractional.date(from: raw) ?? plain.date(from: raw) else {
            return nil
        }
        cacheLock.lock()
        if cache.count > 512 { cache.removeAll(keepingCapacity: true) }
        cache[raw] = parsed
        cacheLock.unlock()
        return parsed
    }
}

enum ChatHistoryGrouping {
    static func relativeAge(from iso: String, now: Date = Date()) -> String {
        guard let date = ChatISODate.parse(iso) else { return "" }
        let secs = now.timeIntervalSince(date)
        if secs < 60 { return "now" }
        let mins = Int(secs / 60)
        if mins < 60 { return "\(mins)m" }
        let hours = Int(mins / 60)
        if hours < 48 { return "\(hours)h" }
        return ""
    }

    static func sections(
        from chats: [AgentChatListItem],
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [ChatHistorySection] {
        var order: [String] = []
        var buckets: [String: (title: String, showAge: Bool, chats: [AgentChatListItem])] = [:]
        for chat in chats {
            let g = group(for: chat.updated, now: now, calendar: calendar)
            if buckets[g.id] == nil {
                order.append(g.id)
                buckets[g.id] = (g.title, g.showAge, [])
            }
            buckets[g.id]?.chats.append(chat)
        }
        return order.compactMap { key in
            guard let row = buckets[key] else { return nil }
            return ChatHistorySection(
                id: key,
                title: row.title,
                showAge: row.showAge,
                chats: row.chats
            )
        }
    }

    private static func group(
        for iso: String,
        now: Date,
        calendar: Calendar
    ) -> (id: String, title: String, showAge: Bool) {
        guard let date = ChatISODate.parse(iso) else {
            return ("older", "Older", false)
        }
        let startToday = calendar.startOfDay(for: now)
        let startThat = calendar.startOfDay(for: date)
        let days = calendar.dateComponents([.day], from: startThat, to: startToday).day ?? 999
        if days <= 0 {
            return ("today", "Today", true)
        }
        if days == 1 {
            return ("yesterday", "Yesterday", false)
        }
        if days < 7 {
            let key = dayKey(startThat, calendar: calendar)
            return (key, weekdayName(date, calendar: calendar), false)
        }
        return ("older", "Older", false)
    }

    private static let weekdayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "EEEE"
        return f
    }()

    private static func weekdayName(_ date: Date, calendar: Calendar) -> String {
        let f = weekdayFormatter
        let locale = calendar.locale ?? Locale.current
        if f.calendar != calendar {
            f.calendar = calendar
        }
        if f.locale != locale {
            f.locale = locale
        }
        if f.timeZone != calendar.timeZone {
            f.timeZone = calendar.timeZone
        }
        return f.string(from: date)
    }

    private static func dayKey(_ date: Date, calendar: Calendar) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }
}

struct ChatHistoryPanel: View {
    @Environment(\.colorScheme) private var colorScheme
    let sections: [ChatHistorySection]
    let isLoading: Bool
    let width: CGFloat
    var onSelect: (AgentChatListItem) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                if isLoading && sections.isEmpty {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.top, 28)
                } else if sections.isEmpty {
                    Text("No past chats yet.")
                        .font(.subheadline)
                        .foregroundStyle(YLTheme.muted(colorScheme))
                        .padding(.top, 20)
                }
                ForEach(sections) { section in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(section.title)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(YLTheme.muted(colorScheme))
                            .padding(.horizontal, 4)
                            .padding(.bottom, 2)
                        ForEach(section.chats) { chat in
                            Button {
                                onSelect(chat)
                            } label: {
                                ChatHistoryRowLabel(
                                    chat: chat,
                                    showAge: section.showAge
                                )
                            }
                            .buttonStyle(ChatHistoryRowButtonStyle())
                            .accessibilityLabel(chat.displayTitle)
                            .accessibilityValue(
                                chat.isWorking ? "Working" : chat.isUnread ? "Unread" : ""
                            )
                        }
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
        }
        .frame(width: width)
        .frame(maxHeight: .infinity, alignment: .top)
        .ylGlassRounded(cornerRadius: 22, interactive: true, clear: true)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Past chats")
    }
}

private struct ChatHistoryRowLabel: View {
    @Environment(\.colorScheme) private var colorScheme
    let chat: AgentChatListItem
    let showAge: Bool

    var body: some View {
        if chat.isWorking || chat.isUnread {
            HStack(alignment: .center, spacing: 8) {
                ChatHistoryStatusDot(working: chat.isWorking)
                titleAndAge
            }
        } else {
            titleAndAge
        }
    }

    private var titleAndAge: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(chat.displayTitle)
                .font(.body)
                .foregroundStyle(YLTheme.fg(colorScheme))
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            if showAge {
                Text(ChatHistoryGrouping.relativeAge(from: chat.updated))
                    .font(.caption)
                    .foregroundStyle(YLTheme.muted(colorScheme))
                    .monospacedDigit()
            }
        }
    }
}

/// Own Liquid Glass chip per past chat. Press shine comes from interactive glass only.
private struct ChatHistoryRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .ylGlassRounded(cornerRadius: 14, interactive: true)
    }
}

private struct ChatHistoryStatusDot: View {
    let working: Bool
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dimmed = false

    var body: some View {
        Circle()
            .fill(YLTheme.chatSend(colorScheme))
            .frame(width: 8, height: 8)
            .opacity(working && !reduceMotion && dimmed ? 0.25 : 1)
            .onAppear(perform: syncPulse)
            .onChange(of: working) { _, _ in
                syncPulse()
            }
            .onChange(of: reduceMotion) { _, _ in
                syncPulse()
            }
    }

    private func syncPulse() {
        dimmed = false
        guard working, !reduceMotion else { return }
        withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
            dimmed = true
        }
    }
}
