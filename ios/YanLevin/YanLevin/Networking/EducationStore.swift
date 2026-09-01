import Foundation
import SwiftUI

struct AgentStartResponse: Decodable {
    let ok: Bool?
    let sessionId: String?
    let status: String?
    let error: String?
}

struct AgentAttachmentPayload: Encodable {
    let name: String
    let mimeType: String
    let data: String
}

struct AgentMessageBody: Encodable {
    let sessionId: String
    let message: String
    let attachments: [AgentAttachmentPayload]?
    let uiContext: AgentUiContext?
    var interrupt: Bool? = nil

    enum CodingKeys: String, CodingKey {
        case sessionId, message, attachments, uiContext, interrupt
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(sessionId, forKey: .sessionId)
        try c.encode(message, forKey: .message)
        try c.encodeIfPresent(attachments, forKey: .attachments)
        try c.encodeIfPresent(uiContext, forKey: .uiContext)
        if interrupt == true {
            try c.encode(true, forKey: .interrupt)
        }
    }
}

struct AgentUiContext: Encodable {
    let client: String
    var view: String?
    var title: String?
    var classId: String?
    var className: String?
    var period: String?
    var freePeriod: Bool?
    var projectId: String?
    var projectName: String?
    var todoId: String?
    var todoName: String?
    var tag: String?
    var done: Bool?
    var dateId: String?
    var dateName: String?
    var date: String?
    var capsuleId: String?
    var capsuleTitle: String?
    var capsuleCategory: String? = nil
    var capsuleBody: String? = nil
    var capsuleCitations: String? = nil
    var phoneLocation: AgentPhoneLocation? = nil
}

/// Shared across Education + Chat tabs: which education screen is open.
enum EducationRoute: Hashable {
    case classDetail(EducationClass)
    case projectDetail(EducationProject)
    case todoDetail(EducationTodo)
    case dateDetail(EducationDate)
    case capsuleDetail(EducationTodo, EducationCapsule)
}

@MainActor
final class EducationFocusStore: ObservableObject {
    /// Education tab `NavigationStack` path — Chat reads the last entry for agent context.
    @Published var path: [EducationRoute] = []
    /// Visible Education page is within a few points of the top.
    @Published var visiblePageIsAtTop = true
    @Published var scrollToTopGeneration = 0
    @Published var filePreviewPresented = false
    @Published var filePreviewDismissGeneration = 0

    func handleTabReselect() {
        if filePreviewPresented {
            filePreviewDismissGeneration += 1
            return
        }
        if !visiblePageIsAtTop {
            scrollToTopGeneration += 1
            return
        }
        guard !path.isEmpty else { return }
        var next = path
        next.removeLast()
        let transaction = Transaction(animation: .easeInOut(duration: 0.28))
        withTransaction(transaction) {
            path = next
        }
    }

    var isShowingDashboard: Bool { path.isEmpty }

    func isShowingClass(_ id: String) -> Bool {
        if case .classDetail(let cls) = path.last { return cls.id == id }
        return false
    }

    func isShowingProject(_ id: String) -> Bool {
        if case .projectDetail(let project) = path.last { return project.id == id }
        return false
    }

    func isShowingTodo(_ id: String) -> Bool {
        if case .todoDetail(let todo) = path.last { return todo.id == id }
        return false
    }

    func isShowingDate(_ id: String) -> Bool {
        if case .dateDetail(let date) = path.last { return date.id == id }
        return false
    }

    func isShowingCapsule(todoId: String, capsuleId: String) -> Bool {
        if case .capsuleDetail(let todo, let capsule) = path.last {
            return todo.id == todoId && capsule.id == capsuleId
        }
        return false
    }

    private var pendingAgentNavigate: AgentEducationNavigate?
    private var lastAppliedNavigateKey = ""

    /// Set Education's stack from the Personal Agent. Does not switch tabs.
    @discardableResult
    func applyAgentNavigate(_ nav: AgentEducationNavigate, tree: EducationTreeResponse?) -> Bool {
        let key = nav.dedupeKey
        if !key.isEmpty, key == lastAppliedNavigateKey { return true }
        let view = (nav.view ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let ok: Bool
        switch view {
        case "home":
            if !path.isEmpty { path = [] }
            ok = true
        case "class":
            ok = applyClassNavigate(nav.classId, tree: tree)
        case "project":
            ok = applyProjectNavigate(nav.projectId, tree: tree)
        case "todo":
            ok = applyTodoNavigate(nav, tree: tree)
        case "date":
            ok = applyDateNavigate(nav, tree: tree)
        case "capsule":
            ok = applyCapsuleNavigate(nav, tree: tree)
        default:
            return false
        }
        if ok {
            lastAppliedNavigateKey = key
            pendingAgentNavigate = nil
            return true
        }
        pendingAgentNavigate = nav
        return false
    }

    func applyPendingNavigate(tree: EducationTreeResponse?) {
        guard let pending = pendingAgentNavigate else { return }
        _ = applyAgentNavigate(pending, tree: tree)
    }

    private func applyClassNavigate(_ classId: String?, tree: EducationTreeResponse?) -> Bool {
        let id = (classId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty else { return false }
        guard let cls = tree?.classes?.first(where: { $0.id == id }) else { return false }
        if isShowingClass(id) { return true }
        path = [.classDetail(cls)]
        return true
    }

    private func applyProjectNavigate(_ projectId: String?, tree: EducationTreeResponse?) -> Bool {
        let id = (projectId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty else { return false }
        guard let project = tree?.projects?.first(where: { $0.id == id }) else { return false }
        if isShowingProject(id) { return true }
        path = [.projectDetail(project)]
        return true
    }

    private func applyTodoNavigate(_ nav: AgentEducationNavigate, tree: EducationTreeResponse?) -> Bool {
        let todoId = (nav.todoId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !todoId.isEmpty else { return false }
        guard let todo = EducationTodoHelpers.todo(
            todoId: todoId,
            classId: nav.classId,
            projectId: nav.projectId,
            from: tree
        ) else { return false }
        if isShowingTodo(todo.id) { return true }
        path = parentStack(for: todo, tree: tree) + [.todoDetail(todo)]
        return true
    }

    private func applyDateNavigate(_ nav: AgentEducationNavigate, tree: EducationTreeResponse?) -> Bool {
        let dateId = (nav.dateId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !dateId.isEmpty else { return false }
        guard let date = EducationDateHelpers.date(
            dateId: dateId,
            classId: nav.classId,
            projectId: nav.projectId,
            from: tree
        ) else { return false }
        if isShowingDate(date.id) { return true }
        path = parentStack(forDate: date, tree: tree) + [.dateDetail(date)]
        return true
    }

    private func applyCapsuleNavigate(_ nav: AgentEducationNavigate, tree: EducationTreeResponse?) -> Bool {
        let todoId = (nav.todoId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let capsuleId = (nav.capsuleId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !todoId.isEmpty, !capsuleId.isEmpty else { return false }
        guard let todo = EducationTodoHelpers.todo(
            todoId: todoId,
            classId: nav.classId,
            projectId: nav.projectId,
            from: tree
        ) else { return false }
        guard let capsule = (todo.capsules ?? []).first(where: { $0.id == capsuleId }) else {
            return false
        }
        if isShowingCapsule(todoId: todo.id, capsuleId: capsule.id) { return true }
        path = parentStack(for: todo, tree: tree) + [
            .todoDetail(todo),
            .capsuleDetail(todo, capsule),
        ]
        return true
    }

    private func parentStack(for todo: EducationTodo, tree: EducationTreeResponse?) -> [EducationRoute] {
        if let projectId = todo.projectId, !projectId.isEmpty,
           let project = tree?.projects?.first(where: { $0.id == projectId }) {
            return [.projectDetail(project)]
        }
        if let classId = todo.classId, !classId.isEmpty,
           let cls = tree?.classes?.first(where: { $0.id == classId }) {
            return [.classDetail(cls)]
        }
        return []
    }

    private func parentStack(forDate date: EducationDate, tree: EducationTreeResponse?) -> [EducationRoute] {
        if let projectId = date.projectId, !projectId.isEmpty,
           let project = tree?.projects?.first(where: { $0.id == projectId }) {
            return [.projectDetail(project)]
        }
        if let classId = date.classId, !classId.isEmpty,
           let cls = tree?.classes?.first(where: { $0.id == classId }) {
            return [.classDetail(cls)]
        }
        return []
    }

    /// Same shape as web `__eduUiContext` for `/api/education/agent/message`.
    func agentUiContext(tree: EducationTreeResponse?) -> AgentUiContext {
        switch path.last {
        case nil:
            return AgentUiContext(client: "ios", view: "home", title: "Education home")

        case .classDetail(let cls):
            let live = tree?.classes?.first(where: { $0.id == cls.id }) ?? cls
            return AgentUiContext(
                client: "ios",
                view: "class",
                title: live.contextDisplayName,
                classId: live.id,
                className: live.name ?? live.contextDisplayName,
                period: live.period?.uppercased(),
                freePeriod: live.isFreePeriod == true ? true : nil
            )

        case .projectDetail(let project):
            let live = tree?.projects?.first(where: { $0.id == project.id }) ?? project
            return AgentUiContext(
                client: "ios",
                view: "project",
                title: live.displayName,
                projectId: live.id,
                projectName: live.name ?? live.displayName
            )

        case .todoDetail(let todo):
            let live = EducationTodoHelpers.flattenTodos(from: tree).first(where: { $0.id == todo.id }) ?? todo
            var ctx = AgentUiContext(
                client: "ios",
                view: "todo",
                title: live.displayName,
                todoId: live.todoId,
                todoName: live.name ?? live.displayName,
                tag: live.displayTag,
                done: live.done
            )
            if let projectId = live.projectId, !projectId.isEmpty {
                ctx.projectId = projectId
                let project = tree?.projects?.first(where: { $0.id == projectId })
                ctx.projectName = project?.name ?? project?.displayName
            } else if let classId = live.classId, !classId.isEmpty {
                ctx.classId = classId
                let cls = tree?.classes?.first(where: { $0.id == classId })
                ctx.className = cls?.name ?? cls?.contextDisplayName
                ctx.period = cls?.period?.uppercased()
            }
            return ctx

        case .capsuleDetail(let todo, let capsule):
            let live = EducationTodoHelpers.flattenTodos(from: tree).first(where: { $0.id == todo.id }) ?? todo
            let liveCapsule = (live.capsules ?? []).first(where: { $0.id == capsule.id }) ?? capsule
            var ctx = AgentUiContext(
                client: "ios",
                view: "capsule",
                title: liveCapsule.displayTitle,
                todoId: live.todoId,
                todoName: live.name ?? live.displayName,
                capsuleId: liveCapsule.id,
                capsuleTitle: liveCapsule.displayTitle
            )
            if let category = liveCapsule.category?.trimmingCharacters(in: .whitespacesAndNewlines),
               !category.isEmpty {
                ctx.capsuleCategory = category
            }
            let body = liveCapsule.displayBody
            if !body.isEmpty { ctx.capsuleBody = body }
            let citeText = liveCapsule.citationsContextText
            if !citeText.isEmpty { ctx.capsuleCitations = citeText }
            if let projectId = live.projectId, !projectId.isEmpty {
                ctx.projectId = projectId
                let project = tree?.projects?.first(where: { $0.id == projectId })
                ctx.projectName = project?.name ?? project?.displayName
            } else if let classId = live.classId, !classId.isEmpty {
                ctx.classId = classId
                let cls = tree?.classes?.first(where: { $0.id == classId })
                ctx.className = cls?.name ?? cls?.contextDisplayName
                ctx.period = cls?.period?.uppercased()
            }
            return ctx

        case .dateDetail(let date):
            let live = EducationDateHelpers.flattenDates(from: tree).first(where: { $0.id == date.id }) ?? date
            var ctx = AgentUiContext(
                client: "ios",
                view: "date",
                title: live.displayName,
                dateId: live.dateId,
                dateName: live.name ?? live.displayName,
                date: live.date
            )
            if let projectId = live.projectId, !projectId.isEmpty {
                ctx.projectId = projectId
                let project = tree?.projects?.first(where: { $0.id == projectId })
                ctx.projectName = project?.name ?? project?.displayName
            } else if let classId = live.classId, !classId.isEmpty {
                ctx.classId = classId
                let cls = tree?.classes?.first(where: { $0.id == classId })
                ctx.className = cls?.name ?? cls?.contextDisplayName
                ctx.period = cls?.period?.uppercased()
            }
            return ctx
        }
    }
}

struct AgentChatWireMessage: Decodable {
    let role: String?
    let content: String?
    let queued: Bool?
    let widgets: [ChatWidget]?
}

struct AgentEducationNavigate: Decodable, Equatable {
    let id: String?
    let view: String?
    let classId: String?
    let projectId: String?
    let todoId: String?
    let dateId: String?
    let capsuleId: String?

    var dedupeKey: String {
        if let id, !id.isEmpty { return id }
        return [view, classId, projectId, todoId, dateId, capsuleId]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: "|")
    }
}

private struct EducationSSEPayload: Decodable {
    let navigate: AgentEducationNavigate?
}

struct AgentMessageResponse: Decodable {
    let ok: Bool?
    let reply: String?
    let message: String?
    let content: String?
    let status: String?
    let sessionId: String?
    let messages: [AgentChatWireMessage]?
    let queued: Bool?
    let queueLength: Int?
    let error: String?
    let workingLabel: String?

    var text: String? { reply ?? message ?? content }
}

struct AgentStateResponse: Decodable {
    let ok: Bool?
    let sessionId: String?
    let status: String?
    let messages: [AgentChatWireMessage]?
    let content: String?
    let queueLength: Int?
    let error: String?
    let workingLabel: String?
    let navigate: AgentEducationNavigate?
}

struct AgentStopBody: Encodable {
    let sessionId: String
}

struct AgentResumeBody: Encodable {
    let sessionId: String
}

struct AgentReadBody: Encodable {
    let sessionId: String
}

struct AgentReadResponse: Decodable {
    let ok: Bool?
}

struct AgentChatListItem: Decodable, Identifiable, Equatable {
    let sessionId: String
    let title: String?
    let updated: String
    let preview: String?
    let started: String?
    var working: Bool
    var unread: Bool

    var id: String { sessionId }

    var isWorking: Bool { working }
    var isUnread: Bool { unread && !working }

    var displayTitle: String {
        let t = (title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty { return t }
        let p = (preview ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return p.isEmpty ? "Chat" : p
    }

    enum CodingKeys: String, CodingKey {
        case sessionId, title, updated, preview, started, working, unread
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        updated = try c.decode(String.self, forKey: .updated)
        preview = try c.decodeIfPresent(String.self, forKey: .preview)
        started = try c.decodeIfPresent(String.self, forKey: .started)
        working = try c.decodeIfPresent(Bool.self, forKey: .working) ?? false
        unread = try c.decodeIfPresent(Bool.self, forKey: .unread) ?? false
    }
}

struct AgentChatListResponse: Decodable {
    let ok: Bool?
    let sessionId: String?
    let chats: [AgentChatListItem]?
}

struct PendingChatAttachment: Identifiable, Equatable {
    let id: UUID
    let name: String
    /// Shown in the composer chip / bubble. Full headline for news; otherwise `name`.
    let displayName: String
    let mimeType: String
    let data: Data

    init(
        id: UUID = UUID(),
        name: String,
        mimeType: String,
        data: Data,
        displayName: String? = nil
    ) {
        self.id = id
        self.name = name
        self.mimeType = mimeType
        self.data = data
        let shown = (displayName ?? name).trimmingCharacters(in: .whitespacesAndNewlines)
        self.displayName = shown.isEmpty ? name : shown
    }

    static func newsCapsule(todo: EducationTodo, capsule: EducationCapsule) -> PendingChatAttachment {
        let title = capsule.displayTitle
        var lines: [String] = [
            todo.displayName,
            "",
            title,
        ]
        if let category = capsule.category?.trimmingCharacters(in: .whitespacesAndNewlines), !category.isEmpty {
            lines.append("")
            lines.append("Category: \(category)")
        }
        let body = capsule.displayBody
        if !body.isEmpty {
            lines.append("")
            lines.append(body)
        }
        if !capsule.citations.isEmpty {
            lines.append("")
            lines.append("Citations:")
            for cite in capsule.citations {
                if let url = cite.url, !url.isEmpty {
                    lines.append("- \(cite.displayName): \(url)")
                } else {
                    lines.append("- \(cite.displayName)")
                }
            }
        }
        let text = lines.joined(separator: "\n") + "\n"
        let data = Data(text.utf8)
        return PendingChatAttachment(
            name: newsFilename(title),
            mimeType: "text/markdown",
            data: data,
            displayName: title
        )
    }

    private static func newsFilename(_ title: String) -> String {
        let invalid = CharacterSet(charactersIn: "/\\?%*:|\"<>")
        var base = title.components(separatedBy: invalid).joined(separator: "-")
        base = base.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if base.isEmpty { base = "news" }
        return "\(base).md"
    }
}

@MainActor
final class EducationStore: ObservableObject {
    @Published var tree: EducationTreeResponse?
    @Published var isLoading = false
    @Published var errorText: String?
    @Published var agentMessages: [ChatMessage] = []
    @Published var agentSessionId: String?
    @Published var agentBusy = false
    @Published var agentWorkingLabel = "Working"
    @Published var chatHistory: [AgentChatListItem] = []
    @Published var chatHistoryLoading = false
    @Published var agentNavigate: AgentEducationNavigate?
    @Published private(set) var treeEpoch = 0

    private let sse = MacSSEClient()
    private var liveToken: String?
    private var sseReloadTask: Task<Void, Never>?
    private var agentPollTask: Task<Void, Never>?
    private var persistAgentChatTask: Task<Void, Never>?
    private var persistEmail: String?
    /// Last `/api/education/data` payload. Identical bytes skip `@Published tree`
    /// so Chat map cards are not rebuilt on every agent-file SSE tick.
    private var lastEducationData: Data?
    private var lastOpenedProjectId: String?
    private var lastOpenedAt = Date.distantPast
    private var lastIngestedNavigateKey = ""
    /// Bumped when the visible thread changes so in-flight polls/resumes cannot
    /// paint an older chat.
    private var agentViewGen = 0
    /// True while `startNewChat` is replacing the visible thread. Resume from
    /// `/agent/active` must not paint the previous session over the blank one.
    private var startingNewChat = false

    var isStartingNewChat: Bool { startingNewChat }

    private func chatDefaultsKey(email: String) -> String {
        "edu-chat-v1:\(email.lowercased())"
    }

    /// Debounced persist for poll/SSE merges. Snapshot is taken when the wait fires.
    private func persistAgentChat() {
        persistAgentChatTask?.cancel()
        persistAgentChatTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard let self, !Task.isCancelled else { return }
            self.persistAgentChatNow()
        }
    }

    private func persistAgentChatNow() {
        persistAgentChatTask?.cancel()
        persistAgentChatTask = nil
        guard let email = persistEmail, !email.isEmpty else { return }
        let sessionId = agentSessionId
        let messages = agentMessages
        // A nil sessionId (fresh thread being prepared, or /agent/start failed)
        // must OMIT the key — `nil as Any` becomes NSNull in the dictionary and
        // UserDefaults throws NSInvalidArgumentException ("non-property list
        // object"), which crashed every lock-screen / toggle new-chat entry.
        var payload: [String: Any] = [
            "messages": messages.map { msg -> [String: Any] in
                var row: [String: Any] = ["role": msg.role, "content": msg.content]
                if msg.queued { row["queued"] = true }
                if !msg.widgets.isEmpty,
                   let data = try? APIClient.encoder.encode(msg.widgets),
                   let obj = try? JSONSerialization.jsonObject(with: data)
                {
                    row["widgets"] = obj
                }
                return row
            },
        ]
        if let sessionId, !sessionId.isEmpty {
            payload["sessionId"] = sessionId
        }
        UserDefaults.standard.set(payload, forKey: chatDefaultsKey(email: email))
    }

    private func clearPersistedAgentChat() {
        persistAgentChatTask?.cancel()
        persistAgentChatTask = nil
        guard let email = persistEmail, !email.isEmpty else { return }
        UserDefaults.standard.removeObject(forKey: chatDefaultsKey(email: email))
    }

    private static func decodeWidgets(_ raw: Any?) -> [ChatWidget] {
        guard let raw else { return [] }
        guard JSONSerialization.isValidJSONObject(raw),
              let data = try? JSONSerialization.data(withJSONObject: raw),
              let widgets = try? APIClient.decoder.decode([ChatWidget].self, from: data)
        else { return [] }
        return widgets
    }

    /// Drop clock fields so SSE reloads of `/data` do not republish `tree`
    /// once a second while the agent is writing files.
    private static func stableEducationPayload(_ data: Data) -> Data {
        guard var obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return data
        }
        obj.removeValue(forKey: "nowContext")
        return (try? JSONSerialization.data(withJSONObject: obj)) ?? data
    }

    private func loadPersistedAgentChat(email: String) {
        persistEmail = email.lowercased()
        guard let raw = UserDefaults.standard.dictionary(forKey: chatDefaultsKey(email: email)) else {
            return
        }
        if let sid = raw["sessionId"] as? String, !sid.isEmpty {
            agentSessionId = sid
        }
        if let list = raw["messages"] as? [[String: Any]] {
            agentMessages = list.compactMap { row in
                guard let role = row["role"] as? String,
                      let content = row["content"] as? String
                else { return nil }
                let queued = row["queued"] as? Bool ?? false
                let widgets = Self.decodeWidgets(row["widgets"])
                return ChatMessage(role: role, content: content, queued: queued, widgets: widgets)
            }
        } else if let list = raw["messages"] as? [[String: String]] {
            agentMessages = list.compactMap { row in
                guard let role = row["role"], let content = row["content"] else { return nil }
                return ChatMessage(role: role, content: content)
            }
        }
    }

    private func applyWireMessages(_ list: [AgentChatWireMessage]?) {
        guard let list else { return }
        let incoming: [ChatMessage] = list.compactMap { row in
            guard let role = row.role, role == "user" || role == "assistant" else {
                return nil
            }
            return ChatMessage(
                role: role,
                content: row.content ?? "",
                queued: row.queued == true,
                widgets: row.widgets ?? []
            )
        }
        // Keep SwiftUI identities stable across poll/SSE snapshots so MapKit
        // tiles and carousel state are not torn down on every "Working" tick.
        let merged: [ChatMessage] = incoming.enumerated().map { index, msg in
            guard index < agentMessages.count else { return msg }
            var next = msg
            next.id = agentMessages[index].id
            return next
        }
        guard merged != agentMessages else { return }
        agentMessages = merged
        persistAgentChat()
    }

    private static func displayWorkingLabel(_ raw: String?) -> String {
        var s = (raw ?? "Working").trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { s = "Working" }
        if s.hasSuffix("...") { s.removeLast(3) }
        if s.hasSuffix("…") { s.removeLast() }
        s = s.trimmingCharacters(in: .whitespaces)
        return s.isEmpty ? "Working" : s
    }

    private func applyAgentRunState(status: String?, workingLabel: String?) {
        let running = status == "running"
        if agentBusy != running {
            agentBusy = running
        }
        let next = running ? Self.displayWorkingLabel(workingLabel) : "Working"
        if agentWorkingLabel != next {
            agentWorkingLabel = next
        }
        if let sid = agentSessionId,
           let i = chatHistory.firstIndex(where: { $0.sessionId == sid }) {
            if running {
                if !chatHistory[i].working {
                    chatHistory[i].working = true
                }
                if chatHistory[i].unread {
                    chatHistory[i].unread = false
                }
            } else if chatHistory[i].working {
                chatHistory[i].working = false
                chatHistory[i].unread = true
            }
        }
    }

    var queuedMessageCount: Int {
        agentMessages.filter(\.queued).count
    }

    var isQueueFull: Bool {
        queuedMessageCount >= 8
    }

    /// Keep education data fresh while this view task is alive.
    /// SSE for instant updates + polling fallback (same idea as `/education` web).
    /// Stop is tied to task cancellation — do not also stop from `onDisappear`
    /// (iPad sidebar tabs can fire disappear without tearing the view down).
    func runLiveSession(token: String) async {
        liveToken = token
        startLiveUpdates(token: token)
        defer { stopLiveUpdates() }
        // Website polls every 45s; use 20s on iOS as a safety net when SSE stalls.
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
        sse.start(path: "api/education/events", bearer: token) { [weak self] data in
            self?.ingestSSEPayload(data)
            self?.scheduleReloadFromSSE()
        }
    }

    func stopLiveUpdates() {
        sseReloadTask?.cancel()
        sseReloadTask = nil
        sse.stop()
        liveToken = nil
    }

    private func ingestSSEPayload(_ data: String) {
        guard !data.isEmpty, let raw = data.data(using: .utf8) else { return }
        guard let payload = try? JSONDecoder().decode(EducationSSEPayload.self, from: raw) else {
            return
        }
        ingestAgentNavigate(payload.navigate)
    }

    private func ingestAgentNavigate(_ nav: AgentEducationNavigate?) {
        guard let nav else { return }
        let key = nav.dedupeKey
        if !key.isEmpty, key == lastIngestedNavigateKey { return }
        lastIngestedNavigateKey = key
        agentNavigate = nav
    }

    private func scheduleReloadFromSSE() {
        sseReloadTask?.cancel()
        sseReloadTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard let self, !Task.isCancelled, let token = self.liveToken else { return }
            await self.load(token: token)
            // Same SSE bump refreshes education agent chat (reply may land without a file write).
            if let sid = self.agentSessionId {
                await self.refreshAgentState(token: token, sessionId: sid)
            } else if self.agentBusy {
                await self.resumeAgentChat(email: self.persistEmail, token: token)
            }
            if !self.chatHistory.isEmpty {
                await self.loadChatList(token: token)
            }
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
                "api/education/data",
                bearer: token,
                query: [bust]
            )
            guard (200..<300).contains(http.statusCode) else {
                let msg = String(data: data, encoding: .utf8) ?? ""
                errorText = "HTTP \(http.statusCode): \(msg.prefix(120))"
                return
            }
            let res = try APIClient.decoder.decode(EducationTreeResponse.self, from: data)
            if let err = res.error, res.classes == nil {
                errorText = err
            }
            let stable = Self.stableEducationPayload(data)
            if lastEducationData != stable {
                lastEducationData = stable
                tree = res
                AppGroupStore.cacheEducationData(data)
                treeEpoch += 1
            }
            if let email = res.email, !email.isEmpty {
                persistEmail = email.lowercased()
            }
        } catch {
            errorText = error.localizedDescription
        }
    }

    func setTodoDone(
        id: String,
        done: Bool,
        classId: String? = nil,
        projectId: String? = nil,
        token: String
    ) async {
        do {
            var query: [URLQueryItem] = []
            if let classId, !classId.isEmpty {
                query.append(URLQueryItem(name: "classId", value: classId))
            }
            if let projectId, !projectId.isEmpty {
                query.append(URLQueryItem(name: "projectId", value: projectId))
            }
            let _: TodoDoneResponse = try await APIClient.shared.request(
                "api/education/todo/\(id)/done",
                method: "PATCH",
                body: TodoDoneBody(done: done, classId: classId, projectId: projectId),
                bearer: token,
                query: query
            )
            await load(token: token)
        } catch {
            errorText = error.localizedDescription
        }
    }

    func markProjectOpened(id: String, token: String?) async {
        guard let token, !id.isEmpty else { return }
        let now = Date()
        if id == lastOpenedProjectId, now.timeIntervalSince(lastOpenedAt) < 2 {
            return
        }
        lastOpenedProjectId = id
        lastOpenedAt = now
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        _ = try? await APIClient.shared.requestRaw(
            "api/education/project/\(encoded)/opened",
            method: "POST",
            bearer: token
        )
    }

    func setCapsuleVote(
        todoId: String,
        capsuleId: String,
        vote: String?,
        classId: String? = nil,
        projectId: String? = nil,
        token: String
    ) async {
        do {
            var query: [URLQueryItem] = []
            if let classId, !classId.isEmpty {
                query.append(URLQueryItem(name: "classId", value: classId))
            }
            if let projectId, !projectId.isEmpty {
                query.append(URLQueryItem(name: "projectId", value: projectId))
            }
            let encodedTodo = todoId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? todoId
            let encodedCap = capsuleId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? capsuleId
            let _: CapsuleVoteResponse = try await APIClient.shared.request(
                "api/education/todo/\(encodedTodo)/capsule/\(encodedCap)/vote",
                method: "PATCH",
                body: CapsuleVoteBody(vote: vote, classId: classId, projectId: projectId),
                bearer: token,
                query: query
            )
            await load(token: token)
        } catch {
            errorText = error.localizedDescription
        }
    }

    /// Download a context file into a temp URL for Quick Look (caller owns cleanup).
    func downloadContextFile(
        scope: String,
        id: String?,
        classId: String? = nil,
        projectId: String? = nil,
        name: String,
        token: String
    ) async throws -> URL {
        var query: [URLQueryItem] = [
            URLQueryItem(name: "scope", value: scope),
            URLQueryItem(name: "name", value: name),
        ]
        if let id, !id.isEmpty {
            query.append(URLQueryItem(name: "id", value: id))
        }
        if let classId, !classId.isEmpty {
            query.append(URLQueryItem(name: "classId", value: classId))
        }
        if let projectId, !projectId.isEmpty {
            query.append(URLQueryItem(name: "projectId", value: projectId))
        }

        let (data, http) = try await APIClient.shared.requestRaw(
            "api/education/file",
            bearer: token,
            query: query
        )
        guard (200..<300).contains(http.statusCode) else {
            let msg = String(data: data, encoding: .utf8) ?? ""
            throw APIError.http(http.statusCode, String(msg.prefix(240)))
        }

        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("edu-context-files", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        // Unique folder per open so Quick Look gets a clean basename.
        let folder = dir.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let dest = folder.appendingPathComponent(name)
        try data.write(to: dest, options: .atomic)
        return dest
    }

    /// Restore local cache then sync from Mac `/agent/active` (or saved session state).
    func resumeAgentChat(email: String?, token: String) async {
        if startingNewChat { return }
        let gen = agentViewGen
        if let email, !email.isEmpty {
            loadPersistedAgentChat(email: email)
        }
        guard gen == agentViewGen, !startingNewChat else { return }
        do {
            let active: AgentStateResponse = try await APIClient.shared.request(
                "api/education/agent/active",
                bearer: token
            )
            guard gen == agentViewGen, !startingNewChat else { return }
            if let sid = active.sessionId, !sid.isEmpty {
                if agentSessionId != sid {
                    agentSessionId = sid
                }
                applyWireMessages(active.messages)
                applyAgentRunState(status: active.status, workingLabel: active.workingLabel)
                if agentBusy {
                    startAgentPolling(token: token)
                } else {
                    stopAgentPolling()
                }
                persistAgentChatNow()
                return
            }
            // Backend has no active session (cleared on another device) — wipe local too.
            clearLocalAgentChat()
            return
        } catch {
            // Fall through to saved sessionId poll.
        }

        guard gen == agentViewGen, !startingNewChat else { return }
        guard let sid = agentSessionId else {
            // No server active and no local id — treat as cleared.
            if !agentMessages.isEmpty {
                clearLocalAgentChat()
            }
            return
        }
        await refreshAgentState(token: token, sessionId: sid)
    }

    private func clearLocalAgentChat() {
        stopAgentPolling()
        agentSessionId = nil
        agentMessages = []
        agentBusy = false
        agentWorkingLabel = "Working"
        clearPersistedAgentChat()
    }

    private func refreshAgentState(token: String, sessionId sid: String) async {
        do {
            let state: AgentStateResponse = try await APIClient.shared.request(
                "api/education/agent/state",
                bearer: token,
                query: [URLQueryItem(name: "sessionId", value: sid)]
            )
            // Ignore in-flight polls after the user switched threads.
            guard agentSessionId == sid else { return }
            let nextSid = state.sessionId ?? sid
            if agentSessionId != nextSid {
                agentSessionId = nextSid
                persistAgentChatNow()
            }
            applyWireMessages(state.messages)
            applyAgentRunState(status: state.status, workingLabel: state.workingLabel)
            ingestAgentNavigate(state.navigate)
            if agentBusy {
                startAgentPolling(token: token)
            } else {
                stopAgentPolling()
            }
        } catch {
            guard agentSessionId == sid else { return }
            // Session expired / stopped on Mac — clear transcript everywhere.
            if case let APIError.http(code, _) = error, code == 404 {
                clearLocalAgentChat()
            }
        }
    }

    private func startAgentPolling(token: String) {
        if agentPollTask != nil { return }
        agentPollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard let self, !Task.isCancelled else { return }
                guard let sid = self.agentSessionId else { return }
                await self.refreshAgentState(token: token, sessionId: sid)
                if !self.agentBusy { return }
            }
        }
    }

    private func stopAgentPolling() {
        agentPollTask?.cancel()
        agentPollTask = nil
    }

    func ensureAgent(token: String) async {
        if agentSessionId != nil { return }
        do {
            let res: AgentStartResponse = try await APIClient.shared.request(
                "api/education/agent/start",
                method: "POST",
                body: EmptyBody(),
                bearer: token
            )
            if let sid = res.sessionId {
                agentSessionId = sid
                persistAgentChatNow()
            } else {
                errorText = res.error ?? "Could not start education agent."
            }
        } catch {
            errorText = error.localizedDescription
        }
    }

    func sendAgent(
        _ text: String,
        attachments: [PendingChatAttachment] = [],
        uiContext: AgentUiContext? = nil,
        interrupt: Bool = false,
        token: String
    ) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty else { return }
        if !interrupt {
            guard !isQueueFull else { return }
        }
        await ensureAgent(token: token)
        guard let sid = agentSessionId else { return }

        var bubble = trimmed
        if !attachments.isEmpty {
            let names = attachments.map(\.displayName).joined(separator: ", ")
            let tag = "[\(attachments.count) file\(attachments.count == 1 ? "" : "s"): \(names)]"
            bubble = trimmed.isEmpty ? tag : "\(trimmed)\n\(tag)"
        }
        let willQueue = agentBusy && !interrupt
        agentMessages.append(ChatMessage(role: "user", content: bubble, queued: willQueue))
        persistAgentChatNow()
        applyAgentRunState(status: "running", workingLabel: "Working")

        let payload: [AgentAttachmentPayload]? = attachments.isEmpty
            ? nil
            : attachments.map {
                AgentAttachmentPayload(
                    name: $0.name,
                    mimeType: $0.mimeType,
                    data: $0.data.base64EncodedString()
                )
            }

        let context = uiContext ?? AgentUiContext(client: "ios", view: "chat", title: "Personal Agent")

        do {
            let res: AgentMessageResponse = try await APIClient.shared.request(
                "api/education/agent/message",
                method: "POST",
                body: AgentMessageBody(
                    sessionId: sid,
                    message: trimmed,
                    attachments: payload,
                    uiContext: context,
                    interrupt: interrupt ? true : nil
                ),
                bearer: token
            )
            applyWireMessages(res.messages)
            if res.status == "running" || res.content == nil {
                applyAgentRunState(status: "running", workingLabel: res.workingLabel)
                startAgentPolling(token: token)
            } else if let reply = res.text {
                // Sync path fallback (shouldn't happen with 202 async API).
                if agentMessages.last?.role != "assistant" {
                    agentMessages.append(ChatMessage(role: "assistant", content: reply))
                }
                applyAgentRunState(status: "idle", workingLabel: nil)
                persistAgentChatNow()
            }
        } catch {
            // Drop optimistic bubble on failure.
            if let last = agentMessages.last,
               last.role == "user",
               last.content == bubble
            {
                agentMessages.removeLast()
            }
            if !willQueue {
                applyAgentRunState(status: "idle", workingLabel: nil)
                stopAgentPolling()
            }
            let message: String
            if case let APIError.http(code, _) = error, code == 429 {
                message = "Queue full (max 8). Wait for a reply before sending more."
            } else {
                message = "Education agent unavailable (Mac / Cursor offline)."
            }
            agentMessages.append(
                ChatMessage(role: "assistant", content: message)
            )
            persistAgentChatNow()
        }
    }

    /// Tear down the live Cursor agent for this thread. Prefer `startNewChat`
    /// so background work on the previous thread can finish.
    func stopAgent(token: String) async {
        let sid = agentSessionId
        clearLocalAgentChat()
        guard let sid else { return }
        _ = try? await APIClient.shared.requestRaw(
            "api/education/agent/stop",
            method: "POST",
            body: AgentStopBody(sessionId: sid),
            bearer: token
        )
    }

    /// Blank the visible thread immediately so a later `/agent/active` resume
    /// cannot flash the previous chat. Call before `startNewChat` from lock-screen.
    func prepareNewChat() {
        agentViewGen += 1
        startingNewChat = true
        stopAgentPolling()
        agentBusy = false
        agentWorkingLabel = "Working"
        agentMessages = []
        agentSessionId = nil
        persistAgentChatNow()
    }

    /// Switch the UI to a blank thread. The previous session keeps running
    /// (including its queue) and stays in past chats.
    func startNewChat(token: String, force: Bool = false) async {
        if !startingNewChat {
            if !force, agentMessages.isEmpty && !agentBusy { return }
            prepareNewChat()
        }
        let gen = agentViewGen
        defer {
            if gen == agentViewGen {
                startingNewChat = false
            }
        }
        do {
            let res: AgentStartResponse = try await APIClient.shared.request(
                "api/education/agent/start",
                method: "POST",
                body: EmptyBody(),
                bearer: token
            )
            guard gen == agentViewGen else { return }
            if let sid = res.sessionId, !sid.isEmpty {
                agentSessionId = sid
            } else {
                agentSessionId = nil
            }
            persistAgentChatNow()
            await loadChatList(token: token)
        } catch {
            guard gen == agentViewGen else { return }
            agentSessionId = nil
            persistAgentChatNow()
            errorText = error.localizedDescription
        }
    }

    func loadChatList(token: String) async {
        if chatHistory.isEmpty {
            chatHistoryLoading = true
        }
        defer { chatHistoryLoading = false }
        do {
            let res: AgentChatListResponse = try await APIClient.shared.request(
                "api/education/agent/chats",
                bearer: token
            )
            chatHistory = res.chats ?? []
        } catch {
            if chatHistory.isEmpty {
                errorText = error.localizedDescription
            }
        }
    }

    func markChatRead(sessionId: String, token: String) async {
        let sid = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sid.isEmpty else { return }
        if let i = chatHistory.firstIndex(where: { $0.sessionId == sid }),
           chatHistory[i].unread {
            chatHistory[i].unread = false
        }
        do {
            let _: AgentReadResponse = try await APIClient.shared.request(
                "api/education/agent/read",
                method: "POST",
                body: AgentReadBody(sessionId: sid),
                bearer: token
            )
        } catch {
            /* list refresh will catch up */
        }
    }

    func resumePersistedChat(sessionId: String, token: String) async {
        let sid = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sid.isEmpty else { return }
        if agentSessionId == sid { return }
        startingNewChat = false
        agentViewGen += 1
        let gen = agentViewGen
        stopAgentPolling()
        // Loading a past transcript is not an agent run — keep Working hidden
        // unless the resumed session is actually running.
        agentBusy = false
        do {
            let res: AgentStateResponse = try await APIClient.shared.request(
                "api/education/agent/resume",
                method: "POST",
                body: AgentResumeBody(sessionId: sid),
                bearer: token
            )
            guard gen == agentViewGen else { return }
            agentSessionId = res.sessionId ?? sid
            agentMessages = []
            applyWireMessages(res.messages)
            applyAgentRunState(status: res.status, workingLabel: res.workingLabel)
            if agentBusy {
                startAgentPolling(token: token)
            }
            persistAgentChatNow()
        } catch {
            guard gen == agentViewGen else { return }
            applyAgentRunState(status: "idle", workingLabel: nil)
            errorText = error.localizedDescription
        }
    }
}

private struct EmptyBody: Encodable {}
