import SwiftUI

/// Signed-out Voice is the Account sign-in cards. Signed-in Voice is one
/// glass stage: the tinted orb, a caption capsule, and no person button.
/// The orb is the mic. A tap starts listening. A tap while the session is
/// up goes dormant and stops listening. The screen does not open Chat.
struct VoiceView: View {
    @EnvironmentObject private var auth: AuthStore
    @EnvironmentObject private var nav: AppNavigationStore
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var session = VoiceSession()

    var body: some View {
        Group {
            if auth.isAuthenticated {
                VoiceStage(session: session)
            } else {
                AccountView()
            }
        }
        .environment(\.ylPalette, .standard)
        .onAppear {
            session.isForeground = scenePhase != .background
            session.micEnabled = auth.hasFullAccess
            session.bind(token: auth.session?.token)
        }
        .onChange(of: auth.session?.token) { _, token in
            session.bind(token: token)
        }
        .onChange(of: auth.hasFullAccess) { _, allowed in
            session.micEnabled = allowed
            if !allowed {
                session.goDormant()
            }
        }
        .onChange(of: auth.isAuthenticated) { _, signedIn in
            if !signedIn {
                session.goDormant()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            session.isForeground = phase != .background
            if phase == .background {
                session.goDormant()
            }
        }
        .onChange(of: nav.selectedTab) { _, _ in
            session.goDormant()
        }
        .onDisappear {
            session.goDormant()
        }
    }
}

/// Glass circle, caption capsule, and the orb control. Personal palette.
/// iPhone landscape stays one column. iPad uses a larger circle and
/// `AdaptiveLayout.formMaxWidth` for the caption.
struct VoiceStage: View {
    @ObservedObject var session: VoiceSession
    /// Preview-only. Nil follows the real device.
    var prefersPadLayout: Bool? = nil
    /// Preview-only. When set, a tap walks states instead of starting the mic.
    var onOrbTap: (() -> Void)? = nil

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    private var isPad: Bool {
        prefersPadLayout ?? AdaptiveLayout.isPad
    }

    /// Library geometry is drawn at 160 on iPhone and 200 on iPad, then
    /// scaled inside the canvas. The glass circle uses the same padding as
    /// the 48 point orb inside the 60 point Working square.
    private var orbPoints: CGFloat {
        isPad ? 200 : 160
    }

    private var circlePoints: CGFloat {
        orbPoints * 60 / 48
    }

    var body: some View {
        VStack(spacing: stackSpacing) {
            orbControl
            captionCapsule
                .adaptiveReadableWidth(AdaptiveLayout.formMaxWidth, enabled: isPad)
        }
        .padding(.horizontal, isPad ? 32 : 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
            YLTheme.pageFill(colorScheme, palette: .standard)
                .ignoresSafeArea()
        }
        .environment(\.ylPalette, .standard)
    }

    private var stackSpacing: CGFloat {
        if verticalSizeClass == .compact && !isPad { return 16 }
        return 28
    }

    private var orbControl: some View {
        orbGlass
            .contentShape(Circle())
            .onTapGesture {
                guard session.orbIsControl || onOrbTap != nil else { return }
                if let onOrbTap {
                    onOrbTap()
                } else {
                    session.tapOrb()
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(onOrbTap == nil ? session.orbAccessibilityLabel : session.phase.rawValue)
            .accessibilityAddTraits(session.orbIsControl || onOrbTap != nil ? .isButton : [])
    }

    private var orbGlass: some View {
        YLTintedOrb(state: session.phase.orbState, size: orbPoints)
            .frame(width: circlePoints, height: circlePoints)
            .ylGlassRounded(
                cornerRadius: circlePoints / 2,
                interactive: session.orbIsControl || onOrbTap != nil,
                clear: true
            )
    }

    private var captionCapsule: some View {
        let line = session.displayedCaption
        return (Text(line.settled).foregroundStyle(YLTheme.fg(colorScheme))
            + Text(line.volatileSuffix).foregroundStyle(YLTheme.muted(colorScheme)))
            .font(.body)
            .lineLimit(1)
            .minimumScaleFactor(0.75)
            .frame(maxWidth: .infinity, minHeight: 22)
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
            .ylGlassCapsule(interactive: false)
            .opacity(line.isEmpty ? 0 : 1)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(line.spoken)
            .accessibilityHidden(line.isEmpty)
    }
}

#Preview("Session") {
    VoicePreviewHost()
}

#Preview("States") {
    VoiceStateBrowser()
}

#Preview("Dark") {
    VoiceStateBrowser()
        .preferredColorScheme(.dark)
}

#Preview("Landscape", traits: .landscapeLeft) {
    VoiceStateBrowser()
}

#Preview("iPad") {
    VoiceStateBrowser(prefersPadLayout: true)
}

#Preview("Other device") {
    VoiceOtherDevicePreview()
}

private struct VoiceOtherDevicePreview: View {
    @StateObject private var session = VoiceSession(micEnabled: true, thisDevice: .phone)

    var body: some View {
        VoiceStage(session: session)
            .onAppear {
                session.noteRemoteActiveDevice(.pad)
            }
    }
}

private struct VoicePreviewHost: View {
    @StateObject private var session = VoiceSession(micEnabled: true)

    var body: some View {
        VoiceStage(session: session)
    }
}

/// Tap the orb to walk the six states. No haptics. The shipping screen uses
/// `VoiceSession.tapOrb`, which starts and stops listening instead.
private struct VoiceStateBrowser: View {
    var prefersPadLayout: Bool? = nil

    @StateObject private var session = VoiceSession(micEnabled: true)
    @State private var index = 0

    private var phases: [VoiceOrbPhase] { Array(VoiceOrbPhase.allCases) }

    var body: some View {
        VoiceStage(session: session, prefersPadLayout: prefersPadLayout, onOrbTap: { advance() })
            .onAppear { show(0) }
    }

    private func advance() {
        show((index + 1) % phases.count)
    }

    private func show(_ next: Int) {
        index = next
        let phase = phases[next]
        session.preview(phase, caption: Self.sample(phase))
    }

    private static func sample(_ phase: VoiceOrbPhase) -> VoiceCaption {
        switch phase {
        case .connecting, .breathing:
            return VoiceCaption()
        case .listening:
            return VoiceCaption(settled: "Move the calc set", volatileSuffix: " to Friday")
        case .working, .searching:
            return VoiceCaption(settled: "Checking.")
        case .composing:
            return VoiceCaption(settled: "Moved it to Friday.")
        }
    }
}
