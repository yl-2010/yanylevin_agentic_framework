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
                DynamicIslandExpandedRegion(.trailing) {
                    LiveActivityBusyDots()
                        .padding(.trailing, LiveActivityChrome.islandEarPad)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    AgentLiveActivityIslandBottom(state: context.state)
                }
            } compactLeading: {
                LiveActivityYLMark(size: 13)
            } compactTrailing: {
                if context.state.agents.count == 1 {
                    LiveActivityBusyDots()
                } else {
                    Text("\(context.state.agents.count + context.state.overflowCount)")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(LiveActivityPalette.orange)
                }
            } minimal: {
                LiveActivityYLMark(size: 11)
            }
            .keylineTint(LiveActivityPalette.islandAccent)
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
                LiveActivityYLMark(size: 18)
                Text(headerTitle)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(LiveActivityPalette.accent(colorScheme))
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
    let state: AgentActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                LiveActivityYLMark(size: 14)
                Text(headerTitle)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(LiveActivityPalette.islandAccent)
                Spacer(minLength: 0)
            }
            ForEach(state.agents, id: \.sessionId) { row in
                Button(intent: OpenAgentChatIntent(sessionId: row.sessionId)) {
                    HStack(spacing: 8) {
                        Circle()
                            .fill(LiveActivityPalette.orange)
                            .frame(width: 5, height: 5)
                        Text(row.title)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(LiveActivityPalette.islandFg)
                            .lineLimit(1)
                        Spacer(minLength: 6)
                        Text(row.workingLabel)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(LiveActivityPalette.orange)
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                    }
                }
                .buttonStyle(.plain)
            }
            if state.overflowCount > 0 {
                Text("+\(state.overflowCount) more")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(LiveActivityPalette.islandMuted)
            }
        }
        .padding(.horizontal, LiveActivityChrome.islandSidePad)
        .padding(.bottom, LiveActivityChrome.islandBottomPad)
        .padding(.top, 2)
    }

    private var headerTitle: String {
        let n = state.agents.count + state.overflowCount
        return n == 1 ? "Agent" : "\(n) agents"
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
                .fill(LiveActivityPalette.orange)
                .frame(width: 6, height: 6)
            Text(row.title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(YLTheme.fg(colorScheme))
                .lineLimit(1)
            Spacer(minLength: 4)
            Text(row.workingLabel)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(LiveActivityPalette.orange)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(
            LiveActivityPalette.accent(colorScheme).opacity(0.12),
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
                    .foregroundStyle(LiveActivityPalette.orange)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            LiveActivityPalette.accent(colorScheme).opacity(0.12),
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
    }
}
