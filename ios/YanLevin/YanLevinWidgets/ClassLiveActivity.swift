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
                        .frame(maxHeight: .infinity, alignment: .center)
                        .padding(.leading, LiveActivityChrome.islandEarPad)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    ClassLiveActivityTimer(state: context.state, compact: true)
                        .frame(maxHeight: .infinity, alignment: .center)
                        .padding(.trailing, LiveActivityChrome.islandEarPad)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    ClassLiveActivityIslandBottom(state: context.state)
                }
            } compactLeading: {
                Text(context.state.period)
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(LiveActivityPalette.islandAccent)
                    .padding(.leading, LiveActivityChrome.islandCompactLeadingPad)
            } compactTrailing: {
                ClassLiveActivityTimer(state: context.state, compact: true, compactIsland: true)
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
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(state.period)
                    .font(.title3.weight(.bold))
                    .foregroundStyle(LiveActivityPalette.accent(colorScheme))
                Text(state.className)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(YLTheme.fg(colorScheme))
                    .lineLimit(1)
                    .layoutPriority(1)
                Spacer(minLength: 8)
                ClassLiveActivityTimer(state: state, compact: false)
            }
            ClassLiveActivityAssignments(state: state, island: false)
        }
        .padding(LiveActivityChrome.lockScreenPad)
        .background { LiveActivityBannerBackground() }
        .liveActivityLockScreenChrome()
    }
}

private struct ClassLiveActivityIslandBottom: View {
    let state: ClassActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(state.className)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(LiveActivityPalette.islandFg)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            ClassLiveActivityAssignments(state: state, island: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, LiveActivityChrome.islandSidePad)
        .padding(.bottom, LiveActivityChrome.islandBottomPad)
    }
}

private struct ClassLiveActivityTimer: View {
    @Environment(\.colorScheme) private var colorScheme
    let state: ClassActivityAttributes.ContentState
    var compact: Bool
    var compactIsland: Bool = false

    var body: some View {
        Group {
            if let start = state.startDate, Date.now < start {
                Text(timerInterval: Date.now...start, countsDown: true, showsHours: false)
            } else if let start = state.startDate, let end = state.endDate, Date.now < end {
                if compact {
                    TimelineView(.periodic(from: Date(), by: 60)) { context in
                        let mins = max(0, Int(ceil(end.timeIntervalSince(context.date) / 60)))
                        Text("\(mins)m")
                    }
                } else {
                    TimelineView(.periodic(from: start, by: 60)) { context in
                        let mins = max(0, Int(context.date.timeIntervalSince(start) / 60))
                        Text("\(mins) min")
                    }
                }
            } else if !state.end.isEmpty {
                Text(state.end)
            }
        }
        .font(timerFont)
        .foregroundStyle(compact ? LiveActivityPalette.islandAccent : LiveActivityPalette.accent(colorScheme))
        .minimumScaleFactor(0.7)
        .lineLimit(1)
        .multilineTextAlignment(.trailing)
    }

    private var timerFont: Font {
        if compactIsland {
            return .system(size: 13, weight: .bold).monospacedDigit()
        }
        if compact {
            return .system(size: 15, weight: .bold).monospacedDigit()
        }
        return .subheadline.monospacedDigit().weight(.bold)
    }
}

private struct ClassLiveActivityAssignments: View {
    @Environment(\.colorScheme) private var colorScheme
    let state: ClassActivityAttributes.ContentState
    var island: Bool

    var body: some View {
        if state.assignments.isEmpty {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .top, spacing: 8) {
                    ForEach(state.assignments, id: \.todoId) { item in
                        Button(
                            intent: OpenTodoIntent(
                                todoId: item.todoId,
                                classId: item.classId,
                                projectId: nil
                            )
                        ) {
                            ClassLiveActivityAssignmentTile(
                                tag: item.tag,
                                name: EducationTodo.stripTagPrefix(item.name),
                                done: item.done == true,
                                island: island
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
                if state.overflowCount > 0 {
                    Text("+\(state.overflowCount)")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(island ? LiveActivityPalette.islandMuted : YLTheme.muted(colorScheme))
                }
            }
        }
    }
}

private struct ClassLiveActivityAssignmentTile: View {
    @Environment(\.colorScheme) private var colorScheme
    let tag: String
    let name: String
    var done: Bool
    var island: Bool

    private var tileHeight: CGFloat { island ? 54 : 58 }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(tag)
                .font(.caption.weight(.bold))
                .foregroundStyle(island ? YLTheme.darkAccent : YLTheme.accent(colorScheme))
            Text(name)
                .font(.caption.weight(.semibold))
                .foregroundStyle(island ? LiveActivityPalette.islandFg : YLTheme.fg(colorScheme))
                .strikethrough(done, color: island ? LiveActivityPalette.islandMuted : YLTheme.muted(colorScheme))
                .lineLimit(2)
                .truncationMode(.tail)
                .multilineTextAlignment(.leading)
        }
        .padding(island ? 7 : 8)
        .frame(maxWidth: .infinity, minHeight: tileHeight, maxHeight: tileHeight, alignment: .topLeading)
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(
                    island
                        ? LiveActivityPalette.islandAccent.opacity(0.4)
                        : LiveActivityPalette.accent(colorScheme).opacity(0.35),
                    lineWidth: 1
                )
        )
        .opacity(done ? 0.72 : 1)
        .accessibilityLabel("\(tag) \(name)")
    }
}
