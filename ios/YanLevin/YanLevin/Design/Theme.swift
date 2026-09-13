import SwiftUI

enum YLTheme {
    /// Keep `LaunchBackground` in Assets.xcassets in sync with bg0.
    static let lightBg0 = Color(red: 0xE8 / 255, green: 0xED / 255, blue: 0xF2 / 255)
    static let lightBg1 = Color(red: 0xDD / 255, green: 0xE5 / 255, blue: 0xEC / 255)
    static let lightFg = Color(red: 0x14 / 255, green: 0x18 / 255, blue: 0x1D / 255)
    static let lightMuted = Color(red: 0x5A / 255, green: 0x64 / 255, blue: 0x70 / 255)
    static let lightAccent = Color(red: 0x1B / 255, green: 0x7D / 255, blue: 0x8A / 255)

    static let darkBg0 = Color(red: 0x0B / 255, green: 0x0E / 255, blue: 0x11 / 255)
    static let darkBg1 = Color(red: 0x0F / 255, green: 0x14 / 255, blue: 0x1A / 255)
    static let darkFg = Color(red: 0xE9 / 255, green: 0xEE / 255, blue: 0xF2 / 255)
    static let darkMuted = Color(red: 0x98 / 255, green: 0xA2 / 255, blue: 0xAD / 255)
    static let darkAccent = Color(red: 0x71 / 255, green: 0xC4 / 255, blue: 0xC2 / 255)

    /// Website chat send tint (`--chat-orange`).
    static let chatOrange = Color(red: 0xFD / 255, green: 0x58 / 255, blue: 0x02 / 255)
    static let chatOrangeDark = Color(red: 0xF4 / 255, green: 0x68 / 255, blue: 0x10 / 255)

    static func bg0(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? darkBg0 : lightBg0
    }

    static func bg1(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? darkBg1 : lightBg1
    }

    static func fg(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? darkFg : lightFg
    }

    static func muted(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? darkMuted : lightMuted
    }

    static func accent(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? darkAccent : lightAccent
    }

    static func chatSend(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? chatOrangeDark : chatOrange
    }

    /// Soft diagonal wash matching the site (`linear-gradient(165deg, bg-0, bg-1)`).
    static func pageFill(_ scheme: ColorScheme) -> LinearGradient {
        LinearGradient(
            colors: [bg0(scheme), bg1(scheme)],
            startPoint: UnitPoint(x: 0.15, y: 0),
            endPoint: UnitPoint(x: 0.85, y: 1)
        )
    }

    /// Convenience for views that don't have ColorScheme yet.
    static var bg0: Color { Color(uiColor: UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(YLTheme.darkBg0)
            : UIColor(YLTheme.lightBg0)
    }) }

    static var bg1: Color { Color(uiColor: UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(YLTheme.darkBg1)
            : UIColor(YLTheme.lightBg1)
    }) }

    static var fg: Color { Color(uiColor: UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(YLTheme.darkFg)
            : UIColor(YLTheme.lightFg)
    }) }

    static var muted: Color { Color(uiColor: UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(YLTheme.darkMuted)
            : UIColor(YLTheme.lightMuted)
    }) }

    static var accent: Color { Color(uiColor: UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(YLTheme.darkAccent)
            : UIColor(YLTheme.lightAccent)
    }) }
}

enum ThemePreference: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var title: String {
        switch self {
        case .system: return "System"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }
}

@MainActor
final class ThemeStore: ObservableObject {
    @Published var preference: ThemePreference = .system

    var preferredColorScheme: ColorScheme? {
        switch preference {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }

    func cycle() {
        switch preference {
        case .system: preference = .light
        case .light: preference = .dark
        case .dark: preference = .system
        }
    }
}

private struct YLPageBackgroundModifier: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        content
            .background {
                YLTheme.pageFill(colorScheme)
                    .ignoresSafeArea()
            }
            // Opaque nav chrome hides large titles on iOS 26+; keep liquid glass there.
            .modifier(YLNavigationBarBackgroundModifier(colorScheme: colorScheme))
    }
}

private struct YLNavigationBarBackgroundModifier: ViewModifier {
    let colorScheme: ColorScheme

    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content
        } else {
            content
                .toolbarBackground(YLTheme.bg0(colorScheme), for: .navigationBar)
                .toolbarBackground(.visible, for: .navigationBar)
        }
    }
}

extension View {
    /// Site-matching page wash (light blue-gray / dark blue-black) without orbs.
    func ylPageBackground() -> some View {
        modifier(YLPageBackgroundModifier())
    }
}
