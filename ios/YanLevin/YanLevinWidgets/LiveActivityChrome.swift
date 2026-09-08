import SwiftUI

/// Shared Live Activity chrome: calmer palette than the app, YL mark, busy pulse.
enum LiveActivityChrome {
    /// Dynamic Island expanded corner radius is 44pt. Keep content inside that curve.
    static let islandBottomPad: CGFloat = 16
    static let islandSidePad: CGFloat = 16
    static let islandEarPad: CGFloat = 20
    static let islandCompactLeadingPad: CGFloat = 8
    /// Caps compact-island timers. `Text(timerInterval:)` and `TimeDataSource` report a huge ideal width.
    static let islandCompactTimerWidth: CGFloat = 54
    static let lockScreenPad: CGFloat = 16
}

/// Live Activity colors only. App `YLTheme` stays as-is.
enum LiveActivityPalette {
    static let mark = Color.white

    /// Dusty teal (app accent with the saturation pulled down).
    private static let lightAccent = Color(red: 0x30 / 255, green: 0x6D / 255, blue: 0x75 / 255)
    private static let darkAccent = Color(red: 0x7E / 255, green: 0xB7 / 255, blue: 0xB6 / 255)

    /// Dusty orange. Same hue as before, brightness bumped.
    static let orange = Color(hue: 25 / 360, saturation: 0.55, brightness: 0.93)

    /// Island is always a black pill.
    static let islandAccent = darkAccent
    static let islandFg = Color.white
    static let islandMuted = Color.white.opacity(0.58)

    static func accent(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? darkAccent : lightAccent
    }

    static var adaptiveAccent: Color {
        Color(uiColor: UIColor { trait in
            UIColor(trait.userInterfaceStyle == .dark ? darkAccent : lightAccent)
        })
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
            timerInterval: start...start.addingTimeInterval(99 * 60),
            countsDown: false,
            showsHours: false
        )
        .font(compact ? .caption2.monospacedDigit().weight(.bold) : .caption.monospacedDigit().weight(.semibold))
        .foregroundStyle(color)
        .lineLimit(1)
        .minimumScaleFactor(0.7)
        .multilineTextAlignment(.trailing)
        .monospacedDigit()
        .frame(width: compact ? 40 : 48, alignment: .trailing)
    }
}

struct LiveActivityWorkingLabel: View {
    let label: String
    var startedAt: Date? = nil
    var color: Color = LiveActivityPalette.orange

    var body: some View {
        HStack(spacing: 4) {
            Text(Self.stem(label))
            if let startedAt {
                LiveActivityElapsed(start: startedAt, compact: true, color: color)
            }
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
        YLTheme.pageFill(colorScheme)
            .overlay(alignment: .top) {
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

extension View {
    func liveActivityLockScreenChrome() -> some View {
        modifier(LiveActivityLockScreenChrome())
    }

    /// Tint the ActivityKit container, not an inner view wrapped by `widgetURL`.
    func liveActivityRootChrome() -> some View {
        activityBackgroundTint(YLTheme.bg0)
            .activitySystemActionForegroundColor(LiveActivityPalette.adaptiveAccent)
    }
}

private struct LiveActivityLockScreenChrome: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        content
            .foregroundStyle(YLTheme.fg(colorScheme))
            .containerBackground(for: .widget) {
                LiveActivityBannerBackground()
            }
    }
}
