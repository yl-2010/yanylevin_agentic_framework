import ActivityKit
import Foundation

@MainActor
final class LiveActivityCoordinator {
    static let shared = LiveActivityCoordinator()

    private var syncTask: Task<Void, Never>?
    private var classEndTask: Task<Void, Never>?
    private var agentSyncGeneration = 0
    private var watchingClassPush = false
    private var watchedActivityIds = Set<String>()

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
            await endClass(report: true)
            await endAgents()
            return
        }
        await syncClass()
        await syncAgents()
    }

    private func syncClass() async {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            await endClass(report: true)
            return
        }
        startPushWatching()
        guard let tree = AppGroupStore.loadCachedEducationTree() else { return }
        let sections = EducationScheduleHelper.classSections(
            schedule: tree.schedule,
            classes: tree.classes ?? [],
            activeClassIdsByDate: tree.activeClassIdsByDate
        )
        guard let section = sections.first(where: \.isToday) else {
            await endClass(report: true)
            return
        }
        switch classDayPhase(section: section, tree: tree) {
        case .idle(let when):
            await endClass(report: true)
            armClassEnd(when)
        case .end:
            await endClass(report: true)
        case .show(let state, let stale):
            await upsertDay(dayId: dayId(for: section.dateKey), state: state, staleDate: stale)
            armClassEnd(stale)
        }
    }

    private enum ClassDayPhase {
        case idle(Date?)
        case show(ClassActivityAttributes.ContentState, Date?)
        case end
    }

    /// One card from the first highlight until 15 minutes after the last bell.
    /// Gaps show the next real class instead of ending the activity.
    private func classDayPhase(section: DaySection, tree: EducationTreeResponse) -> ClassDayPhase {
        let classes = section.classes
        let real = classes.filter { !$0.cls.isFreePeriod && $0.endMin != nil }
        guard !real.isEmpty else { return .end }
        let lastBell = classes.compactMap(\.endMin).max() ?? 0
        let dayEnd = lastBell + EducationScheduleHelper.schoolDayEndBufferMinutes
        let firstReal = classes.firstIndex(where: { !$0.cls.isFreePeriod }) ?? 0
        var dayStart = EducationScheduleHelper.highlightStartMin(for: real[0], in: classes)
        for dayClass in classes.prefix(firstReal) {
            guard let highlight = EducationScheduleHelper.highlightStartMin(for: dayClass, in: classes) else { continue }
            if dayStart == nil || highlight < dayStart! { dayStart = highlight }
        }
        let zone = tree.schedule?.timezone
        func at(_ minutes: Int) -> Date? {
            EducationScheduleHelper.minutesToDate(dateKey: section.dateKey, minutes: minutes, timezone: zone)
        }
        guard let dayStart else { return .end }
        if section.nowMinutes < dayStart {
            return .idle(at(dayStart))
        }
        if section.nowMinutes >= dayEnd {
            return .end
        }
        let shown: DayClass
        let staleMin: Int
        if let active = classes.first(where: { section.isCurrent($0) && !$0.cls.isFreePeriod }) {
            shown = active
            staleMin = active.endMin ?? dayEnd
        } else if let upcoming = real.first(where: { ($0.endMin ?? 0) > section.nowMinutes }) {
            shown = upcoming
            staleMin = upcoming.endMin ?? dayEnd
        } else if let last = real.last {
            shown = last
            staleMin = dayEnd
        } else {
            return .end
        }
        return .show(contentState(for: shown, section: section, tree: tree), at(staleMin))
    }

    private func contentState(
        for dayClass: DayClass,
        section: DaySection,
        tree: EducationTreeResponse
    ) -> ClassActivityAttributes.ContentState {
        let zone = tree.schedule?.timezone
        let (items, overflow) = EducationScheduleHelper.periodAssignments(
            for: dayClass,
            dateKey: section.dateKey,
            from: tree
        )
        return ClassActivityAttributes.ContentState(
            classId: dayClass.cls.id,
            className: dayClass.cls.displayName,
            period: dayClass.period,
            start: dayClass.start ?? "",
            end: dayClass.end ?? "",
            startDate: dayClass.startMin.flatMap {
                EducationScheduleHelper.minutesToDate(dateKey: section.dateKey, minutes: $0, timezone: zone)
            },
            endDate: dayClass.endMin.flatMap {
                EducationScheduleHelper.minutesToDate(dateKey: section.dateKey, minutes: $0, timezone: zone)
            },
            scoreLabel: dayClass.cls.scoreLabel,
            assignments: items.map {
                ClassActivityAssignment(
                    todoId: $0.todoId,
                    classId: $0.classId,
                    tag: $0.filterTagKey,
                    name: $0.displayName,
                    done: $0.done == true,
                    scoreLabel: $0.scoreLabel
                )
            },
            overflowCount: overflow
        )
    }

    private func dayId(for dateKey: String) -> String {
        "school-day-\(dateKey)"
    }

    private func upsertDay(
        dayId: String,
        state: ClassActivityAttributes.ContentState,
        staleDate: Date?
    ) async {
        let content = ActivityContent(state: state, staleDate: staleDate)
        let existing = Activity<ClassActivityAttributes>.activities
        if let current = existing.first(where: { $0.attributes.dayId == dayId }) {
            await current.update(content)
            watchActivityToken(current)
            for extra in existing where extra.id != current.id {
                await extra.end(nil, dismissalPolicy: .immediate)
            }
            return
        }
        for extra in existing {
            await extra.end(nil, dismissalPolicy: .immediate)
        }
        do {
            let activity = try Activity.request(
                attributes: ClassActivityAttributes(dayId: dayId),
                content: content,
                pushType: .token
            )
            watchActivityToken(activity)
        } catch {
            NSLog("LiveActivity class start: %@", error.localizedDescription)
        }
    }

    private func endClass(report: Bool) async {
        classEndTask?.cancel()
        classEndTask = nil
        let running = Activity<ClassActivityAttributes>.activities
        guard !running.isEmpty else { return }
        for activity in running {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        if report {
            await PushRegistration.shared.uploadLiveActivity(
                pushToStartToken: nil,
                activityPushToken: nil,
                dayId: nil,
                ended: true
            )
        }
    }

    private func startPushWatching() {
        guard !watchingClassPush else { return }
        watchingClassPush = true
        Task { @MainActor in
            for await token in Activity<ClassActivityAttributes>.pushToStartTokenUpdates {
                let hex = Self.hex(token)
                await PushRegistration.shared.uploadLiveActivity(
                    pushToStartToken: hex,
                    activityPushToken: nil,
                    dayId: nil,
                    ended: false
                )
            }
        }
        Task { @MainActor in
            for await activity in Activity<ClassActivityAttributes>.activityUpdates {
                self.watchActivityToken(activity)
            }
        }
        for activity in Activity<ClassActivityAttributes>.activities {
            watchActivityToken(activity)
        }
    }

    private func watchActivityToken(_ activity: Activity<ClassActivityAttributes>) {
        guard watchedActivityIds.insert(activity.id).inserted else { return }
        let dayId = activity.attributes.dayId
        Task { @MainActor in
            for await token in activity.pushTokenUpdates {
                let hex = Self.hex(token)
                await PushRegistration.shared.uploadLiveActivity(
                    pushToStartToken: nil,
                    activityPushToken: hex,
                    dayId: dayId,
                    ended: false
                )
            }
        }
    }

    private static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    /// Wake when the next class content has to change. The minute counter is system-drawn.
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
