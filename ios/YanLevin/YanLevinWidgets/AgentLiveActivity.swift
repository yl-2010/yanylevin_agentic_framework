import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

struct AgentLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AgentActivityAttributes.self) { context in
            AgentLiveActivityBody(state: context.state)
                .widgetURL(AgentActivityAttributes.chatURL(sessionId: nil))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    LiveActivityYLMark(size: 16, color: YLTheme.accent)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    LiveActivityBusyDots()
                }
                DynamicIslandExpandedRegion(.bottom) {
                    AgentLiveActivityIslandBottom(state: context.state)
                }
            } compactLeading: {
                LiveActivityYLMark(size: 14, color: YLTheme.accent)
            } compactTrailing: {
                if context.state.agents.count == 1 {
                    LiveActivityBusyDots()
                } else {
                    Text("\(context.state.agents.count + context.state.overflowCount)")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(YLTheme.chatOrange)
                }
            } minimal: {
                LiveActivityYLMark(size: 12, color: YLTheme.accent)
            }
            .keylineTint(YLTheme.accent)
            .widgetURL(AgentActivityAttributes.chatURL(sessionId: nil))
        }
    }
}

private struct AgentLiveActivityBody: View {
    @Environment(\.colorScheme) private var colorScheme
    let state: AgentActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                LiveActivityYLMark(size: 18, color: YLTheme.accent(colorScheme))
                Text(headerTitle)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(YLTheme.accent(colorScheme))
                Spacer(minLength: 0)
                LiveActivityBusyDots()
            }
            AgentLiveActivityRows(state: state, compact: false)
        }
        .padding(14)
        .background { LiveActivityBannerBackground() }
        .liveActivityLockScreenChrome()
    }

    private var headerTitle: String {
        let n = state.agents.count + state.overflowCount
        return n == 1 ? "Agent" : "\(n) agents"
    }
}

private struct AgentLiveActivityIslandBottom: View {
    @Environment(\.colorScheme) private var colorScheme
    let state: AgentActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(state.agents, id: \.sessionId) { row in
                Button(intent: OpenAgentChatIntent(sessionId: row.sessionId)) {
                    HStack(spacing: 8) {
                        Circle()
                            .fill(YLTheme.chatOrange)
                            .frame(width: 5, height: 5)
                        Text(row.title)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(YLTheme.fg(colorScheme))
                            .lineLimit(1)
                        Spacer(minLength: 6)
                        Text(row.workingLabel)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(YLTheme.chatOrange)
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
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
        .padding(.horizontal, LiveActivityChrome.islandSidePad)
        .padding(.bottom, LiveActivityChrome.islandBottomPad)
        .padding(.top, 2)
    }
}

private struct AgentLiveActivityRows: View {
    @Environment(\.colorScheme) private var colorScheme
    let state: AgentActivityAttributes.ContentState
    var compact: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 5 : 7) {
            ForEach(state.agents, id: \.sessionId) { row in
                Button(intent: OpenAgentChatIntent(sessionId: row.sessionId)) {
                    if compact {
                        compactRow(row)
                    } else {
                        lockRow(row)
                    }
                }
                .buttonStyle(.plain)
            }
            if state.overflowCount > 0 {
                Text("+\(state.overflowCount) more")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(YLTheme.muted(colorScheme))
                    .padding(.leading, 2)
            }
        }
    }

    private func compactRow(_ row: AgentActivityRow) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(YLTheme.chatOrange)
                .frame(width: 6, height: 6)
            Text(row.title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(YLTheme.fg(colorScheme))
                .lineLimit(1)
            Spacer(minLength: 4)
            Text(row.workingLabel)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(YLTheme.chatOrange)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(
            YLTheme.accent(colorScheme).opacity(0.12),
            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
        )
    }

    private func lockRow(_ row: AgentActivityRow) -> some View {
        HStack(spacing: 10) {
            LiveActivityBusyDots()
            VStack(alignment: .leading, spacing: 1) {
                Text(row.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(YLTheme.fg(colorScheme))
                    .lineLimit(1)
                Text(row.workingLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(YLTheme.chatOrange)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            YLTheme.accent(colorScheme).opacity(0.12),
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
    }
}
