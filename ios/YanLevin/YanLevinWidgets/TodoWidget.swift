import AppIntents
import SwiftUI
import WidgetKit

struct TodoEntry: TimelineEntry {
    let date: Date
    let authorized: Bool
    let appGroupReady: Bool
    let todos: [EducationTodo]
    /// At most one recently checked-off todo (linger window); shown at bottom, no section title.
    let recentCompleted: EducationTodo?
    let tree: EducationTreeResponse?
    let configuration: TodoWidgetConfigurationIntent
}

struct TodoProvider: AppIntentTimelineProvider {
    typealias Entry = TodoEntry
    typealias Intent = TodoWidgetConfigurationIntent

    func placeholder(in context: Context) -> TodoEntry {
        TodoEntry(
            date: .now,
            authorized: true,
            appGroupReady: true,
            todos: [],
            recentCompleted: nil,
            tree: nil,
            configuration: TodoWidgetConfigurationIntent()
        )
    }

    func snapshot(for configuration: TodoWidgetConfigurationIntent, in context: Context) async -> TodoEntry {
        await makeEntry(configuration: configuration, limit: Self.todoLimit(for: context.family))
    }

    func timeline(for configuration: TodoWidgetConfigurationIntent, in context: Context) async -> Timeline<TodoEntry> {
        let limit = Self.todoLimit(for: context.family)
        let now = Date()
        let entry = await makeEntry(configuration: configuration, limit: limit, asOf: now)
        var entries = [entry]

        // Second entry drops the lingered completed row when its 5-minute window ends.
        if let completed = entry.recentCompleted,
           let completedAt = completed.completedAtDate {
            let expire = completedAt.addingTimeInterval(EducationTodoHelpers.widgetCompletedLinger)
            if expire > now {
                let after = await makeEntry(configuration: configuration, limit: limit, asOf: expire)
                entries.append(
                    TodoEntry(
                        date: expire,
                        authorized: after.authorized,
                        appGroupReady: after.appGroupReady,
                        todos: after.todos,
                        recentCompleted: after.recentCompleted,
                        tree: after.tree,
                        configuration: configuration
                    )
                )
            }
        }

        let refresh = Calendar.current.date(byAdding: .minute, value: 15, to: now)
            ?? now.addingTimeInterval(900)
        return Timeline(entries: entries, policy: .after(refresh))
    }

    /// Small/medium: 5 · large: 7 · extra-large (iPad): 14 (two columns of 7).
    /// One fewer than before so due-date bars still fit with even padding.
    private static func todoLimit(for family: WidgetFamily) -> Int {
        switch family {
        case .systemExtraLarge: return 14
        case .systemLarge: return 7
        default: return 5
        }
    }

    private func makeEntry(
        configuration: TodoWidgetConfigurationIntent,
        limit: Int,
        asOf: Date = .now
    ) async -> TodoEntry {
        guard AppGroupStore.isAvailable else {
            return TodoEntry(
                date: asOf,
                authorized: false,
                appGroupReady: false,
                todos: [],
                recentCompleted: nil,
                tree: nil,
                configuration: configuration
            )
        }
        guard AppGroupStore.hasFullAccess else {
            return TodoEntry(
                date: asOf,
                authorized: false,
                appGroupReady: true,
                todos: [],
                recentCompleted: nil,
                tree: nil,
                configuration: configuration
            )
        }
        let tree = await WidgetEducationLoader.loadTree()
            ?? AppGroupStore.loadCachedEducationTree()
        let packed = EducationTodoHelpers.widgetTodos(
            from: tree,
            typeFilters: configuration.typeFilters,
            classId: configuration.classFilter?.id,
            limit: limit,
            asOf: asOf
        )
        return TodoEntry(
            date: asOf,
            authorized: true,
            appGroupReady: true,
            todos: packed.open,
            recentCompleted: packed.recentCompleted,
            tree: tree,
            configuration: configuration
        )
    }
}

struct TodoWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TodoEntry

    /// 2×2 and 2×4 share height; titles only, no due/class lines.
    private var isCompactFamily: Bool {
        family == .systemSmall || family == .systemMedium
    }

    /// Open todos plus optional lingered completed (completed takes the last slot).
    private var allRows: [(todo: EducationTodo, completed: Bool)] {
        Self.stackedRows(todos: entry.todos, completed: entry.recentCompleted)
    }

    var body: some View {
        Group {
            if !entry.appGroupReady {
                messageView(
                    "Widgets need App Groups. That requires an Apple Developer Program account — then enable group.com.example.personalagent for the app + widget."
                )
            } else if !entry.authorized {
                messageView("Open Yan Levin and sign in with a full-access account.")
            } else if family == .systemExtraLarge {
                extraLargeTodoList
            } else if isCompactFamily {
                compactTodoList
            } else {
                todoList(showMeta: true)
            }
        }
        .foregroundStyle(WidgetTheme.fg)
        // Compact: system content margins only (even inset past the squircle). 4×4 keeps extra padding.
        .padding(isCompactFamily ? 0 : 14)
        .containerBackground(for: .widget) {
            LinearGradient(
                colors: [WidgetTheme.bg0, WidgetTheme.bg1],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        }
    }

    private func messageView(_ body: String) -> some View {
        Text(body)
            .font(.caption)
            .foregroundStyle(WidgetTheme.muted)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    /// 2×2 / 2×4: even leftover gaps, up to 5 single-line rows. Completed uses the last slot.
    private var compactTodoList: some View {
        GeometryReader { geo in
            let rows = allRows
            if rows.isEmpty {
                Text("Nothing here")
                    .font(.caption)
                    .foregroundStyle(WidgetTheme.muted)
                    .frame(width: geo.size.width, height: geo.size.height, alignment: .center)
            } else {
                let sepBefore = Self.separatorBeforeFlags(rows.map(\.todo))
                let sepCount = CGFloat(sepBefore.filter { $0 }.count)
                let sepHeight = WidgetTodoDaySeparator.compactHeight
                let minGap: CGFloat = 4
                let rowCount = CGFloat(rows.count)
                let gapCount = rowCount + 1 - sepCount
                let space = max(0, geo.size.height - sepCount * sepHeight)
                let rowHeight = min(
                    18,
                    max(
                        15,
                        gapCount > 0
                            ? (space - gapCount * minGap) / max(rowCount, 1)
                            : space / max(rowCount, 1)
                    )
                )
                let gap = gapCount > 0 ? max(0, (space - rowHeight * rowCount) / gapCount) : 0
                VStack(alignment: .leading, spacing: 0) {
                    Color.clear.frame(height: gap)
                    ForEach(Array(rows.enumerated()), id: \.element.todo.id) { index, item in
                        if index > 0 {
                            if sepBefore[index] {
                                WidgetTodoDaySeparator(style: .compact)
                            } else {
                                Color.clear.frame(height: gap)
                            }
                        }
                        compactTodoRow(item.todo, completed: item.completed)
                            .frame(height: rowHeight, alignment: .center)
                    }
                    Color.clear.frame(height: gap)
                }
                .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
            }
        }
    }

    private func compactTodoRow(_ todo: EducationTodo, completed: Bool) -> some View {
        HStack(alignment: .center, spacing: 8) {
            completeButton(todo, completed: completed, iconSize: 14)
                .frame(width: 22)
                .frame(maxHeight: .infinity)

            openTodoButton(todo) {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    if let tag = todo.displayTag {
                        Text(tag)
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(completed ? WidgetTheme.muted : WidgetTheme.accent)
                    }
                    Text(todo.displayName)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(completed ? WidgetTheme.muted : WidgetTheme.fg)
                        .strikethrough(completed, color: WidgetTheme.muted)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if !todo.scoreLabel.isEmpty {
                        Text(todo.scoreLabel)
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(WidgetTheme.grade)
                            .strikethrough(false)
                    }
                }
                .contentShape(Rectangle())
            }
        }
        .opacity(completed ? 0.72 : 1)
    }

    private func todoList(showMeta: Bool) -> some View {
        Group {
            if entry.todos.isEmpty && entry.recentCompleted == nil {
                Text("Nothing here")
                    .font(.caption)
                    .foregroundStyle(WidgetTheme.muted)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            } else {
                stackedTodoColumn(entry.todos, completed: entry.recentCompleted, showMeta: showMeta)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// iPad-only extra-large: open todos in two columns; recent completed at bottom of right column.
    private var extraLargeTodoList: some View {
        let mid = (entry.todos.count + 1) / 2
        let left = Array(entry.todos.prefix(mid))
        let right = Array(entry.todos.dropFirst(mid))
        return Group {
            if entry.todos.isEmpty && entry.recentCompleted == nil {
                Text("Nothing here")
                    .font(.caption)
                    .foregroundStyle(WidgetTheme.muted)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            } else {
                HStack(alignment: .top, spacing: 20) {
                    stackedTodoColumn(left, completed: nil, showMeta: true)
                    stackedTodoColumn(right, completed: entry.recentCompleted, showMeta: true)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func stackedTodoColumn(
        _ todos: [EducationTodo],
        completed: EducationTodo?,
        showMeta: Bool
    ) -> some View {
        let rows = Self.stackedRows(todos: todos, completed: completed)
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.todo.id) { index, item in
                if index > 0 {
                    if Self.dayKey(rows[index - 1].todo) != Self.dayKey(item.todo) {
                        WidgetTodoDaySeparator(style: .regular)
                    } else {
                        Color.clear.frame(height: 8)
                    }
                }
                todoRow(item.todo, showMeta: showMeta, completed: item.completed)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private static func stackedRows(
        todos: [EducationTodo],
        completed: EducationTodo?
    ) -> [(todo: EducationTodo, completed: Bool)] {
        var rows = todos.map { (todo: $0, completed: false) }
        if let completed {
            rows.append((todo: completed, completed: true))
        }
        return rows
    }

    private static func dayKey(_ todo: EducationTodo) -> String {
        todo.dueDateValue ?? ""
    }

    private static func separatorBeforeFlags(_ todos: [EducationTodo]) -> [Bool] {
        todos.enumerated().map { index, todo in
            guard index > 0 else { return false }
            return dayKey(todos[index - 1]) != dayKey(todo)
        }
    }

    private func todoRow(_ todo: EducationTodo, showMeta: Bool, completed: Bool) -> some View {
        let className = EducationTodoHelpers.className(for: todo, in: entry.tree)
        let when = NaturalWhen.format(
            date: todo.dueDateValue,
            time: todo.dueTimeValue,
            use24Hour: AppGroupStore.use24Hour
        )
        return HStack(alignment: .center, spacing: 10) {
            completeButton(todo, completed: completed, iconSize: 16)
                .frame(width: 28, height: 28)

            openTodoButton(todo) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        if let tag = todo.displayTag {
                            Text(tag)
                                .font(.caption.weight(.bold))
                                .foregroundStyle(completed ? WidgetTheme.muted : WidgetTheme.accent)
                        }
                        Text(todo.displayName)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(completed ? WidgetTheme.muted : WidgetTheme.fg)
                            .strikethrough(completed, color: WidgetTheme.muted)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        if !todo.scoreLabel.isEmpty {
                            Text(todo.scoreLabel)
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(WidgetTheme.grade)
                                .strikethrough(false)
                        }
                    }
                    if showMeta {
                        HStack(spacing: 6) {
                            if let className {
                                Text(className)
                                    .font(.caption2)
                                    .foregroundStyle(WidgetTheme.muted)
                                    .lineLimit(1)
                            }
                            if !when.isEmpty {
                                Text(when)
                                    .font(.caption2)
                                    .foregroundStyle(WidgetTheme.muted)
                                    .lineLimit(1)
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
        }
        .opacity(completed ? 0.72 : 1)
    }

    private func completeButton(_ todo: EducationTodo, completed: Bool, iconSize: CGFloat) -> some View {
        Button(
            intent: CompleteTodoIntent(
                todoId: todo.todoId,
                classId: todo.classId,
                projectId: todo.projectId,
                done: !completed
            )
        ) {
            // WidgetKit often ignores Image-only buttons. Label + a filled
            // hit box matches the in-app checkbox (hollow circle has no pixels).
            Label(completed ? "Mark not done" : "Mark done", systemImage: completed ? "checkmark.circle.fill" : "circle")
                .labelStyle(.iconOnly)
                .font(.system(size: iconSize, weight: .medium))
                .foregroundStyle(completed ? WidgetTheme.accent.opacity(0.75) : WidgetTheme.accent)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .invalidatableContent()
    }

    private func openTodoButton<Content: View>(
        _ todo: EducationTodo,
        @ViewBuilder content: () -> Content
    ) -> some View {
        Button(
            intent: OpenTodoIntent(
                todoId: todo.todoId,
                classId: todo.classId,
                projectId: todo.projectId
            )
        ) {
            content()
        }
        .buttonStyle(.plain)
    }
}

/// 1pt hairline at 12% foreground, same as the in-app / site TODO day bars.
private struct WidgetTodoDaySeparator: View {
    enum Style {
        case compact
        case regular
    }

    var style: Style = .regular

    static let compactHeight: CGFloat = 9
    static let regularHeight: CGFloat = 13

    private var height: CGFloat {
        style == .compact ? Self.compactHeight : Self.regularHeight
    }

    var body: some View {
        Rectangle()
            .fill(WidgetTheme.fg.opacity(0.12))
            .frame(height: 1)
            .padding(.horizontal, 8)
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .accessibilityHidden(true)
    }
}

struct TodoWidget: Widget {
    let kind = "YanLevinTodoWidget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: kind,
            intent: TodoWidgetConfigurationIntent.self,
            provider: TodoProvider()
        ) { entry in
            TodoWidgetView(entry: entry)
        }
        .configurationDisplayName("Todos")
        .description("Upcoming education todos. Tap a title to open it, or the circle to check it off.")
        // systemExtraLarge is iPad-only (twice as wide as large); iPhone never offers it.
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .systemExtraLarge])
    }
}
