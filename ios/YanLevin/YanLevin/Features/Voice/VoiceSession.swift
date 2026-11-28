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

/// Local voice session for the glass screen. No network. Listening, dormant,
/// and the later audio cues all go through here so a partial caption cannot buzz.
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
                VoiceCapture.shared.goDormant()
            }
        }
    }

    /// App is not backgrounded. `voiceSaved` plays only while this is true.
    var isForeground = true

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
        return listening ? "Stop listening" : "Start listening"
    }

    /// Tap on the orb. Starts listening, or goes dormant and stops the mic.
    func tapOrb() {
        guard orbIsControl else { return }
        if listening || !phase.isDormant {
            goDormant()
        } else {
            startListening()
        }
    }

    func startListening() {
        guard orbIsControl, !listening else { return }
        activeDevice = thisDevice
        listening = true
        phase = VoiceCapture.shared.readiness == .installing ? .connecting : .breathing
        VoiceCapture.shared.setOtherDeviceLive(false)
        VoiceCapture.shared.startListening()
    }

    /// Stop listening. Same path for the orb tap, leaving the Voice tab, and
    /// leaving the app. The capture plays medium once, and only if the mic
    /// was actually up. A second call does not buzz again.
    func goDormant() {
        VoiceCapture.shared.goDormant()
        listening = false
        phase = .breathing
        if activeDevice == thisDevice {
            activeDevice = nil
        }
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

    /// Caption and orb follow the mic. Searching and working stay put while
    /// the call is open and he is quiet, so a later store can set those.
    private func applyCapture() {
        let capture = VoiceCapture.shared
        if otherDeviceHoldsMic { return }
        if case .unavailable(let message) = capture.readiness, !capture.isListening {
            listening = false
            phase = .breathing
            caption = VoiceCaption(settled: message)
            return
        }
        let armed = capture.isListening || capture.wantsMic
        listening = armed
        if capture.isHearing {
            phase = .listening
        } else if capture.isSpeaking {
            phase = .composing
        } else if capture.readiness == .installing && !armed {
            phase = .connecting
        } else if armed {
            if phase != .searching && phase != .working {
                phase = capture.readiness == .installing ? .connecting : .breathing
            }
        } else if phase == .listening || phase == .composing || phase == .connecting {
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
