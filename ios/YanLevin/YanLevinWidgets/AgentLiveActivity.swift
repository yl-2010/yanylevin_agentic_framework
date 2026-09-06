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
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                LiveActivityYLMark(size: 16)
                Text(headerTitle)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(LiveActivityPalette.accent(colorScheme))
                Spacer(minLength: 0)
                LiveActivityBusyDots()
            }
            ViewThatFits(in: .vertical) {
                AgentLiveActivityRows(state: state, limit: 3)
                AgentLiveActivityRows(state: state, limit: 2)
                AgentLiveActivityRows(state: state, limit: 1)
            }
        }
        .padding(LiveActivityChrome.lockScreenPad)
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
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                LiveActivityYLMark(size: 14)
                Text(headerTitle)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(LiveActivityPalette.islandAccent)
                Spacer(minLength: 0)
                LiveActivityBusyDots()
            }
            ForEach(state.agents, id: \.sessionId) { row in
                Button(intent: OpenAgentChatIntent(sessionId: row.sessionId)) {
                    AgentLiveActivityLine(
                        row: row,
                        titleColor: LiveActivityPalette.islandFg,
                        labelColor: LiveActivityPalette.orange
                    )
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
    var limit: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(shown, id: \.sessionId) { row in
                Button(intent: OpenAgentChatIntent(sessionId: row.sessionId)) {
                    AgentLiveActivityLine(
                        row: row,
                        titleColor: YLTheme.fg(colorScheme),
                        labelColor: LiveActivityPalette.orange
                    )
                }
                .buttonStyle(.plain)
            }
            if extra > 0 {
                Text("+\(extra) more")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(YLTheme.muted(colorScheme))
            }
        }
    }

    private var shown: [AgentActivityRow] {
        Array(state.agents.prefix(limit))
    }

    private var extra: Int {
        state.overflowCount + max(0, state.agents.count - shown.count)
    }
}

private struct AgentLiveActivityLine: View {
    let row: AgentActivityRow
    let titleColor: Color
    let labelColor: Color

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(labelColor)
                .frame(width: 5, height: 5)
            Text(row.title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(titleColor)
                .lineLimit(1)
            Spacer(minLength: 6)
            Text(row.workingLabel)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(labelColor)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
    }
}
