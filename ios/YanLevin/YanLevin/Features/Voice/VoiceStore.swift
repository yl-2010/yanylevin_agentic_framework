import Combine
import Foundation
import UIKit

/// Live voice call on the Mac. Uses `APIClient` and the same bearer as
/// `POST api/home/agent/message`. The phone does not classify the phrase.
/// The first sound is the voice model's first sentence, played as soon as
/// that text arrives. Parakeet and Kokoro run on the server. Composer does
/// not gate the first line.
@MainActor
final class VoiceStore {
    static let shared = VoiceStore()

    private static let livePoll: UInt64 = 300_000_000
    private static let summaryPoll: UInt64 = 2_000_000_000
    private static let heartbeatWait: UInt64 = 5_000_000_000
    private static let chaseWindow: TimeInterval = 20
    private static let audioWait: TimeInterval = 12

    private weak var surface: VoiceSession?
    private var token: String?
    private var device: VoiceDeviceKind = .current
    private var sessionId: String?
    private var holding = false
    private var holdingIntent = false
    private var claimGeneration = 0
    private var summarized = false
    private var hadUtterance = false
    private var didSaveHaptic = false
    private var answerStarted = false
    private var agentRunning = false
    /// The first model sentence of this utterance has started the speaker.
    private var openedModelLine = false
    private var serverPhase: VoiceOrbPhase = .breathing
    private var foreground = true
    /// True only after a foreground poll still showed an unsummarized call.
    /// A summary that finished while the app was away does not buzz.
    private var sawUnsummarizedWhileForeground = false
    private var chaseUntil: Date?
    private var seenUtteranceIDs = Set<String>()
    private var posted: [PostedLine] = []
    private var speakTrack: [String: SpeakTrack] = [:]
    private var audioTasks: [String: Task<Void, Never>] = [:]
    private var linkTail: Task<Void, Never>?
    private var sendTail: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var watch: AnyCancellable?

    private struct PostedLine {
        var id: String
        var apple: String
    }

    private struct SpeakTrack {
        var spoke = false
        var audioDone = false
        var seen = Date()
        var lineID: String?
        var opening = false
    }

    private struct Outbound {
        var id: String
        var text: String
        var pcm: Data
        var interrupt: Bool
    }

    var hasToken: Bool {
        guard let token else { return false }
        return !token.isEmpty
    }

    private init() {
        watch = VoiceCapture.shared.objectWillChange.sink { [weak self] _ in
            Task { @MainActor in
                self?.drainUtterances()
            }
        }
    }

    func attach(surface: VoiceSession, token: String?, device: VoiceDeviceKind) {
        self.surface = surface
        self.device = device
        let trimmed = token?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.token = (trimmed?.isEmpty == false) ? trimmed : nil
        if self.token != nil {
            drainUtterances()
        }
    }

    func setForeground(_ value: Bool) {
        foreground = value
        if value {
            kickPoll()
        } else {
            sawUnsummarizedWhileForeground = false
        }
    }

    /// Orb tap. Claims this phone or iPad, or reports that the other one still has the mic.
    func claim(surface: VoiceSession, device: VoiceDeviceKind) {
        self.surface = surface
        self.device = device
        // Clips already sitting in the capture belong to an earlier local pass.
        for item in VoiceCapture.shared.utterances {
            seenUtteranceIDs.insert(item.id)
            _ = VoiceCapture.shared.consumeUtterance(id: item.id)
        }
        claimGeneration += 1
        let generation = claimGeneration
        holdingIntent = true
        enqueueLink { [weak self] in
            await self?.performClaim(generation)
        }
    }

    /// Orb, leaving Voice, leaving the app, or the server dropping the claim.
    /// Heartbeats stop here. Two missed ones are how a powered-off phone goes dormant.
    func release() {
        claimGeneration += 1
        let wasHolding = holding
        holding = false
        holdingIntent = false
        agentRunning = false
        openedModelLine = false
        serverPhase = .breathing
        chaseUntil = nil
        stopHeartbeat()
        VoiceCapture.shared.liveTurnRunning = false
        guard wasHolding, let token, let sessionId, !sessionId.isEmpty else {
            kickPoll()
            return
        }
        let device = self.device
        let pendingSend = sendTail
        enqueueLink { [weak self] in
            await pendingSend?.value
            await self?.postDormant(token: token, sessionId: sessionId, device: device)
            self?.kickPoll()
        }
    }

    /// Testing control. Marks the live call dormant, then `voice/reset` starts a new one.
    /// A second call cancels the first. An in-flight phrase stays on the old call.
    func resetSession(surface: VoiceSession, device: VoiceDeviceKind) {
        self.surface = surface
        self.device = device
        claimGeneration += 1
        let generation = claimGeneration
        let previousId = sessionId
        holding = false
        holdingIntent = false
        agentRunning = false
        openedModelLine = false
        serverPhase = .breathing
        chaseUntil = nil
        hadUtterance = false
        posted.removeAll()
        stopHeartbeat()
        retireQueuedSpeech()
        VoiceCapture.shared.liveTurnRunning = false
        dropLocalUtterances()
        VoiceCapture.shared.goDormant()
        dropLocalUtterances()
        let token = self.token
        let pendingSend = sendTail
        sessionId = nil
        enqueueLink { [weak self] in
            await pendingSend?.value
            guard let self, generation == self.claimGeneration else { return }
            self.holdingIntent = true
            await self.performReset(
                generation,
                previousId: previousId,
                token: token,
                device: device
            )
        }
    }

    // MARK: Claim

    private func performClaim(_ generation: Int) async {
        guard generation == claimGeneration, holdingIntent else { return }
        guard let token, !token.isEmpty else {
            holdingIntent = false
            surface?.voiceLinkFailed("Sign in again.")
            return
        }
        do {
            if let existing = sessionId, !existing.isEmpty {
                let resumed = try await resumeOrClear(existing, token: token, generation: generation)
                if resumed == .adopted || resumed == .stopped { return }
            }
            guard generation == claimGeneration, holdingIntent else { return }
            let start: VoiceCallResponse = try await APIClient.shared.request(
                "api/home/agent/voice/start",
                method: "POST",
                body: VoiceSessionBody(device: device.rawValue),
                bearer: token
            )
            guard generation == claimGeneration, holdingIntent else {
                if start.claimed == true, let sid = start.sessionId, !sid.isEmpty {
                    await postDormant(token: token, sessionId: sid, device: device)
                }
                return
            }
            guard let sid = start.sessionId, !sid.isEmpty else {
                holdingIntent = false
                surface?.voiceLinkFailed("Can't reach the Mac.")
                return
            }
            sessionId = sid
            if start.claimed == true {
                adopt(sid)
                return
            }
            holding = false
            holdingIntent = false
            if let holder = otherDevice(in: start.activeDevice) {
                surface?.voiceLinkBusyElsewhere(holder)
            } else {
                surface?.voiceLinkFailed("Voice is still on your other device.")
            }
        } catch {
            guard generation == claimGeneration, holdingIntent else { return }
            holdingIntent = false
            holding = false
            surface?.voiceLinkFailed(Self.failureLine(error))
        }
    }

    private enum ResumeStep {
        case adopted
        case stopped
        case startFresh
    }

    private func resumeOrClear(_ existing: String, token: String, generation: Int) async throws -> ResumeStep {
        let resume: VoiceCallResponse
        do {
            resume = try await APIClient.shared.request(
                "api/home/agent/voice/resume",
                method: "POST",
                body: VoiceSessionBody(device: device.rawValue, sessionId: existing),
                bearer: token
            )
        } catch {
            if Self.statusCode(error) == 404 {
                sessionId = nil
                return .startFresh
            }
            throw error
        }
        guard generation == claimGeneration, holdingIntent else {
            if resume.resumed == true {
                await postDormant(token: token, sessionId: existing, device: device)
            }
            return .stopped
        }
        if resume.resumed == true {
            adopt(existing)
            return .adopted
        }
        if resume.onOtherDevice == true {
            holdingIntent = false
            if let holder = otherDevice(in: resume.activeDevice) {
                surface?.voiceLinkBusyElsewhere(holder)
            } else {
                surface?.voiceLinkFailed("Voice is still on your other device.")
            }
            return .stopped
        }
        if resume.summarizing == true {
            holdingIntent = false
            surface?.voiceLinkFailed("Saving the last call.")
            return .stopped
        }
        sessionId = nil
        summarized = false
        return .startFresh
    }

    private func adopt(_ sid: String) {
        sessionId = sid
        summarized = false
        holding = true
        holdingIntent = true
        didSaveHaptic = false
        answerStarted = false
        agentRunning = false
        openedModelLine = false
        serverPhase = .breathing
        chaseUntil = nil
        sawUnsummarizedWhileForeground = false
        speakTrack.removeAll()
        for task in audioTasks.values { task.cancel() }
        audioTasks.removeAll()
        surface?.voiceLinkClaimed()
        startHeartbeat()
        kickPoll()
    }

    private func performReset(
        _ generation: Int,
        previousId: String?,
        token: String?,
        device: VoiceDeviceKind
    ) async {
        guard generation == claimGeneration, holdingIntent else { return }
        guard let token, !token.isEmpty else {
            holdingIntent = false
            surface?.voiceLinkFailed("Sign in again.")
            return
        }
        do {
            let start: VoiceCallResponse = try await APIClient.shared.request(
                "api/home/agent/voice/reset",
                method: "POST",
                body: VoiceSessionBody(device: device.rawValue, sessionId: previousId),
                bearer: token
            )
            guard generation == claimGeneration, holdingIntent else {
                if start.claimed == true, let sid = start.sessionId, !sid.isEmpty {
                    await postDormant(token: token, sessionId: sid, device: device)
                }
                return
            }
            guard let sid = start.sessionId, !sid.isEmpty, start.claimed == true else {
                holdingIntent = false
                if let holder = otherDevice(in: start.activeDevice) {
                    surface?.voiceLinkBusyElsewhere(holder)
                } else {
                    surface?.voiceLinkFailed("Can't reach the Mac.")
                }
                return
            }
            sessionId = sid
            adopt(sid)
        } catch {
            guard generation == claimGeneration, holdingIntent else { return }
            holdingIntent = false
            holding = false
            surface?.voiceLinkFailed(Self.failureLine(error))
        }
    }

    private func dropLocalUtterances() {
        for item in VoiceCapture.shared.utterances {
            seenUtteranceIDs.insert(item.id)
            _ = VoiceCapture.shared.consumeUtterance(id: item.id)
        }
    }

    private func otherDevice(in raw: String?) -> VoiceDeviceKind? {
        guard let raw, let kind = VoiceDeviceKind(rawValue: raw), kind != device else { return nil }
        return kind
    }

    // MARK: Utterance

    private func drainUtterances() {
        guard hasToken else { return }
        guard holding || holdingIntent else { return }
        for item in VoiceCapture.shared.utterances {
            guard seenUtteranceIDs.insert(item.id).inserted else { continue }
            if item.interruptsLiveTurn {
                retireQueuedSpeech()
            }
            posted.append(PostedLine(id: item.id, apple: item.text))
            hadUtterance = true
            answerStarted = false
            openedModelLine = false
            chaseUntil = Date().addingTimeInterval(Self.chaseWindow)
            let interrupt = item.interruptsLiveTurn || agentRunning
            let job = Outbound(
                id: item.id,
                text: item.text,
                pcm: item.pcm16kMono,
                interrupt: interrupt
            )
            _ = VoiceCapture.shared.consumeUtterance(id: item.id)
            enqueueSend(job)
            kickPoll()
        }
    }

    private func retireQueuedSpeech() {
        for id in speakTrack.keys {
            speakTrack[id]?.spoke = true
            speakTrack[id]?.audioDone = true
        }
        for task in audioTasks.values { task.cancel() }
        audioTasks.removeAll()
    }

    private func enqueueSend(_ job: Outbound) {
        let previous = sendTail
        sendTail = Task { [weak self] in
            await previous?.value
            await self?.send(job)
        }
    }

    private func send(_ job: Outbound) async {
        while sessionId == nil && holdingIntent && !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        guard let sessionId, let token else { return }
        let said = job.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !said.isEmpty else { return }
        let body = VoiceUtteranceBody(
            sessionId: sessionId,
            text: said,
            clientUtteranceId: job.id,
            device: device.rawValue,
            interrupt: job.interrupt,
            audioBase64: job.pcm.base64EncodedString()
        )
        do {
            playReturnedSpeak(try await postUtterance(body, token: token))
        } catch {
            if Self.statusCode(error) == 409 {
                if holding {
                    await recoverUtterance(body, token: token, error: error)
                }
                return
            }
            guard Self.isRetryable(error) else {
                failUtterance()
                return
            }
            try? await Task.sleep(nanoseconds: 400_000_000)
            do {
                playReturnedSpeak(try await postUtterance(body, token: token))
            } catch {
                failUtterance()
            }
        }
    }

    /// The Mac did not take the turn. Stop whatever has started instead of talking over a dead send.
    private func failUtterance() {
        agentRunning = false
        VoiceCapture.shared.liveTurnRunning = false
        if !answerStarted {
            VoiceCapture.shared.speaker.stopPlayback()
        }
    }

    private func playReturnedSpeak(_ response: VoiceCallResponse) {
        playSpeak(response.speak ?? [])
    }

    private func recoverUtterance(_ body: VoiceUtteranceBody, token: String, error: Error) async {
        let message = Self.errorText(error).lowercased()
        if message.contains("already saved") {
            sessionId = nil
            summarized = true
            return
        }
        if message.contains("saving") {
            return
        }
        guard holding else { return }
        do {
            let resume: VoiceCallResponse = try await APIClient.shared.request(
                "api/home/agent/voice/resume",
                method: "POST",
                body: VoiceSessionBody(device: device.rawValue, sessionId: body.sessionId),
                bearer: token
            )
            guard holding, resume.resumed == true else {
                if resume.onOtherDevice == true, let holder = otherDevice(in: resume.activeDevice) {
                    loseHold(to: holder)
                }
                return
            }
            playReturnedSpeak(try await postUtterance(body, token: token))
        } catch {
            return
        }
    }

    private func postUtterance(_ body: VoiceUtteranceBody, token: String) async throws -> VoiceCallResponse {
        let response: VoiceCallResponse = try await APIClient.shared.request(
            "api/home/agent/voice/utterance",
            method: "POST",
            body: body,
            bearer: token
        )
        chaseUntil = Date().addingTimeInterval(Self.chaseWindow)
        kickPoll()
        return response
    }

    // MARK: State

    private func kickPoll() {
        if pollTask != nil { return }
        pollTask = Task { [weak self] in
            await self?.pollLoop()
        }
    }

    private func pollLoop() async {
        while !Task.isCancelled {
            guard let delay = pollDelay() else { break }
            await pollOnce()
            if Task.isCancelled { break }
            try? await Task.sleep(nanoseconds: delay)
        }
        pollTask = nil
        if !Task.isCancelled, pollDelay() != nil {
            kickPoll()
        }
    }

    private func pollDelay() -> UInt64? {
        guard let sessionId, !sessionId.isEmpty, hasToken, !summarized else { return nil }
        if holding && outstanding { return Self.livePoll }
        if !holding && hadUtterance && foreground { return Self.summaryPoll }
        return nil
    }

    private var outstanding: Bool {
        if agentRunning { return true }
        if serverPhase == .working || serverPhase == .searching || serverPhase == .composing {
            return true
        }
        if speakTrack.values.contains(where: { !$0.audioDone }) { return true }
        if let chaseUntil, Date() < chaseUntil { return true }
        return false
    }

    private func pollOnce() async {
        guard let token, let sessionId else { return }
        let generation = claimGeneration
        let polled = sessionId
        do {
            let state: VoiceStateResponse = try await APIClient.shared.request(
                "api/home/agent/voice/state",
                bearer: token,
                query: [URLQueryItem(name: "sessionId", value: polled)]
            )
            guard generation == claimGeneration, self.sessionId == polled else { return }
            apply(state)
        } catch {
            guard generation == claimGeneration else { return }
            if Self.statusCode(error) == 404 {
                self.sessionId = nil
                holding = false
                holdingIntent = false
                stopHeartbeat()
            }
        }
    }

    private func apply(_ state: VoiceStateResponse) {
        if state.summarized == true {
            summarized = true
        } else if foreground {
            sawUnsummarizedWhileForeground = true
        }
        let wasHolding = holding
        noteSummary(state)
        if wasHolding && !holding {
            surface?.voiceDroppedByServer()
            return
        }
        guard holding else {
            if let holder = otherDevice(in: state.activeDevice), state.dormant != true {
                surface?.voiceLinkBusyElsewhere(holder)
            } else {
                surface?.voiceOtherDeviceReleased()
            }
            for chunk in state.speak ?? [] {
                var track = speakTrack[chunk.id] ?? SpeakTrack()
                track.spoke = true
                track.audioDone = true
                speakTrack[chunk.id] = track
            }
            return
        }
        if state.dormant == true {
            voiceDroppedByServer()
            return
        }
        if let holder = otherDevice(in: state.activeDevice) {
            loseHold(to: holder)
            return
        }
        agentRunning = state.agentStatus == "running"
        serverPhase = Self.orbPhase(state.phase)
        VoiceCapture.shared.liveTurnRunning = agentRunning
        surface?.voiceServerPhase(serverPhase)
        considerCaption(state.caption)
        if agentRunning, captureCaptionEmpty, let label = Self.cleaned(state.workingLabel) {
            VoiceCapture.shared.noteServerCaption(label)
        }
        playSpeak(state.speak ?? [])
        if state.summarized == true {
            sessionId = nil
            holding = false
            stopHeartbeat()
        }
    }

    private func noteSummary(_ state: VoiceStateResponse) {
        guard state.summarySaved == true, !didSaveHaptic, hadUtterance else { return }
        didSaveHaptic = true
        summarized = true
        if foreground && sawUnsummarizedWhileForeground {
            VoiceCapture.shared.noteSummarySaved()
        }
        if state.summarized == true {
            sessionId = nil
            holding = false
            stopHeartbeat()
        }
    }

    private func considerCaption(_ raw: String?) {
        let text = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if answerStarted { return }
        let capture = VoiceCapture.shared
        if capture.isHearing || capture.isSpeaking { return }
        guard let last = posted.last else {
            capture.noteServerCaption(text)
            return
        }
        if text == last.apple { return }
        if VoicePhrase.normalize(text) == VoicePhrase.normalize(last.apple) { return }
        capture.noteServerCaption(text)
    }

    private func playSpeak(_ chunks: [VoiceSpeakChunk]) {
        guard holding else { return }
        for chunk in chunks {
            var track = speakTrack[chunk.id] ?? SpeakTrack()
            let text = (chunk.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let kind = chunk.kind ?? "answer"
            if kind == "voice" {
                if track.lineID == nil {
                    track.opening = !openedModelLine
                    openedModelLine = true
                    track.lineID = chunk.id
                }
                if !track.spoke && !text.isEmpty {
                    track.spoke = true
                    VoiceCapture.shared.speakModelLine(id: chunk.id, text: text, opening: track.opening)
                }
                let role: VoicePlaybackRole = track.opening ? .firstSound : .company
                if let audioId = chunk.audioId, !audioId.isEmpty, !track.audioDone {
                    fetchAudio(chunkID: chunk.id, audioId: audioId, lineID: chunk.id, role: role, line: text)
                } else if chunk.audioId == nil && Date().timeIntervalSince(track.seen) > Self.audioWait {
                    track.audioDone = true
                }
            } else if !text.isEmpty {
                if !track.spoke {
                    track.spoke = true
                    answerStarted = true
                    VoiceCapture.shared.speakAnswer(id: chunk.id, text: text)
                }
                if let audioId = chunk.audioId, !audioId.isEmpty, !track.audioDone {
                    fetchAudio(chunkID: chunk.id, audioId: audioId, lineID: chunk.id, role: .answer, line: text)
                } else if chunk.audioId == nil && Date().timeIntervalSince(track.seen) > Self.audioWait {
                    track.audioDone = true
                }
            } else {
                track.audioDone = true
            }
            speakTrack[chunk.id] = track
        }
    }

    private func fetchAudio(
        chunkID: String,
        audioId: String,
        lineID: String,
        role: VoicePlaybackRole,
        line: String
    ) {
        guard audioTasks[chunkID] == nil else { return }
        guard let token, let sessionId else { return }
        audioTasks[chunkID] = Task { [weak self] in
            guard let self else { return }
            defer { self.audioTasks[chunkID] = nil }
            do {
                let (data, rate) = try await self.loadAudio(sessionId: sessionId, audioId: audioId, token: token)
                guard !Task.isCancelled, self.holding, !data.isEmpty else {
                    self.finishAudio(chunkID, done: true)
                    return
                }
                VoiceCapture.shared.playReturnedAudio(
                    chunkID: chunkID,
                    lineID: lineID,
                    pcmLE16: data,
                    sampleRate: rate,
                    role: role,
                    line: line
                )
                self.finishAudio(chunkID, done: true)
            } catch {
                self.finishAudio(chunkID, done: true)
            }
        }
    }

    private func finishAudio(_ chunkID: String, done: Bool) {
        guard var track = speakTrack[chunkID] else { return }
        if done { track.audioDone = true }
        speakTrack[chunkID] = track
    }

    private func loadAudio(sessionId: String, audioId: String, token: String) async throws -> (Data, Double) {
        let (data, http) = try await APIClient.shared.requestRaw(
            "api/home/agent/voice/audio",
            bearer: token,
            query: [
                URLQueryItem(name: "sessionId", value: sessionId),
                URLQueryItem(name: "chunkId", value: audioId),
            ]
        )
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.http(http.statusCode, "")
        }
        let rate = Double(http.value(forHTTPHeaderField: "X-Sample-Rate") ?? "") ?? 24_000
        return (data, rate > 0 ? rate : 24_000)
    }

    private func loseHold(to holder: VoiceDeviceKind) {
        holding = false
        holdingIntent = false
        agentRunning = false
        claimGeneration += 1
        stopHeartbeat()
        VoiceCapture.shared.liveTurnRunning = false
        surface?.voiceLinkBusyElsewhere(holder)
        kickPoll()
    }

    private func voiceDroppedByServer() {
        holding = false
        holdingIntent = false
        agentRunning = false
        serverPhase = .breathing
        claimGeneration += 1
        stopHeartbeat()
        surface?.voiceDroppedByServer()
        kickPoll()
    }

    // MARK: Heartbeat

    private func startHeartbeat() {
        stopHeartbeat()
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: Self.heartbeatWait)
                guard let self, self.holding, !Task.isCancelled else { return }
                await self.sendHeartbeat()
            }
        }
    }

    private func stopHeartbeat() {
        heartbeatTask?.cancel()
        heartbeatTask = nil
    }

    private func sendHeartbeat() async {
        guard holding, let token, let sessionId else { return }
        let generation = claimGeneration
        let polled = sessionId
        do {
            let state: VoiceStateResponse = try await APIClient.shared.request(
                "api/home/agent/voice/heartbeat",
                method: "POST",
                body: VoiceSessionBody(device: device.rawValue, sessionId: polled),
                bearer: token
            )
            guard generation == claimGeneration, holding, self.sessionId == polled else { return }
            apply(state)
        } catch {
            guard generation == claimGeneration, holding else { return }
            if Self.statusCode(error) == 404 {
                holding = false
                self.sessionId = nil
                stopHeartbeat()
            }
        }
    }

    private func postDormant(token: String, sessionId: String, device: VoiceDeviceKind) async {
        let body = VoiceSessionBody(device: device.rawValue, sessionId: sessionId)
        for attempt in 0..<2 {
            do {
                let _: VoiceStateResponse = try await APIClient.shared.request(
                    "api/home/agent/voice/dormant",
                    method: "POST",
                    body: body,
                    bearer: token
                )
                return
            } catch {
                if attempt == 1 || Self.statusCode(error) == 404 { return }
                try? await Task.sleep(nanoseconds: 400_000_000)
            }
        }
    }

    private func enqueueLink(_ work: @escaping @MainActor () async -> Void) {
        let previous = linkTail
        linkTail = Task { @MainActor in
            await previous?.value
            await work()
        }
    }

    /// `listening` is an open mic. `breathing` means the call went dormant.
    private static func orbPhase(_ raw: String?) -> VoiceOrbPhase {
        switch raw {
        case "working": return .working
        case "searching": return .searching
        case "composing": return .composing
        case "connecting": return .connecting
        case "listening": return .listening
        case "breathing": return .breathing
        default: return .breathing
        }
    }

    private static func statusCode(_ error: Error) -> Int? {
        switch error {
        case APIError.http(let code, _): return code
        case APIError.unauthorized: return 401
        default: return nil
        }
    }

    private static func errorText(_ error: Error) -> String {
        if case APIError.http(_, let message) = error { return message }
        return error.localizedDescription
    }

    private static func isRetryable(_ error: Error) -> Bool {
        switch error {
        case APIError.offline(_):
            return true
        case APIError.http(let code, _):
            return code >= 500
        case APIError.unauthorized, APIError.decoding:
            return false
        default:
            return true
        }
    }

    private static func cleaned(_ raw: String?) -> String? {
        let text = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    private var captureCaptionEmpty: Bool {
        let capture = VoiceCapture.shared
        return !capture.isHearing && !capture.isSpeaking && capture.captionFinal.isEmpty && capture.captionVolatile.isEmpty
    }

    private static func failureLine(_ error: Error) -> String {
        if case APIError.unauthorized = error { return "Sign in again." }
        return "Can't reach the Mac."
    }
}

private struct VoiceSessionBody: Encodable {
    var device: String
    var sessionId: String?

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(device, forKey: .device)
        if let sessionId, !sessionId.isEmpty {
            try container.encode(sessionId, forKey: .sessionId)
        }
    }

    enum CodingKeys: String, CodingKey {
        case device, sessionId
    }
}

private struct VoiceUtteranceBody: Encodable {
    var sessionId: String
    var text: String
    var clientUtteranceId: String
    var device: String
    var interrupt: Bool
    var audioBase64: String
}

private struct VoiceCallResponse: Decodable {
    var ok: Bool?
    var sessionId: String?
    var activeDevice: String?
    var claimed: Bool?
    var dormant: Bool?
    var resumed: Bool?
    var summarized: Bool?
    var summarizing: Bool?
    var onOtherDevice: Bool?
    var duplicate: Bool?
    var speak: [VoiceSpeakChunk]?
}

private struct VoiceSpeakChunk: Decodable {
    var id: String
    var text: String?
    var kind: String?
    var audioId: String?
}

private struct VoiceStateResponse: Decodable {
    var ok: Bool?
    var sessionId: String?
    var phase: String?
    var caption: String?
    var agentStatus: String?
    var workingLabel: String?
    var activeDevice: String?
    var dormant: Bool?
    var summarizing: Bool?
    var summarized: Bool?
    var summarySaved: Bool?
    var speak: [VoiceSpeakChunk]?
}
