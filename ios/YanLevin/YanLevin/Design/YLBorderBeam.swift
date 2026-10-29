// Adapted from border-beam by Jakub Antalik (MIT), "md" rotate recipe.
import SwiftUI

/// Conic window stops from the web `md` mask (`white 52%, white 80%`), as
/// (location, alpha). Location 0 is the beam angle, measured from 12 o'clock.
private enum YLBeamStops {
    static let mask: [(CGFloat, Double)] = [
        (0, 0), (0.30, 0), (0.36, 0.1), (0.44, 0.35),
        (0.52, 1), (0.80, 1),
        (0.86, 0.35), (0.92, 0.1), (0.95, 0), (1, 0),
    ]

    /// Web bloom ring: a tight bright core near 70% with long faint tails.
    static let bloom: [(CGFloat, Double)] = [
        (0, 0), (0.58, 0), (0.62, 0.03), (0.65, 0.08), (0.67, 0.2),
        (0.69, 0.45), (0.70, 0.85), (0.705, 0.85), (0.715, 0.45),
        (0.73, 0.2), (0.75, 0.08), (0.78, 0.03), (0.82, 0), (1, 0),
    ]

    /// White highlight riding the middle of the arc (web `whiteGradient`).
    static let core: [(CGFloat, Double)] = [
        (0, 0), (0.54, 0), (0.57, 0.1), (0.60, 0.3), (0.63, 0.6),
        (0.66, 0.75), (0.69, 0.6), (0.72, 0.3), (0.75, 0.1), (0.78, 0), (1, 0),
    ]

    static func gradient(_ stops: [(CGFloat, Double)]) -> Gradient {
        Gradient(stops: stops.map { .init(color: .white.opacity($0.1), location: $0.0) })
    }
}

private enum YLBeamTiming {
    static let revolution: Double = 1.96
    static let fadeIn: Double = 0.6
    static let fadeOut: Double = 0.5
}

struct YLBorderBeam: View {
    var cornerRadius: CGFloat
    var active: Bool
    var lineWidth: CGFloat = 1.5

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.ylPalette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var fade: Double = 0
    @State private var mounted = false

    var body: some View {
        ZStack {
            if mounted {
                if reduceMotion {
                    shape.strokeBorder(color.opacity(0.45), lineWidth: lineWidth)
                } else {
                    TimelineView(.animation(paused: !active)) { timeline in
                        let turns = (timeline.date.timeIntervalSinceReferenceDate / YLBeamTiming.revolution)
                            .truncatingRemainder(dividingBy: 1)
                        layers(angle: .degrees(turns * 360 - 90))
                    }
                }
            }
        }
        .opacity(fade)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear {
            mounted = active
            fade = active ? 1 : 0
        }
        .onChange(of: active) { _, isActive in
            if isActive {
                mounted = true
                withAnimation(.easeInOut(duration: YLBeamTiming.fadeIn)) { fade = 1 }
            } else {
                withAnimation(.easeOut(duration: YLBeamTiming.fadeOut)) {
                    fade = 0
                } completion: {
                    if !active { mounted = false }
                }
            }
        }
    }

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
    }

    private var color: Color {
        YLTheme.chatSend(colorScheme, palette: palette)
    }

    private var dark: Bool { colorScheme == .dark }

    @ViewBuilder
    private func layers(angle: Angle) -> some View {
        let mask = AngularGradient(gradient: YLBeamStops.gradient(YLBeamStops.mask), center: .center, angle: angle)
        let bloomMask = AngularGradient(gradient: YLBeamStops.gradient(YLBeamStops.bloom), center: .center, angle: angle)
        let coreMask = AngularGradient(gradient: YLBeamStops.gradient(YLBeamStops.core), center: .center, angle: angle)
        let bloomPad = lineWidth * 2 + 18

        ZStack {
            // Inner glow (web ::before): wide soft band hugging the inside edge.
            shape
                .strokeBorder(color, lineWidth: lineWidth * 6)
                .blur(radius: lineWidth * 3)
                .clipShape(shape)
                .mask(mask)
                .opacity(dark ? 0.55 : 0.45)

            // Stroke ring (web ::after).
            shape
                .strokeBorder(color, lineWidth: lineWidth)
                .mask(mask)

            shape
                .strokeBorder(Color.white, lineWidth: max(0.5, lineWidth * 0.6))
                .mask(coreMask)
                .opacity(dark ? 0.55 : 0.35)

            // Bloom: blurred ring bleeding outside the shape. The mask is padded
            // out so the blur is not clipped at the view bounds.
            shape
                .stroke(color, lineWidth: lineWidth * 2)
                .blur(radius: 8)
                .mask { bloomMask.padding(-bloomPad) }
                .opacity(dark ? 0.85 : 0.7)
        }
        .compositingGroup()
    }
}

extension View {
    /// Rotating orange beam around a rounded rect. Purely decorative overlay.
    func ylBorderBeam(cornerRadius: CGFloat, active: Bool, lineWidth: CGFloat = 1.5) -> some View {
        overlay {
            YLBorderBeam(cornerRadius: cornerRadius, active: active, lineWidth: lineWidth)
        }
    }
}
