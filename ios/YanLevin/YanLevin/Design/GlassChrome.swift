import SwiftUI
import UIKit

/// Liquid Glass on iOS 26+; fully usable `.ultraThinMaterial` fallback earlier.
/// Feature parity is identical — only chrome treatment differs.
///
/// - **Buttons** — SwiftUI `.buttonStyle(.glass)` via `ylGlassButton` (native touch warp).
/// - **Interactive fields** — SwiftUI `.glassEffect(.regular.interactive())` via `ylGlassField`.
/// - **Passive panels** — UIKit `UIGlassEffect` via `glassPanel` / `glassCapsule`
///   (avoids stacking `glassEffect` on large static surfaces).
///
/// Creation note for UIKit glass: prefer `+[UIGlassEffect effectWithStyle:]` when present
/// (iOS 27+ / later 26). Early iOS 26.0 only supports plain `init` / `effectWithGlass:` —
/// calling `effectWithStyle:` there throws unrecognized selector.
struct GlassChrome<Content: View>: View {
    var cornerRadius: CGFloat = 16
    var capsule: Bool = false
    var interactive: Bool = false
    @ViewBuilder var content: () -> Content

    var body: some View {
        if #available(iOS 26, *) {
            LiquidGlassChrome(
                cornerRadius: cornerRadius,
                capsule: capsule,
                interactive: interactive,
                content: content
            )
        } else {
            MaterialGlassChrome(
                cornerRadius: cornerRadius,
                capsule: capsule,
                content: content
            )
        }
    }
}

@available(iOS 26, *)
private struct LiquidGlassChrome<Content: View>: View {
    var cornerRadius: CGFloat
    var capsule: Bool
    var interactive: Bool
    @ViewBuilder var content: () -> Content

    var body: some View {
        if capsule {
            content()
                .background {
                    NativeLiquidGlassView(interactive: interactive)
                        .clipShape(Capsule())
                }
        } else {
            content()
                .background {
                    NativeLiquidGlassView(interactive: interactive)
                        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
                }
        }
    }
}

/// UIKit-hosted Liquid Glass — works on iOS 26 and 27 when built with Xcode 27.
@available(iOS 26, *)
private struct NativeLiquidGlassView: UIViewRepresentable {
    var interactive: Bool

    final class Coordinator {
        var lastInteractive: Bool?
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> UIVisualEffectView {
        let view = UIVisualEffectView(effect: makeEffect())
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear
        context.coordinator.lastInteractive = interactive
        return view
    }

    func updateUIView(_ uiView: UIVisualEffectView, context: Context) {
        guard context.coordinator.lastInteractive != interactive else { return }
        uiView.effect = makeEffect()
        context.coordinator.lastInteractive = interactive
    }

    private func makeEffect() -> UIGlassEffect {
        let effect = Self.makeGlassEffect()
        effect.isInteractive = interactive
        return effect
    }

    /// Create a `UIGlassEffect` without assuming `effectWithStyle:` exists.
    private static func makeGlassEffect() -> UIGlassEffect {
        let styleSelector = NSSelectorFromString("effectWithStyle:")
        if UIGlassEffect.responds(to: styleSelector) {
            return UIGlassEffect(style: .regular)
        }
        // Early iOS 26.0: class exists, but only plain init / effectWithGlass:.
        return (UIGlassEffect.self as NSObject.Type).init() as! UIGlassEffect
    }
}

private struct MaterialGlassChrome<Content: View>: View {
    var cornerRadius: CGFloat
    var capsule: Bool
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .background {
                if capsule {
                    Capsule().fill(.ultraThinMaterial)
                } else {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(.ultraThinMaterial)
                }
            }
            .overlay {
                if capsule {
                    Capsule().strokeBorder(Color.white.opacity(0.22), lineWidth: 0.5)
                } else {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.22), lineWidth: 0.5)
                }
            }
    }
}

extension View {
    func glassPanel(cornerRadius: CGFloat = 16, interactive: Bool = false) -> some View {
        GlassChrome(cornerRadius: cornerRadius, interactive: interactive) { self }
    }

    func glassCapsule(interactive: Bool = false) -> some View {
        GlassChrome(capsule: true, interactive: interactive) { self }
    }

    /// Circular liquid-glass chrome with the native specular rim.
    /// Optional `tint` matches website `--lg-tint-*` (e.g. chat-orange send).
    ///
    /// Prefer `UIView.cornerConfiguration = .capsule()` when present (iOS 27+ /
    /// later 26) so Liquid Glass keeps its shiny edge lighting. Early iOS 26.0
    /// lacks that API — SwiftUI-clip instead (rim is softer, but no crash).
    func glassCircle(interactive: Bool = false, tint: Color? = nil) -> some View {
        background {
            if #available(iOS 26, *) {
                NativeLiquidGlassCircle(interactive: interactive, tint: tint.map { UIColor($0) })
                    .modifier(LiquidGlassCircleShape())
            } else {
                ZStack {
                    Circle().fill(.ultraThinMaterial)
                    if let tint {
                        Circle().fill(tint)
                    }
                }
                .overlay {
                    Circle().strokeBorder(Color.white.opacity(0.28), lineWidth: 0.6)
                }
                .clipShape(Circle())
            }
        }
    }

    /// Native Shortcuts-style Liquid Glass button (touch-point shine + press shift).
    /// Prefer this over `.plain` + `glassCircle`/`glassPanel` backgrounds — those only
    /// draw material and fall back to a flat highlight.
    @ViewBuilder
    func ylGlassButton(
        shape: YLGlassButtonShape = .capsule,
        tint: Color? = nil
    ) -> some View {
        if #available(iOS 26, *) {
            self
                .buttonStyle(.glass)
                .buttonBorderShape(shape.borderShape)
                .modifier(OptionalGlassTint(tint: tint))
        } else {
            switch shape {
            case .circle:
                self.background(.ultraThinMaterial, in: Circle())
            case .capsule:
                self
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
            case .rounded(let radius):
                self
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(
                        .ultraThinMaterial,
                        in: RoundedRectangle(cornerRadius: radius, style: .continuous)
                    )
            }
        }
    }

    /// Circular glass control (attach / send / filters).
    func ylGlassCircleButton(tint: Color? = nil) -> some View {
        ylGlassButton(shape: .circle, tint: tint)
    }

    /// Circular glass sized to an exact diameter.
    /// Prefer this over `ylGlassCircleButton` when height must match a neighbor
    /// (`.buttonStyle(.glass)` uses system control sizing and ignores label frames).
    @ViewBuilder
    func ylSizedGlassCircle(side: CGFloat, tint: Color? = nil) -> some View {
        let shaped = self
            .frame(width: side, height: side)
            .contentShape(Circle())
        if #available(iOS 26, *) {
            shaped.glassEffect(Self.ylGlass(tint: tint, interactive: true), in: Circle())
        } else {
            shaped
                .background {
                    ZStack {
                        Circle().fill(.ultraThinMaterial)
                        if let tint {
                            Circle().fill(tint)
                        }
                    }
                }
                .overlay {
                    Circle().strokeBorder(Color.white.opacity(0.28), lineWidth: 0.6)
                }
        }
    }

    /// Composer / text-field chrome with native Liquid Glass finger warp
    /// (same interactive deform as Shortcuts / `.buttonStyle(.glass)` — not a view offset).
    ///
    /// Uses a fixed-radius rounded rect (not `Capsule`) so multi-line growth keeps
    /// stable side padding — a capsule's radius is half the height, which eats
    /// horizontal space as the field gets taller and forces chaotic re-wrapping.
    @ViewBuilder
    func ylGlassField(interactive: Bool = true, cornerRadius: CGFloat = 22) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        if #available(iOS 26, *) {
            if interactive {
                self.glassEffect(.regular.interactive(), in: shape)
            } else {
                self.glassEffect(.regular, in: shape)
            }
        } else {
            self
                .background(.ultraThinMaterial, in: shape)
                .overlay {
                    shape.strokeBorder(Color.white.opacity(0.22), lineWidth: 0.5)
                }
        }
    }

    /// Capsule Liquid Glass with optional tint + finger-follow warp (same as glass buttons).
    @ViewBuilder
    func ylGlassCapsule(tint: Color? = nil, interactive: Bool = true) -> some View {
        if #available(iOS 26, *) {
            self.glassEffect(Self.ylGlass(tint: tint, interactive: interactive), in: Capsule())
        } else {
            self
                .background {
                    ZStack {
                        Capsule().fill(.ultraThinMaterial)
                        if let tint {
                            Capsule().fill(tint)
                        }
                    }
                }
                .overlay {
                    Capsule().strokeBorder(Color.white.opacity(0.22), lineWidth: 0.5)
                }
        }
    }

    /// Rounded-rect Liquid Glass with optional tint + finger-follow warp.
    /// `clear` is the more liquid, less frosted material — use when inner
    /// glass chips already carry the readable surfaces.
    @ViewBuilder
    func ylGlassRounded(
        cornerRadius: CGFloat,
        tint: Color? = nil,
        interactive: Bool = true,
        clear: Bool = false
    ) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        if #available(iOS 26, *) {
            self.glassEffect(
                Self.ylGlass(tint: tint, interactive: interactive, clear: clear),
                in: shape
            )
        } else {
            self
                .background {
                    ZStack {
                        shape.fill(.ultraThinMaterial)
                        if let tint {
                            shape.fill(tint)
                        }
                    }
                }
                .overlay {
                    shape.strokeBorder(Color.white.opacity(0.22), lineWidth: 0.5)
                }
        }
    }

    @available(iOS 26, *)
    private static func ylGlass(tint: Color?, interactive: Bool, clear: Bool = false) -> Glass {
        var glass: Glass = clear ? .clear : .regular
        if let tint {
            glass = glass.tint(tint)
        }
        if interactive {
            glass = glass.interactive()
        }
        return glass
    }
}

/// Groups glass shapes so they can melt together when they get close
/// (`GlassEffectContainer`). No-op before iOS 26.
///
/// `spacing` is the merge threshold: shapes closer than this blend. Keep it
/// BELOW the rest-state gap so shapes stay separate at rest and only melt
/// when interactive Liquid Glass warps them toward each other (iMessage composer).
struct YLGlassEffectContainer<Content: View>: View {
    var spacing: CGFloat
    @ViewBuilder var content: () -> Content

    var body: some View {
        if #available(iOS 26, *) {
            GlassEffectContainer(spacing: spacing, content: content)
        } else {
            content()
        }
    }
}

/// Shapes for `ylGlassButton` — maps to `buttonBorderShape` on iOS 26+.
enum YLGlassButtonShape {
    case capsule
    case circle
    case rounded(CGFloat)

    var borderShape: ButtonBorderShape {
        switch self {
        case .capsule: return .capsule
        case .circle: return .circle
        case .rounded(let radius): return .roundedRectangle(radius: radius)
        }
    }
}

private struct OptionalGlassTint: ViewModifier {
    var tint: Color?

    @ViewBuilder
    func body(content: Content) -> some View {
        if let tint {
            content.tint(tint)
        } else {
            content
        }
    }
}

/// Clip only when `cornerConfiguration` is unavailable (early iOS 26.0).
@available(iOS 26, *)
private struct LiquidGlassCircleShape: ViewModifier {
    func body(content: Content) -> some View {
        if NativeLiquidGlassCircle.supportsCornerConfiguration {
            content
        } else {
            content.clipShape(Circle())
        }
    }
}

@available(iOS 26, *)
private struct NativeLiquidGlassCircle: UIViewRepresentable {
    var interactive: Bool
    var tint: UIColor? = nil

    /// Early iOS 26.0 (e.g. 23A5260l) has UIGlassEffect but no cornerConfiguration.
    /// Touching the Swift setter there null-derefs (EXC_BAD_ACCESS / 0x0).
    static let supportsCornerConfiguration: Bool = {
        UIVisualEffectView.instancesRespond(to: NSSelectorFromString("setCornerConfiguration:"))
    }()

    final class Coordinator {
        var lastInteractive: Bool?
        var lastTint: UIColor?
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> UIVisualEffectView {
        let view = UIVisualEffectView(effect: makeEffect())
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear
        applyCornerConfiguration(to: view)
        context.coordinator.lastInteractive = interactive
        context.coordinator.lastTint = tint
        return view
    }

    func updateUIView(_ uiView: UIVisualEffectView, context: Context) {
        let interactiveChanged = context.coordinator.lastInteractive != interactive
        let tintChanged = !Self.sameTint(context.coordinator.lastTint, tint)
        if interactiveChanged || tintChanged {
            uiView.effect = makeEffect()
            context.coordinator.lastInteractive = interactive
            context.coordinator.lastTint = tint
        }
        applyCornerConfiguration(to: uiView)
    }

    private static func sameTint(_ a: UIColor?, _ b: UIColor?) -> Bool {
        switch (a, b) {
        case (nil, nil): return true
        case (nil, _), (_, nil): return false
        case let (a?, b?): return a == b
        }
    }

    private func applyCornerConfiguration(to view: UIVisualEffectView) {
        guard Self.supportsCornerConfiguration else { return }
        // Capsule/circle corner config draws the shiny glass outline.
        view.cornerConfiguration = .capsule()
    }

    private func makeEffect() -> UIGlassEffect {
        let effect = Self.makeGlassEffect()
        effect.isInteractive = interactive
        effect.tintColor = tint
        return effect
    }

    private static func makeGlassEffect() -> UIGlassEffect {
        let styleSelector = NSSelectorFromString("effectWithStyle:")
        if UIGlassEffect.responds(to: styleSelector) {
            return UIGlassEffect(style: .regular)
        }
        // Early iOS 26.0: only `effectWithGlass:` / plain init.
        return (UIGlassEffect.self as NSObject.Type).init() as! UIGlassEffect
    }
}
