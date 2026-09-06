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
                    Image(systemName: "bubble.left.and.bubble.right.fill")
                        .font(.title3)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(islandTitle(context.state))
                        .font(.headline)
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    AgentLiveActivityRows(state: context.state, compact: true)
                }
            } compactLeading: {
                Image(systemName: "bubble.left.and.bubble.right.fill")
                    .font(.caption)
            } compactTrailing: {
                Text(compactTrailing(context.state))
                    .font(.caption2.weight(.bold))
                    .lineLimit(1)
            } minimal: {
                Image(systemName: "bubble.left.and.bubble.right.fill")
                    .font(.caption2)
            }
            .widgetURL(AgentActivityAttributes.chatURL(sessionId: nil))
        }
    }

    private func islandTitle(_ state: AgentActivityAttributes.ContentState) -> String {
        if state.agents.count == 1 {
            return state.agents[0].title
        }
        return "\(state.agents.count + state.overflowCount) agents"
    }

    private func compactTrailing(_ state: AgentActivityAttributes.ContentState) -> String {
        if state.agents.count == 1 {
            return state.agents[0].workingLabel
        }
        return "\(state.agents.count + state.overflowCount)"
    }
}

private struct AgentLiveActivityBody: View {
    let state: AgentActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(state.agents.count + state.overflowCount == 1 ? "Agent" : "Agents")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            AgentLiveActivityRows(state: state, compact: false)
        }
        .padding(14)
    }
}

private struct AgentLiveActivityRows: View {
    let state: AgentActivityAttributes.ContentState
    var compact: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 4 : 6) {
            ForEach(state.agents, id: \.sessionId) { row in
                Button(intent: OpenAgentChatIntent(sessionId: row.sessionId)) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(row.title)
                            .font(.caption.weight(.semibold))
                            .lineLimit(1)
                        Text(row.workingLabel)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
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
