import SwiftUI
import UIKit

struct ChatHistorySection: Identifiable, Equatable {
    let id: String
    let title: String
    let showAge: Bool
    let entries: [ChatHistoryEntry]
}

/// Priority order, highest last: working > unread > pending > draft > normal.
enum ChatHistoryRowState: Equatable {
    case normal
    case draft
    case pending
    case unread
    case working

    var accessibilityValue: String {
        switch self {
        case .normal: return ""
        case .draft: return "Draft"
        case .pending: return "Sending"
        case .unread: return "Unread"
        case .working: return "Working"
        }
    }
}

/// One sidebar row: a server chat, an unsent new-chat draft, or a send the
/// server has not accepted yet.
struct ChatHistoryEntry: Identifiable, Equatable {
    enum Target: Equatable {
        case chat(sessionId: String)
        case draft(id: String)
        case pending(sessionId: String?)
    }

    let id: String
    let target: Target
    let title: String
    let updated: String
    let state: ChatHistoryRowState
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
    /// History buckets are Seattle calendar days, not the phone's zone.
    private static let seattleCalendar: Calendar = {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "America/Los_Angeles") ?? .current
        cal.locale = Locale(identifier: "en_US")
        return cal
    }()

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

    /// Chats, sessionless drafts, and unclaimed pending sends merged newest first.
    /// A pending send converts its draft row or chat row in place; only a send
    /// with neither gets its own row.
    static func entries(
        chats: [AgentChatListItem],
        drafts: [ChatDraft],
        pending: [AgentPendingSend]
    ) -> [ChatHistoryEntry] {
        let chatIds = Set(chats.map(\.sessionId))
        let draftedSessions = Set(drafts.compactMap { $0.hasContent ? $0.sessionId : nil })
        var claimed = Set<UUID>()
        var rows: [ChatHistoryEntry] = []

        for chat in chats {
            let sends = pending.filter { $0.sessionId == chat.sessionId }
            sends.forEach { claimed.insert($0.id) }
            let state: ChatHistoryRowState
            if chat.isWorking {
                state = .working
            } else if chat.isUnread {
                state = .unread
            } else if !sends.isEmpty {
                state = .pending
            } else if draftedSessions.contains(chat.sessionId) {
                state = .draft
            } else {
                state = .normal
            }
            rows.append(
                ChatHistoryEntry(
                    id: "chat-\(chat.sessionId)",
                    target: .chat(sessionId: chat.sessionId),
                    title: chat.displayTitle,
                    updated: chat.updated,
                    state: state
                )
            )
        }

        for draft in drafts where draft.sessionId == nil && draft.hasContent {
            let send = pending.first { $0.draftId == draft.id }
            if let send {
                claimed.insert(send.id)
                if let sid = send.sessionId, chatIds.contains(sid) { continue }
            }
            rows.append(
                ChatHistoryEntry(
                    id: "draft-\(draft.id)",
                    target: .draft(id: draft.id),
                    title: draft.displayTitle,
                    updated: draft.updated,
                    state: send == nil ? .draft : .pending
                )
            )
        }

        for send in pending where !claimed.contains(send.id) {
            rows.append(
                ChatHistoryEntry(
                    id: "pending-\(send.id.uuidString)",
                    target: .pending(sessionId: send.sessionId),
                    title: send.title,
                    updated: send.started,
                    state: .pending
                )
            )
        }

        return rows.enumerated()
            .sorted { a, b in
                let da = ChatISODate.parse(a.element.updated) ?? .distantPast
                let db = ChatISODate.parse(b.element.updated) ?? .distantPast
                if da != db { return da > db }
                return a.offset < b.offset
            }
            .map(\.element)
    }

    static func sections(
        from entries: [ChatHistoryEntry],
        now: Date = Date(),
        calendar: Calendar = seattleCalendar
    ) -> [ChatHistorySection] {
        var order: [String] = []
        var buckets: [String: (title: String, showAge: Bool, entries: [ChatHistoryEntry])] = [:]
        for entry in entries {
            let g = group(for: entry.updated, now: now, calendar: calendar)
            if buckets[g.id] == nil {
                order.append(g.id)
                buckets[g.id] = (g.title, g.showAge, [])
            }
            buckets[g.id]?.entries.append(entry)
        }
        return order.compactMap { key in
            guard let row = buckets[key] else { return nil }
            return ChatHistorySection(
                id: key,
                title: row.title,
                showAge: row.showAge,
                entries: row.entries
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
        f.calendar = seattleCalendar
        f.locale = seattleCalendar.locale
        f.timeZone = seattleCalendar.timeZone
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
    var onSelect: (ChatHistoryEntry) -> Void

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
                        ForEach(section.entries) { entry in
                            Button {
                                onSelect(entry)
                            } label: {
                                ChatHistoryRowLabel(
                                    entry: entry,
                                    showAge: section.showAge
                                )
                            }
                            .buttonStyle(ChatHistoryRowButtonStyle(state: entry.state))
                            .accessibilityLabel(entry.title)
                            .accessibilityValue(entry.state.accessibilityValue)
                        }
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
            .background {
                HistoryScrollClipLock()
            }
        }
        .scrollClipDisabled(false)
        .frame(width: width)
        .frame(maxHeight: .infinity, alignment: .top)
        .ylGlassRounded(cornerRadius: 22, interactive: true, clear: true)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Past chats")
    }
}

/// SwiftUI turns the history list's clip off when the finger lifts, so row
/// chips draw into the gap under the panel. Keep `clipsToBounds` on.
private struct HistoryScrollClipLock: UIViewRepresentable {
    func makeUIView(context: Context) -> HistoryScrollClipLockView {
        let view = HistoryScrollClipLockView()
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear
        return view
    }

    func updateUIView(_ uiView: HistoryScrollClipLockView, context: Context) {
        uiView.lock()
    }
}

private final class HistoryScrollClipLockView: UIView {
    private weak var scroll: UIScrollView?
    private var trackingObservation: NSKeyValueObservation?
    private var draggingObservation: NSKeyValueObservation?
    private var deceleratingObservation: NSKeyValueObservation?

    override func didMoveToWindow() {
        super.didMoveToWindow()
        attachIfNeeded()
        lock()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        attachIfNeeded()
        lock()
    }

    func lock() {
        attachIfNeeded()
        apply()
        DispatchQueue.main.async { [weak self] in
            self?.apply()
        }
    }

    private func attachIfNeeded() {
        guard scroll == nil else { return }
        var view: UIView? = self
        while let current = view {
            if let found = current as? UIScrollView {
                scroll = found
                trackingObservation = found.observe(\.isTracking, options: [.new]) { [weak self] _, _ in
                    self?.lock()
                }
                draggingObservation = found.observe(\.isDragging, options: [.new]) { [weak self] _, _ in
                    self?.lock()
                }
                deceleratingObservation = found.observe(\.isDecelerating, options: [.new]) { [weak self] _, _ in
                    self?.lock()
                }
                return
            }
            view = current.superview
        }
    }

    private func apply() {
        guard let scroll else { return }
        if !scroll.clipsToBounds {
            scroll.clipsToBounds = true
        }
        if !scroll.layer.masksToBounds {
            scroll.layer.masksToBounds = true
        }
    }
}

private struct ChatHistoryRowLabel: View {
    @Environment(\.colorScheme) private var colorScheme
    let entry: ChatHistoryEntry
    let showAge: Bool

    private var faded: Bool {
        entry.state == .draft || entry.state == .pending
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(entry.title)
                .font(.body)
                .foregroundStyle(YLTheme.fg(colorScheme))
                .opacity(faded ? 0.5 : 1)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            if showAge {
                Text(ChatHistoryGrouping.relativeAge(from: entry.updated))
                    .font(.caption)
                    .foregroundStyle(YLTheme.muted(colorScheme))
                    .monospacedDigit()
            }
        }
    }
}

/// Own Liquid Glass chip per past chat. Press shine comes from interactive glass only.
private struct ChatHistoryRowButtonStyle: ButtonStyle {
    let state: ChatHistoryRowState

    func makeBody(configuration: Configuration) -> some View {
        ChatHistoryRowChrome(state: state) {
            configuration.label
        }
    }
}

private struct ChatHistoryRowChrome<Label: View>: View {
    let state: ChatHistoryRowState
    @ViewBuilder var label: () -> Label
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.ylPalette) private var palette

    private var unreadTint: Color? {
        guard state == .unread else { return nil }
        return YLTheme.chatSend(colorScheme, palette: palette)
            .opacity(colorScheme == .dark ? 0.38 : 0.3)
    }

    var body: some View {
        label()
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .ylGlassRounded(cornerRadius: 14, tint: unreadTint, interactive: true)
            .ylBorderBeam(cornerRadius: 14, active: state == .working, style: .compact)
    }
}
