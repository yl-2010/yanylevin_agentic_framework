import SwiftUI

enum YLPalette: Equatable {
    case standard
    case jype
    case debate
}

private struct YLPaletteKey: EnvironmentKey {
    static let defaultValue: YLPalette = .standard
}

extension EnvironmentValues {
    var ylPalette: YLPalette {
        get { self[YLPaletteKey.self] }
        set { self[YLPaletteKey.self] = newValue }
    }
}

/// Brand colors come from `BrandPalette` (brand/palette.mjs, `npm run brand`). Neutrals stay here.
enum YLTheme {
    /// Keep `LaunchBackground` in Assets.xcassets in sync with bg0.
    static let lightBg0 = Color(red: 0xE8 / 255, green: 0xED / 255, blue: 0xF2 / 255)
    static let lightBg1 = Color(red: 0xDD / 255, green: 0xE5 / 255, blue: 0xEC / 255)
    static let lightFg = Color(red: 0x14 / 255, green: 0x18 / 255, blue: 0x1D / 255)
    static let lightMuted = Color(red: 0x5A / 255, green: 0x64 / 255, blue: 0x70 / 255)
    static let lightAccent = BrandPalette.personalAccentLight

    static let darkBg0 = Color(red: 0x0B / 255, green: 0x0E / 255, blue: 0x11 / 255)
    static let darkBg1 = Color(red: 0x0F / 255, green: 0x14 / 255, blue: 0x1A / 255)
    static let darkFg = Color(red: 0xE9 / 255, green: 0xEE / 255, blue: 0xF2 / 255)
    static let darkMuted = Color(red: 0x98 / 255, green: 0xA2 / 255, blue: 0xAD / 255)
    static let darkAccent = BrandPalette.personalAccentDark

    /// Chat send tint. Debate uses this too, never its own.
    static let chatOrange = BrandPalette.agentAccentLight
    static let chatOrangeDark = BrandPalette.agentAccentDark

    static let jypeLightBg0 = BrandPalette.jypeBg0Light
    static let jypeLightBg1 = BrandPalette.jypeBg1Light
    static let jypeLightAccent = BrandPalette.jypeAccentLight
    static let jypeDarkBg0 = BrandPalette.jypeBg0Dark
    static let jypeDarkBg1 = BrandPalette.jypeBg1Dark
    static let jypeDarkAccent = BrandPalette.jypeAccentDark

    static let debateLightBg0 = BrandPalette.debateBg0Light
    static let debateLightBg1 = BrandPalette.debateBg1Light
    static let debateLightAccent = BrandPalette.debateAccentLight
    static let debateDarkBg0 = BrandPalette.debateBg0Dark
    static let debateDarkBg1 = BrandPalette.debateBg1Dark
    static let debateDarkAccent = BrandPalette.debateAccentDark

    static func bg0(_ scheme: ColorScheme, palette: YLPalette = .standard) -> Color {
        switch palette {
        case .jype: return scheme == .dark ? jypeDarkBg0 : jypeLightBg0
        case .debate: return scheme == .dark ? debateDarkBg0 : debateLightBg0
        case .standard: return scheme == .dark ? darkBg0 : lightBg0
        }
    }

    static func bg1(_ scheme: ColorScheme, palette: YLPalette = .standard) -> Color {
        switch palette {
        case .jype: return scheme == .dark ? jypeDarkBg1 : jypeLightBg1
        case .debate: return scheme == .dark ? debateDarkBg1 : debateLightBg1
        case .standard: return scheme == .dark ? darkBg1 : lightBg1
        }
    }

    static func fg(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? darkFg : lightFg
    }

    static func muted(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? darkMuted : lightMuted
    }

    static func accent(_ scheme: ColorScheme, palette: YLPalette = .standard) -> Color {
        switch palette {
        case .jype: return scheme == .dark ? jypeDarkAccent : jypeLightAccent
        case .debate: return scheme == .dark ? debateDarkAccent : debateLightAccent
        case .standard: return scheme == .dark ? darkAccent : lightAccent
        }
    }

    static func chatSend(_ scheme: ColorScheme, palette: YLPalette = .standard) -> Color {
        switch palette {
        case .jype: return accent(scheme, palette: .jype)
        case .debate, .standard: return scheme == .dark ? chatOrangeDark : chatOrange
        }
    }

    /// Arrow on the solid send fill. A light gray fill needs a dark glyph.
    static func chatSendGlyph(_ scheme: ColorScheme, palette: YLPalette = .standard) -> Color {
        prefersDarkGlyph(chatSend(scheme, palette: palette)) ? .black : .white
    }

    private static func prefersDarkGlyph(_ color: Color) -> Bool {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        guard UIColor(color).getRed(&r, green: &g, blue: &b, alpha: &a) else { return false }
        func lin(_ c: CGFloat) -> CGFloat {
            c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        let y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
        return y > 0.45
    }

    /// Soft diagonal wash matching the site (`linear-gradient(165deg, bg-0, bg-1)`).
    static func pageFill(_ scheme: ColorScheme, palette: YLPalette = .standard) -> LinearGradient {
        LinearGradient(
            colors: [bg0(scheme, palette: palette), bg1(scheme, palette: palette)],
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

    static var jypeAccent: Color { Color(uiColor: UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(YLTheme.jypeDarkAccent)
            : UIColor(YLTheme.jypeLightAccent)
    }) }

    static var debateAccent: Color { Color(uiColor: UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(YLTheme.debateDarkAccent)
            : UIColor(YLTheme.debateLightAccent)
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
    @Environment(\.ylPalette) private var palette

    func body(content: Content) -> some View {
        content
            .background {
                YLTheme.pageFill(colorScheme, palette: palette)
                    .ignoresSafeArea()
            }
            // Opaque nav chrome hides large titles on iOS 26+; keep liquid glass there.
            .modifier(YLNavigationBarBackgroundModifier(colorScheme: colorScheme, palette: palette))
    }
}

private struct YLNavigationBarBackgroundModifier: ViewModifier {
    let colorScheme: ColorScheme
    var palette: YLPalette = .standard

    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content
        } else {
            content
                .toolbarBackground(YLTheme.bg0(colorScheme, palette: palette), for: .navigationBar)
                .toolbarBackground(.visible, for: .navigationBar)
        }
    }
}

extension View {
    /// Site-matching page wash without orbs. Reads `ylPalette` (JYPE red when set).
    func ylPageBackground() -> some View {
        modifier(YLPageBackgroundModifier())
    }
}
