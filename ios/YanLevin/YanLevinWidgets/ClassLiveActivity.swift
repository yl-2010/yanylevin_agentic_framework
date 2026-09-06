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
                        .font(.headline.weight(.bold))
                        .foregroundStyle(LiveActivityPalette.islandAccent)
                        .padding(.leading, LiveActivityChrome.islandEarPad)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    ClassLiveActivityTimer(state: context.state, compact: true)
                        .padding(.trailing, LiveActivityChrome.islandEarPad)
                        .dynamicIsland(verticalPlacement: .belowIfTooWide)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    ClassLiveActivityIslandBottom(state: context.state)
                }
            } compactLeading: {
                Text(context.state.period)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(LiveActivityPalette.islandAccent)
            } compactTrailing: {
                if let first = context.state.assignments.first {
                    Text(first.tag)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(LiveActivityPalette.islandAccent)
                } else {
                    ClassLiveActivityTimer(state: context.state, compact: true)
                }
            } minimal: {
                Text(context.state.period)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(LiveActivityPalette.islandAccent)
            }
            .keylineTint(LiveActivityPalette.islandAccent)
            .widgetURL(ClassActivityAttributes.classURL(id: context.state.classId))
        }
    }
}

private struct ClassLiveActivityBody: View {
    @Environment(\.colorScheme) private var colorScheme
    let state: ClassActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 10) {
                Text(state.period)
                    .font(.title3.weight(.bold))
                    .foregroundStyle(LiveActivityPalette.accent(colorScheme))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(LiveActivityPalette.accent(colorScheme).opacity(0.16), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text(state.className)
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(YLTheme.fg(colorScheme))
                        .lineLimit(1)
                    Text(timeRange)
                        .font(.caption)
                        .foregroundStyle(YLTheme.muted(colorScheme))
                }
                Spacer(minLength: 0)
                ClassLiveActivityTimer(state: state, compact: false)
            }
            ClassLiveActivityMeter(state: state)
            ClassLiveActivityAssignments(state: state, compact: false)
        }
        .padding(14)
        .background { LiveActivityBannerBackground() }
        .liveActivityLockScreenChrome()
    }

    private var timeRange: String {
        if state.start.isEmpty || state.end.isEmpty { return state.start + state.end }
        return "\(state.start)-\(state.end)"
    }
}

private struct ClassLiveActivityIslandBottom: View {
    let state: ClassActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(state.className)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(LiveActivityPalette.islandFg)
                .lineLimit(1)
            ClassLiveActivityMeter(state: state, island: true)
            ClassLiveActivityAssignments(state: state, compact: true)
        }
        .padding(.horizontal, LiveActivityChrome.islandSidePad)
        .padding(.bottom, LiveActivityChrome.islandBottomPad)
        .padding(.top, 2)
    }
}

private struct ClassLiveActivityTimer: View {
    @Environment(\.colorScheme) private var colorScheme
    let state: ClassActivityAttributes.ContentState
    var compact: Bool

    var body: some View {
        Group {
            if let start = state.startDate, Date.now < start {
                Text(timerInterval: Date.now...start, countsDown: true, showsHours: !compact)
            } else if let end = state.endDate, Date.now < end {
                Text(timerInterval: Date.now...end, countsDown: true, showsHours: !compact)
            } else if !state.end.isEmpty {
                Text(state.end)
            }
        }
        .font(compact ? .caption.monospacedDigit().weight(.semibold) : .subheadline.monospacedDigit().weight(.bold))
        .foregroundStyle(compact ? LiveActivityPalette.islandAccent : LiveActivityPalette.accent(colorScheme))
        .minimumScaleFactor(0.7)
        .lineLimit(1)
        .multilineTextAlignment(.trailing)
    }
}

private struct ClassLiveActivityMeter: View {
    @Environment(\.colorScheme) private var colorScheme
    let state: ClassActivityAttributes.ContentState
    var island: Bool = false

    var body: some View {
        if let start = state.startDate, let end = state.endDate, end > start {
            ProgressView(timerInterval: start...end, countsDown: false)
                .progressViewStyle(.linear)
                .tint(island ? LiveActivityPalette.islandAccent : LiveActivityPalette.accent(colorScheme))
                .labelsHidden()
        }
    }
}

private struct ClassLiveActivityAssignments: View {
    @Environment(\.colorScheme) private var colorScheme
    let state: ClassActivityAttributes.ContentState
    var compact: Bool

    var body: some View {
        if state.assignments.isEmpty {
            EmptyView()
        } else if compact {
            HStack(spacing: 6) {
                ForEach(state.assignments, id: \.todoId) { item in
                    Button(
                        intent: OpenTodoIntent(
                            todoId: item.todoId,
                            classId: item.classId,
                            projectId: nil
                        )
                    ) {
                        LiveActivityTagChip(tag: item.tag, island: compact)
                    }
                    .buttonStyle(.plain)
                }
                if state.overflowCount > 0 {
                    Text("+\(state.overflowCount)")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(LiveActivityPalette.islandMuted)
                }
                Spacer(minLength: 0)
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(state.assignments, id: \.todoId) { item in
                    Button(
                        intent: OpenTodoIntent(
                            todoId: item.todoId,
                            classId: item.classId,
                            projectId: nil
                        )
                    ) {
                        HStack(spacing: 8) {
                            LiveActivityTagChip(tag: item.tag)
                            Text(item.name)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(YLTheme.fg(colorScheme))
                                .lineLimit(1)
                            Spacer(minLength: 0)
                        }
                    }
                    .buttonStyle(.plain)
                }
                if state.overflowCount > 0 {
                    Text("+\(state.overflowCount) more")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(YLTheme.muted(colorScheme))
                }
            }
        }
    }
}
