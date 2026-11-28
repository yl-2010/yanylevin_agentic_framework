import Combine
import SwiftUI
import ThinkingOrbsKit

/// Which phone holds the live mic. Matches `activeDevice` on `voice/state`:
/// `phone`, `pad`, or none.
enum VoiceDeviceKind: String, Equatable {
    case phone
    case pad

    static var current: VoiceDeviceKind {
        AdaptiveLayout.isPad ? .pad : .phone
    }

    var label: String {
        switch self {
        case .phone: return "iPhone"
        case .pad: return "iPad"
        }
    }
}

/// The six orb modes the voice screen uses. `solving`, `weaving`, and
/// `shaping` stay unused, same as the plan.
enum VoiceOrbPhase: String, CaseIterable, Equatable, Identifiable {
    case connecting
    case breathing
    case listening
    case working
    case searching
    case composing

    var id: String { rawValue }

    var orbState: OrbState {
        switch self {
        case .connecting: return .connecting
        case .breathing: return .breathing
        case .listening: return .listening
        case .working: return .working
        case .searching: return .searching
        case .composing: return .composing
        }
    }

    /// Idle breath. Tap from here starts listening. Any other phase is a live
    /// session, and a tap goes dormant.
    var isDormant: Bool { self == .breathing }
}

/// One caption line. Settled words use the normal foreground. The volatile
/// tail stays muted. Updating this never plays a haptic.
struct VoiceCaption: Equatable {
    var settled: String = ""
    var volatileSuffix: String = ""

    var isEmpty: Bool {
        settled.isEmpty && volatileSuffix.isEmpty
    }

    var spoken: String {
        settled + volatileSuffix
    }
}

/// Voice session for the glass screen. The mic, the caption, and Okay / Checking
/// stay on the phone. `VoiceStore` posts the clip with the same signed-in client
/// as Chat. A partial caption never buzzes.
@MainActor
final class VoiceSession: ObservableObject {
    /// This device. The server later reports who `activeDevice` is.
    let thisDevice: VoiceDeviceKind

    /// Signed in and `canUseAgent` would allow the Personal Agent. Full access
    /// on this app is that gate. Guests never reach the stage.
    var micEnabled: Bool {
        didSet {
            guard micEnabled != oldValue else { return }
            if micEnabled {
                VoiceCapture.shared.prepare()
            } else {
                goDormant()
            }
        }
    }

    /// App is not backgrounded. `voiceSaved` plays only while this is true.
    var isForeground = true {
        didSet {
            guard isForeground != oldValue else { return }
            VoiceStore.shared.setForeground(isForeground)
        }
    }

    /// Mac call is still being claimed, or the speech asset is still installing.
    private var callConnecting = false
    /// Last phase from `voice/state`. Hearing and speaking on the phone win over this.
    private var serverPhase: VoiceOrbPhase = .breathing

    private var capturePull: AnyCancellable?

    @Published private(set) var phase: VoiceOrbPhase = .breathing
    @Published private(set) var caption = VoiceCaption()
    @Published private(set) var listening = false
    /// Nil while dormant. Never both devices at once.
    @Published private(set) var activeDevice: VoiceDeviceKind?

    init(micEnabled: Bool = false, thisDevice: VoiceDeviceKind = .current) {
        self.micEnabled = micEnabled
        self.thisDevice = thisDevice
        capturePull = VoiceCapture.shared.objectWillChange.sink { [weak self] _ in
            Task { @MainActor in
                self?.applyCapture()
            }
        }
        if micEnabled {
            VoiceCapture.shared.prepare()
        }
    }

    var otherDeviceHoldsMic: Bool {
        guard let activeDevice else { return false }
        return activeDevice != thisDevice
    }

    /// Orb can start or stop listening on this device.
    var orbIsControl: Bool {
        micEnabled && !otherDeviceHoldsMic
    }

    var displayedCaption: VoiceCaption {
        if let holder = activeDevice, holder != thisDevice {
            return VoiceCaption(settled: "Listening on \(holder.label)")
        }
        return caption
    }

    var orbAccessibilityLabel: String {
        if otherDeviceHoldsMic {
            return displayedCaption.settled
        }
        if !micEnabled {
            return "Voice"
        }
        return (listening || callConnecting) ? "Stop listening" : "Start listening"
    }

    /// Signed-in token, the same one `POST api/home/agent/message` sends.
    func bind(token: String?) {
        VoiceStore.shared.attach(surface: self, token: token, device: thisDevice)
        VoiceStore.shared.setForeground(isForeground)
    }

    /// Tap on the orb. Starts listening, or goes dormant and stops the mic.
    /// With a token, the Mac is claimed before the mic opens. Okay and Checking
    /// still come from the phone the moment a phrase ends.
    func tapOrb() {
        guard orbIsControl else { return }
        if listening || callConnecting || !phase.isDormant {
            goDormant()
        } else if VoiceStore.shared.hasToken {
            beginCall()
        } else {
            startListening()
        }
    }

    private func beginCall() {
        guard orbIsControl, !listening, !callConnecting else { return }
        callConnecting = true
        serverPhase = .breathing
        phase = .connecting
        VoiceCapture.shared.showIdleLine("")
        VoiceStore.shared.claim(surface: self, device: thisDevice)
    }

    func startListening() {
        guard orbIsControl, !listening else { return }
        callConnecting = true
        activeDevice = thisDevice
        phase = .connecting
        VoiceCapture.shared.setOtherDeviceLive(false)
        VoiceCapture.shared.startListening()
    }

    /// Stop listening. Same path for the orb tap, leaving the Voice tab, and
    /// leaving the app. The capture plays medium once, and only if the mic
    /// was actually up. A second call does not buzz again.
    func goDormant() {
        let micUp = VoiceCapture.shared.isListening || VoiceCapture.shared.wantsMic
        let cancelConnect = callConnecting && !micUp
        callConnecting = false
        serverPhase = .breathing
        VoiceStore.shared.release()
        VoiceCapture.shared.goDormant()
        listening = false
        phase = .breathing
        if activeDevice == thisDevice {
            activeDevice = nil
        }
        if cancelConnect {
            YLHaptics.medium()
        }
    }

    /// `voice/start` or `voice/resume` claimed this device. Open the mic.
    func voiceLinkClaimed() {
        startListening()
    }

    func voiceLinkFailed(_ line: String) {
        callConnecting = false
        serverPhase = .breathing
        VoiceCapture.shared.liveTurnRunning = false
        VoiceCapture.shared.showIdleLine(line)
        listening = false
        phase = .breathing
        applyCapture()
    }

    func voiceLinkBusyElsewhere(_ device: VoiceDeviceKind) {
        if activeDevice == device && !listening && phase.isDormant && !callConnecting {
            return
        }
        callConnecting = false
        serverPhase = .breathing
        phase = .breathing
        noteRemoteActiveDevice(device)
    }

    /// The other device let go. A tap here can claim the call.
    func voiceOtherDeviceReleased() {
        guard otherDeviceHoldsMic else { return }
        VoiceCapture.shared.setOtherDeviceLive(false)
        activeDevice = nil
        listening = false
        phase = .breathing
    }

    /// Server marked the call dormant, usually after missed heartbeats.
    func voiceDroppedByServer() {
        goDormant()
    }

    func voiceServerPhase(_ phase: VoiceOrbPhase) {
        serverPhase = phase
        applyCapture()
    }

    /// He started talking over playback. Stops the spoken turn on screen and
    /// plays the chat interrupt haptic. Partials do not come through here.
    func noteBargeIn() {
        guard listening else { return }
        phase = .listening
        YLHaptics.interrupt()
    }

    /// Audio for this turn actually started. One soft hit. Not when the
    /// request is sent.
    func noteFirstSound() {
        guard listening else { return }
        YLHaptics.voiceFirstSound()
    }

    /// Grok's spoken answer started. Orb goes to the speaking ribbon.
    func noteAnswerStarted() {
        guard listening else { return }
        phase = .composing
        YLHaptics.voiceAnswer()
    }

    /// Summary bubbles were written. Soft hit only if this app is still up.
    func noteSummarySaved() {
        guard isForeground else { return }
        VoiceCapture.shared.noteSummarySaved()
    }

    /// Live transcript or the sentence being spoken. No haptic.
    func applyCaption(settled: String, volatileSuffix: String = "") {
        caption = VoiceCaption(settled: settled, volatileSuffix: volatileSuffix)
    }

    /// Another device claimed the mic, or released it. This device closes
    /// the mic and shows the breathing orb. Does not steal a live claim.
    func noteRemoteActiveDevice(_ device: VoiceDeviceKind?) {
        if device == thisDevice {
            VoiceCapture.shared.setOtherDeviceLive(false)
            activeDevice = thisDevice
            return
        }
        let wasAwake = listening || !phase.isDormant
        VoiceCapture.shared.setOtherDeviceLive(device != nil)
        listening = false
        phase = .breathing
        activeDevice = device
        if wasAwake {
            YLHaptics.medium()
        }
    }

    /// Caption and orb follow the mic. Grok's phase shows only while he is quiet.
    /// A long silence leaves the mic up. It does not hang up.
    private func applyCapture() {
        let capture = VoiceCapture.shared
        if otherDeviceHoldsMic { return }
        if case .unavailable(let message) = capture.readiness, !capture.isListening {
            callConnecting = false
            listening = false
            phase = .breathing
            caption = VoiceCaption(settled: message)
            return
        }
        let armed = capture.isListening || capture.wantsMic
        listening = armed
        if capture.isListening {
            callConnecting = false
        }
        if capture.isHearing {
            phase = .listening
        } else if capture.isSpeaking {
            phase = .composing
        } else if callConnecting || (armed && !capture.isListening) || capture.readiness == .installing {
            phase = .connecting
        } else if armed && (serverPhase == .searching || serverPhase == .working || serverPhase == .composing) {
            phase = serverPhase
        } else {
            phase = .breathing
        }
        if capture.isSpeaking {
            let line = capture.spokenLine.isEmpty ? capture.captionFinal : capture.spokenLine
            caption = VoiceCaption(settled: line)
        } else {
            caption = VoiceCaption(settled: capture.captionFinal, volatileSuffix: capture.captionVolatile)
        }
    }

    /// Preview and the state browser. Sets the orb without a buzz.
    func preview(_ phase: VoiceOrbPhase, caption: VoiceCaption = VoiceCaption()) {
        self.phase = phase
        self.caption = caption
        self.listening = phase == .listening
        if phase.isDormant {
            activeDevice = nil
        }
    }
}
