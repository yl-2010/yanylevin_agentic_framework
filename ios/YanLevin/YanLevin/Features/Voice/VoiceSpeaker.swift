import AVFoundation
import Foundation

/// Which spoken line a buffer belongs to.
/// The first sound is the voice model's first sentence. Later sentences from
/// that model use company. The answer is the Personal Agent's spoken line.
enum VoicePlaybackRole: Equatable {
    case firstSound
    /// More lines while Grok is still working. Not the answer.
    case company
    case answer
}

/// Plays Mac audio on an `AVAudioEngine`. A live call never starts
/// `AVSpeechSynthesizer`. Each buffer is resampled to the session rate and
/// queued before the one ahead of it finishes, so a sentence stays one piece.
@MainActor
final class VoiceSpeaker: ObservableObject {
    @Published private(set) var spokenLine = ""
    @Published private(set) var isSpeaking = false

    /// Fires when a line's first audible buffer is handed to the player.
    var onLineStarted: ((String, VoicePlaybackRole) -> Void)?
    var onSpeakingChange: ((Bool) -> Void)?

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let sessionWork = AudioSessionWork()
    private var playFormat: AVAudioFormat
    private let tapBox = TapBox()

    private var playerConnected = false
    private var voiceProcessingSet = false
    private var tapInstalled = false
    private var micUp = false
    private var playingBuffer = false
    private var playGeneration = 0
    private var nextToken = 0
    private var queued: [Queued] = []
    private var inflight: [Queued] = []
    private var startedTokens = Set<Int>()
    private var openLines: [OpenLine] = []
    private var playedChunks = Set<String>()
    /// Stop cut the holding line. A late Mac clip for that line does not come back.
    private var holdingCut = false

    private struct OpenLine {
        var id: String
        var role: VoicePlaybackRole
        var line: String
        var started = false
    }

    private struct Queued {
        var token: Int
        var buffer: AVAudioPCMBuffer
        var role: VoicePlaybackRole
        var lineID: String
        var line: String
        var firesStart: Bool
    }

    init() {
        playFormat = Self.floatFormat(48_000)
    }

    /// True when Mac audio is playing or queued. Waiting on a clip is silence.
    var isAudible: Bool {
        isSpeaking || playingBuffer || !queued.isEmpty
    }

    /// A new holding line may play. `stopPlayback` had closed the previous one.
    func allowHoldingLine() {
        holdingCut = false
    }

    /// Little-endian Int16 mono from the Mac. Kokoro is 24 kHz, then resampled
    /// to the session rate. `chunkID` is dropped if it already played. Later
    /// chunks of the same sentence append. The system voice is not a fallback.
    func playReturnedAudio(
        chunkID: String,
        lineID: String,
        pcmLE16: Data,
        sampleRate: Double,
        role: VoicePlaybackRole,
        line: String
    ) async {
        guard !pcmLE16.isEmpty else { return }
        guard playedChunks.insert(chunkID).inserted else { return }
        if role == .firstSound, holdingCut { return }
        if !micUp {
            do {
                try await sessionWork.activate(mic: false)
            } catch {
                return
            }
        }
        do {
            try ensureEngine()
        } catch {
            return
        }
        guard let buffer = floatBuffer(pcmLE16, sampleRate: sampleRate > 0 ? sampleRate : 24_000) else { return }

        let text = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if let index = openLines.firstIndex(where: { $0.role == role && $0.id == lineID }) {
            if !text.isEmpty { openLines[index].line = text }
            let fires = !openLines[index].started && VoicePCM.isAudible(buffer) && !lineHasStart(lineID, role: role)
            enqueue(buffer, role: role, lineID: lineID, line: openLines[index].line, firesStart: fires)
            return
        }
        openLines.append(OpenLine(id: lineID, role: role, line: text))
        enqueue(buffer, role: role, lineID: lineID, line: text, firesStart: VoicePCM.isAudible(buffer))
    }

    func stopPlayback() {
        playGeneration += 1
        queued.removeAll()
        inflight.removeAll()
        startedTokens.removeAll()
        openLines.removeAll()
        holdingCut = true
        playingBuffer = false
        player.stop()
        setSpeaking(false)
    }

    func resetPlayedChunks() {
        playedChunks.removeAll()
    }

    // MARK: Mic engine

    /// Session is play-and-record, speaker unless a headset is already the route.
    /// Returns the input format. The tap is not installed yet.
    func activateMic() async throws -> AVAudioFormat {
        try await sessionWork.activate(mic: true)
        if engine.isRunning { engine.stop() }
        enableVoiceProcessing()
        adoptHardwareFormat()
        engine.prepare()
        try engine.start()
        micUp = true
        adoptHardwareFormat()
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
        sessionWork.deactivate()
    }

    // MARK: Playback queue

    private var currentPlayingID: String?

    private func lineHasStart(_ lineID: String, role: VoicePlaybackRole) -> Bool {
        queued.contains { $0.lineID == lineID && $0.role == role && $0.firesStart }
            || inflight.contains { $0.lineID == lineID && $0.role == role && $0.firesStart }
    }

    private func enqueue(
        _ buffer: AVAudioPCMBuffer,
        role: VoicePlaybackRole,
        lineID: String,
        line: String,
        firesStart: Bool
    ) {
        guard buffer.frameLength > 0 else { return }
        nextToken += 1
        queued.append(Queued(
            token: nextToken,
            buffer: buffer,
            role: role,
            lineID: lineID,
            line: line,
            firesStart: firesStart
        ))
        pump()
    }

    private func pump() {
        guard !queued.isEmpty else {
            if inflight.isEmpty {
                playingBuffer = false
                retireFinishedLines()
                setSpeaking(false)
            }
            return
        }
        do {
            try ensureEngine()
        } catch {
            return
        }
        let gen = playGeneration
        while !queued.isEmpty {
            let item = queued.removeFirst()
            let startsNow = inflight.isEmpty
            inflight.append(item)
            player.scheduleBuffer(item.buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                Task { @MainActor in
                    guard let self, gen == self.playGeneration else { return }
                    self.finishScheduled(item.token)
                }
            }
            if startsNow {
                beginIfNeeded(item)
            }
        }
        playingBuffer = !inflight.isEmpty
        if playingBuffer && !player.isPlaying {
            player.play()
        }
    }

    private func finishScheduled(_ token: Int) {
        guard let index = inflight.firstIndex(where: { $0.token == token }) else { return }
        inflight.remove(at: index)
        if let head = inflight.first {
            beginIfNeeded(head)
            return
        }
        playingBuffer = false
        retireFinishedLines()
        pump()
    }

    private func beginIfNeeded(_ item: Queued) {
        guard startedTokens.insert(item.token).inserted else { return }
        currentPlayingID = item.lineID
        guard item.firesStart else { return }
        if let index = openLines.firstIndex(where: { $0.id == item.lineID && $0.role == item.role }) {
            openLines[index].started = true
        }
        setSpeaking(true)
        if !item.line.isEmpty {
            spokenLine = item.line
        }
        switch item.role {
        case .firstSound:
            YLHaptics.voiceFirstSound()
        case .company:
            break
        case .answer:
            YLHaptics.voiceAnswer()
        }
        onLineStarted?(item.line, item.role)
    }

    private func retireFinishedLines() {
        openLines.removeAll { line in
            guard line.started else { return false }
        if line.id == currentPlayingID && playingBuffer { return false }
        if inflight.contains(where: { $0.lineID == line.id }) { return false }
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
            adoptHardwareFormat()
            return
        }
        if !engine.isRunning {
            adoptHardwareFormat()
            engine.prepare()
            try engine.start()
        }
        adoptHardwareFormat()
    }

    private func adoptHardwareFormat() {
        let rate = hardwareRate()
        guard rate > 0 else { return }
        if playerConnected && abs(playFormat.sampleRate - rate) < 1 {
            return
        }
        if !inflight.isEmpty { return }
        let restart = engine.isRunning && !micUp && !tapInstalled
        if restart { engine.stop() }
        playFormat = Self.floatFormat(rate)
        if !playerConnected {
            engine.attach(player)
            playerConnected = true
        } else {
            engine.disconnectNodeOutput(player)
        }
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)
        if restart {
            engine.prepare()
            try? engine.start()
        }
    }

    private func hardwareRate() -> Double {
        if engine.isRunning {
            let mixer = engine.mainMixerNode.outputFormat(forBus: 0).sampleRate
            if mixer > 0 { return mixer }
            let output = engine.outputNode.outputFormat(forBus: 0).sampleRate
            if output > 0 { return output }
        }
        let session = AVAudioSession.sharedInstance().sampleRate
        if session > 0 { return session }
        return 48_000
    }

    private static func floatFormat(_ sampleRate: Double) -> AVAudioFormat {
        AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: sampleRate,
            channels: 1,
            interleaved: false
        )!
    }

    private func enableVoiceProcessing() {
        guard !voiceProcessingSet else { return }
        voiceProcessingSet = true
        try? engine.inputNode.setVoiceProcessingEnabled(true)
    }

    private func floatBuffer(_ pcm: Data, sampleRate: Double) -> AVAudioPCMBuffer? {
        let frames = pcm.count / MemoryLayout<Int16>.size
        guard frames > 0, pcm.count == frames * 2 else { return nil }
        let rate = sampleRate > 0 ? sampleRate : 24_000
        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: rate,
            channels: 1,
            interleaved: false
        ), let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
        let dst = buffer.floatChannelData else { return nil }
        buffer.frameLength = AVAudioFrameCount(frames)
        var samples = [Int16](repeating: 0, count: frames)
        pcm.withUnsafeBytes { raw in
            samples.withUnsafeMutableBytes { dest in
                dest.copyBytes(from: raw.prefix(frames * 2))
            }
        }
        for i in 0..<frames {
            dst[0][i] = Float(samples[i]) / 32768
        }
        return renderComplete(buffer)
    }

    private func renderComplete(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        if samePlayFormat(buffer.format) { return buffer }
        guard let converter = AVAudioConverter(from: buffer.format, to: playFormat) else { return nil }
        return convert(buffer, using: converter, flush: true)
    }

    private func convert(
        _ input: AVAudioPCMBuffer,
        using converter: AVAudioConverter,
        flush: Bool
    ) -> AVAudioPCMBuffer? {
        let ratio = playFormat.sampleRate / max(input.format.sampleRate, 1)
        let capacity = AVAudioFrameCount((Double(max(input.frameLength, 1)) * ratio).rounded(.up)) + 512
        guard let output = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: max(capacity, 512)) else {
            return nil
        }
        output.frameLength = output.frameCapacity
        var error: NSError?
        var fed = false
        converter.convert(to: output, error: &error) { _, status in
            if fed {
                status.pointee = flush ? .endOfStream : .noDataNow
                return nil
            }
            fed = true
            status.pointee = .haveData
            return input
        }
        if error != nil || output.frameLength == 0 { return nil }
        return output
    }

    private func samePlayFormat(_ format: AVAudioFormat) -> Bool {
        format.sampleRate == playFormat.sampleRate
            && format.channelCount == playFormat.channelCount
            && format.commonFormat == playFormat.commonFormat
            && format.isInterleaved == playFormat.isInterleaved
    }

}

enum VoiceAudioError: Error {
    case noInput
    /// A newer session change replaced this one before it ran.
    case superseded
}

/// Category and `setActive` run off the main thread. The newest request wins,
/// so a hang-up cannot deactivate a call that already replaced it.
private final class AudioSessionWork: @unchecked Sendable {
    private let queue = DispatchQueue(label: "yl.voice.audio-session")
    private let lock = NSLock()
    private var ticket = 0

    func activate(mic: Bool) async throws {
        let mine = bump()
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            queue.async {
                guard self.isCurrent(mine) else {
                    cont.resume(throwing: VoiceAudioError.superseded)
                    return
                }
                do {
                    try self.apply(mic: mic, active: true)
                    cont.resume()
                } catch {
                    cont.resume(throwing: error)
                }
            }
        }
    }

    func deactivate() {
        let mine = bump()
        queue.async {
            guard self.isCurrent(mine) else { return }
            try? self.apply(mic: false, active: false)
        }
    }

    private func bump() -> Int {
        lock.lock()
        ticket += 1
        let mine = ticket
        lock.unlock()
        return mine
    }

    private func isCurrent(_ mine: Int) -> Bool {
        lock.lock()
        let current = ticket == mine
        lock.unlock()
        return current
    }

    private func apply(mic: Bool, active: Bool) throws {
        let session = AVAudioSession.sharedInstance()
        if !active {
            try session.setActive(false, options: .notifyOthersOnDeactivation)
            return
        }
        try? session.setPreferredSampleRate(48_000)
        try? session.setPreferredIOBufferDuration(0.02)
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
