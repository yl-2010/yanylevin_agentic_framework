import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

struct ClassLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ClassActivityAttributes.self) { context in
            ClassLiveActivityBody(state: context.state)
                .widgetURL(ClassActivityAttributes.classURL(id: context.state.classId))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text(context.state.period)
                        .font(.title2.weight(.bold))
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.state.className)
                            .font(.headline)
                            .lineLimit(1)
                        Text("\(context.state.start)–\(context.state.end)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    ClassLiveActivityAssignments(state: context.state, compact: true)
                }
            } compactLeading: {
                Text(context.state.period)
                    .font(.caption.weight(.bold))
            } compactTrailing: {
                if let first = context.state.assignments.first {
                    Text(first.tag)
                        .font(.caption2.weight(.bold))
                }
            } minimal: {
                Text(context.state.period)
                    .font(.caption2.weight(.bold))
            }
            .widgetURL(ClassActivityAttributes.classURL(id: context.state.classId))
        }
    }
}

private struct ClassLiveActivityBody: View {
    let state: ClassActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(state.period)
                    .font(.headline.weight(.bold))
                Text(state.className)
                    .font(.headline.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 0)
                Text("\(state.start)–\(state.end)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ClassLiveActivityAssignments(state: state, compact: false)
        }
        .padding(14)
    }
}

private struct ClassLiveActivityAssignments: View {
    let state: ClassActivityAttributes.ContentState
    var compact: Bool

    var body: some View {
        if state.assignments.isEmpty {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: compact ? 4 : 6) {
                ForEach(state.assignments, id: \.todoId) { item in
                    Button(
                        intent: OpenTodoIntent(
                            todoId: item.todoId,
                            classId: item.classId,
                            projectId: nil
                        )
                    ) {
                        HStack(spacing: 8) {
                            Text(item.tag)
                                .font(.caption2.weight(.bold))
                                .frame(width: 28, alignment: .leading)
                            Text(item.name)
                                .font(.caption.weight(.semibold))
                                .lineLimit(1)
                            Spacer(minLength: 0)
                        }
                    }
                    .buttonStyle(.plain)
                }
                if state.overflowCount > 0 {
                    Text("+\(state.overflowCount) more")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}
