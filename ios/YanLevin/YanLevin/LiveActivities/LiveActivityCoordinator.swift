import ActivityKit
import Foundation

@MainActor
final class LiveActivityCoordinator {
    static let shared = LiveActivityCoordinator()

    private var syncTask: Task<Void, Never>?
    private var classEndTask: Task<Void, Never>?
    private var agentSyncGeneration = 0

    private init() {}

    func scheduleSync() {
        syncTask?.cancel()
        syncTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            await sync()
        }
    }

    func sync() async {
        guard AppGroupStore.hasFullAccess else {
            await endClass()
            await endAgents()
            return
        }
        await syncClass()
        await syncAgents()
    }

    private func syncClass() async {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            await endClass()
            return
        }
        let tree = AppGroupStore.loadCachedEducationTree()
        let sections = EducationScheduleHelper.classSections(
            schedule: tree?.schedule,
            classes: tree?.classes ?? [],
            activeClassIdsByDate: tree?.activeClassIdsByDate
        )
        guard let active = EducationScheduleHelper.activeDayClass(in: sections) else {
            await endClass()
            armNextHighlight(in: sections)
            return
        }
        let dayClass = active.dayClass
        let (items, overflow) = EducationScheduleHelper.periodAssignments(
            for: dayClass,
            dateKey: active.section.dateKey,
            from: tree
        )
        let startDate = dayClass.startMin.flatMap {
            EducationScheduleHelper.minutesToDate(dateKey: active.section.dateKey, minutes: $0)
        }
        let endDate = dayClass.endMin.flatMap {
            EducationScheduleHelper.minutesToDate(dateKey: active.section.dateKey, minutes: $0)
        }
        let state = ClassActivityAttributes.ContentState(
            classId: dayClass.cls.id,
            className: dayClass.cls.displayName,
            period: dayClass.period,
            start: dayClass.start ?? "",
            end: dayClass.end ?? "",
            startDate: startDate,
            endDate: endDate,
            assignments: items.map {
                ClassActivityAssignment(
                    todoId: $0.todoId,
                    classId: $0.classId,
                    tag: $0.filterTagKey,
                    name: $0.displayName,
                    done: $0.done == true
                )
            },
            overflowCount: overflow
        )
        await upsertClass(state: state, staleDate: endDate)
        armClassRefresh(startDate: startDate, endDate: endDate)
    }

    private func upsertClass(state: ClassActivityAttributes.ContentState, staleDate: Date?) async {
        let content = ActivityContent(state: state, staleDate: staleDate)
        let existing = Activity<ClassActivityAttributes>.activities
        if let current = existing.first(where: { $0.attributes.classId == state.classId }) {
            await current.update(content)
            for extra in existing where extra.id != current.id {
                await extra.end(nil, dismissalPolicy: .immediate)
            }
            return
        }
        for extra in existing {
            await extra.end(nil, dismissalPolicy: .immediate)
        }
        let attrs = ClassActivityAttributes(classId: state.classId)
        do {
            _ = try Activity.request(attributes: attrs, content: content, pushType: nil)
        } catch {
            NSLog("LiveActivity class start: %@", error.localizedDescription)
        }
    }

    private func endClass() async {
        classEndTask?.cancel()
        classEndTask = nil
        for activity in Activity<ClassActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    private func armNextHighlight(in sections: [DaySection]) {
        guard let section = sections.first(where: { $0.isToday }) else { return }
        var soonest: Date?
        for dayClass in section.classes {
            guard let startMin = EducationScheduleHelper.highlightStartMin(
                for: dayClass,
                in: section.classes
            ), startMin > section.nowMinutes,
               let date = EducationScheduleHelper.minutesToDate(
                dateKey: section.dateKey,
                minutes: startMin
               )
            else { continue }
            if soonest == nil || date < soonest! {
                soonest = date
            }
        }
        armClassRefresh(startDate: soonest, endDate: nil)
    }

    /// Wake at class start (lead → elapsed), then once a minute so "N min" stays current.
    private func armClassRefresh(startDate: Date?, endDate: Date?) {
        let now = Date()
        if let startDate, startDate > now {
            armClassEnd(startDate)
            return
        }
        if let endDate, endDate > now {
            armClassEnd(min(endDate, now.addingTimeInterval(60)))
            return
        }
        armClassEnd(nil)
    }

    private func armClassEnd(_ date: Date?) {
        classEndTask?.cancel()
        guard let date else {
            classEndTask = nil
            return
        }
        classEndTask = Task { @MainActor in
            let delay = date.timeIntervalSinceNow + 0.6
            guard delay > 0 else {
                await sync()
                return
            }
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await sync()
        }
    }

    private func syncAgents() async {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            await endAgents()
            return
        }
        guard let token = AppGroupStore.token, !token.isEmpty else {
            await endAgents()
            return
        }
        agentSyncGeneration += 1
        let gen = agentSyncGeneration
        do {
            let res: RunningAgentsResponse = try await APIClient.shared.request(
                "api/education/agent/running",
                bearer: token
            )
            guard gen == agentSyncGeneration else { return }
            let agents = res.agents ?? []
            if agents.isEmpty {
                await endAgents()
                return
            }
            let previousStarts = Dictionary(
                (Activity<AgentActivityAttributes>.activities.first?.content.state.agents ?? [])
                    .map { ($0.sessionId, $0.startedAt) },
                uniquingKeysWith: { _, last in last }
            )
            let shown = Array(agents.prefix(3)).map { row in
                AgentActivityRow(
                    sessionId: row.sessionId,
                    title: {
                        let t = (row.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                        return t.isEmpty ? "Chat" : t
                    }(),
                    workingLabel: {
                        let t = (row.workingLabel ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                        return t.isEmpty ? "Working" : t
                    }(),
                    startedAt: previousStarts[row.sessionId] ?? Date()
                )
            }
            let state = AgentActivityAttributes.ContentState(
                agents: shown,
                overflowCount: max(0, agents.count - shown.count)
            )
            await upsertAgents(state: state)
        } catch {
            NSLog("LiveActivity agents: %@", error.localizedDescription)
        }
    }

    private func upsertAgents(state: AgentActivityAttributes.ContentState) async {
        let content = ActivityContent(state: state, staleDate: nil)
        if let current = Activity<AgentActivityAttributes>.activities.first {
            await current.update(content)
            return
        }
        do {
            _ = try Activity.request(
                attributes: AgentActivityAttributes(kind: AgentActivityAttributes.kindValue),
                content: content,
                pushType: nil
            )
        } catch {
            NSLog("LiveActivity agent start: %@", error.localizedDescription)
        }
    }

    private func endAgents() async {
        for activity in Activity<AgentActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }
}

private struct RunningAgentsResponse: Decodable {
    let ok: Bool?
    let agents: [RunningAgentRow]?
}

private struct RunningAgentRow: Decodable {
    let sessionId: String
    let title: String?
    let workingLabel: String?
    let status: String?
}
