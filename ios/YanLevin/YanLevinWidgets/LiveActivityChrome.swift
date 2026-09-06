import SwiftUI

/// Shared Live Activity chrome: calmer palette than the app, YL mark, busy pulse.
enum LiveActivityChrome {
    /// Dynamic Island expanded corner radius is 44pt. Keep content inside that curve.
    static let islandBottomPad: CGFloat = 16
    static let islandSidePad: CGFloat = 14
    static let islandEarPad: CGFloat = 16
    static let lockScreenPad: CGFloat = 16
}

/// Live Activity colors only. App `YLTheme` stays as-is.
enum LiveActivityPalette {
    static let mark = Color.white

    /// Dusty teal (app accent with the saturation pulled down).
    private static let lightAccent = Color(red: 0x30 / 255, green: 0x6D / 255, blue: 0x75 / 255)
    private static let darkAccent = Color(red: 0x7E / 255, green: 0xB7 / 255, blue: 0xB6 / 255)

    /// Dusty orange, a bit lighter than the first pass.
    static let orange = Color(red: 0xD6 / 255, green: 0x8C / 255, blue: 0x56 / 255)

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

struct LiveActivityElapsed: View {
    let start: Date
    var compact: Bool = false
    var color: Color = LiveActivityPalette.orange

    var body: some View {
        Text(
            timerInterval: start...start.addingTimeInterval(6 * 60 * 60),
            countsDown: false,
            showsHours: false
        )
        .font(compact ? .caption2.monospacedDigit().weight(.bold) : .caption.monospacedDigit().weight(.semibold))
        .foregroundStyle(color)
        .lineLimit(1)
        .minimumScaleFactor(0.7)
        .multilineTextAlignment(.trailing)
        .monospacedDigit()
    }
}

struct LiveActivityWorkingLabel: View {
    let label: String
    let startedAt: Date
    var color: Color = LiveActivityPalette.orange

    var body: some View {
        HStack(spacing: 4) {
            Text(Self.stem(label))
            LiveActivityElapsed(start: startedAt, compact: true, color: color)
        }
        .font(.caption2.weight(.semibold))
        .foregroundStyle(color)
        .lineLimit(1)
        .minimumScaleFactor(0.7)
    }

    static func stem(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasSuffix("...") {
            s.removeLast(3)
        } else if s.hasSuffix("…") {
            s.removeLast()
        }
        while s.hasSuffix(".") { s.removeLast() }
        return s.trimmingCharacters(in: .whitespaces)
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
