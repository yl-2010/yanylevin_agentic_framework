import SwiftUI

/// Shared Live Activity chrome: calmer palette than the app, YL mark, busy pulse.
enum LiveActivityChrome {
    /// Dynamic Island expanded corner radius is 44pt. Keep content inside that curve.
    static let islandBottomPad: CGFloat = 22
    static let islandSidePad: CGFloat = 18
    static let islandEarPad: CGFloat = 20
}

/// Live Activity colors only. App `YLTheme` stays as-is.
enum LiveActivityPalette {
    static let mark = Color.white

    /// Dusty teal (app accent with the saturation pulled down).
    private static let lightAccent = Color(red: 0x30 / 255, green: 0x6D / 255, blue: 0x75 / 255)
    private static let darkAccent = Color(red: 0x7E / 255, green: 0xB7 / 255, blue: 0xB6 / 255)

    /// Dusty orange (chat orange mixed toward gray).
    static let orange = Color(red: 0xC8 / 255, green: 0x7B / 255, blue: 0x4A / 255)

    /// Island is always a black pill.
    static let islandAccent = darkAccent
    static let islandFg = Color.white
    static let islandMuted = Color.white.opacity(0.58)

    static func accent(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? darkAccent : lightAccent
    }
}

struct LiveActivityYLMark: View {
    var size: CGFloat = 18
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Image("YLMark")
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .foregroundStyle(LiveActivityPalette.mark)
            .shadow(
                color: Color.black.opacity(colorScheme == .light ? 0.35 : 0),
                radius: 1.2,
                y: 0.4
            )
            .accessibilityHidden(true)
    }
}

struct LiveActivityBusyDots: View {
    var color: Color = LiveActivityPalette.orange

    var body: some View {
        Image(systemName: "ellipsis")
            .font(.system(size: 17, weight: .heavy))
            .foregroundStyle(color)
            .symbolRenderingMode(.hierarchical)
            .symbolEffect(
                .variableColor.iterative.dimInactiveLayers.nonReversing,
                options: .repeating,
                isActive: true
            )
            .frame(width: 22, height: 12)
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
                    LiveActivityPalette.accent(colorScheme).opacity(0.14),
                    LiveActivityPalette.accent(colorScheme).opacity(0)
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
    var island: Bool = false

    var body: some View {
        Text(tag)
            .font(.caption2.weight(.bold))
            .foregroundStyle(island ? LiveActivityPalette.islandAccent : LiveActivityPalette.accent(colorScheme))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(
                (island ? LiveActivityPalette.islandAccent : LiveActivityPalette.accent(colorScheme)).opacity(0.16),
                in: Capsule()
            )
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
            .activitySystemActionForegroundColor(LiveActivityPalette.accent(colorScheme))
    }
}
