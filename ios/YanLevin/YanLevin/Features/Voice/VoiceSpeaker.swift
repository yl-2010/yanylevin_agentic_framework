import AVFoundation
import Foundation

/// Which spoken line a buffer belongs to.
/// The holding line is the first sound. The answer is the later Grok sentence.
enum VoicePlaybackRole: Equatable {
    case firstSound
    case answer
}

/// Plays Kokoro chunks on an `AVAudioEngine`, and the system voice when those
/// chunks are late or missing. The first buffer starts immediately. Nothing here
/// waits for the rest of the reply, or for Grok.
@MainActor
final class VoiceSpeaker: ObservableObject {
    @Published private(set) var spokenLine = ""
    @Published private(set) var isSpeaking = false

    /// Fires when a line's first audible buffer is handed to the player.
    var onLineStarted: ((String, VoicePlaybackRole) -> Void)?
    var onSpeakingChange: ((Bool) -> Void)?

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let synth = AVSpeechSynthesizer()
    private let playFormat: AVAudioFormat
    private let tapBox = TapBox()

    private var playerConnected = false
    private var voiceProcessingSet = false
    private var tapInstalled = false
    private var micUp = false
    private var playingBuffer = false
    private var playGeneration = 0
    private var issuedSynthToken = 0
    private var queued: [Queued] = []
    private var openLines: [OpenLine] = []
    private var playedChunks = Set<String>()
    /// Set once the holding line's first word has started, so a late Kokoro chunk cannot talk over it.
    private var firstSoundLocked: Source?
    private var converters: [Double: AVAudioConverter] = [:]
    private var premiumVoice: AVSpeechSynthesisVoice?
    private var didWarmVoice = false

    private struct OpenLine {
        var id: String
        var role: VoicePlaybackRole
        var line: String
        var source: Source
        var started = false
        var synthToken = 0
    }

    private enum Source {
        case pending
        case synth
        case kokoro
    }

    private struct Queued {
        var buffer: AVAudioPCMBuffer
        var role: VoicePlaybackRole
        var lineID: String
        var line: String
        var firesStart: Bool
    }

    init() {
        playFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 24_000,
            channels: 1,
            interleaved: false
        )!
    }

    /// True when audio is playing, queued, or the system voice is about to produce a buffer.
    var isAudible: Bool {
        isSpeaking || playingBuffer || !queued.isEmpty || openLines.contains { $0.source == .pending }
    }

    /// Premium en-US if this phone has it. Otherwise the utterance keeps the default system voice.
    func warmVoice() {
        guard !didWarmVoice else { return }
        didWarmVoice = true
        premiumVoice = AVSpeechSynthesisVoice.speechVoices().first {
            $0.language == "en-US" && $0.quality == .premium
        }
    }

    /// Holding line. Returns as soon as synthesis is scheduled. Kokoro can still
    /// take the line if a chunk arrives before the first word is audible.
    func speakFirstSound(id: String, text: String) {
        firstSoundLocked = nil
        speakLine(id: id, text: text, role: .firstSound)
    }

    /// One answer sentence. Starts the system voice now. A Kokoro chunk with the
    /// same line id replaces it only if the word has not started.
    func speakLine(id: String, text: String, role: VoicePlaybackRole) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if openLines.contains(where: { $0.id == id && $0.role == role }) { return }
        warmVoice()
        issuedSynthToken += 1
        let gen = issuedSynthToken
        openLines.append(OpenLine(id: id, role: role, line: trimmed, source: .pending, synthToken: gen))
        let utterance = AVSpeechUtterance(string: trimmed)
        if let premiumVoice {
            utterance.voice = premiumVoice
        }
        synth.write(utterance) { [weak self] buffer in
            guard let pcm = buffer as? AVAudioPCMBuffer else { return }
            if pcm.frameLength == 0 {
                Task { @MainActor in
                    self?.synthEnded(id: id, role: role, gen: gen)
                }
                return
            }
            guard let copy = VoicePCM.copy(pcm) else { return }
            Task { @MainActor in
                self?.takeSynth(copy, id: id, role: role, text: trimmed, gen: gen)
            }
        }
    }

    /// Little-endian Int16 mono. Kokoro is 24 kHz. `chunkID` is dropped if it
    /// already played. `lineID` ties the chunk to a spoken sentence so a late
    /// prettier take cannot talk over a word that already started.
    func playReturnedAudio(
        chunkID: String,
        lineID: String,
        pcmLE16: Data,
        sampleRate: Double,
        role: VoicePlaybackRole,
        line: String
    ) {
        guard !pcmLE16.isEmpty else { return }
        guard playedChunks.insert(chunkID).inserted else { return }
        if role == .firstSound, firstSoundLocked == .synth {
            return
        }
        guard let buffer = floatBuffer(pcmLE16, sampleRate: sampleRate > 0 ? sampleRate : 24_000) else { return }

        if let index = lineIndex(role: role, lineID: lineID) {
            if openLines[index].source == .synth && openLines[index].started {
                return
            }
            if !openLines[index].started {
                queued.removeAll { $0.lineID == openLines[index].id && $0.role == role }
                if playingBuffer && currentPlayingID == openLines[index].id {
                    playGeneration += 1
                    player.stop()
                    playingBuffer = false
                }
                openLines[index].synthToken = 0
                if !openLines.contains(where: { $0.synthToken != 0 }) {
                    synth.stopSpeaking(at: .immediate)
                }
            }
            openLines[index].source = .kokoro
            openLines[index].id = lineID
            if !line.isEmpty { openLines[index].line = line }
            let fires = !openLines[index].started && VoicePCM.isAudible(buffer)
            enqueue(buffer, role: role, lineID: lineID, line: openLines[index].line, firesStart: fires)
            return
        }

        let text = line.trimmingCharacters(in: .whitespacesAndNewlines)
        openLines.append(OpenLine(id: lineID, role: role, line: text, source: .kokoro))
        enqueue(buffer, role: role, lineID: lineID, line: text, firesStart: VoicePCM.isAudible(buffer))
    }

    func stopPlayback() {
        playGeneration += 1
        queued.removeAll()
        openLines.removeAll()
        firstSoundLocked = .synth
        playingBuffer = false
        player.stop()
        synth.stopSpeaking(at: .immediate)
        setSpeaking(false)
    }

    func resetPlayedChunks() {
        playedChunks.removeAll()
    }

    // MARK: Mic engine

    /// Session is play-and-record, speaker unless a headset is already the route.
    /// Returns the input format. The tap is not installed yet.
    func activateMic() throws -> AVAudioFormat {
        try configureSession(mic: true)
        if engine.isRunning { engine.stop() }
        enableVoiceProcessing()
        connectPlayerIfNeeded()
        engine.prepare()
        try engine.start()
        micUp = true
        let format = engine.inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw VoiceAudioError.noInput
        }
        return format
    }

    func installTap(_ handler: @escaping @Sendable (AVAudioPCMBuffer) -> Void) {
        tapBox.set(handler)
        let input = engine.inputNode
        if tapInstalled {
            input.removeTap(onBus: 0)
            tapInstalled = false
        }
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [tapBox] buffer, _ in
            guard let copy = VoicePCM.copy(buffer) else { return }
            tapBox.call(copy)
        }
        tapInstalled = true
    }

    func removeTap() {
        tapBox.set(nil)
        guard tapInstalled else { return }
        engine.inputNode.removeTap(onBus: 0)
        tapInstalled = false
    }

    func stopEngine() {
        removeTap()
        if engine.isRunning { engine.stop() }
        micUp = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: Playback queue

    private var currentPlayingID: String?

    private func lineIndex(role: VoicePlaybackRole, lineID: String) -> Int? {
        if let exact = openLines.firstIndex(where: { $0.role == role && $0.id == lineID }) {
            return exact
        }
        // One holding line. Its Kokoro chunk can use a different id and still win
        // if the system voice has not started the word. Answer lines match ids only,
        // so the next sentence does not glue onto the previous one.
        guard role == .firstSound else { return nil }
        return openLines.firstIndex(where: { $0.role == role && !$0.started })
    }

    private func takeSynth(_ buffer: AVAudioPCMBuffer, id: String, role: VoicePlaybackRole, text: String, gen: Int) {
        guard let index = openLines.firstIndex(where: { $0.id == id && $0.role == role }) else { return }
        guard openLines[index].synthToken == gen else { return }
        guard openLines[index].source != .kokoro else { return }
        openLines[index].source = .synth
        let played = playFormatBuffer(buffer)
        let audible = VoicePCM.isAudible(played)
        let fires = audible && !openLines[index].started && !queued.contains(where: { $0.lineID == id && $0.firesStart })
        enqueue(played, role: role, lineID: id, line: text, firesStart: fires)
    }

    private func synthEnded(id: String, role: VoicePlaybackRole, gen: Int) {
        guard let index = openLines.firstIndex(where: { $0.id == id && $0.role == role }) else { return }
        guard openLines[index].synthToken == gen else { return }
        if openLines[index].source == .pending {
            openLines[index].source = .synth
        }
        pump()
    }

    private func enqueue(
        _ buffer: AVAudioPCMBuffer,
        role: VoicePlaybackRole,
        lineID: String,
        line: String,
        firesStart: Bool
    ) {
        queued.append(Queued(buffer: buffer, role: role, lineID: lineID, line: line, firesStart: firesStart))
        pump()
    }

    private func pump() {
        guard !playingBuffer else { return }
        guard !queued.isEmpty else {
            retireFinishedLines()
            if !openLines.contains(where: { $0.source == .pending }) {
                setSpeaking(false)
            }
            return
        }
        let item = queued.removeFirst()
        if item.firesStart {
            if let index = openLines.firstIndex(where: { $0.id == item.lineID && $0.role == item.role }) {
                openLines[index].started = true
                if item.role == .firstSound && firstSoundLocked == nil {
                    firstSoundLocked = openLines[index].source
                }
            }
            currentPlayingID = item.lineID
            setSpeaking(true)
            if !item.line.isEmpty {
                spokenLine = item.line
            }
            switch item.role {
            case .firstSound:
                YLHaptics.voiceFirstSound()
            case .answer:
                YLHaptics.voiceAnswer()
            }
            onLineStarted?(item.line, item.role)
        } else {
            currentPlayingID = item.lineID
        }
        playingBuffer = true
        let gen = playGeneration
        do {
            try ensureEngine()
        } catch {
            playingBuffer = false
            return
        }
        player.scheduleBuffer(item.buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in
                guard let self, gen == self.playGeneration else { return }
                self.playingBuffer = false
                self.pump()
            }
        }
        if !player.isPlaying {
            player.play()
        }
    }

    private func retireFinishedLines() {
        openLines.removeAll { line in
            guard line.started else { return false }
            if line.id == currentPlayingID && playingBuffer { return false }
            return !queued.contains { $0.lineID == line.id }
        }
    }

    private func setSpeaking(_ value: Bool) {
        guard isSpeaking != value else { return }
        isSpeaking = value
        onSpeakingChange?(value)
    }

    private func ensureEngine() throws {
        if micUp {
            if !engine.isRunning { try engine.start() }
            return
        }
        try configureSession(mic: false)
        if !engine.isRunning {
            connectPlayerIfNeeded()
            engine.prepare()
            try engine.start()
        }
    }

    private func configureSession(mic: Bool) throws {
        let session = AVAudioSession.sharedInstance()
        if mic {
            try session.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: [.defaultToSpeaker, .duckOthers, .allowBluetoothHFP]
            )
        } else {
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        }
        try session.setActive(true)
    }

    private func connectPlayerIfNeeded() {
        guard !playerConnected else { return }
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)
        playerConnected = true
    }

    private func enableVoiceProcessing() {
        guard !voiceProcessingSet else { return }
        voiceProcessingSet = true
        try? engine.inputNode.setVoiceProcessingEnabled(true)
    }

    private func floatBuffer(_ pcm: Data, sampleRate: Double) -> AVAudioPCMBuffer? {
        let frames = pcm.count / MemoryLayout<Int16>.size
        guard frames > 0 else { return nil }
        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: sampleRate,
            channels: 1,
            interleaved: false
        ), let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
        let dst = buffer.floatChannelData else { return nil }
        buffer.frameLength = AVAudioFrameCount(frames)
        pcm.withUnsafeBytes { raw in
            let src = raw.bindMemory(to: Int16.self)
            for i in 0..<frames {
                dst[0][i] = Float(src[i]) / 32768
            }
        }
        return playFormatBuffer(buffer)
    }

    private func playFormatBuffer(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer {
        if buffer.format.sampleRate == playFormat.sampleRate,
           buffer.format.channelCount == playFormat.channelCount,
           buffer.format.commonFormat == playFormat.commonFormat {
            return buffer
        }
        let key = buffer.format.sampleRate
        let converter: AVAudioConverter
        if let cached = converters[key] {
            converter = cached
        } else if let made = AVAudioConverter(from: buffer.format, to: playFormat) {
            converters[key] = made
            converter = made
        } else {
            return buffer
        }
        return VoicePCM.convert(buffer, using: converter, to: playFormat) ?? buffer
    }
}

private enum VoiceAudioError: Error {
    case noInput
}

enum VoicePCM {
    static func copy(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        let frames = buffer.frameLength
        guard frames > 0, let out = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: frames) else {
            return nil
        }
        out.frameLength = frames
        let channels = Int(buffer.format.channelCount)
        let count = Int(frames)
        if let src = buffer.floatChannelData, let dst = out.floatChannelData {
            for channel in 0..<channels {
                dst[channel].update(from: src[channel], count: count)
            }
            return out
        }
        if let src = buffer.int16ChannelData, let dst = out.int16ChannelData {
            let stride = max(Int(buffer.stride), 1)
            for channel in 0..<channels {
                dst[channel].update(from: src[channel], count: count * stride)
            }
            return out
        }
        return nil
    }

    static func convert(
        _ input: AVAudioPCMBuffer,
        using converter: AVAudioConverter,
        to format: AVAudioFormat
    ) -> AVAudioPCMBuffer? {
        let ratio = format.sampleRate / max(input.format.sampleRate, 1)
        let capacity = AVAudioFrameCount((Double(input.frameLength) * ratio).rounded(.up)) + 32
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: max(capacity, 1)) else {
            return nil
        }
        converter.reset()
        var error: NSError?
        var fed = false
        converter.convert(to: output, error: &error) { _, status in
            if fed {
                status.pointee = .noDataNow
                return nil
            }
            fed = true
            status.pointee = .haveData
            return input
        }
        if error != nil || output.frameLength == 0 { return nil }
        return output
    }

    static func rms(_ buffer: AVAudioPCMBuffer) -> Float {
        let frames = Int(buffer.frameLength)
        guard frames > 0 else { return 0 }
        var sum: Float = 0
        if let samples = buffer.floatChannelData {
            for i in 0..<frames {
                let sample = samples[0][i]
                sum += sample * sample
            }
            return (sum / Float(frames)).squareRoot()
        }
        if let samples = buffer.int16ChannelData {
            for i in 0..<frames {
                let sample = Float(samples[0][i]) / 32768
                sum += sample * sample
            }
            return (sum / Float(frames)).squareRoot()
        }
        return 1
    }

    static func isAudible(_ buffer: AVAudioPCMBuffer) -> Bool {
        let level = rms(buffer)
        if level == 1 && buffer.floatChannelData == nil && buffer.int16ChannelData == nil {
            return true
        }
        return level >= 0.015
    }

    /// Mono Int16 little-endian. Float input is scaled. Int16 input is copied.
    static func pcm16(_ buffer: AVAudioPCMBuffer) -> Data {
        let frames = Int(buffer.frameLength)
        guard frames > 0 else { return Data() }
        if let samples = buffer.int16ChannelData {
            return Data(bytes: samples[0], count: frames * MemoryLayout<Int16>.size)
        }
        guard let samples = buffer.floatChannelData else { return Data() }
        var data = Data(count: frames * MemoryLayout<Int16>.size)
        data.withUnsafeMutableBytes { raw in
            let dst = raw.bindMemory(to: Int16.self)
            for i in 0..<frames {
                let sample = max(-1 as Float, min(1, samples[0][i]))
                dst[i] = Int16(sample * 32767)
            }
        }
        return data
    }
}

private final class TapBox: @unchecked Sendable {
    private let lock = NSLock()
    private var handler: (@Sendable (AVAudioPCMBuffer) -> Void)?

    func set(_ handler: (@Sendable (AVAudioPCMBuffer) -> Void)?) {
        lock.lock()
        self.handler = handler
        lock.unlock()
    }

    func call(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        let handler = self.handler
        lock.unlock()
        handler?(buffer)
    }
}
