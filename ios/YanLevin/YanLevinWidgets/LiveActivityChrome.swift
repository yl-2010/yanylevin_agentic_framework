import SwiftUI

/// Shared Live Activity chrome: app theme, YL mark, busy pulse.
enum LiveActivityChrome {
    static let islandBottomPad: CGFloat = 14
    static let islandSidePad: CGFloat = 10
}

struct LiveActivityYLMark: View {
    var size: CGFloat = 18
    var color: Color = YLTheme.accent

    var body: some View {
        Image("YLMark")
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .foregroundStyle(color)
            .accessibilityHidden(true)
    }
}

struct LiveActivityBusyDots: View {
    var color: Color = YLTheme.chatOrange

    var body: some View {
        let stepInterval = 0.32 / 1.5
        TimelineView(.animation(minimumInterval: stepInterval, paused: false)) { context in
            let step = Int(context.date.timeIntervalSinceReferenceDate / stepInterval) % 3
            HStack(spacing: 3) {
                ForEach(0..<3, id: \.self) { index in
                    Circle()
                        .fill(color)
                        .frame(width: 4, height: 4)
                        .opacity(index == step ? 1 : 0.28)
                        .scaleEffect(index == step ? 1.2 : 0.85)
                }
            }
            .animation(.easeInOut(duration: stepInterval * 0.875), value: step)
        }
        .frame(width: 20, height: 8)
        .accessibilityHidden(true)
    }
}

struct LiveActivityBannerBackground: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack(alignment: .top) {
            YLTheme.pageFill(colorScheme)
            LinearGradient(
                colors: [
                    YLTheme.accent(colorScheme).opacity(0.22),
                    YLTheme.accent(colorScheme).opacity(0)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: 28)
        }
    }
}

struct LiveActivityTagChip: View {
    @Environment(\.colorScheme) private var colorScheme
    let tag: String

    var body: some View {
        Text(tag)
            .font(.caption2.weight(.bold))
            .foregroundStyle(YLTheme.accent(colorScheme))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(YLTheme.accent(colorScheme).opacity(0.16), in: Capsule())
    }
}

extension View {
    func liveActivityLockScreenChrome() -> some View {
        modifier(LiveActivityLockScreenChrome())
    }
}

private struct LiveActivityLockScreenChrome: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        content
            .foregroundStyle(YLTheme.fg(colorScheme))
            .activityBackgroundTint(YLTheme.bg0(colorScheme))
            .activitySystemActionForegroundColor(YLTheme.accent(colorScheme))
    }
}
