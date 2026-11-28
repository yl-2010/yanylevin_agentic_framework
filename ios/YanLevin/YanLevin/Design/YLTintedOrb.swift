import SwiftUI
import ThinkingOrbsKit
import UIKit

/// ThinkingOrbsKit orb painted in the chat tint instead of greys.
/// Ink ramps toward black on dark and toward white on light, same as the web engine.
/// `state` defaults to `.working` so the chat Working bubble stays on that mode.
/// A new state has to hold still briefly, then the old dots fade into the new ones.
/// A one-frame state never gets a frame of its own.
struct YLTintedOrb: View {
    var state: OrbState = .working
    let size: CGFloat

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.ylPalette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var mix: OrbMix

    private static let tuned: OrbSize = .px64
    /// ThinkingOrbsKit's reduced-motion instant (`OrbSpec.reducedMotionT`, internal).
    private static let reducedMotionT: Double = 0.6

    init(state: OrbState = .working, size: CGFloat) {
        self.state = state
        self.size = size
        _mix = State(initialValue: OrbMix(state: state))
    }

    var body: some View {
        let tint = Self.rgb(YLTheme.chatSend(colorScheme, palette: palette))
        let dark = colorScheme == .dark
        Group {
            if reduceMotion {
                canvas(
                    layers: [(state, 1)],
                    now: Self.reducedMotionT,
                    tint: tint,
                    dark: dark
                )
            } else {
                TimelineView(.animation) { timeline in
                    let now = timeline.date.timeIntervalSinceReferenceDate
                    canvas(layers: mix.layers(toward: state, at: now), now: now, tint: tint, dark: dark)
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private func canvas(
        layers: [(OrbState, Double)],
        now: TimeInterval,
        tint: (r: Double, g: Double, b: Double),
        dark: Bool
    ) -> some View {
        Canvas(rendersAsynchronously: false) { context, _ in
            var context = context
            let base = Double(Self.tuned.rawValue)
            let zoom = Double(size) / base
            if zoom != 1 { context.scaleBy(x: zoom, y: zoom) }
            for (orbState, gain) in layers {
                let preset = resolvePreset(orbState, Self.tuned)
                let frame = orbFrame(preset, size: base, t: now * preset.speed)
                paint(frame, into: &context, tint: tint, dark: dark, gain: gain)
            }
        }
    }

    private func paint(
        _ frame: OrbFrame,
        into context: inout GraphicsContext,
        tint: (r: Double, g: Double, b: Double),
        dark: Bool,
        gain: Double
    ) {
        guard gain > 0.004 else { return }
        for l in frame.lines {
            var path = Path()
            path.move(to: CGPoint(x: l.x1, y: l.y1))
            path.addLine(to: CGPoint(x: l.x2, y: l.y2))
            context.stroke(
                path,
                with: .color(Self.ink(l.white, l.a * gain, tint: tint, dark: dark)),
                lineWidth: l.w
            )
        }
        for d in frame.dots {
            let rect = CGRect(x: d.x - d.r, y: d.y - d.r, width: d.r * 2, height: d.r * 2)
            context.fill(
                Path(ellipseIn: rect),
                with: .color(Self.ink(d.white, d.a * gain, tint: tint, dark: dark))
            )
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

/// Two orb drawings, faded by a clock the timeline already owns.
/// The state has to sit still for a moment before it becomes the one on screen,
/// so a single published frame cannot pop a different animation.
private final class OrbMix {
    private var previous: OrbState
    private var rendered: OrbState
    private var fadeStart: TimeInterval?
    private var candidate: OrbState
    private var candidateSince: TimeInterval?

    /// Long enough that one frame is ignored, short enough that a real change still starts.
    private static let settle: TimeInterval = 0.09
    private static let duration: TimeInterval = 0.45

    init(state: OrbState) {
        previous = state
        rendered = state
        candidate = state
    }

    /// Steps the mix, then returns the drawings. The timeline cannot call `advance` itself. That call is Void, and ViewBuilder tries to treat it as a view.
    func layers(toward target: OrbState, at now: TimeInterval) -> [(OrbState, Double)] {
        advance(toward: target, now: now)
        return layers(at: now)
    }

    func advance(toward target: OrbState, now: TimeInterval) {
        if target != candidate {
            candidate = target
            candidateSince = now
        }
        guard target != rendered else { return }
        guard let since = candidateSince, now - since >= Self.settle else { return }
        let shown = dominant(at: now)
        if shown == target {
            previous = target
            rendered = target
            fadeStart = nil
            return
        }
        previous = shown
        rendered = target
        fadeStart = now
    }

    func layers(at now: TimeInterval) -> [(OrbState, Double)] {
        let fade = progress(at: now)
        if fade >= 0.999 || previous == rendered {
            return [(rendered, 1)]
        }
        if fade <= 0.001 {
            return [(previous, 1)]
        }
        return [(previous, 1 - fade), (rendered, fade)]
    }

    private func dominant(at now: TimeInterval) -> OrbState {
        progress(at: now) >= 0.5 ? rendered : previous
    }

    private func progress(at now: TimeInterval) -> Double {
        guard previous != rendered, let fadeStart else { return 1 }
        let raw = min(1, max(0, (now - fadeStart) / Self.duration))
        return raw * raw * (3 - 2 * raw)
    }
}
