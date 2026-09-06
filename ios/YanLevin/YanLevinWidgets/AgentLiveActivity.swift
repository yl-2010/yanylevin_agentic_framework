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
                Text("\(context.state.agents.count + context.state.overflowCount)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(LiveActivityPalette.orange)
                    .monospacedDigit()
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
                LiveActivityElapsed(start: state.pulseStart)
            }
            AgentLiveActivityRows(state: state)
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
            }
            ForEach(state.agents, id: \.sessionId) { row in
                Button(intent: OpenAgentChatIntent(sessionId: row.sessionId)) {
                    AgentLiveActivityLine(
                        row: row,
                        titleColor: LiveActivityPalette.islandFg,
                        labelColor: LiveActivityPalette.orange,
                        showElapsed: false
                    )
                }
                .buttonStyle(.plain)
            }
            if state.overflowCount > 0, state.agents.count >= 3 {
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

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(state.agents, id: \.sessionId) { row in
                Button(intent: OpenAgentChatIntent(sessionId: row.sessionId)) {
                    AgentLiveActivityLine(
                        row: row,
                        titleColor: YLTheme.fg(colorScheme),
                        labelColor: LiveActivityPalette.orange,
                        showElapsed: true
                    )
                }
                .buttonStyle(.plain)
            }
            if state.overflowCount > 0, state.agents.count >= 3 {
                Text("+\(state.overflowCount) more")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(YLTheme.muted(colorScheme))
            }
        }
    }
}

private struct AgentLiveActivityLine: View {
    let row: AgentActivityRow
    let titleColor: Color
    let labelColor: Color
    var showElapsed: Bool = true

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
            LiveActivityWorkingLabel(
                label: row.workingLabel,
                startedAt: showElapsed ? row.startedAt : nil,
                color: labelColor
            )
        }
    }
}

private extension AgentActivityAttributes.ContentState {
    var pulseStart: Date {
        agents.map(\.startedAt).min() ?? .now
    }
}
