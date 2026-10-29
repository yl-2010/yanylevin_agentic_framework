import Foundation

struct ChatDraftFile: Decodable, Equatable, Identifiable {
    let id: String
    let name: String
    let mimeType: String
    let size: Int?

    enum CodingKeys: String, CodingKey {
        case id, name, mimeType, size
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? "file"
        mimeType = try c.decodeIfPresent(String.self, forKey: .mimeType) ?? "application/octet-stream"
        size = try c.decodeIfPresent(Int.self, forKey: .size)
    }
}

/// Unsent composer state synced to the Mac. New-chat drafts use a UUID id;
/// drafts for an existing chat use `s-<sessionId>`.
struct ChatDraft: Decodable, Equatable, Identifiable {
    let id: String
    var sessionId: String?
    var text: String
    var title: String?
    var files: [ChatDraftFile]
    var created: String
    var updated: String

    enum CodingKeys: String, CodingKey {
        case id, sessionId, text, title, files, created, updated
    }

    init(
        id: String,
        sessionId: String?,
        text: String,
        title: String?,
        files: [ChatDraftFile],
        created: String,
        updated: String
    ) {
        self.id = id
        self.sessionId = sessionId
        self.text = text
        self.title = title
        self.files = files
        self.created = created
        self.updated = updated
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        let sid = try c.decodeIfPresent(String.self, forKey: .sessionId)
        sessionId = (sid?.isEmpty == false) ? sid : nil
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        title = try c.decodeIfPresent(String.self, forKey: .title)
        files = (try? c.decodeIfPresent([ChatDraftFile].self, forKey: .files)) ?? []
        let stamp = ChatDraft.nowISO()
        created = try c.decodeIfPresent(String.self, forKey: .created) ?? stamp
        updated = try c.decodeIfPresent(String.self, forKey: .updated) ?? created
    }

    var hasContent: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty
    }

    var displayTitle: String {
        let t = (title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty { return t }
        if let line = Self.firstLine(text) { return line }
        return files.first?.name ?? "Draft"
    }

    static func sessionDraftId(_ sessionId: String) -> String {
        "s-\(sessionId)"
    }

    static func firstLine(_ text: String) -> String? {
        let line = text
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty }
        return line.map { String($0.prefix(80)) }
    }

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func nowISO() -> String {
        isoFormatter.string(from: Date())
    }
}

private struct ChatDraftResponse: Decodable {
    let ok: Bool?
    let draft: ChatDraft?
}

private struct ChatDraftListResponse: Decodable {
    let ok: Bool?
    let drafts: [ChatDraft]?
}

private struct ChatDraftFileResponse: Decodable {
    let ok: Bool?
    let file: ChatDraftFile?
    let draft: ChatDraft?
}

private struct ChatDraftOKResponse: Decodable {
    let ok: Bool?
}

private struct ChatDraftTextBody: Encodable {
    let text: String
    let sessionId: String?

    enum CodingKeys: String, CodingKey {
        case text, sessionId
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(text, forKey: .text)
        if let sessionId, !sessionId.isEmpty {
            try c.encode(sessionId, forKey: .sessionId)
        }
    }
}

/// Server-synced composer drafts. Only the sidebar list and explicit restores
/// read from here; the live composer text stays in `ChatView` so a refresh can
/// never rewrite what is being typed.
@MainActor
final class ChatDraftStore: ObservableObject {
    @Published private(set) var drafts: [ChatDraft] = []
    var workspace = ""
    var token: String?

    private static let debounceNanoseconds: UInt64 = 500_000_000
    /// A list fetched just before a local write lands must not undo it.
    private static let localWriteGrace: TimeInterval = 10
    private static let tombstoneLife: TimeInterval = 15

    private var debounceTasks: [String: Task<Void, Never>] = [:]
    private var dirtyText: [String: (text: String, sessionId: String?)] = [:]
    private var inFlight: Set<String> = []
    private var sending: Set<String> = []
    private var serverKnown: Set<String> = []
    private var lastLocalWrite: [String: Date] = [:]
    private var tombstones: [String: Date] = [:]
    private var uploads: [UUID: Task<ChatDraftFile?, Never>] = [:]
    private var uploadDraftIds: [UUID: String] = [:]
    private var cancelledUploads: Set<UUID> = []

    private var prefix: String {
        workspace == "jype" ? "api/jype/agent" : "api/education/agent"
    }

    func draft(id: String?) -> ChatDraft? {
        guard let id else { return nil }
        return drafts.first { $0.id == id }
    }

    func reset() {
        debounceTasks.values.forEach { $0.cancel() }
        debounceTasks = [:]
        dirtyText = [:]
        inFlight = []
        sending = []
        serverKnown = []
        lastLocalWrite = [:]
        tombstones = [:]
        uploads = [:]
        uploadDraftIds = [:]
        cancelledUploads = []
        drafts = []
    }

    /// Server list from `GET chats` / `GET drafts`. Drafts with local work in
    /// flight keep their local copy.
    func ingest(_ server: [ChatDraft]) {
        let now = Date()
        tombstones = tombstones.filter { now.timeIntervalSince($0.value) < Self.tombstoneLife }
        lastLocalWrite = lastLocalWrite.filter { now.timeIntervalSince($0.value) < Self.localWriteGrace }
        serverKnown = Set(server.map(\.id))
        var next: [String: ChatDraft] = [:]
        for d in server where tombstones[d.id] == nil {
            next[d.id] = d
        }
        for local in drafts where isHot(local.id) {
            next[local.id] = local
            if !local.hasContent { next.removeValue(forKey: local.id) }
        }
        publish(Array(next.values))
    }

    func reload(token: String) async {
        self.token = token
        do {
            let res: ChatDraftListResponse = try await APIClient.shared.request(
                "\(prefix)/drafts",
                bearer: token
            )
            if let list = res.drafts { ingest(list) }
        } catch {
            /* older server: no drafts */
        }
    }

    /// Composer edit. Updates the local copy now and PUTs after a short pause.
    func setText(_ text: String, draftId id: String, sessionId: String?) {
        // Typing into a draft whose previous content is mid-send starts clean;
        // the sent files belong to that message.
        let base = sending.contains(id) ? nil : draft(id: id)
        var d = base ?? ChatDraft(
            id: id,
            sessionId: sessionId,
            text: "",
            title: nil,
            files: [],
            created: ChatDraft.nowISO(),
            updated: ChatDraft.nowISO()
        )
        guard d.text != text || base == nil else { return }
        d.text = text
        d.updated = ChatDraft.nowISO()
        if let line = ChatDraft.firstLine(text) { d.title = line }
        lastLocalWrite[id] = Date()
        if d.hasContent {
            tombstones.removeValue(forKey: id)
            upsert(d)
        } else {
            remove(id)
            tombstones[id] = Date()
            // Never seen by the server and nothing uploading: nothing to delete.
            if !serverKnown.contains(id), !inFlight.contains(id), !hasUploads(id) {
                cancelDebounce(id)
                dirtyText.removeValue(forKey: id)
                return
            }
        }
        dirtyText[id] = (text, sessionId)
        guard !sending.contains(id) else { return }
        scheduleFlush(id)
    }

    func flushAll() async {
        let ids = Array(dirtyText.keys)
        for id in ids where !sending.contains(id) {
            cancelDebounce(id)
            await flushText(id)
        }
    }

    func flush(id: String?) async {
        guard let id, !sending.contains(id) else { return }
        cancelDebounce(id)
        await flushText(id)
    }

    /// Uploads immediately. The task resolves to the server file, or nil on
    /// failure / cancellation (the send then falls back to inline base64).
    @discardableResult
    func upload(
        _ attachment: PendingChatAttachment,
        draftId: String,
        sessionId: String?
    ) -> Task<ChatDraftFile?, Never> {
        if let existing = uploads[attachment.id] { return existing }
        guard let token, !attachment.data.isEmpty else {
            return Task { nil }
        }
        uploadDraftIds[attachment.id] = draftId
        lastLocalWrite[draftId] = Date()
        tombstones.removeValue(forKey: draftId)
        var headers = [
            "Content-Type": "application/octet-stream",
            "X-File-Name": Self.headerEncoded(attachment.name),
            "X-File-Type": attachment.mimeType,
        ]
        if let sessionId, !sessionId.isEmpty {
            headers["X-Session-Id"] = sessionId
        }
        let path = "\(prefix)/drafts/\(draftId)/files"
        let data = attachment.data
        let attachmentID = attachment.id
        let task = Task { [weak self] () -> ChatDraftFile? in
            let res: ChatDraftFileResponse
            do {
                res = try await APIClient.shared.upload(path, data: data, headers: headers, bearer: token)
            } catch {
                self?.uploadDraftIds.removeValue(forKey: attachmentID)
                return nil
            }
            guard let self else { return res.file }
            self.uploadDraftIds.removeValue(forKey: attachmentID)
            guard let file = res.file else { return nil }
            self.serverKnown.insert(draftId)
            if self.cancelledUploads.remove(attachmentID) != nil {
                self.deleteFile(file.id, draftId: draftId)
                return nil
            }
            if let d = res.draft { self.mergeServer(d) }
            return file
        }
        uploads[attachment.id] = task
        return task
    }

    /// Tile removed while its upload is still running.
    func cancelUpload(_ attachmentID: UUID) {
        guard uploadDraftIds[attachmentID] != nil else { return }
        cancelledUploads.insert(attachmentID)
    }

    /// Waits for any uploads still running and fills in their server ids.
    func resolveUploads(_ attachments: [PendingChatAttachment]) async -> [PendingChatAttachment] {
        var out = attachments
        for i in out.indices where out[i].serverFileId == nil {
            if let task = uploads[out[i].id], let file = await task.value {
                out[i].serverFileId = file.id
            }
            out[i].uploading = false
        }
        return out
    }

    func deleteFile(_ fileId: String, draftId: String) {
        if var d = draft(id: draftId) {
            d.files.removeAll { $0.id == fileId }
            d.updated = ChatDraft.nowISO()
            if d.hasContent { upsert(d) } else { remove(draftId) }
        }
        lastLocalWrite[draftId] = Date()
        guard let token else { return }
        let path = "\(prefix)/drafts/\(draftId)/files/\(fileId)"
        Task { [weak self] in
            do {
                let res: ChatDraftResponse = try await APIClient.shared.request(path, method: "DELETE", bearer: token)
                guard let self else { return }
                if let d = res.draft {
                    self.mergeServer(d)
                } else {
                    self.serverKnown.remove(draftId)
                    if self.draft(id: draftId)?.hasContent == false { self.remove(draftId) }
                }
            } catch {
                /* list refresh will catch up */
            }
        }
    }

    func deleteDraft(id: String) {
        cancelDebounce(id)
        dirtyText.removeValue(forKey: id)
        remove(id)
        tombstones[id] = Date()
        guard serverKnown.contains(id) || inFlight.contains(id), let token else { return }
        serverKnown.remove(id)
        let path = "\(prefix)/drafts/\(id)"
        Task {
            let _: ChatDraftOKResponse? = try? await APIClient.shared.request(path, method: "DELETE", bearer: token)
        }
    }

    /// True when the server may hold this draft (so `POST message` should name it).
    func serverMayHave(_ id: String) -> Bool {
        serverKnown.contains(id) || inFlight.contains(id) || hasUploads(id)
    }

    /// Composer submitted with this draft. Holds text PUTs until the send resolves.
    func beginSend(_ id: String) {
        cancelDebounce(id)
        dirtyText.removeValue(forKey: id)
        sending.insert(id)
    }

    func endSend(_ id: String, success: Bool) {
        sending.remove(id)
        if success {
            serverKnown.remove(id)
            if dirtyText[id] != nil {
                scheduleFlush(id)
            } else {
                remove(id)
                tombstones[id] = Date()
            }
            return
        }
        if dirtyText[id] == nil, let d = draft(id: id), d.hasContent {
            dirtyText[id] = (d.text, d.sessionId)
        }
        if dirtyText[id] != nil { scheduleFlush(id) }
    }

    // MARK: - Private

    private func isHot(_ id: String) -> Bool {
        if dirtyText[id] != nil || inFlight.contains(id) || sending.contains(id) || hasUploads(id) {
            return true
        }
        if let at = lastLocalWrite[id], Date().timeIntervalSince(at) < Self.localWriteGrace {
            return true
        }
        return false
    }

    private func hasUploads(_ id: String) -> Bool {
        uploadDraftIds.values.contains(id)
    }

    private func scheduleFlush(_ id: String) {
        cancelDebounce(id)
        debounceTasks[id] = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.debounceNanoseconds)
            guard !Task.isCancelled, let self else { return }
            self.debounceTasks.removeValue(forKey: id)
            await self.flushText(id)
        }
    }

    private func cancelDebounce(_ id: String) {
        debounceTasks.removeValue(forKey: id)?.cancel()
    }

    private func flushText(_ id: String) async {
        guard let token, let pending = dirtyText.removeValue(forKey: id) else { return }
        inFlight.insert(id)
        defer { inFlight.remove(id) }
        do {
            let res: ChatDraftResponse = try await APIClient.shared.request(
                "\(prefix)/drafts/\(id)",
                method: "PUT",
                body: ChatDraftTextBody(text: pending.text, sessionId: pending.sessionId),
                bearer: token
            )
            if let d = res.draft {
                serverKnown.insert(id)
                mergeServer(d)
            } else {
                serverKnown.remove(id)
                if draft(id: id)?.hasContent != true { remove(id) }
            }
        } catch {
            /* keep the local copy; the next edit retries */
        }
    }

    /// Server echo. Local text wins while the user is still typing into it.
    private func mergeServer(_ incoming: ChatDraft) {
        guard tombstones[incoming.id] == nil || incoming.hasContent else { return }
        var next = incoming
        if let local = draft(id: incoming.id), dirtyText[incoming.id] != nil || sending.contains(incoming.id) {
            next.text = local.text
            next.title = local.title ?? incoming.title
        }
        if next.hasContent {
            tombstones.removeValue(forKey: next.id)
            upsert(next)
        } else {
            remove(next.id)
        }
    }

    private func upsert(_ d: ChatDraft) {
        var list = drafts
        if let i = list.firstIndex(where: { $0.id == d.id }) {
            list[i] = d
        } else {
            list.append(d)
        }
        publish(list)
    }

    private func remove(_ id: String) {
        guard drafts.contains(where: { $0.id == id }) else { return }
        publish(drafts.filter { $0.id != id })
    }

    private func publish(_ list: [ChatDraft]) {
        let sorted = list.sorted { a, b in
            let da = ChatISODate.parse(a.updated) ?? .distantPast
            let db = ChatISODate.parse(b.updated) ?? .distantPast
            if da != db { return da > db }
            return a.id < b.id
        }
        if sorted != drafts { drafts = sorted }
    }

    private static func headerEncoded(_ name: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-_.!~*'()")
        return name.addingPercentEncoding(withAllowedCharacters: allowed) ?? "file"
    }
}
