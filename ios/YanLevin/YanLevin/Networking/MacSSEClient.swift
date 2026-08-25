import Foundation

/// Lightweight SSE client for Mac `api.yanylevin.com` live file events.
///
/// Stream I/O runs off the main actor so a long-lived connection cannot stall UI
/// or block concurrent `api/*/data` fetches. Request timeout between packets
/// forces reconnect if the tunnel holds a zombie stream (server pings every 25s).
final class MacSSEClient: @unchecked Sendable {
    private let lock = NSLock()
    private var task: Task<Void, Never>?
    private var retry = 0

    @MainActor
    func start(path: String, bearer: String, onChange: @escaping @MainActor () -> Void) {
        stop()
        let pathCopy = path
        let token = bearer
        let stream = Task.detached { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do {
                    try await self.streamOnce(path: pathCopy, bearer: token) {
                        await onChange()
                    }
                    self.setRetry(0)
                } catch is CancellationError {
                    return
                } catch {
                    self.setRetry(min(self.getRetry() + 1, 6))
                }
                let delay = UInt64(1_500_000_000) * UInt64(max(self.getRetry(), 1))
                try? await Task.sleep(nanoseconds: delay)
            }
        }
        lock.lock()
        task = stream
        lock.unlock()
    }

    @MainActor
    func stop() {
        lock.lock()
        let running = task
        task = nil
        retry = 0
        lock.unlock()
        running?.cancel()
    }

    private func getRetry() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return retry
    }

    private func setRetry(_ value: Int) {
        lock.lock()
        retry = value
        lock.unlock()
    }

    private func streamOnce(
        path: String,
        bearer: String,
        onChange: @escaping @Sendable () async -> Void
    ) async throws {
        guard let url = await MainActor.run(body: { APIClient.makeURL(path: path) }) else {
            throw APIError.offline("Bad URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        req.cachePolicy = .reloadIgnoringLocalCacheData
        // Server heartbeats every 25s; silence longer than this → reconnect.
        req.timeoutInterval = 60

        let (bytes, response) = try await URLSession.shared.bytes(for: req)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError.offline("SSE failed")
        }

        var eventName = "message"
        var dataLines: [String] = []

        for try await line in bytes.lines {
            if Task.isCancelled { throw CancellationError() }
            if line.isEmpty {
                let name = eventName
                eventName = "message"
                dataLines = []
                if name == "change" {
                    await onChange()
                }
                continue
            }
            if line.hasPrefix(":") { continue }
            if line.hasPrefix("event:") {
                eventName = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
            }
        }
    }
}
