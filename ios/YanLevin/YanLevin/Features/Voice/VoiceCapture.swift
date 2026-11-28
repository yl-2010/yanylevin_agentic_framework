import AVFoundation
import Foundation
import Speech
import SwiftUI
import UIKit

/// Fixed social lines. The phone says "Okay." for these and "Checking." for everything else.
/// The server allowlist has to use the same phrases, or it will start Grok on a line the phone already treated as social.
enum VoicePhrase {
    static let silence: TimeInterval = 0.7
    /// A volatile result that never finalizes cannot sit in front of the first sound.
    /// 700 ms plus this cap stays under a couple of seconds from the end of the phrase.
    static let revisionCap: TimeInterval = 0.8
    static let revisionSettle: TimeInterval = 0.2
    static let sampleRate: Double = 16_000

    /// Hey, thanks, stop, never mind, and the same kind of short reply.
    static let socialPhrases: Set<String> = [
        "hey",
        "hi",
        "hello",
        "thanks",
        "thank you",
        "stop",
        "never mind",
        "nevermind",
        "okay",
        "ok",
    ]

    static let fillers: Set<String> = [
        "uh", "um", "uhm", "hmm", "hm", "ah", "er", "eh", "huh",
        "mm", "mmm", "mhm", "mmhmm", "uhh", "ahh",
    ]

    static func normalize(_ text: String) -> String {
        let raw = text.lowercased().unicodeScalars.map { scalar -> Character in
            CharacterSet.alphanumerics.contains(scalar) ? Character(scalar) : " "
        }
        return String(raw).split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    static func isSocial(_ text: String) -> Bool {
        socialPhrases.contains(normalize(text))
    }

    static func firstSound(for text: String) -> String {
        isSocial(text) ? "Okay." : "Checking."
    }

    /// Empty audio is dropped. A one-word noise blip is dropped. "Hey" and "stop" are not blips.
    static func shouldDrop(text: String, speechSeconds: Double) -> Bool {
        if speechSeconds <= 0 { return true }
        let norm = normalize(text)
        let count = norm.isEmpty ? 0 : norm.split(separator: " ").count
        if count <= 1 && speechSeconds < 0.12 { return true }
        if count == 1 && fillers.contains(norm) { return true }
        return false
    }
}

struct VoiceUtterance: Identifiable, Equatable {
    let id: String
    var text: String
    /// 16 kHz mono little-endian Int16. About 32 KB a second. Kept so the Mac can run Parakeet.
    let pcm16kMono: Data
    let social: Bool
    /// Speech started over the speaker, or over a Grok turn the store marked live.
    let interruptsLiveTurn: Bool
}

enum VoiceCaptureReadiness: Equatable {
    case idle
    case installing
    case ready
    case unavailable(String)
}

/// 700 ms of silence after the last speech, and not while the recognizer is still revising.
struct VoiceUtteranceGate {
    private(set) var speaking = false
    private var lastSpeechAt: Date?
    private var lastRevisionAt: Date?
    private var revising = false
    private var lastText = ""

    var collecting: Bool { speaking || lastSpeechAt != nil }

    mutating func beginSpeech() {
        speaking = true
    }

    mutating func endSpeech(now: Date) {
        guard speaking else { return }
        speaking = false
        lastSpeechAt = now
    }

    mutating func noteResult(now: Date, text: String, revising: Bool) {
        if text != lastText || revising != self.revising {
            lastRevisionAt = now
            lastText = text
        }
        self.revising = revising
    }

    func shouldCommit(now: Date) -> Bool {
        guard !speaking, let lastSpeechAt else { return false }
        let sinceSpeech = now.timeIntervalSince(lastSpeechAt)
        guard sinceSpeech >= VoicePhrase.silence else { return false }
        if sinceSpeech >= VoicePhrase.silence + VoicePhrase.revisionCap { return true }
        if revising, let revisedAt = lastRevisionAt, now.timeIntervalSince(revisedAt) < VoicePhrase.revisionSettle {
            return false
        }
        return true
    }

    mutating func reset() {
        speaking = false
        lastSpeechAt = nil
        lastRevisionAt = nil
        revising = false
        lastText = ""
    }
}

/// On-device listen. SpeechTranscriber on iOS 26, on-device SFSpeechRecognizer before that.
/// `prepare` when Voice appears. `readiness == .installing` is the connecting orb.
/// `orbTapped` starts the mic or goes dormant. Leaving the Voice tab calls `goDormant`.
/// A long silence does not. `captionVolatile` is the muted partial.
/// While `isSpeaking`, `spokenLine` is the sentence being spoken.
@MainActor
final class VoiceCapture: ObservableObject {
    static let shared = VoiceCapture()

    @Published private(set) var readiness: VoiceCaptureReadiness = .idle
    @Published private(set) var captionFinal = ""
    @Published private(set) var captionVolatile = ""
    @Published private(set) var spokenLine = ""
    @Published private(set) var isListening = false
    @Published private(set) var isHearing = false
    @Published private(set) var isSpeaking = false
    @Published private(set) var otherDeviceIsLive = false
    @Published private(set) var statusNote = ""
    @Published private(set) var utterances: [VoiceUtterance] = []

    /// Store sets this while a Grok turn from this session is running.
    var liveTurnRunning = false

    let speaker = VoiceSpeaker()

    private let feed = VoiceFeed()
    private let legacyBox = LegacyBox()
    private let captureBox = CaptureBox()
    private var gate = VoiceUtteranceGate()
    private var utterancePCM = Data()
    private var speechSamples = 0
    private var finalizedText = ""
    private var volatileText = ""
    private var useSegments = false
    private var dropUntilSpeech = false
    private var ignoreNextIdenticalFinal = false
    private var lastCommitted = ""
    private var bargeFired = false
    private var currentInterrupts = false
    @Published private(set) var wantsMic = false
    private var analyzerReady = false
    private var openTask: Task<Void, Never>?
    private var prepareTask: Task<Void, Never>?
    private var recognizer: SFSpeechRecognizer?
    private var legacyTask: SFSpeechRecognitionTask?
    private var analyzerResultTask: Task<Void, Never>?
    private var analyzerHold: Any?
    private var backgroundObserver: NSObjectProtocol?
    private var interruptionObserver: NSObjectProtocol?

    private static let speechOn: Float = 0.02
    private static let speechOff: Float = 0.012

    private init() {
        captureBox.capture = self
        speaker.onLineStarted = { [weak self] line, _ in
            self?.lineDidStart(line)
        }
        speaker.onSpeakingChange = { [weak self] speaking in
            self?.isSpeaking = speaking
        }
        backgroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.goDormant()
            }
        }
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            guard raw == AVAudioSession.InterruptionType.began.rawValue else { return }
            Task { @MainActor in
                self?.goDormant()
            }
        }
    }

    deinit {
        if let backgroundObserver {
            NotificationCenter.default.removeObserver(backgroundObserver)
        }
        if let interruptionObserver {
            NotificationCenter.default.removeObserver(interruptionObserver)
        }
    }

    /// First open of Voice. Downloads the SpeechTranscriber asset when it is missing.
    /// Does not open the mic.
    func prepare() {
        Task { await ensurePrepared() }
    }

    /// Orb tap. Starts the mic, or goes dormant if it is already up.
    func orbTapped() {
        if isListening || wantsMic {
            goDormant()
        } else {
            startListening()
        }
    }

    func startListening() {
        guard !otherDeviceIsLive else {
            statusNote = "Voice is still on your other device."
            return
        }
        guard !isListening else { return }
        wantsMic = true
        openTask?.cancel()
        openTask = Task { await openMic() }
    }

    /// Orb, leaving the Voice tab, leaving the app, or the audio session getting taken.
    /// Stops the mic. A long silence must not call this.
    func goDormant() {
        let was = isListening || wantsMic
        openTask?.cancel()
        closeMic()
        speaker.stopPlayback()
        if was {
            YLHaptics.medium()
        }
    }

    /// The session listens on one device. The other one keeps the mic closed.
    func setOtherDeviceLive(_ live: Bool) {
        otherDeviceIsLive = live
        if live {
            openTask?.cancel()
            closeMic()
            speaker.stopPlayback()
            statusNote = "Voice is still on your other device."
        } else if statusNote == "Voice is still on your other device." {
            statusNote = ""
        }
    }

    /// Parakeet's line, when it differs. Does not cover the sentence being spoken.
    func replaceUtteranceText(id: String, with text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard let index = utterances.firstIndex(where: { $0.id == id }) else { return }
        guard utterances[index].text != trimmed else { return }
        utterances[index].text = trimmed
        if !isSpeaking && !isHearing {
            captionFinal = trimmed
            captionVolatile = ""
        }
    }

    func consumeUtterance(id: String) -> VoiceUtterance? {
        guard let index = utterances.firstIndex(where: { $0.id == id }) else { return nil }
        return utterances.remove(at: index)
    }

    /// Answer sentence. The system voice starts now. Kokoro replaces it only if the word has not started.
    func speakAnswer(id: String, text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if !isHearing {
            captionFinal = trimmed
            captionVolatile = ""
            spokenLine = trimmed
        }
        speaker.speakLine(id: id, text: trimmed, role: .answer)
    }

    func playReturnedAudio(
        chunkID: String,
        lineID: String,
        pcmLE16: Data,
        sampleRate: Double,
        role: VoicePlaybackRole,
        line: String
    ) {
        if role == .answer && !line.isEmpty && !isHearing {
            captionFinal = line
            captionVolatile = ""
            spokenLine = line
        }
        speaker.playReturnedAudio(
            chunkID: chunkID,
            lineID: lineID,
            pcmLE16: pcmLE16,
            sampleRate: sampleRate,
            role: role,
            line: line
        )
    }

    /// Summary landed. Soft haptic only while this device is in the foreground.
    func noteSummarySaved() {
        guard UIApplication.shared.applicationState == .active else { return }
        YLHaptics.voiceSaved()
    }

    func resetPlayedChunks() {
        speaker.resetPlayedChunks()
    }

    // MARK: Open and close

    private func ensurePrepared() async {
        if readiness == .ready { return }
        if let prepareTask {
            await prepareTask.value
            if readiness == .ready { return }
        }
        let task = Task { @MainActor in
            await self.prepareBody()
        }
        prepareTask = task
        await task.value
        prepareTask = nil
    }

    private func prepareBody() async {
        if readiness == .ready { return }
        speaker.warmVoice()
        var analyzer = false
        if #available(iOS 26.0, *) {
            analyzer = await prepareAnalyzerAssets()
        }
        analyzerReady = analyzer
        if analyzerReady || legacyCanRun() {
            readiness = .ready
        } else {
            readiness = .unavailable("On-device speech isn't available on this \(Self.deviceWord), so the mic stays off.")
        }
    }

    private func openMic() async {
        await ensurePrepared()
        guard wantsMic, !Task.isCancelled else { return }
        guard !otherDeviceIsLive else {
            wantsMic = false
            statusNote = "Voice is still on your other device."
            return
        }
        guard await requestSpeech() else {
            wantsMic = false
            readiness = .unavailable("Speech recognition is turned off for Yan Levin, so the mic stays off.")
            return
        }
        guard wantsMic, !Task.isCancelled else { return }
        let micOK = await AVAudioApplication.requestRecordPermission()
        guard wantsMic, !Task.isCancelled else { return }
        guard micOK else {
            wantsMic = false
            readiness = .unavailable("The microphone is turned off for Yan Levin, so the mic stays off.")
            return
        }
        guard analyzerReady || legacyCanRun() else {
            wantsMic = false
            readiness = .unavailable("On-device speech isn't available on this \(Self.deviceWord), so the mic stays off.")
            return
        }

        do {
            let input = try speaker.activateMic()
            var analyzerFormat: AVAudioFormat?
            var analyzerYield: (@Sendable (AVAudioPCMBuffer) -> Void)?
            if analyzerReady {
                if #available(iOS 26.0, *) {
                    if let started = try? await startAnalyzer() {
                        analyzerFormat = started.format
                        analyzerYield = started.yield
                        useSegments = true
                    }
                }
            }
            guard wantsMic, !Task.isCancelled else {
                closeMic()
                return
            }
            if analyzerYield == nil {
                useSegments = false
                guard legacyCanRun() else {
                    closeMic()
                    readiness = .unavailable("On-device speech isn't available on this \(Self.deviceWord), so the mic stays off.")
                    return
                }
                try openLegacyRequest()
            }
            guard wantsMic, !Task.isCancelled else {
                closeMic()
                return
            }
            let clip = Self.clipFormat()
            let box = captureBox
            let legacy = analyzerYield == nil ? legacyBox : nil
            feed.configure(
                input: input,
                clip: clip,
                onPCM: { rms, pcm in box.ingest(rms: rms, pcm: pcm) },
                legacy: legacy,
                analyzerFormat: analyzerFormat,
                analyzerYield: analyzerYield
            )
            speaker.installTap { [feed] buffer in
                feed.handle(buffer)
            }
            isListening = true
            statusNote = ""
            YLHaptics.tap()
        } catch {
            closeMic()
            readiness = .unavailable("On-device speech isn't available on this \(Self.deviceWord), so the mic stays off.")
        }
    }

    private func closeMic() {
        wantsMic = false
        isListening = false
        isHearing = false
        gate.reset()
        utterancePCM.removeAll(keepingCapacity: false)
        speechSamples = 0
        feed.stop()
        legacyBox.set(nil)
        legacyTask?.cancel()
        legacyTask = nil
        stopAnalyzer()
        speaker.removeTap()
        speaker.stopEngine()
    }

    private func requestSpeech() async -> Bool {
        let status = SFSpeechRecognizer.authorizationStatus()
        if status == .authorized { return true }
        if status == .denied || status == .restricted { return false }
        return await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { newStatus in
                continuation.resume(returning: newStatus == .authorized)
            }
        }
    }

    private func legacyCanRun() -> Bool {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")) else { return false }
        return recognizer.isAvailable && recognizer.supportsOnDeviceRecognition
    }

    private func openLegacyRequest() throws {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
              recognizer.isAvailable,
              recognizer.supportsOnDeviceRecognition else {
            throw VoiceListenError.unavailable
        }
        self.recognizer = recognizer
        legacyTask?.cancel()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true
        request.addsPunctuation = true
        legacyBox.set(request)
        legacyTask = recognizer.recognitionTask(with: request) { [weak self] result, _ in
            guard let result else { return }
            let text = result.bestTranscription.formattedString
            let isFinal = result.isFinal
            Task { @MainActor in
                self?.applyHypothesis(text: text, isFinal: isFinal, segments: false)
            }
        }
    }

    private func stopAnalyzer() {
        analyzerResultTask?.cancel()
        analyzerResultTask = nil
        if #available(iOS 26.0, *) {
            finishAnalyzerHold()
        }
    }

    // MARK: Samples and commit

    fileprivate func ingest(rms: Float, pcm: Data) {
        guard isListening, !pcm.isEmpty else { return }
        let now = Date()
        let voiced = rms >= (gate.speaking ? Self.speechOff : Self.speechOn)
        if voiced {
            let fresh = !gate.speaking && utterancePCM.isEmpty
            if !gate.speaking {
                gate.beginSpeech()
                dropUntilSpeech = false
            }
            if fresh {
                finalizedText = ""
                volatileText = ""
                captionFinal = ""
                captionVolatile = ""
                bargeFired = false
                currentInterrupts = false
            }
            speechSamples += pcm.count / MemoryLayout<Int16>.size
            maybeBargeIn()
        } else if gate.speaking {
            gate.endSpeech(now: now)
        }
        // Quiet frames after speech stay in the clip. They do not end the session.
        if gate.collecting {
            utterancePCM.append(pcm)
        }
        if isHearing != gate.speaking {
            isHearing = gate.speaking
        }
        if gate.shouldCommit(now: now) {
            commit()
        }
    }

    private func maybeBargeIn() {
        guard !bargeFired else { return }
        guard Double(speechSamples) / VoicePhrase.sampleRate >= 0.12 else { return }
        guard speaker.isAudible || liveTurnRunning else { return }
        bargeFired = true
        currentInterrupts = true
        speaker.stopPlayback()
        YLHaptics.interrupt()
    }

    private func applyHypothesis(text: String, isFinal: Bool, segments: Bool) {
        guard !dropUntilSpeech else { return }
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if ignoreNextIdenticalFinal && isFinal && VoicePhrase.normalize(cleaned) == VoicePhrase.normalize(lastCommitted) {
            ignoreNextIdenticalFinal = false
            return
        }
        if ignoreNextIdenticalFinal && VoicePhrase.normalize(cleaned) != VoicePhrase.normalize(lastCommitted) {
            ignoreNextIdenticalFinal = false
        }
        if segments {
            if isFinal {
                finalizedText = join(finalizedText, cleaned)
                volatileText = ""
            } else {
                volatileText = cleaned
            }
        } else if isFinal {
            finalizedText = cleaned
            volatileText = ""
        } else {
            finalizedText = ""
            volatileText = cleaned
        }
        captionFinal = finalizedText
        captionVolatile = volatileText
        gate.noteResult(now: Date(), text: joinedCaption(), revising: !isFinal)
        if gate.shouldCommit(now: Date()) {
            commit()
        }
    }

    private func commit() {
        let text = joinedCaption()
        let seconds = Double(speechSamples) / VoicePhrase.sampleRate
        let pcm = utterancePCM
        let interrupts = currentInterrupts
        utterancePCM.removeAll(keepingCapacity: true)
        speechSamples = 0
        finalizedText = ""
        volatileText = ""
        bargeFired = false
        currentInterrupts = false
        gate.reset()
        dropUntilSpeech = true
        lastCommitted = text
        ignoreNextIdenticalFinal = true
        if !useSegments {
            try? openLegacyRequest()
        }
        guard !VoicePhrase.shouldDrop(text: text, speechSeconds: seconds) else {
            captionFinal = ""
            captionVolatile = ""
            return
        }
        let id = UUID().uuidString
        let line = VoicePhrase.firstSound(for: text)
        utterances.append(
            VoiceUtterance(
                id: id,
                text: text,
                pcm16kMono: pcm,
                social: VoicePhrase.isSocial(text),
                interruptsLiveTurn: interrupts
            )
        )
        captionFinal = line
        captionVolatile = ""
        spokenLine = line
        // On the phone, before any upload, Parakeet, or Grok.
        speaker.speakFirstSound(id: id, text: line)
    }

    private func lineDidStart(_ line: String) {
        guard !gate.speaking else { return }
        guard !line.isEmpty else { return }
        spokenLine = line
        captionFinal = line
        captionVolatile = ""
    }

    private func joinedCaption() -> String {
        join(finalizedText, volatileText)
    }

    private func join(_ left: String, _ right: String) -> String {
        let a = left.trimmingCharacters(in: .whitespacesAndNewlines)
        let b = right.trimmingCharacters(in: .whitespacesAndNewlines)
        if a.isEmpty { return b }
        if b.isEmpty { return a }
        return a + " " + b
    }

    private static var deviceWord: String {
        UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
    }

    private static func clipFormat() -> AVAudioFormat {
        if let format = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: VoicePhrase.sampleRate,
            channels: 1,
            interleaved: true
        ) {
            return format
        }
        return AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: VoicePhrase.sampleRate,
            channels: 1,
            interleaved: false
        )!
    }
}

private enum VoiceListenError: Error {
    case unavailable
}

// MARK: - iOS 26 SpeechAnalyzer

@available(iOS 26.0, *)
private extension VoiceCapture {
    func prepareAnalyzerAssets() async -> Bool {
        guard SpeechTranscriber.isAvailable else { return false }
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US")) else {
            return false
        }
        do {
            _ = try await AssetInventory.reserve(locale: locale)
        } catch {
            // The locale may already be reserved. The install request is the real check.
        }
        let transcriber = makeTranscriber(locale)
        do {
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                readiness = .installing
                try await request.downloadAndInstall()
            }
            return true
        } catch {
            return false
        }
    }

    func startAnalyzer() async throws -> (format: AVAudioFormat, yield: @Sendable (AVAudioPCMBuffer) -> Void) {
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US")) else {
            throw VoiceListenError.unavailable
        }
        let transcriber = makeTranscriber(locale)
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw VoiceListenError.unavailable
        }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        try await analyzer.start(inputSequence: stream)
        let box = AnalyzerYieldBox(continuation)
        let hold = VoiceAnalyzerHold(analyzer: analyzer, box: box)
        analyzerHold = hold
        analyzerResultTask = Task { @MainActor [weak self] in
            do {
                for try await result in transcriber.results {
                    guard !Task.isCancelled else { return }
                    self?.applyAnalyzer(result)
                }
            } catch {
                // The mic closed, or the stream finished.
            }
        }
        return (format, { buffer in box.yield(buffer) })
    }

    func finishAnalyzerHold() {
        (analyzerHold as? VoiceAnalyzerHold)?.finish()
        analyzerHold = nil
    }

    func applyAnalyzer(_ result: SpeechTranscriber.Result) {
        applyHypothesis(text: String(result.text.characters), isFinal: result.isFinal, segments: true)
    }

    func makeTranscriber(_ locale: Locale) -> SpeechTranscriber {
        SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults],
            attributeOptions: [.audioTimeRange]
        )
    }
}

@available(iOS 26.0, *)
private final class VoiceAnalyzerHold {
    let analyzer: SpeechAnalyzer
    let box: AnalyzerYieldBox

    init(analyzer: SpeechAnalyzer, box: AnalyzerYieldBox) {
        self.analyzer = analyzer
        self.box = box
    }

    func finish() {
        box.finish()
    }
}

@available(iOS 26.0, *)
private final class AnalyzerYieldBox: @unchecked Sendable {
    private let continuation: AsyncStream<AnalyzerInput>.Continuation

    init(_ continuation: AsyncStream<AnalyzerInput>.Continuation) {
        self.continuation = continuation
    }

    func yield(_ buffer: AVAudioPCMBuffer) {
        continuation.yield(AnalyzerInput(buffer: buffer))
    }

    func finish() {
        continuation.finish()
    }
}

// MARK: - Audio thread

private final class CaptureBox: @unchecked Sendable {
    weak var capture: VoiceCapture?

    func ingest(rms: Float, pcm: Data) {
        let capture = capture
        Task { @MainActor in
            capture?.ingest(rms: rms, pcm: pcm)
        }
    }
}

private final class LegacyBox: @unchecked Sendable {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?

    func set(_ request: SFSpeechAudioBufferRecognitionRequest?) {
        lock.lock()
        self.request = request
        lock.unlock()
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        let request = self.request
        lock.unlock()
        request?.append(buffer)
    }
}

private final class VoiceFeed: @unchecked Sendable {
    private let lock = NSLock()
    private var onPCM: (@Sendable (Float, Data) -> Void)?
    private var legacy: LegacyBox?
    private var clipConverter: AVAudioConverter?
    private var clipFormat: AVAudioFormat?
    private var analyzerConverter: AVAudioConverter?
    private var analyzerFormat: AVAudioFormat?
    private var analyzerYield: (@Sendable (AVAudioPCMBuffer) -> Void)?

    func configure(
        input: AVAudioFormat,
        clip: AVAudioFormat,
        onPCM: @escaping @Sendable (Float, Data) -> Void,
        legacy: LegacyBox?,
        analyzerFormat: AVAudioFormat?,
        analyzerYield: (@Sendable (AVAudioPCMBuffer) -> Void)?
    ) {
        lock.lock()
        self.onPCM = onPCM
        self.legacy = legacy
        self.clipFormat = clip
        self.clipConverter = AVAudioConverter(from: input, to: clip)
        self.analyzerFormat = analyzerFormat
        if let analyzerFormat {
            self.analyzerConverter = AVAudioConverter(from: input, to: analyzerFormat)
        } else {
            self.analyzerConverter = nil
        }
        self.analyzerYield = analyzerYield
        lock.unlock()
    }

    func handle(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        let onPCM = self.onPCM
        let legacy = self.legacy
        let clipConverter = self.clipConverter
        let clipFormat = self.clipFormat
        let analyzerConverter = self.analyzerConverter
        let analyzerFormat = self.analyzerFormat
        let analyzerYield = self.analyzerYield
        lock.unlock()

        legacy?.append(buffer)
        if let analyzerConverter, let analyzerFormat,
           let converted = VoicePCM.convert(buffer, using: analyzerConverter, to: analyzerFormat) {
            analyzerYield?(converted)
        }
        guard let clipConverter, let clipFormat,
              let clip = VoicePCM.convert(buffer, using: clipConverter, to: clipFormat) else { return }
        onPCM?(VoicePCM.rms(clip), VoicePCM.pcm16(clip))
    }

    func stop() {
        lock.lock()
        onPCM = nil
        analyzerYield = nil
        legacy = nil
        lock.unlock()
    }
}
