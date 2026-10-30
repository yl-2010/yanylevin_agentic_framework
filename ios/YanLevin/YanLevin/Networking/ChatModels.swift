import Foundation

struct ChatMessageFile: Identifiable, Equatable, Codable, Hashable {
    var name: String
    var mimeType: String
    /// Bytes still on the phone for a send the server has not accepted. Not stored.
    var localData: Data?

    var id: String { name }

    enum CodingKeys: String, CodingKey {
        case name, mimeType
    }

    init(name: String, mimeType: String = "", localData: Data? = nil) {
        self.name = name
        self.mimeType = mimeType
        self.localData = localData
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        mimeType = try c.decodeIfPresent(String.self, forKey: .mimeType) ?? ""
        localData = nil
    }
}

enum ChatFileTag {
    private static let fence = try? NSRegularExpression(
        pattern: "```chat-files\\s*\\n([\\s\\S]*?)\\n```",
        options: []
    )
    private static let legacy = try? NSRegularExpression(
        pattern: "(?:^|\\n)\\[\\d+ files?: ([^\\]]+)\\]\\s*$",
        options: []
    )

    static func split(_ raw: String) -> (text: String, files: [ChatMessageFile]) {
        var text = raw
        var fromFence: [ChatMessageFile] = []
        if let fence {
            let ns = text as NSString
            let full = NSRange(location: 0, length: ns.length)
            let matches = fence.matches(in: text, range: full)
            for match in matches where match.numberOfRanges > 1 {
                let body = ns.substring(with: match.range(at: 1))
                if let data = body.data(using: .utf8),
                   let rows = try? JSONDecoder().decode([ChatMessageFile].self, from: data)
                {
                    fromFence.append(contentsOf: rows)
                }
            }
            text = fence.stringByReplacingMatches(in: text, range: full, withTemplate: "\n")
        }
        var fromTag: [ChatMessageFile] = []
        if let legacy {
            let ns = text as NSString
            let full = NSRange(location: 0, length: ns.length)
            if let match = legacy.firstMatch(in: text, range: full), match.numberOfRanges > 1 {
                let names = ns.substring(with: match.range(at: 1))
                fromTag = names
                    .components(separatedBy: ", ")
                    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
                    .map { ChatMessageFile(name: $0) }
                text = ns.substring(with: NSRange(location: 0, length: match.range.location))
            }
        }
        var trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let files = fromFence.isEmpty ? fromTag : fromFence
        if !files.isEmpty && (trimmed == "(attachment)" || trimmed == "(empty)") {
            trimmed = ""
        }
        return (trimmed, files)
    }
}

struct ChatMessage: Identifiable, Equatable, Codable {
    var id = UUID()
    var role: String
    var content: String
    /// Waiting behind an in-flight education agent turn (server-backed queue).
    var queued: Bool = false
    /// Server id for a waiting turn. Hold the bubble to interrupt with it.
    var queueId: String? = nil
    var widgets: [ChatWidget] = []
    /// Files attached to this user message. Tiles sit above the text.
    var files: [ChatMessageFile] = []
    /// Local send the server has not accepted yet. Never persisted.
    var pending: Bool = false

    var bubbleText: String {
        var text = ChatFileTag.split(content).text
        if !displayFiles.isEmpty && (text == "(attachment)" || text == "(empty)") {
            text = ""
        }
        return text
    }

    var displayFiles: [ChatMessageFile] {
        if !files.isEmpty { return files }
        return ChatFileTag.split(content).files
    }

    enum CodingKeys: String, CodingKey {
        case role, content, queued, queueId, widgets, files
    }

    init(
        role: String,
        content: String,
        queued: Bool = false,
        queueId: String? = nil,
        widgets: [ChatWidget] = [],
        files: [ChatMessageFile] = [],
        pending: Bool = false
    ) {
        self.role = role
        self.content = content
        self.queued = queued
        self.queueId = queueId
        self.widgets = widgets
        self.files = files
        self.pending = pending
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        role = try c.decode(String.self, forKey: .role)
        content = try c.decode(String.self, forKey: .content)
        queued = try c.decodeIfPresent(Bool.self, forKey: .queued) ?? false
        let rawQueueId = try c.decodeIfPresent(String.self, forKey: .queueId)
        queueId = (rawQueueId?.isEmpty == false) ? rawQueueId : nil
        widgets = try c.decodeIfPresent([ChatWidget].self, forKey: .widgets) ?? []
        files = try c.decodeIfPresent([ChatMessageFile].self, forKey: .files) ?? []
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(role, forKey: .role)
        try c.encode(content, forKey: .content)
        if queued { try c.encode(true, forKey: .queued) }
        if let queueId, !queueId.isEmpty {
            try c.encode(queueId, forKey: .queueId)
        }
        if !widgets.isEmpty { try c.encode(widgets, forKey: .widgets) }
        if !files.isEmpty { try c.encode(files, forKey: .files) }
    }
}

struct ChatMapPin: Equatable, Codable, Identifiable, Hashable {
    var id: String
    var lat: Double
    var lng: Double
    var title: String
    var subtitle: String

    enum CodingKeys: String, CodingKey {
        case id, lat, lng, title, subtitle
    }

    init(id: String, lat: Double, lng: Double, title: String, subtitle: String = "") {
        self.id = id
        self.lat = lat
        self.lng = lng
        self.title = title
        self.subtitle = subtitle
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        lat = try c.decode(Double.self, forKey: .lat)
        lng = try c.decode(Double.self, forKey: .lng)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        subtitle = try c.decodeIfPresent(String.self, forKey: .subtitle) ?? ""
        id = try c.decodeIfPresent(String.self, forKey: .id).flatMap { $0.isEmpty ? nil : $0 }
            ?? "\(lat),\(lng),\(title)"
    }
}

struct ChatWidget: Equatable, Codable, Identifiable, Hashable {
    var id: String
    var type: String
    var pins: [ChatMapPin]?
    var html: String?
    var htmlDark: String?
    var url: String?
    var alt: String?
    var pinId: String?
    var title: String?
    var subtitle: String?
    var body: String?

    enum CodingKeys: String, CodingKey {
        case id, type, pins, html, htmlDark, url, alt, pinId, title, subtitle, body
    }

    init(
        id: String,
        type: String,
        pins: [ChatMapPin]? = nil,
        html: String? = nil,
        htmlDark: String? = nil,
        url: String? = nil,
        alt: String? = nil,
        pinId: String? = nil,
        title: String? = nil,
        subtitle: String? = nil,
        body: String? = nil
    ) {
        self.id = id
        self.type = type
        self.pins = pins
        self.html = html
        self.htmlDark = htmlDark
        self.url = url
        self.alt = alt
        self.pinId = pinId
        self.title = title
        self.subtitle = subtitle
        self.body = body
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = (try c.decodeIfPresent(String.self, forKey: .type) ?? "").lowercased()
        pins = try c.decodeIfPresent([ChatMapPin].self, forKey: .pins)
        html = try c.decodeIfPresent(String.self, forKey: .html)
        htmlDark = try c.decodeIfPresent(String.self, forKey: .htmlDark)
        url = try c.decodeIfPresent(String.self, forKey: .url)
        alt = try c.decodeIfPresent(String.self, forKey: .alt)
        pinId = try c.decodeIfPresent(String.self, forKey: .pinId)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        subtitle = try c.decodeIfPresent(String.self, forKey: .subtitle)
        body = try c.decodeIfPresent(String.self, forKey: .body)
        if let explicit = try c.decodeIfPresent(String.self, forKey: .id), !explicit.isEmpty {
            id = explicit
        } else if type == "map" {
            id = "map"
        } else if let pinId, !pinId.isEmpty {
            id = pinId
        } else {
            id = Self.fallbackId(
                type: type,
                url: url,
                title: title,
                html: html,
                htmlDark: htmlDark
            )
        }
    }

    /// Stable across re-decodes so SwiftUI does not rebuild widgets on poll/SSE.
    private static func fallbackId(
        type: String,
        url: String?,
        title: String?,
        html: String?,
        htmlDark: String?
    ) -> String {
        let seed = [type, url ?? "", title ?? "", html ?? "", htmlDark ?? ""].joined(separator: "\u{1e}")
        var hash: UInt64 = 5381
        for byte in seed.utf8 {
            hash = ((hash << 5) &+ hash) &+ UInt64(byte)
        }
        return "\(type)-\(String(hash, radix: 16))"
    }
}

struct ChatRequest: Encodable {
    let messages: [[String: String]]
    let sessionId: String
    let uiContext: String?
}

struct ChatResponse: Decodable {
    let ok: Bool?
    let reply: String?
    let message: String?
    let content: String?
    let error: String?

    var text: String? {
        reply ?? message ?? content
    }
}

@MainActor
final class VisitorChatStore: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var isSending = false
    @Published var errorText: String?

    let sessionId = UUID().uuidString

    func send(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isSending else { return }
        messages.append(ChatMessage(role: "user", content: trimmed))
        isSending = true
        errorText = nil
        defer { isSending = false }

        let payload = messages.map { ["role": $0.role, "content": $0.content] }
        do {
            let res: ChatResponse = try await APIClient.shared.request(
                "api/chat",
                method: "POST",
                body: ChatRequest(messages: payload, sessionId: sessionId, uiContext: "ios-app")
            )
            if let err = res.error, res.text == nil {
                errorText = err
                messages.append(ChatMessage(role: "assistant", content: "Sorry — \(err)"))
                return
            }
            let reply = res.text ?? "…"
            messages.append(ChatMessage(role: "assistant", content: reply))
        } catch {
            errorText = error.localizedDescription
            messages.append(
                ChatMessage(
                    role: "assistant",
                    content: "Yan’s Mac is offline or unreachable right now. Please try again later."
                )
            )
        }
    }
}
