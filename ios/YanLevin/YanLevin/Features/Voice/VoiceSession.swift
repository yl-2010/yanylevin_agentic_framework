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

/// Voice session for the glass screen. The mic, the caption, and the first
/// spoken lines stay on the phone. `VoiceStore` posts the clip with the same
/// signed-in client as Chat. A partial caption never buzzes.
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
    /// Last phase from `voice/state`. An open mic reports `listening`, which is not
    /// the same as the call going dormant (`breathing`).
    private var serverPhase: VoiceOrbPhase = .breathing
    /// Thinking or tool use. Stays up while polls still say the mic is open.
    private var latchedWork: VoiceOrbPhase?
    private var workConfirmed = false
    /// A holding line can still be playing when thinking starts. The answer is the audio
    /// that begins after that talk has gone quiet.
    private var heardAudioDuringWork = false
    private var quietAfterConfirm = false
    private var answerAudio = false
    private var quietWorkSince: Date?
    private var heardSince: Date?
    private var lastHeard: Date?
    private var spokeUntil: Date?
    private var bargeListen = false
    /// State browser. Capture ticks must not pull the orb back to the ring.
    private var previewing = false

    private static let listenHold: TimeInterval = 0.9
    private static let speakHold: TimeInterval = 0.28
    private static let hearSustain: TimeInterval = 0.12
    private static let workFailGrace: TimeInterval = 12

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
    /// With a token, the Mac is claimed before the mic opens. The phone starts
    /// talking the moment a phrase ends, and keeps going while the agent works.
    func tapOrb() {
        guard orbIsControl else { return }
        // A second tap while the claim is still opening used to cancel it.
        // That cut the connecting web in for a frame and left the ring.
        if callConnecting && !listening {
            return
        }
        if listening || !phase.isDormant {
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
        clearWork()
        clearSpeechClocks()
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
        clearWork()
        clearSpeechClocks()
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
        switch phase {
        case .searching, .working:
            latchedWork = phase
            workConfirmed = true
        case .composing:
            workConfirmed = true
        case .breathing:
            clearWork()
            clearSpeechClocks()
        case .listening, .connecting:
            break
        }
        applyCapture()
    }

    /// He started talking over playback. Stops the spoken turn on screen and
    /// plays the chat interrupt haptic. Partials do not come through here.
    func noteBargeIn() {
        guard listening else { return }
        bargeListen = true
        lastHeard = Date()
        YLHaptics.interrupt()
        applyCapture()
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
        workConfirmed = true
        quietAfterConfirm = true
        answerAudio = true
        spokeUntil = Date().addingTimeInterval(Self.speakHold)
        YLHaptics.voiceAnswer()
        applyCapture()
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
        callConnecting = false
        clearWork()
        clearSpeechClocks()
        listening = false
        phase = .breathing
        activeDevice = device
        if wasAwake {
            YLHaptics.medium()
        }
    }

    /// Caption and orb follow the mic. Grok's phase shows only while he is quiet.
    /// A long silence leaves the mic up. It does not hang up.
    /// Listening, thinking, and speaking stay up through a pause. A one-frame
    /// mic blip does not cut in the connecting web.
    private func applyCapture() {
        let capture = VoiceCapture.shared
        if previewing { return }
        if otherDeviceHoldsMic { return }
        if case .unavailable(let message) = capture.readiness, !capture.isListening {
            callConnecting = false
            clearWork()
            clearSpeechClocks()
            listening = false
            phase = .breathing
            caption = VoiceCaption(settled: message)
            return
        }
        let now = Date()
        let armed = capture.isListening || capture.wantsMic
        listening = armed
        if capture.isListening {
            callConnecting = false
        }

        let audible = capture.isSpeaking || capture.speaker.isAudible
        if audible {
            spokeUntil = now.addingTimeInterval(Self.speakHold)
            if workConfirmed { heardAudioDuringWork = true }
        }
        let speakingNow = audible || (spokeUntil.map { now < $0 } ?? false)
        if workConfirmed && heardAudioDuringWork && !speakingNow {
            quietAfterConfirm = true
        }
        if workConfirmed && quietAfterConfirm && audible {
            answerAudio = true
        }
        let openMic = serverPhase == .listening || serverPhase == .breathing
        if answerAudio && !speakingNow && openMic {
            clearWork()
        } else if workConfirmed && !answerAudio && !speakingNow && serverPhase == .listening {
            if quietWorkSince == nil { quietWorkSince = now }
            if let since = quietWorkSince, now.timeIntervalSince(since) >= Self.workFailGrace {
                clearWork()
            }
        } else {
            quietWorkSince = nil
        }

        var keepListen = bargeListen
        if bargeListen {
            bargeListen = false
            lastHeard = now
        }
        if capture.isHearing {
            if heardSince == nil { heardSince = now }
            let longEnough = now.timeIntervalSince(heardSince!) >= Self.hearSustain
            // A noise blip is not listening. Once the wave is up, a short dip can refresh it.
            if longEnough || phase == .listening {
                keepListen = true
                lastHeard = now
            }
        } else {
            heardSince = nil
            if !speakingNow, phase == .listening, let lastHeard, now.timeIntervalSince(lastHeard) < Self.listenHold {
                keepListen = true
            }
        }

        let installing = capture.readiness == .installing && !capture.isListening
        let opening = callConnecting && !capture.isListening
        let next: VoiceOrbPhase
        if (speakingNow || serverPhase == .composing) && !keepListen {
            next = .composing
        } else if keepListen {
            next = .listening
        } else if let latchedWork, armed || speakingNow {
            next = latchedWork
        } else if opening || installing {
            next = .connecting
        } else {
            next = .breathing
        }
        if phase != next { phase = next }

        if capture.isSpeaking {
            let line = capture.spokenLine.isEmpty ? capture.captionFinal : capture.spokenLine
            caption = VoiceCaption(settled: line)
        } else {
            caption = VoiceCaption(settled: capture.captionFinal, volatileSuffix: capture.captionVolatile)
        }
    }

    private func clearWork() {
        latchedWork = nil
        workConfirmed = false
        heardAudioDuringWork = false
        quietAfterConfirm = false
        answerAudio = false
        quietWorkSince = nil
    }

    private func clearSpeechClocks() {
        heardSince = nil
        lastHeard = nil
        spokeUntil = nil
        bargeListen = false
    }

    /// Preview and the state browser. Sets the orb without a buzz.
    func preview(_ phase: VoiceOrbPhase, caption: VoiceCaption = VoiceCaption()) {
        previewing = true
        self.phase = phase
        self.caption = caption
        self.listening = phase == .listening
        if phase.isDormant {
            activeDevice = nil
        }
    }
}
