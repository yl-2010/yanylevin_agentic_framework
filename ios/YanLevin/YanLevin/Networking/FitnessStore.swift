import Foundation
import SwiftUI

@MainActor
final class FitnessStore: ObservableObject {
    @Published var tree: FitnessTreeResponse?
    @Published var isLoading = false
    @Published var errorText: String?
    @Published var agentSessionId: String?
    @Published var agentBusy = false
    @Published var agentReply: String?

    private let sse = MacSSEClient()
    private var liveToken: String?
    private var sseReloadTask: Task<Void, Never>?

    /// SSE + polling while the Fitness tab task is alive (see EducationStore).
    func runLiveSession(token: String) async {
        liveToken = token
        startLiveUpdates(token: token)
        defer { stopLiveUpdates() }
        while !Task.isCancelled {
            do {
                try await Task.sleep(nanoseconds: 20_000_000_000)
            } catch {
                break
            }
            guard !Task.isCancelled, let token = liveToken else { break }
            await load(token: token)
        }
    }

    func startLiveUpdates(token: String) {
        liveToken = token
        sse.start(path: "api/fitness/events", bearer: token) { [weak self] _ in
            self?.scheduleReloadFromSSE()
        }
    }

    func stopLiveUpdates() {
        sseReloadTask?.cancel()
        sseReloadTask = nil
        sse.stop()
        liveToken = nil
    }

    private func scheduleReloadFromSSE() {
        sseReloadTask?.cancel()
        sseReloadTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard let self, !Task.isCancelled, let token = self.liveToken else { return }
            await self.load(token: token)
        }
    }

    func load(token: String) async {
        let showLoading = tree == nil
        if showLoading { isLoading = true }
        if errorText != nil { errorText = nil }
        defer { if showLoading { isLoading = false } }
        do {
            let bust = URLQueryItem(
                name: "_",
                value: String(Int(Date().timeIntervalSince1970 * 1000))
            )
            let (data, http) = try await APIClient.shared.requestRaw(
                "api/fitness/data",
                bearer: token,
                query: [bust]
            )
            guard (200..<300).contains(http.statusCode) else {
                let msg = String(data: data, encoding: .utf8) ?? ""
                errorText = "HTTP \(http.statusCode): \(msg.prefix(120))"
                return
            }
            let res = try APIClient.decoder.decode(FitnessTreeResponse.self, from: data)
            if let err = res.error, res.machines == nil {
                errorText = err
            }
            tree = res
        } catch {
            errorText = error.localizedDescription
        }
    }

    @discardableResult
    func appendWeights(machineId: String, weights: [Double], token: String) async -> [FitnessPendingEntry] {
        do {
            let res: FitnessEntriesResponse = try await APIClient.shared.request(
                "api/fitness/entries",
                method: "POST",
                body: FitnessEntriesBody(machineId: machineId, weights: weights),
                bearer: token
            )
            if let tree = res.tree {
                self.tree = tree
            } else {
                await load(token: token)
            }
            return res.created ?? []
        } catch {
            errorText = error.localizedDescription
            return []
        }
    }

    func ensureAgent(token: String) async -> String? {
        if let agentSessionId { return agentSessionId }
        do {
            let res: FitnessAgentStartResponse = try await APIClient.shared.request(
                "api/fitness/agent/start",
                method: "POST",
                body: FitnessEmptyBody(),
                bearer: token
            )
            agentSessionId = res.sessionId
            return res.sessionId
        } catch {
            errorText = error.localizedDescription
            return nil
        }
    }

    func sendAgent(
        message: String,
        machineId: String?,
        machineName: String?,
        token: String
    ) async {
        agentBusy = true
        agentReply = nil
        defer { agentBusy = false }
        guard let sid = await ensureAgent(token: token) else { return }
        do {
            let res: FitnessAgentMessageResponse = try await APIClient.shared.request(
                "api/fitness/agent/message",
                method: "POST",
                body: FitnessAgentMessageBody(
                    sessionId: sid,
                    message: message,
                    machineId: machineId,
                    machineName: machineName
                ),
                bearer: token
            )
            agentReply = res.reply
            await load(token: token)
        } catch {
            errorText = error.localizedDescription
        }
    }
}

private struct FitnessEmptyBody: Encodable {}
