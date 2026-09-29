import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

struct ClassLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ClassActivityAttributes.self) { context in
            ClassLiveActivityBody(state: context.state)
                .widgetURL(ClassActivityAttributes.classURL(id: context.state.classId))
                .liveActivityRootChrome()
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
                    .fixedSize()
                    .padding(.leading, LiveActivityChrome.islandCompactLeadingPad)
            } compactTrailing: {
                ClassLiveActivityTimer(state: context.state, compact: true, compactIsland: true)
                    .fixedSize()
            } minimal: {
                Text(context.state.period)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(LiveActivityPalette.islandAccent)
            }
            .keylineTint(LiveActivityPalette.islandAccent)
            .widgetURL(ClassActivityAttributes.classURL(id: context.state.classId))
        }
        .contentMarginsDisabled()
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
                if !state.scoreLabel.isEmpty {
                    Text(state.scoreLabel)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(LiveActivityPalette.accent(colorScheme))
                        .monospacedDigit()
                }
                Spacer(minLength: 8)
                ClassLiveActivityTimer(state: state, compact: false)
            }
            ClassLiveActivityAssignments(state: state, island: false)
        }
        .padding(LiveActivityChrome.lockScreenPad)
        .liveActivityLockScreenChrome()
    }
}

private struct ClassLiveActivityIslandBottom: View {
    let state: ClassActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(state.className)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(LiveActivityPalette.islandFg)
                    .lineLimit(1)
                if !state.scoreLabel.isEmpty {
                    Text(state.scoreLabel)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(LiveActivityPalette.islandAccent)
                        .monospacedDigit()
                }
            }
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
                timerText(interval: Date.now...start, countsDown: true)
            } else if let start = state.startDate, let end = state.endDate, Date.now < end {
                elapsedMinutes(from: start)
            } else if !state.end.isEmpty {
                Text(state.end)
            }
        }
        .font(timerFont)
        .foregroundStyle(compact ? LiveActivityPalette.islandAccent : LiveActivityPalette.accent(colorScheme))
        .minimumScaleFactor(compactIsland ? 0.6 : 0.7)
        .lineLimit(1)
        .monospacedDigit()
    }

    /// System-drawn minutes. `TimelineView` and app wakes freeze once iPad sleeps.
    private func elapsedMinutes(from start: Date) -> some View {
        Text("99 min")
            .hidden()
            .overlay(alignment: .trailing) {
                Text(
                    TimeDataSource<Duration>.durationOffset(to: start),
                    format: .units(
                        allowed: [.minutes],
                        width: .abbreviated,
                        zeroValueUnits: .show(length: 1),
                        fractionalPart: .hide(rounded: .down)
                    )
                )
                .lineLimit(1)
            }
    }

    @ViewBuilder
    private func timerText(interval: ClosedRange<Date>, countsDown: Bool) -> some View {
        if compactIsland {
            // timerInterval reports a huge ideal width. Size to MM:SS like elapsed minutes.
            Text("00:00")
                .hidden()
                .overlay(alignment: .leading) {
                    Text(timerInterval: interval, countsDown: countsDown, showsHours: false)
                        .lineLimit(1)
                }
                .clipped()
                .fixedSize()
        } else {
            Text(timerInterval: interval, countsDown: countsDown, showsHours: false)
        }
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
                                scoreLabel: item.scoreLabel,
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
    var scoreLabel: String
    var island: Bool

    private var tileHeight: CGFloat { island ? 54 : 58 }

    private var tagColor: Color {
        island ? YLTheme.darkAccent : YLTheme.accent(colorScheme)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(tag)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(tagColor)
                    // ActivityKit never paints Text.strikethrough, so the done line is drawn here.
                    .overlay {
                        if done {
                            Rectangle()
                                .fill(island ? LiveActivityPalette.islandMuted : YLTheme.muted(colorScheme))
                                .frame(height: 1.5)
                        }
                    }
                Spacer(minLength: 0)
                if !scoreLabel.isEmpty {
                    Text(scoreLabel)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(tagColor)
                        .monospacedDigit()
                        .strikethrough(false)
                }
            }
            Text(name)
                .font(.caption.weight(.semibold))
                .foregroundStyle(island ? LiveActivityPalette.islandFg : YLTheme.fg(colorScheme))
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
        .accessibilityLabel(scoreLabel.isEmpty ? "\(tag) \(name)" : "\(tag) \(name) \(scoreLabel)")
    }
}
