import SwiftUI

/// Signed-out Voice is the Account sign-in cards. Signed-in Voice is one
/// glass stage: the tinted orb, and no person button. No caption, title,
/// or device name. The orb is the mic. A tap starts listening. A tap while
/// the session is up goes dormant and stops listening. A temporary line
/// under the orb names the state, and Reset ends the call and starts
/// another. The screen does not open Chat.
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

/// Glass circle and the orb control. Personal palette. iPhone landscape
/// stays one column. iPad uses a larger circle. A temporary state line and
/// Reset sit under the orb.
struct VoiceStage: View {
    @ObservedObject var session: VoiceSession
    /// Preview-only. Nil follows the real device.
    var prefersPadLayout: Bool? = nil
    /// Preview-only. When set, a tap walks states instead of starting the mic.
    var onOrbTap: (() -> Void)? = nil

    @Environment(\.colorScheme) private var colorScheme

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
        orbControl
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .safeAreaInset(edge: .bottom, spacing: 16) {
                testingControls
                    .frame(maxWidth: .infinity)
            }
            .background {
                YLTheme.pageFill(colorScheme, palette: .standard)
                    .ignoresSafeArea()
            }
            .environment(\.ylPalette, .standard)
    }

    /// Temporary. One line for the phase the orb was told to draw, and a
    /// button that ends the Mac call and starts another.
    private var testingControls: some View {
        VStack(spacing: 12) {
            Text(session.debugStateLine)
                .font(.subheadline)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
                .foregroundStyle(YLTheme.fg(colorScheme))
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(
                    .ultraThinMaterial,
                    in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                )
            Button("Reset") {
                session.resetCall()
            }
            .buttonStyle(.bordered)
            .disabled(onOrbTap != nil || !session.micEnabled)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 8)
        .frame(maxWidth: 420)
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
            .accessibilityLabel(orbAccessibility)
            .accessibilityAddTraits(session.orbIsControl || onOrbTap != nil ? .isButton : [])
    }

    /// VoiceOver names the control. It does not read a caption, a status
    /// line, or which device holds the mic.
    private var orbAccessibility: String {
        if onOrbTap != nil { return session.phase.rawValue }
        if session.otherDeviceHoldsMic { return "Voice" }
        return session.orbAccessibilityLabel
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
        session.preview(phases[next])
    }
}
