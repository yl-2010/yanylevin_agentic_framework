import SwiftUI
import ThinkingOrbsKit
import UIKit

/// ThinkingOrbsKit `.working` orb painted in the chat tint instead of greys,
/// using the web engine's `inkColor` ramp (toward black on dark, toward white on light).
struct YLTintedOrb: View {
    let size: CGFloat

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.ylPalette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let tuned: OrbSize = .px20
    /// ThinkingOrbsKit's reduced-motion instant (`OrbSpec.reducedMotionT`, internal).
    private static let reducedMotionT: Double = 0.6

    var body: some View {
        let preset = resolvePreset(.working, Self.tuned)
        let tint = Self.rgb(YLTheme.chatSend(colorScheme, palette: palette))
        let dark = colorScheme == .dark
        Group {
            if reduceMotion {
                canvas(preset: preset, t: Self.reducedMotionT * preset.speed, tint: tint, dark: dark)
            } else {
                TimelineView(.animation) { timeline in
                    let t = timeline.date.timeIntervalSinceReferenceDate * preset.speed
                    canvas(preset: preset, t: t, tint: tint, dark: dark)
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private func canvas(
        preset: ResolvedPreset,
        t: Double,
        tint: (r: Double, g: Double, b: Double),
        dark: Bool
    ) -> some View {
        Canvas(rendersAsynchronously: false) { context, _ in
            var context = context
            let base = Double(Self.tuned.rawValue)
            let zoom = Double(size) / base
            if zoom != 1 { context.scaleBy(x: zoom, y: zoom) }
            let frame = orbFrame(preset, size: base, t: t)
            for l in frame.lines {
                var path = Path()
                path.move(to: CGPoint(x: l.x1, y: l.y1))
                path.addLine(to: CGPoint(x: l.x2, y: l.y2))
                context.stroke(path, with: .color(Self.ink(l.white, l.a, tint: tint, dark: dark)), lineWidth: l.w)
            }
            for d in frame.dots {
                let rect = CGRect(x: d.x - d.r, y: d.y - d.r, width: d.r * 2, height: d.r * 2)
                context.fill(Path(ellipseIn: rect), with: .color(Self.ink(d.white, d.a, tint: tint, dark: dark)))
            }
        }
    }

    private static func ink(
        _ white: Double,
        _ alpha: Double,
        tint: (r: Double, g: Double, b: Double),
        dark: Bool
    ) -> Color {
        let w = min(1, max(0, white))
        func ramp(_ c: Double) -> Double {
            let v = dark ? c * (1 - w) : c + (1 - c) * w
            return (v * 255).rounded(.toNearestOrAwayFromZero) / 255
        }
        return Color(.sRGB, red: ramp(tint.r), green: ramp(tint.g), blue: ramp(tint.b), opacity: alpha)
    }

    private static func rgb(_ color: Color) -> (r: Double, g: Double, b: Double) {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        UIColor(color).getRed(&r, green: &g, blue: &b, alpha: &a)
        return (Double(r), Double(g), Double(b))
    }
}
