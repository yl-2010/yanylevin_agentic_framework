import SwiftUI
import UIKit

struct EducationView: View {
    @EnvironmentObject private var auth: AuthStore
    @EnvironmentObject private var educationFocus: EducationFocusStore
    @EnvironmentObject private var nav: AppNavigationStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.ylPalette) private var palette
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var store = EducationStore()
    @State private var todoExpanded = false
    /// Completed starts open on iPhone and the site. Collapse only after a tap.
    @State private var completedExpanded = true
    @State private var todoTypeFilters: Set<String> = EducationTodoFilter.load()
    @State private var datesExpanded = false
    @State private var dateFilters: Set<String> = EducationDateFilter.load()
    /// Bumped to cancel/restart SSE + polling (same effect as leaving the tab).
    @State private var liveSessionID = 0

    private static let collapsedTodoLimit = 6

    private var liveTaskID: String {
        "\(auth.session?.token ?? "")-\(liveSessionID)-\(educationFocus.workspace)"
    }

    /// Match website desktop grid (and iPad / landscape phone).
    private var isWide: Bool {
        AdaptiveLayout.isWideLayout(
            horizontalSizeClass: horizontalSizeClass,
            verticalSizeClass: verticalSizeClass
        )
    }

    private var use24Hour: Bool {
        false
    }

    var body: some View {
        NavigationStack(path: $educationFocus.path) {
            ScrollView {
                educationPanels
                    .padding(.horizontal, isWide ? 24 : 16)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .adaptiveReadableWidth(AdaptiveLayout.pageMaxWidth, enabled: isWide)
            }
            .educationTabReselectScroll(isActive: educationFocus.isShowingDashboard)
            .ylPageBackground()
            .navigationTitle(educationNavTitle)
            .navigationBarTitleDisplayMode(.large)
            .refreshable { await reloadAndRestartLiveSession() }
            .onChange(of: educationFocus.path) { _, path in
                if case .projectDetail(let project) = path.last {
                    if project.isJypePortal {
                        educationFocus.enterJype()
                        return
                    }
                    if project.isDebatePortal {
                        educationFocus.enterDebate()
                        return
                    }
                    Task { await store.markProjectOpened(id: project.id, token: auth.session?.token) }
                }
                Task {
                    guard let token = auth.session?.token else { return }
                    await store.load(token: token, live: true)
                }
            }
            .onChange(of: educationFocus.workspace) { _, ws in
                store.workspace = ws
                store.resetTreeCache()
                liveSessionID += 1
                Task {
                    guard let token = auth.session?.token else { return }
                    await store.load(token: token)
                    await store.load(token: token, live: true)
                }
            }
            .navigationDestination(for: EducationRoute.self) { route in
                switch route {
                case .classDetail(let cls):
                    ClassDetailView(cls: cls, store: store, use24Hour: use24Hour)
                        .environmentObject(auth)
                        .ylSwipeBackHaptics()
                case .projectDetail(let project):
                    ProjectDetailView(project: project, store: store, use24Hour: use24Hour)
                        .environmentObject(auth)
                        .ylSwipeBackHaptics()
                case .todoDetail(let todo):
                    TodoDetailView(todo: todo, store: store, use24Hour: use24Hour)
                        .environmentObject(auth)
                        .ylSwipeBackHaptics()
                case .dateDetail(let date):
                    DateDetailView(date: date, store: store, use24Hour: use24Hour)
                        .environmentObject(auth)
                        .ylSwipeBackHaptics()
                case .capsuleDetail(let todo, let capsule):
                    CapsuleDetailView(todo: todo, capsule: capsule, store: store)
                        .environmentObject(auth)
                        .environmentObject(nav)
                        .ylSwipeBackHaptics()
                case .caseDetail(let debateCase, let side):
                    CaseDetailView(debateCase: debateCase, side: side, store: store)
                        .ylSwipeBackHaptics()
                }
            }
        }
        .environment(\.ylPalette, educationPalette)
        .task(id: liveTaskID) {
            store.focus = educationFocus
            store.workspace = educationFocus.workspace
            guard let token = auth.session?.token else { return }
            await store.load(token: token)
            applyEducationTodoHandoff()
            applyEducationClassHandoff()
            Task { await store.load(token: token, live: true) }
            await store.runLiveSession(token: token)
        }
        .onAppear {
            store.focus = educationFocus
            applyEducationTodoHandoff()
            applyEducationClassHandoff()
        }
        .onChange(of: nav.educationTodoHandoff) { _, _ in
            applyEducationTodoHandoff()
        }
        .onChange(of: nav.educationClassHandoff) { _, _ in
            applyEducationClassHandoff()
        }
        .onChange(of: store.agentNavigate) { _, _ in
            applyAgentEducationNavigate()
        }
        .onChange(of: store.treeEpoch) { _, _ in
            applyPendingAgentEducationNavigate()
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await reloadAndRestartLiveSession() }
        }
        .onChange(of: nav.tabReselectGeneration) { _, _ in
            guard nav.selectedTab == .education else { return }
            educationFocus.handleTabReselect()
        }
    }

    private var educationNavTitle: String {
        if educationFocus.isJype { return "JYPE" }
        if educationFocus.isDebate { return "Debate" }
        return "Education"
    }

    private var educationPalette: YLPalette {
        if educationFocus.isJype { return .jype }
        if educationFocus.isDebate { return .debate }
        return .standard
    }

    private var hidesTypeFilters: Bool {
        educationFocus.isJype || educationFocus.isDebate
    }

    @ViewBuilder
    private var educationPanels: some View {
        if store.isLoading && store.tree == nil {
            ProgressView("Loading education…")
                .frame(maxWidth: .infinity, minHeight: 200)
        } else if let err = store.errorText, store.tree == nil {
            ContentUnavailableView("Education unavailable", systemImage: "wifi.exclamationmark", description: Text(err))
        } else if isWide {
            HStack(alignment: .top, spacing: 14) {
                VStack(alignment: .leading, spacing: 14) {
                    todoPanel
                    completedPanel
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)

                VStack(alignment: .leading, spacing: 14) {
                    if educationFocus.isJype {
                        jypeClassesPanel
                        projectsPanel
                        jypeDatesPanel
                    } else if educationFocus.isDebate {
                        casesPanel
                        jypeDatesPanel
                    } else {
                        scheduleAndDatesPanels
                        projectsPanel
                    }
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        } else if educationFocus.isJype {
            VStack(alignment: .leading, spacing: 14) {
                todoPanel
                jypeClassesPanel
                projectsPanel
                jypeDatesPanel
                completedPanel
            }
        } else if educationFocus.isDebate {
            VStack(alignment: .leading, spacing: 14) {
                todoPanel
                casesPanel
                jypeDatesPanel
                completedPanel
            }
        } else {
            VStack(alignment: .leading, spacing: 14) {
                todoPanel
                scheduleAndDatesPanels
                projectsPanel
                completedPanel
            }
        }
    }

    /// Right column on desktop / middle block on mobile — same box order as the site.
    @ViewBuilder
    private var scheduleAndDatesPanels: some View {
        let sections = daySections
        if let day1 = sections.first {
            dayPanel(day1)
        } else {
            eduPanel(title: "Classes") {
                emptyRow("No school days")
            }
        }

        EducationDatesPanel(
            items: visibleDateItems,
            expanded: datesExpanded,
            dateFilters: dateFilters,
            filterKeys: EducationDateFilter.homeKeys,
            use24Hour: use24Hour,
            onToggleExpanded: {
                withAnimation(.easeInOut(duration: 0.22)) {
                    datesExpanded.toggle()
                }
            },
            onToggleFilter: toggleDateFilter
        )

        if sections.count > 1 {
            dayPanel(sections[1])
        }
    }

    private var projectsPanel: some View {
        eduPanel(title: "Projects") {
            let projects = store.tree?.projects ?? []
            if projects.isEmpty {
                emptyRow("Nothing here")
            } else {
                ForEach(projects) { project in
                    if project.isJypePortal {
                        Button {
                            YLHaptics.tap()
                            educationFocus.enterJype()
                        } label: {
                            Text(project.displayName)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(YLTheme.fg(colorScheme))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.vertical, 8)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    } else if project.isDebatePortal {
                        Button {
                            YLHaptics.tap()
                            educationFocus.enterDebate()
                        } label: {
                            Text(project.displayName)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(YLTheme.fg(colorScheme))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.vertical, 8)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    } else {
                        NavigationLink(value: EducationRoute.projectDetail(project)) {
                            Text(project.displayName)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(YLTheme.fg(colorScheme))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.vertical, 8)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .ylHapticNavigation()
                    }
                }
            }
        }
    }

    private var completedPanel: some View {
        EducationCompletedPanel(
            todos: EducationTodo.sortedCompleted(filteredTodos(done: true)),
            expanded: completedExpanded,
            use24Hour: use24Hour,
            showClass: true,
            onToggleExpanded: {
                withAnimation(.easeInOut(duration: 0.22)) {
                    completedExpanded.toggle()
                }
            },
            className: { className(for: $0) },
            onToggleDone: toggleDone
        )
    }

    private var jypeClassesPanel: some View {
        eduPanel(title: "Classes") {
            let rows = staticJypeClasses
            if rows.isEmpty {
                emptyRow("Nothing here")
            } else {
                ForEach(rows) { dayClass in
                    classRow(dayClass, isCurrent: false)
                }
            }
        }
    }

    private var jypeDatesPanel: some View {
        EducationDatesPanel(
            items: visibleDateItems,
            expanded: datesExpanded,
            dateFilters: dateFilters,
            filterKeys: EducationDateFilter.homeKeys,
            use24Hour: use24Hour,
            onToggleExpanded: {
                withAnimation(.easeInOut(duration: 0.22)) {
                    datesExpanded.toggle()
                }
            },
            onToggleFilter: toggleDateFilter,
            showFilters: false
        )
    }

    private var debateProject: EducationProject? {
        store.tree?.projects?.first(where: { $0.id.lowercased() == "debate" })
    }

    private var casesPanel: some View {
        eduPanel(title: "Cases") {
            let cases = debateProject?.cases ?? []
            if cases.isEmpty {
                emptyRow("Nothing here")
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(cases) { debateCase in
                        debateCasePair(debateCase)
                    }
                }
            }
        }
    }

    private func debateCasePair(_ debateCase: EducationCase) -> some View {
        VStack(spacing: 0) {
            debateCaseSideRow(debateCase, side: "aff", label: "Aff")
            Rectangle()
                .fill(YLTheme.fg(colorScheme).opacity(0.12))
                .frame(height: 1)
            debateCaseSideRow(debateCase, side: "neg", label: "Neg")
        }
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(YLTheme.fg(colorScheme).opacity(0.12), lineWidth: 1)
        }
    }

    private func debateCaseSideRow(_ debateCase: EducationCase, side: String, label: String) -> some View {
        NavigationLink(value: EducationRoute.caseDetail(debateCase, side: side)) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(debateCase.displayName)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(YLTheme.fg(colorScheme))
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(label)
                    .font(.caption)
                    .foregroundStyle(YLTheme.muted(colorScheme))
            }
            .padding(.vertical, 10)
            .padding(.horizontal, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .ylHapticNavigation()
    }

    private var staticJypeClasses: [DayClass] {
        let today = store.tree?.todayKey ?? ""
        let schedule = store.tree?.schedule
        return (store.tree?.classes ?? [])
            .map { cls in
                let period = cls.periodLetter(on: today, schedule: schedule)
                return DayClass(
                    cls: cls,
                    period: period,
                    start: nil,
                    end: nil,
                    startMin: nil,
                    endMin: nil
                )
            }
            .sorted {
                if $0.period != $1.period { return $0.period < $1.period }
                return $0.cls.displayName < $1.cls.displayName
            }
    }

    private var visibleOpenTodos: [EducationTodo] {
        let open = filteredTodos(done: false)
            .sorted { $0.dueSortKey < $1.dueSortKey }
        if todoExpanded { return open }
        return Array(open.prefix(Self.collapsedTodoLimit))
    }

    private func filteredTodos(done: Bool) -> [EducationTodo] {
        allTodos.filter { todo in
            (todo.done == true) == done
                && (hidesTypeFilters || todoTypeFilters.contains(todo.filterTagKey))
                && !todo.isHiddenFromHome
        }
    }

    private var todoPanel: some View {
        EducationTodoPanel(
            title: "TODO",
            todos: visibleOpenTodos,
            expanded: todoExpanded,
            typeFilters: todoTypeFilters,
            use24Hour: use24Hour,
            showClass: true,
            onToggleExpanded: {
                withAnimation(.easeInOut(duration: 0.22)) {
                    todoExpanded.toggle()
                }
            },
            onToggleFilter: toggleTodoFilter,
            className: { className(for: $0) },
            onToggleDone: toggleDone,
            showFilters: !hidesTypeFilters
        )
    }

    private func toggleTodoFilter(_ tag: String) {
        if todoTypeFilters.contains(tag) {
            todoTypeFilters.remove(tag)
        } else {
            todoTypeFilters.insert(tag)
        }
        if todoTypeFilters.isEmpty {
            todoTypeFilters = EducationTodoFilter.allTags
        }
        EducationTodoFilter.save(todoTypeFilters)
    }

    private func toggleDateFilter(_ key: String) {
        if dateFilters.contains(key) {
            dateFilters.remove(key)
        } else {
            dateFilters.insert(key)
        }
        if dateFilters.isEmpty {
            dateFilters = EducationDateFilter.allHome
        }
        EducationDateFilter.save(dateFilters)
    }

    private func toggleDone(_ todo: EducationTodo) {
        guard let token = auth.session?.token else { return }
        let next = !(todo.done == true)
        Task {
            await store.setTodoDone(
                id: todo.todoId,
                done: next,
                classId: todo.classId,
                projectId: todo.projectId,
                token: token
            )
        }
    }

    private func eduPanel<Content: View>(
        title: String,
        accentPrefix: String? = nil,
        dimmed: Bool = false,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if let accentPrefix, !accentPrefix.isEmpty {
                    Text(accentPrefix)
                        .font(.title3.weight(.bold))
                        .foregroundStyle(YLTheme.accent(colorScheme, palette: palette))
                }
                Text(title)
                    .font(.title3.weight(.bold))
                    .foregroundStyle(YLTheme.fg(colorScheme))
            }

            VStack(alignment: .leading, spacing: 0) {
                content()
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .ylGlassRounded(cornerRadius: 22, interactive: true)
        .opacity(dimmed ? 0.55 : 1)
    }

    private func dayPanel(_ section: DaySection) -> some View {
        eduPanel(title: section.whenLabel, accentPrefix: section.typeCode) {
            if section.classes.isEmpty {
                emptyRow("Nothing here")
            } else {
                ForEach(section.classes) { dayClass in
                    classRow(
                        dayClass,
                        isCurrent: section.isCurrent(dayClass)
                    )
                }
            }
        }
    }

    private func emptyRow(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(YLTheme.muted(colorScheme))
            .padding(.vertical, 6)
    }

    private func todoRow(_ todo: EducationTodo, showClass: Bool) -> some View {
        EducationTodoRow(
            todo: todo,
            className: showClass ? className(for: todo) : nil,
            use24Hour: use24Hour,
            onToggleDone: { toggleDone(todo) }
        )
    }

    private func classRow(
        _ dayClass: DayClass,
        isCurrent: Bool
    ) -> some View {
        HStack(spacing: 10) {
            NavigationLink(value: EducationRoute.classDetail(dayClass.cls)) {
                HStack(spacing: 10) {
                    Text(dayClass.period)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(YLTheme.accent(colorScheme, palette: palette))
                        .frame(width: 22, alignment: .leading)
                    Text(dayClass.cls.displayName)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(YLTheme.fg(colorScheme))
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .ylHapticNavigation()

            if !educationFocus.isJype && !educationFocus.isDebate {
                EducationCanvasScoreButton(
                    label: dayClass.cls.scoreLabel,
                    url: dayClass.cls.canvasURL
                )
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 8)
        .background {
            if isCurrent {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(YLTheme.accent(colorScheme, palette: palette).opacity(0.12))
            }
        }
    }

    private func className(for todo: EducationTodo) -> String? {
        if let projectId = todo.projectId {
            return store.tree?.projects?.first(where: { $0.id == projectId })?.displayName
        }
        if let classId = todo.classId {
            return store.tree?.classes?.first(where: { $0.id == classId })?.contextDisplayName
        }
        return todoClassNames[todo.id]
    }

    private var allTodos: [EducationTodo] {
        if educationFocus.isDebate {
            let project = debateProject
            return (project?.todos ?? []).map { $0.withProjectId(project?.id ?? "debate") }
        }
        return EducationTodoHelpers.flattenTodos(from: store.tree)
    }

    private var todoClassNames: [String: String] {
        var map: [String: String] = [:]
        for cls in store.tree?.classes ?? [] {
            for todo in cls.pageTodos {
                map[todo.withClassId(cls.id).id] = cls.contextDisplayName
            }
        }
        for project in store.tree?.projects ?? [] {
            for todo in project.todos ?? [] {
                map[todo.withProjectId(project.id).id] = project.displayName
            }
        }
        return map
    }

    private var visibleDateItems: [EducationDateItem] {
        let collected: [EducationDateItem]
        if educationFocus.isDebate {
            collected = EducationDateHelpers.collectItems(from: store.tree, projectId: "debate")
        } else {
            collected = EducationDateHelpers.collectItems(from: store.tree)
        }
        return EducationDateHelpers.visibleItems(
            collected,
            filters: hidesTypeFilters ? EducationDateFilter.allHome : dateFilters,
            expanded: datesExpanded,
            todayKey: store.tree?.todayKey
        )
    }

    private var daySections: [DaySection] {
        EducationScheduleHelper.classSections(
            schedule: store.tree?.schedule,
            classes: store.tree?.classes ?? [],
            activeClassIdsByDate: store.tree?.activeClassIdsByDate
        )
    }

    private func applyEducationTodoHandoff() {
        guard let handoff = nav.educationTodoHandoff else { return }
        let tree = store.tree ?? AppGroupStore.loadCachedEducationTree()
        if let todo = EducationTodoHelpers.todo(
            todoId: handoff.todoId,
            classId: handoff.classId,
            projectId: handoff.projectId,
            from: tree
        ) {
            educationFocus.path = [.todoDetail(todo)]
            nav.educationTodoHandoff = nil
            return
        }
        if store.tree != nil, !store.isLoading {
            nav.educationTodoHandoff = nil
        }
    }

    private func applyEducationClassHandoff() {
        guard let classId = nav.educationClassHandoff, !classId.isEmpty else { return }
        let tree = store.tree ?? AppGroupStore.loadCachedEducationTree()
        if let cls = tree?.classes?.first(where: { $0.id == classId }) {
            educationFocus.path = [.classDetail(cls)]
            nav.educationClassHandoff = nil
            return
        }
        if store.tree != nil, !store.isLoading {
            nav.educationClassHandoff = nil
        }
    }

    private func applyAgentEducationNavigate() {
        guard let nav = store.agentNavigate else { return }
        let tree = store.tree ?? AppGroupStore.loadCachedEducationTree()
        educationFocus.applyAgentNavigate(nav, tree: tree)
    }

    private func applyPendingAgentEducationNavigate() {
        let tree = store.tree ?? AppGroupStore.loadCachedEducationTree()
        educationFocus.applyPendingNavigate(tree: tree)
    }

    private func reload() async {
        guard let token = auth.session?.token else { return }
        await store.load(token: token, live: true)
        applyEducationTodoHandoff()
        applyEducationClassHandoff()
        applyPendingAgentEducationNavigate()
    }

    /// Same as leaving Education and coming back: tear down SSE/polling, reload, restart.
    private func reloadAndRestartLiveSession() async {
        liveSessionID += 1
        await reload()
    }
}

// MARK: - Debate case detail

struct CaseDetailView: View {
    let debateCase: EducationCase
    let side: String
    @ObservedObject var store: EducationStore
    @EnvironmentObject private var educationFocus: EducationFocusStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.ylPalette) private var palette

    private var sideKey: String { side.lowercased() == "neg" ? "neg" : "aff" }

    private var sideLabel: String { sideKey == "neg" ? "Neg" : "Aff" }

    private var isWide: Bool {
        AdaptiveLayout.isWideLayout(
            horizontalSizeClass: horizontalSizeClass,
            verticalSizeClass: verticalSizeClass
        )
    }

    private var liveCase: EducationCase {
        for project in store.tree?.projects ?? [] {
            if let match = project.cases?.first(where: { $0.id == debateCase.id }) {
                return match
            }
        }
        return debateCase
    }

    private var bodySide: DebateSide? { liveCase.side(sideKey) }

    private var hasBlockfile: Bool {
        !(bodySide?.blockfile ?? []).isEmpty
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if liveCase.hasSpeech {
                    sideSwitch
                }
                if let resolution = liveCase.resolution?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !resolution.isEmpty {
                    Text("\(sideKey == "neg" ? "I negate" : "I affirm") \(resolution)")
                        .font(.subheadline)
                        .foregroundStyle(YLTheme.muted(colorScheme))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if let speech = bodySide, speech.hasBody {
                    if isWide, hasBlockfile {
                        HStack(alignment: .top, spacing: 16) {
                            speechColumn(speech)
                            blockColumn(speech.blockfile ?? [])
                        }
                    } else {
                        speechColumn(speech)
                        if hasBlockfile {
                            blockColumn(speech.blockfile ?? [])
                        }
                    }
                }
            }
            .padding(.horizontal, isWide && hasBlockfile ? 28 : 16)
            .padding(.bottom, 28)
            .frame(maxWidth: isWide ? (hasBlockfile ? AdaptiveLayout.pageMaxWidth : 680) : .infinity)
            .frame(maxWidth: .infinity)
        }
        .id(sideKey)
        .educationTabReselectScroll(
            isActive: educationFocus.isShowingCase(debateCase.id, side: side)
        )
        .ylPageBackground()
        .navigationTitle("\(liveCase.displayName) · \(sideLabel)")
        .navigationBarTitleDisplayMode(.large)
    }

    private var sideSwitch: some View {
        HStack(spacing: 8) {
            sidePill("aff", label: "Aff")
            sidePill("neg", label: "Neg")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func sidePill(_ key: String, label: String) -> some View {
        let on = sideKey == key
        return Button {
            selectSide(key)
        } label: {
            Text(label)
                .font(.caption.weight(.bold))
                .foregroundStyle(
                    on
                        ? YLTheme.accent(colorScheme, palette: palette)
                        : YLTheme.muted(colorScheme)
                )
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(
                    on
                        ? YLTheme.accent(colorScheme, palette: palette).opacity(0.16)
                        : YLTheme.fg(colorScheme).opacity(0.06),
                    in: Capsule()
                )
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func selectSide(_ key: String) {
        guard key != sideKey else { return }
        var path = educationFocus.path
        guard let last = path.indices.last else { return }
        path[last] = .caseDetail(liveCase, side: key)
        educationFocus.path = path
    }

    private func speechColumn(_ speech: DebateSide) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            if let defs = speech.definitions, !defs.isEmpty {
                definitionsBlock(defs)
            }
            if let framework = speech.framework {
                frameworkBlock(framework)
            }
            ForEach(speech.contentions ?? []) { contention in
                contentionBlock(contention)
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private func blockColumn(_ blocks: [DebateContention]) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Blockfile")
                .font(.title3.weight(.bold))
                .foregroundStyle(YLTheme.fg(colorScheme))
                .frame(maxWidth: .infinity, alignment: .leading)
            ForEach(blocks) { block in
                contentionBlock(block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private func frameworkBlock(_ framework: DebateFramework) -> some View {
        panel("Framework") {
            VStack(alignment: .leading, spacing: 8) {
                if let value = framework.value, !value.isEmpty {
                    labeled("Value.", value)
                }
                if let criterion = framework.criterion, !criterion.isEmpty {
                    labeled("Criterion.", criterion)
                }
                cueList(framework.text ?? [])
                ForEach(Array((framework.cards ?? []).enumerated()), id: \.offset) { _, card in
                    cardBlock(card)
                }
            }
        }
    }

    private func definitionsBlock(_ defs: [DebateDefinition]) -> some View {
        panel("Definitions") {
            VStack(alignment: .leading, spacing: 14) {
                ForEach(defs) { def in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(def.term)
                            .font(.body.weight(.bold))
                            .foregroundStyle(YLTheme.fg(colorScheme))
                        cueList(def.points ?? [])
                        ForEach(Array((def.cards ?? []).enumerated()), id: \.offset) { _, card in
                            cardBlock(card)
                        }
                    }
                }
            }
        }
    }

    private func contentionBlock(_ contention: DebateContention) -> some View {
        panel(contention.heading) {
            VStack(alignment: .leading, spacing: 16) {
                cueList(contention.chain ?? [])
                ForEach(Array((contention.cards ?? []).enumerated()), id: \.offset) { _, card in
                    cardBlock(card)
                }
            }
        }
    }

    private func debateMarked(_ raw: String) -> Text {
        let parts = raw.components(separatedBy: "**")
        var text = Text("")
        for (index, part) in parts.enumerated() {
            if part.isEmpty { continue }
            if index % 2 == 1 {
                text = text + Text(part).bold()
            } else {
                text = text + Text(part)
            }
        }
        return text
    }

    private func cardBlock(_ card: DebateCard) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let url = card.link {
                Link(destination: url) {
                    Text(card.tag)
                        .font(.body.weight(.bold))
                        .foregroundStyle(YLTheme.fg(colorScheme))
                        .underline()
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                Text(card.tag)
                    .font(.body.weight(.bold))
                    .foregroundStyle(YLTheme.fg(colorScheme))
            }
            if let summary = card.summary?.trimmingCharacters(in: .whitespacesAndNewlines),
               !summary.isEmpty {
                Text(summary)
                    .font(.body)
                    .foregroundStyle(YLTheme.fg(colorScheme))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 1, style: .continuous)
                    .fill(YLTheme.accent(colorScheme, palette: palette).opacity(0.7))
                    .frame(width: 2)
                debateMarked(card.quote)
                    .font(.body)
                    .foregroundStyle(YLTheme.fg(colorScheme))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let source = card.source?.trimmingCharacters(in: .whitespacesAndNewlines),
               !source.isEmpty {
                Text(source)
                    .font(.caption)
                    .foregroundStyle(YLTheme.muted(colorScheme))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            cueList(card.means ?? [])
        }
        .padding(.top, 12)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(YLTheme.fg(colorScheme).opacity(0.12))
                .frame(height: 1)
        }
    }

    private func labeled(_ label: String, _ value: String) -> some View {
        (Text(label).fontWeight(.bold).foregroundStyle(YLTheme.accent(colorScheme, palette: palette))
            + Text(" \(value)").foregroundStyle(YLTheme.fg(colorScheme)))
            .font(.body)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func cueList(_ lines: [String]) -> some View {
        let cues = lines
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(cues.enumerated()), id: \.offset) { _, line in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("•")
                        .foregroundStyle(YLTheme.muted(colorScheme))
                    Text(line)
                        .foregroundStyle(YLTheme.fg(colorScheme))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .font(.body)
            }
        }
    }

    private func panel<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.title3.weight(.bold))
                .foregroundStyle(YLTheme.fg(colorScheme))
            content()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .ylGlassRounded(cornerRadius: 22, interactive: true)
    }
}

// MARK: - Class detail

struct ClassDetailView: View {
    let cls: EducationClass
    @ObservedObject var store: EducationStore
    var use24Hour: Bool = false
    @EnvironmentObject private var auth: AuthStore
    @EnvironmentObject private var educationFocus: EducationFocusStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.ylPalette) private var palette

    @State private var todoExpanded = false
    /// Completed starts open. Collapse only after a tap.
    @State private var completedExpanded = true
    @State private var todoTypeFilters: Set<String> = EducationTodoFilter.load()
    @State private var datesExpanded = false
    @State private var dateFilters: Set<String> = EducationDateFilter.load()
    @State private var commentsExpanded = false
    @State private var archiveNow = Date()

    private static let collapsedTodoLimit = 6

    private var isWide: Bool {
        AdaptiveLayout.isWideLayout(
            horizontalSizeClass: horizontalSizeClass,
            verticalSizeClass: verticalSizeClass
        )
    }

    /// Prefer live tree data so checkbox / SSE refreshes update this page.
    private var liveClass: EducationClass {
        store.tree?.classes?.first(where: { $0.id == cls.id }) ?? cls
    }

    private var nextWhen: String {
        guard let next = EducationScheduleHelper.nextClassOccurrence(
            cls: liveClass,
            schedule: store.tree?.schedule,
            activeClassIdsByDate: store.tree?.activeClassIdsByDate
        ) else { return "" }
        return NaturalWhen.formatNextClassWhen(
            dateKey: next.dateKey,
            start: next.start,
            end: next.end,
            use24Hour: use24Hour
        )
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                classHero

                if !liveClass.descriptionText.isEmpty {
                    YLMarkdownText(source: liveClass.descriptionText)
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .ylGlassRounded(cornerRadius: 22, interactive: true)
                }

                if isWide {
                    // Website class page: left TODO + Completed; right Dates + files
                    HStack(alignment: .top, spacing: 14) {
                        VStack(alignment: .leading, spacing: 14) {
                            todosPanel
                            completedClassPanel
                        }
                        .frame(maxWidth: .infinity, alignment: .topLeading)

                        VStack(alignment: .leading, spacing: 14) {
                            datesPanel
                            classFilesPanel
                            classCommentsPanel
                        }
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                    }
                } else {
                    todosPanel
                    datesPanel
                    classFilesPanel
                    classCommentsPanel
                    completedClassPanel
                }
            }
            .padding(.horizontal, isWide ? 28 : 16)
            .padding(.vertical, 12)
            .adaptiveReadableWidth(AdaptiveLayout.pageMaxWidth, enabled: isWide)
        }
        .educationTabReselectScroll(isActive: educationFocus.isShowingClass(cls.id))
        .ylPageBackground()
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: classArchiveTaskId) {
            await waitForClassTodoArchive()
        }
        .toolbar {
            if store.workspace != "jype", let url = liveClass.canvasURL {
                ToolbarItem(placement: .topBarTrailing) {
                    CanvasToolbarButton(webURL: url, scoreLabel: liveClass.scoreLabel)
                }
            }
        }
        .refreshable {
            guard let token = auth.session?.token else { return }
            await store.load(token: token, live: true)
        }
    }

    private var classHero: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if let period = liveClass.period, !period.isEmpty {
                    Text(period.uppercased())
                        .font(.largeTitle.weight(.bold))
                        .foregroundStyle(YLTheme.accent(colorScheme, palette: palette))
                }
                Text(liveClass.displayName)
                    .font(.largeTitle.weight(.bold))
                    .foregroundStyle(YLTheme.fg(colorScheme))
            }
            if !nextWhen.isEmpty {
                Text(nextWhen)
                    .font(.subheadline)
                    .foregroundStyle(YLTheme.muted(colorScheme))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 4)
        .accessibilityElement(children: .combine)
    }

    private var classTodos: [EducationTodo] {
        liveClass.pageTodos.map { $0.withClassId(liveClass.id) }
    }

    private var classSchedule: EducationSchedule? { store.tree?.schedule }
    private var classActiveIds: [String: [String]]? { store.tree?.activeClassIdsByDate }

    private var classAsOf: Date { max(archiveNow, Date()) }

    private func classTodoStaysOpen(_ todo: EducationTodo) -> Bool {
        EducationScheduleHelper.classTodoStaysInOpenList(
            todo: todo,
            cls: liveClass,
            schedule: classSchedule,
            activeClassIdsByDate: classActiveIds,
            asOf: classAsOf
        )
    }

    private var classArchiveTaskId: String {
        classTodos
            .filter { $0.done == true && classTodoStaysOpen($0) }
            .map(\.id)
            .sorted()
            .joined(separator: ",")
    }

    private func waitForClassTodoArchive() async {
        guard let fire = EducationScheduleHelper.nextClassTodoArchiveDate(
            todos: classTodos,
            cls: liveClass,
            schedule: classSchedule,
            activeClassIdsByDate: classActiveIds,
            asOf: Date()
        ) else { return }
        let delay = fire.timeIntervalSinceNow + 0.25
        if delay <= 0 {
            archiveNow = Date()
            return
        }
        do {
            try await Task.sleep(for: .seconds(delay))
        } catch {
            return
        }
        archiveNow = Date()
    }

    private func filteredClassTodos(done: Bool) -> [EducationTodo] {
        classTodos.filter { todo in
            (store.workspace == "jype" || todoTypeFilters.contains(todo.filterTagKey)) &&
                (done
                    ? todo.done == true && !classTodoStaysOpen(todo)
                    : todo.done != true || classTodoStaysOpen(todo))
        }
    }

    private var visibleOpenClassTodos: [EducationTodo] {
        let open = filteredClassTodos(done: false)
            .sorted { $0.dueSortKey < $1.dueSortKey }
        if todoExpanded { return open }
        return Array(open.prefix(Self.collapsedTodoLimit))
    }

    private var doneClassTodos: [EducationTodo] {
        EducationTodo.sortedCompleted(filteredClassTodos(done: true))
    }

    private var todosPanel: some View {
        EducationTodoPanel(
            title: "TODO",
            todos: visibleOpenClassTodos,
            expanded: todoExpanded,
            typeFilters: todoTypeFilters,
            use24Hour: use24Hour,
            showClass: true,
            onToggleExpanded: {
                withAnimation(.easeInOut(duration: 0.22)) {
                    todoExpanded.toggle()
                }
            },
            onToggleFilter: toggleTodoFilter,
            className: { className(for: $0) },
            onToggleDone: toggleDone,
            showFilters: store.workspace != "jype"
        )
    }

    private var completedClassPanel: some View {
        EducationCompletedPanel(
            todos: doneClassTodos,
            expanded: completedExpanded,
            use24Hour: use24Hour,
            showClass: true,
            onToggleExpanded: {
                withAnimation(.easeInOut(duration: 0.22)) {
                    completedExpanded.toggle()
                }
            },
            className: { className(for: $0) },
            onToggleDone: toggleDone
        )
    }

    private var datesPanel: some View {
        EducationDatesPanel(
            items: visibleClassDateItems,
            expanded: datesExpanded,
            dateFilters: dateFilters,
            filterKeys: EducationDateFilter.classKeys,
            use24Hour: use24Hour,
            onToggleExpanded: {
                withAnimation(.easeInOut(duration: 0.22)) {
                    datesExpanded.toggle()
                }
            },
            onToggleFilter: toggleDateFilter,
            showFilters: store.workspace != "jype"
        )
    }

    @ViewBuilder
    private var classCommentsPanel: some View {
        let all = classCommentEntries
        if !all.isEmpty {
            EducationCommentsBox(
                entries: commentsExpanded ? all : Array(all.prefix(3)),
                expandable: true,
                expanded: commentsExpanded,
                onToggle: {
                    withAnimation(.easeInOut(duration: 0.22)) {
                        commentsExpanded.toggle()
                    }
                },
                use24Hour: use24Hour
            )
        }
    }

    private var classCommentEntries: [EducationCommentEntry] {
        classTodos.flatMap { todo in
            EducationCommentWhen.sorted(todo.canvasComments ?? []).map {
                EducationCommentEntry(comment: $0, todo: todo)
            }
        }
        .sorted { a, b in
            if a.createdAt != b.createdAt { return a.createdAt > b.createdAt }
            return a.id > b.id
        }
    }

    @ViewBuilder
    private var classFilesPanel: some View {
        let files = liveClass.files ?? []
        if !files.isEmpty {
            EducationContextFilesView(
                files: files,
                owner: EducationFileOwner(scope: "class", id: liveClass.id),
                store: store
            )
        }
    }

    private var visibleClassDateItems: [EducationDateItem] {
        EducationDateHelpers.visibleItems(
            EducationDateHelpers.collectItems(from: store.tree, classId: liveClass.id),
            filters: dateFilters,
            expanded: datesExpanded,
            todayKey: store.tree?.todayKey
        )
    }

    private func className(for todo: EducationTodo) -> String? {
        liveClass.contextDisplayName
    }

    private func toggleTodoFilter(_ tag: String) {
        if todoTypeFilters.contains(tag) {
            todoTypeFilters.remove(tag)
        } else {
            todoTypeFilters.insert(tag)
        }
        if todoTypeFilters.isEmpty {
            todoTypeFilters = EducationTodoFilter.allTags
        }
        EducationTodoFilter.save(todoTypeFilters)
    }

    private func toggleDateFilter(_ key: String) {
        if dateFilters.contains(key) {
            dateFilters.remove(key)
        } else {
            dateFilters.insert(key)
        }
        if dateFilters.isEmpty {
            dateFilters = Set(EducationDateFilter.classKeys)
        }
        EducationDateFilter.save(dateFilters)
    }

    private func toggleDone(_ todo: EducationTodo) {
        guard let token = auth.session?.token else { return }
        let next = !(todo.done == true)
        Task {
            await store.setTodoDone(
                id: todo.todoId,
                done: next,
                classId: todo.classId ?? liveClass.id,
                projectId: todo.projectId,
                token: token
            )
        }
    }

    private func eduPanel<Content: View>(title: String, dimmed: Bool = false, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.title3.weight(.bold))
                .foregroundStyle(YLTheme.fg(colorScheme))
            content()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .ylGlassRounded(cornerRadius: 22, interactive: true)
        .opacity(dimmed ? 0.55 : 1)
    }

    private func emptyRow(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(YLTheme.muted(colorScheme))
            .padding(.vertical, 6)
    }
}

// MARK: - Project detail

struct ProjectDetailView: View {
    let project: EducationProject
    @ObservedObject var store: EducationStore
    var use24Hour: Bool = false
    @EnvironmentObject private var auth: AuthStore
    @EnvironmentObject private var educationFocus: EducationFocusStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.colorScheme) private var colorScheme

    @State private var todoExpanded = false
    /// Completed starts open. Collapse only after a tap.
    @State private var completedExpanded = true
    @State private var todoTypeFilters: Set<String> = EducationTodoFilter.load()
    @State private var datesExpanded = false
    @State private var dateFilters: Set<String> = EducationDateFilter.load()

    private static let collapsedTodoLimit = 6

    private var isWide: Bool {
        AdaptiveLayout.isWideLayout(
            horizontalSizeClass: horizontalSizeClass,
            verticalSizeClass: verticalSizeClass
        )
    }

    private var liveProject: EducationProject {
        store.tree?.projects?.first(where: { $0.id == project.id }) ?? project
    }

    private var projectTodos: [EducationTodo] {
        (liveProject.todos ?? []).map { $0.withProjectId(liveProject.id) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text(liveProject.displayName)
                    .font(.largeTitle.weight(.bold))
                    .foregroundStyle(YLTheme.fg(colorScheme))
                    .frame(maxWidth: .infinity, alignment: .leading)

                if !liveProject.descriptionText.isEmpty {
                    YLMarkdownText(source: liveProject.descriptionText)
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .ylGlassRounded(cornerRadius: 22, interactive: true)
                }

                if isWide {
                    HStack(alignment: .top, spacing: 14) {
                        VStack(alignment: .leading, spacing: 14) {
                            todosPanel
                            completedPanel
                        }
                        .frame(maxWidth: .infinity, alignment: .topLeading)

                        VStack(alignment: .leading, spacing: 14) {
                            datesPanel
                            projectFilesPanel
                        }
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                    }
                } else {
                    todosPanel
                    datesPanel
                    projectFilesPanel
                    completedPanel
                }
            }
            .padding(.horizontal, isWide ? 28 : 16)
            .padding(.vertical, 12)
            .adaptiveReadableWidth(AdaptiveLayout.pageMaxWidth, enabled: isWide)
        }
        .educationTabReselectScroll(isActive: educationFocus.isShowingProject(project.id))
        .ylPageBackground()
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            guard let token = auth.session?.token else { return }
            await store.load(token: token, live: true)
        }
        .onAppear {
            Task { await store.markProjectOpened(id: project.id, token: auth.session?.token) }
        }
    }

    private var visibleOpenTodos: [EducationTodo] {
        let open = filteredTodos(done: false).sorted { $0.dueSortKey < $1.dueSortKey }
        if todoExpanded { return open }
        return Array(open.prefix(Self.collapsedTodoLimit))
    }

    private func filteredTodos(done: Bool) -> [EducationTodo] {
        projectTodos.filter { todo in
            (todo.done == true) == done &&
                (store.workspace == "jype" || todoTypeFilters.contains(todo.filterTagKey))
        }
    }

    private var todosPanel: some View {
        EducationTodoPanel(
            title: "TODO",
            todos: visibleOpenTodos,
            expanded: todoExpanded,
            typeFilters: todoTypeFilters,
            use24Hour: use24Hour,
            showClass: false,
            onToggleExpanded: {
                withAnimation(.easeInOut(duration: 0.22)) {
                    todoExpanded.toggle()
                }
            },
            onToggleFilter: toggleTodoFilter,
            className: { _ in nil },
            onToggleDone: toggleDone,
            showFilters: store.workspace != "jype"
        )
    }

    private var completedPanel: some View {
        EducationCompletedPanel(
            todos: EducationTodo.sortedCompleted(filteredTodos(done: true)),
            expanded: completedExpanded,
            use24Hour: use24Hour,
            showClass: false,
            onToggleExpanded: {
                withAnimation(.easeInOut(duration: 0.22)) {
                    completedExpanded.toggle()
                }
            },
            className: { _ in nil },
            onToggleDone: toggleDone
        )
    }

    private var datesPanel: some View {
        EducationDatesPanel(
            items: visibleProjectDateItems,
            expanded: datesExpanded,
            dateFilters: dateFilters,
            filterKeys: EducationDateFilter.projectKeys,
            use24Hour: use24Hour,
            onToggleExpanded: {
                withAnimation(.easeInOut(duration: 0.22)) {
                    datesExpanded.toggle()
                }
            },
            onToggleFilter: toggleDateFilter,
            showFilters: store.workspace != "jype"
        )
    }

    @ViewBuilder
    private var projectFilesPanel: some View {
        let files = liveProject.files ?? []
        if !files.isEmpty {
            EducationContextFilesView(
                files: files,
                owner: EducationFileOwner(scope: "project", id: liveProject.id),
                store: store
            )
        }
    }

    private var visibleProjectDateItems: [EducationDateItem] {
        EducationDateHelpers.visibleItems(
            EducationDateHelpers.collectItems(from: store.tree, projectId: liveProject.id),
            filters: dateFilters,
            expanded: datesExpanded,
            todayKey: store.tree?.todayKey
        )
    }

    private func toggleTodoFilter(_ tag: String) {
        if todoTypeFilters.contains(tag) {
            todoTypeFilters.remove(tag)
        } else {
            todoTypeFilters.insert(tag)
        }
        if todoTypeFilters.isEmpty {
            todoTypeFilters = EducationTodoFilter.allTags
        }
        EducationTodoFilter.save(todoTypeFilters)
    }

    private func toggleDateFilter(_ key: String) {
        if dateFilters.contains(key) {
            dateFilters.remove(key)
        } else {
            dateFilters.insert(key)
        }
        if dateFilters.isEmpty {
            dateFilters = Set(EducationDateFilter.projectKeys)
        }
        EducationDateFilter.save(dateFilters)
    }

    private func toggleDone(_ todo: EducationTodo) {
        guard let token = auth.session?.token else { return }
        let next = !(todo.done == true)
        Task {
            await store.setTodoDone(
                id: todo.todoId,
                done: next,
                classId: todo.classId,
                projectId: todo.projectId ?? liveProject.id,
                token: token
            )
        }
    }

    private func eduPanel<Content: View>(title: String, dimmed: Bool = false, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.title3.weight(.bold))
                .foregroundStyle(YLTheme.fg(colorScheme))
            content()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .ylGlassRounded(cornerRadius: 22, interactive: true)
        .opacity(dimmed ? 0.55 : 1)
    }

    private func emptyRow(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(YLTheme.muted(colorScheme))
            .padding(.vertical, 6)
    }
}

// MARK: - Date detail

struct DateDetailView: View {
    let date: EducationDate
    @ObservedObject var store: EducationStore
    var use24Hour: Bool = false
    @EnvironmentObject private var auth: AuthStore
    @EnvironmentObject private var educationFocus: EducationFocusStore
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    private var isWide: Bool {
        AdaptiveLayout.isWideLayout(
            horizontalSizeClass: horizontalSizeClass,
            verticalSizeClass: verticalSizeClass
        )
    }

    private var liveDate: EducationDate {
        EducationDateHelpers.date(id: date.id, from: store.tree) ?? date
    }

    private var contextName: String? {
        EducationDateHelpers.contextName(for: liveDate, in: store.tree)
    }

    private var when: String {
        NaturalWhen.formatDetail(
            date: liveDate.date,
            time: liveDate.time,
            use24Hour: use24Hour
        )
    }

    private var descriptionText: String {
        let detail = (liveDate.detail ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !detail.isEmpty { return detail }
        return (liveDate.notes ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text(liveDate.displayName)
                    .font(.largeTitle.weight(.bold))
                    .foregroundStyle(YLTheme.fg(colorScheme))
                    .frame(maxWidth: .infinity, alignment: .leading)

                VStack(alignment: .leading, spacing: 14) {
                    if !when.isEmpty {
                        Text(when)
                            .font(.subheadline)
                            .foregroundStyle(YLTheme.muted(colorScheme))
                    }

                    if let contextName {
                        Text(contextName)
                            .font(.subheadline)
                            .foregroundStyle(YLTheme.muted(colorScheme))
                    }

                    if descriptionText.isEmpty {
                        Text("No description")
                            .font(.subheadline)
                            .foregroundStyle(YLTheme.muted(colorScheme))
                    } else {
                        YLMarkdownText(source: descriptionText)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .ylGlassRounded(cornerRadius: 22, interactive: true)

                dateFilesPanel
            }
            .padding(.horizontal, isWide ? 28 : 16)
            .padding(.vertical, 12)
            .adaptiveReadableWidth(AdaptiveLayout.pageMaxWidth, enabled: isWide)
        }
        .educationTabReselectScroll(isActive: educationFocus.isShowingDate(date.id))
        .ylPageBackground()
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let url = liveDate.canvasURL {
                ToolbarItem(placement: .topBarTrailing) {
                    CanvasToolbarButton(webURL: url)
                }
            }
        }
        .refreshable {
            guard let token = auth.session?.token else { return }
            await store.load(token: token, live: true)
        }
    }

    @ViewBuilder
    private var dateFilesPanel: some View {
        let files = liveDate.files ?? []
        if !files.isEmpty {
            EducationContextFilesView(
                files: files,
                owner: EducationFileOwner(
                    scope: "date",
                    id: liveDate.dateId,
                    classId: liveDate.classId,
                    projectId: liveDate.projectId
                ),
                pairColumns: isWide,
                store: store
            )
        }
    }
}

// MARK: - Todo detail

struct TodoDetailView: View {
    let todo: EducationTodo
    @ObservedObject var store: EducationStore
    var use24Hour: Bool = false
    @EnvironmentObject private var auth: AuthStore
    @EnvironmentObject private var educationFocus: EducationFocusStore
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    private var isWide: Bool {
        AdaptiveLayout.isWideLayout(
            horizontalSizeClass: horizontalSizeClass,
            verticalSizeClass: verticalSizeClass
        )
    }

    private var liveTodo: EducationTodo {
        EducationTodoHelpers.todo(id: todo.id, from: store.tree) ?? todo
    }

    private var className: String? {
        EducationTodoHelpers.className(for: liveTodo, in: store.tree)
    }

    private var when: String {
        NaturalWhen.formatDetail(
            date: liveTodo.dueDateValue,
            time: liveTodo.dueTimeValue,
            use24Hour: use24Hour
        )
    }

    private var descriptionText: String {
        let detail = (liveTodo.detail ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !detail.isEmpty { return detail }
        return (liveTodo.notes ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                EducationTodoTitle(todo: liveTodo, font: .largeTitle.weight(.bold))
                    .frame(maxWidth: .infinity, alignment: .leading)

                VStack(alignment: .leading, spacing: 14) {
                    HStack(alignment: .center, spacing: 12) {
                        EducationTodoCheckbox(done: liveTodo.done == true) {
                            toggleDone()
                        }
                        Text(liveTodo.done == true ? "Done" : "Open")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(YLTheme.fg(colorScheme))
                        Spacer(minLength: 0)
                    }

                    if !when.isEmpty {
                        Text(when)
                            .font(.subheadline)
                            .foregroundStyle(YLTheme.muted(colorScheme))
                    }

                    if let className {
                        Text(className)
                            .font(.subheadline)
                            .foregroundStyle(YLTheme.muted(colorScheme))
                    }

                    if !liveTodo.isDailyBriefing {
                        if descriptionText.isEmpty {
                            Text("No description")
                                .font(.subheadline)
                                .foregroundStyle(YLTheme.muted(colorScheme))
                        } else {
                            YLMarkdownText(source: descriptionText)
                        }
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .ylGlassRounded(cornerRadius: 22, interactive: true)

                if liveTodo.isDailyBriefing {
                    let capsules = liveTodo.capsules ?? []
                    if capsules.isEmpty {
                        Text("Briefing is still compiling.")
                            .font(.subheadline)
                            .foregroundStyle(YLTheme.muted(colorScheme))
                            .padding(16)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .ylGlassRounded(cornerRadius: 22, interactive: true)
                    } else {
                        ForEach(capsules) { capsule in
                            EducationBriefingCapsule(
                                capsule: capsule,
                                todo: liveTodo,
                                navigates: true,
                                onVote: { value in
                                    toggleCapsuleVote(capsule, value)
                                }
                            )
                        }
                        let cites = liveTodo.overallCitations
                        if !cites.isEmpty {
                            EducationCitationsBox(citations: cites)
                        }
                    }
                }

                todoLower
            }
            .padding(.horizontal, isWide ? 28 : 16)
            .padding(.vertical, 12)
            .adaptiveReadableWidth(AdaptiveLayout.pageMaxWidth, enabled: isWide)
        }
        .educationTabReselectScroll(isActive: educationFocus.isShowingTodo(todo.id))
        .ylPageBackground()
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let url = liveTodo.canvasURL {
                ToolbarItem(placement: .topBarTrailing) {
                    CanvasToolbarButton(webURL: url, scoreLabel: liveTodo.scoreLabel)
                }
            }
        }
        .refreshable {
            guard let token = auth.session?.token else { return }
            await store.load(token: token, live: true)
        }
    }

    @ViewBuilder
    private func todoFiles(pairColumns: Bool) -> some View {
        let files = liveTodo.files ?? []
        if !files.isEmpty {
            EducationContextFilesView(
                files: files,
                owner: EducationFileOwner(
                    scope: "todo",
                    id: liveTodo.todoId,
                    classId: liveTodo.classId,
                    projectId: liveTodo.projectId
                ),
                pairColumns: pairColumns,
                store: store
            )
        }
    }

    @ViewBuilder
    private var todoLower: some View {
        let files = liveTodo.files ?? []
        let comments = EducationCommentWhen.sorted(liveTodo.canvasComments ?? [])
        if comments.isEmpty {
            todoFiles(pairColumns: isWide)
        } else if isWide && !files.isEmpty {
            HStack(alignment: .top, spacing: 14) {
                todoFiles(pairColumns: false)
                    .frame(maxWidth: .infinity, alignment: .leading)
                EducationCommentsBox(
                    entries: comments.map {
                        EducationCommentEntry(comment: $0, todo: nil, canvasURL: liveTodo.canvasURL)
                    },
                    use24Hour: use24Hour
                )
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            EducationCommentsBox(
                entries: comments.map {
                    EducationCommentEntry(comment: $0, todo: nil, canvasURL: liveTodo.canvasURL)
                },
                use24Hour: use24Hour
            )
            if !files.isEmpty {
                todoFiles(pairColumns: false)
            }
        }
    }

    private func toggleDone() {
        guard let token = auth.session?.token else { return }
        let next = !(liveTodo.done == true)
        Task {
            await store.setTodoDone(
                id: liveTodo.todoId,
                done: next,
                classId: liveTodo.classId,
                projectId: liveTodo.projectId,
                token: token
            )
        }
    }

    private func toggleCapsuleVote(_ capsule: EducationCapsule, _ value: String) {
        guard let token = auth.session?.token else { return }
        let next: String? = capsule.voteKey == value ? nil : value
        Task {
            await store.setCapsuleVote(
                todoId: liveTodo.todoId,
                capsuleId: capsule.id,
                vote: next,
                classId: liveTodo.classId,
                projectId: liveTodo.projectId,
                token: token
            )
        }
    }
}

/// Opens Canvas Student (`canvas-courses://`) when installed, otherwise Safari.
private struct CanvasToolbarButton: View {
    let webURL: URL
    var scoreLabel: String = ""
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.ylPalette) private var palette

    var body: some View {
        Button {
            open()
        } label: {
            Group {
                if scoreLabel.isEmpty {
                    Image("CanvasMark")
                        .renderingMode(.template)
                        .resizable()
                        .scaledToFit()
                        .frame(width: 18, height: 18)
                        .foregroundStyle(YLTheme.fg(colorScheme))
                } else {
                    Text(scoreLabel)
                        .font(.system(size: scoreLabel.count > 6 ? 9 : 11, weight: .bold))
                        .foregroundStyle(YLTheme.accent(colorScheme, palette: palette))
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .padding(.horizontal, 2)
                }
            }
            .frame(width: 36, height: 36)
            .contentShape(Circle())
            .modifier(CanvasToolbarChrome())
        }
        .buttonStyle(.plain)
        .ylHapticOnTap()
        .accessibilityLabel(scoreLabel.isEmpty ? "Open in Canvas" : "Open in Canvas, \(scoreLabel)")
    }

    private func open() {
        CanvasLMS.open(webURL)
    }
}

extension CanvasLMS {
    /// Canvas Student when installed, otherwise Safari.
    static func open(_ webURL: URL) {
        if let appURL = studentAppURL(from: webURL),
           UIApplication.shared.canOpenURL(appURL)
        {
            UIApplication.shared.open(appURL, options: [:]) { ok in
                if !ok { UIApplication.shared.open(webURL) }
            }
            return
        }
        UIApplication.shared.open(webURL)
    }
}

/// Row-view grade. Same destination as the Canvas circle on the object page.
private struct EducationCanvasScoreButton: View {
    let label: String
    let url: URL?
    var topPadding: CGFloat = 0
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.ylPalette) private var palette

    var body: some View {
        if label.isEmpty {
            EmptyView()
        } else if let url {
            Button {
                CanvasLMS.open(url)
            } label: {
                scoreText
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .ylHapticOnTap()
            .accessibilityLabel("Open in Canvas, \(label)")
        } else {
            scoreText
        }
    }

    private var scoreText: some View {
        Text(label)
            .font(.caption.weight(.bold))
                        .foregroundStyle(YLTheme.accent(colorScheme, palette: palette))
            .monospacedDigit()
            .strikethrough(false)
            .padding(.top, topPadding)
    }
}

/// iOS 26 toolbar already draws one glass circle — don't nest another.
private struct CanvasToolbarChrome: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content
        } else {
            content.glassCircle(interactive: true)
        }
    }
}

// MARK: - Shared todo UI

/// Dimmed completed list. Starts expanded. Collapsed shows 6. No type filters.
private struct EducationCompletedPanel: View {
    let todos: [EducationTodo]
    let expanded: Bool
    let use24Hour: Bool
    let showClass: Bool
    let onToggleExpanded: () -> Void
    let className: (EducationTodo) -> String?
    let onToggleDone: (EducationTodo) -> Void

    private static let collapsedLimit = 6

    @Environment(\.colorScheme) private var colorScheme

    private var visible: [EducationTodo] {
        expanded ? todos : Array(todos.prefix(Self.collapsedLimit))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                YLHaptics.tap()
                onToggleExpanded()
            } label: {
                Text("Completed")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(YLTheme.fg(colorScheme))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(expanded ? "Collapse completed" : "Expand completed")

            if visible.isEmpty {
                Text("Nothing here")
                    .font(.subheadline)
                    .foregroundStyle(YLTheme.muted(colorScheme))
                    .padding(.vertical, 6)
            } else {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(visible.enumerated()), id: \.element.id) { index, todo in
                        VStack(alignment: .leading, spacing: 0) {
                            if showsDaySeparator(before: index) {
                                EducationTodoDaySeparator()
                            }
                            EducationTodoRow(
                                todo: todo,
                                className: showClass ? className(todo) : nil,
                                use24Hour: use24Hour,
                                onToggleDone: { onToggleDone(todo) }
                            )
                        }
                    }
                    .animation(.spring(response: 0.42, dampingFraction: 0.86), value: visible.map(\.id))
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .ylGlassRounded(cornerRadius: 22, interactive: true)
        .opacity(0.55)
    }

    /// Hairline when the due day changes. Completion time does not count.
    private func showsDaySeparator(before index: Int) -> Bool {
        guard index > 0, index < visible.count else { return false }
        return Self.dayKey(visible[index - 1]) != Self.dayKey(visible[index])
    }

    private static func dayKey(_ todo: EducationTodo) -> String {
        todo.dueDateValue ?? ""
    }
}

private struct EducationTodoPanel: View {
    let title: String
    let todos: [EducationTodo]
    let expanded: Bool
    let typeFilters: Set<String>
    let use24Hour: Bool
    let showClass: Bool
    let onToggleExpanded: () -> Void
    let onToggleFilter: (String) -> Void
    let className: (EducationTodo) -> String?
    let onToggleDone: (EducationTodo) -> Void
    var showFilters: Bool = true

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 8) {
                Button {
                    YLHaptics.tap()
                    onToggleExpanded()
                } label: {
                    Text(title)
                        .font(.title3.weight(.bold))
                        .foregroundStyle(YLTheme.fg(colorScheme))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(expanded ? "Collapse todos" : "Expand todos")
                .accessibilityHint("Shows all todos and type filters when expanded")

                if expanded && showFilters {
                    Spacer(minLength: 8)
                    EducationTodoFilterBar(typeFilters: typeFilters, onToggle: onToggleFilter)
                }
            }

            LazyVStack(alignment: .leading, spacing: 0) {
                if todos.isEmpty {
                    Text("Nothing here")
                        .font(.subheadline)
                        .foregroundStyle(YLTheme.muted(colorScheme))
                        .padding(.vertical, 6)
                } else {
                    ForEach(Array(todos.enumerated()), id: \.element.id) { index, todo in
                        VStack(alignment: .leading, spacing: 0) {
                            if showsDaySeparator(before: index) {
                                EducationTodoDaySeparator()
                            }
                            EducationTodoRow(
                                todo: todo,
                                className: showClass ? className(todo) : nil,
                                use24Hour: use24Hour,
                                onToggleDone: { onToggleDone(todo) }
                            )
                        }
                    }
                    .animation(.spring(response: 0.42, dampingFraction: 0.86), value: todos.map(\.id))
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .ylGlassRounded(cornerRadius: 22, interactive: true)
    }

    private func showsDaySeparator(before index: Int) -> Bool {
        guard index > 0, index < todos.count else { return false }
        return Self.dayKey(todos[index - 1]) != Self.dayKey(todos[index])
    }

    private static func dayKey(_ todo: EducationTodo) -> String {
        todo.dueDateValue ?? ""
    }
}

private struct EducationTodoDaySeparator: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Rectangle()
            .fill(YLTheme.fg(colorScheme).opacity(0.12))
            .frame(height: 1)
            .padding(.horizontal, 8)
            .padding(.vertical, 8)
            .accessibilityHidden(true)
    }
}

private struct EducationDatesPanel: View {
    let items: [EducationDateItem]
    let expanded: Bool
    let dateFilters: Set<String>
    let filterKeys: [String]
    let use24Hour: Bool
    let onToggleExpanded: () -> Void
    let onToggleFilter: (String) -> Void
    var showFilters: Bool = true

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 8) {
                Button {
                    YLHaptics.tap()
                    onToggleExpanded()
                } label: {
                    Text("Dates")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(YLTheme.fg(colorScheme))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(expanded ? "Collapse dates" : "Expand dates")
                .accessibilityHint("Shows all dates and filters when expanded")

                if expanded && showFilters {
                    Spacer(minLength: 8)
                    EducationDateFilterBar(
                        keys: filterKeys,
                        dateFilters: dateFilters,
                        onToggle: onToggleFilter
                    )
                }
            }

            LazyVStack(alignment: .leading, spacing: 0) {
                if items.isEmpty {
                    Text("Nothing here")
                        .font(.subheadline)
                        .foregroundStyle(YLTheme.muted(colorScheme))
                        .padding(.vertical, 6)
                } else {
                    ForEach(items) { item in
                        EducationDateItemRow(item: item, use24Hour: use24Hour)
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .ylGlassRounded(cornerRadius: 22, interactive: true)
    }
}

private struct EducationDateItemRow: View {
    let item: EducationDateItem
    let use24Hour: Bool
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Group {
                if let todo = item.todoValue {
                    // Todos in Dates deep-link to the normal todo detail (never /date/).
                    NavigationLink(value: EducationRoute.todoDetail(todo)) {
                        rowLabel
                    }
                    .buttonStyle(.plain)
                    .ylHapticNavigation()
                } else if let date = item.dateValue {
                    NavigationLink(value: EducationRoute.dateDetail(date)) {
                        rowLabel
                    }
                    .buttonStyle(.plain)
                    .ylHapticNavigation()
                } else {
                    rowLabel
                }
            }
            if let todo = item.todoValue {
                EducationCanvasScoreButton(
                    label: todo.scoreLabel,
                    url: todo.canvasURL,
                    topPadding: 2
                )
            }
        }
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    private var rowLabel: some View {
        let when = NaturalWhen.format(date: item.date, time: item.time, use24Hour: use24Hour)
        return VStack(alignment: .leading, spacing: 4) {
            if let todo = item.todoValue {
                EducationTodoTitle(todo: todo, font: .body.weight(.semibold))
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text(item.name)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(YLTheme.fg(colorScheme))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            HStack(spacing: 8) {
                if let className = item.className, !className.isEmpty {
                    Text(className)
                        .font(.caption)
                        .foregroundStyle(YLTheme.muted(colorScheme))
                } else if let projectName = item.projectName, !projectName.isEmpty {
                    Text(projectName)
                        .font(.caption)
                        .foregroundStyle(YLTheme.muted(colorScheme))
                }
                if !when.isEmpty {
                    Text(when)
                        .font(.caption)
                        .foregroundStyle(YLTheme.muted(colorScheme))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

private struct EducationTodoFilterBar: View {
    let typeFilters: Set<String>
    let onToggle: (String) -> Void
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.ylPalette) private var palette

    var body: some View {
        HStack(spacing: 6) {
            ForEach(EducationTodoFilter.orderedTags, id: \.self) { tag in
                let on = typeFilters.contains(tag)
                Button {
                    YLHaptics.tap()
                    onToggle(tag)
                } label: {
                    Text(tag == "none" ? "·" : tag)
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(on ? Color.white : YLTheme.muted(colorScheme))
                        .frame(width: 32, height: 32)
                        // UIGlassEffect.tintColor (not SwiftUI .tint) so selected
                        // fill is opaque enough for white labels — same as Fitness.
                        .glassCircle(
                            interactive: true,
                            tint: on ? EducationFilterChrome.selectedTint(colorScheme, palette: palette) : nil
                        )
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tag == "none" ? "none" : tag)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Type filters")
    }
}

private struct EducationDateFilterBar: View {
    let keys: [String]
    let dateFilters: Set<String>
    let onToggle: (String) -> Void
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.ylPalette) private var palette

    var body: some View {
        HStack(spacing: 6) {
            ForEach(keys, id: \.self) { key in
                let on = dateFilters.contains(key)
                Button {
                    YLHaptics.tap()
                    onToggle(key)
                } label: {
                    Group {
                        if key == "class" {
                            Image(systemName: "graduationcap.fill")
                                .font(.system(size: 11, weight: .bold))
                        } else if key == "ma" {
                            Text("MA")
                                .font(.system(size: 11, weight: .bold))
                        } else {
                            Text("·")
                                .font(.system(size: 11, weight: .bold))
                        }
                    }
                    .foregroundStyle(on ? Color.white : YLTheme.muted(colorScheme))
                    .frame(width: 32, height: 32)
                    .glassCircle(
                        interactive: true,
                        tint: on ? EducationFilterChrome.selectedTint(colorScheme, palette: palette) : nil
                    )
                    .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(
                    key == "ma" ? "MA" : key == "class" ? "class" : "none"
                )
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Date filters")
    }
}

/// Selected filter fill matches website `.edu-filter.is-on` tint opacities.
private enum EducationFilterChrome {
    static func selectedTint(_ scheme: ColorScheme, palette: YLPalette = .standard) -> Color {
        YLTheme.accent(scheme, palette: palette).opacity(scheme == .dark ? 0.55 : 0.72)
    }
}

private struct EducationCommentEntry: Identifiable {
    let id: Int
    let createdAt: String
    let text: String
    let todo: EducationTodo?
    let canvasURL: URL?

    init(comment: EducationCanvasComment, todo: EducationTodo?, canvasURL: URL? = nil) {
        id = comment.id
        createdAt = comment.createdAt
        text = comment.comment
        self.todo = todo
        self.canvasURL = canvasURL ?? todo?.canvasURL
    }
}

private enum EducationCommentWhen {
    static func sorted(_ comments: [EducationCanvasComment]) -> [EducationCanvasComment] {
        comments
            .filter { !$0.comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .sorted { a, b in
                if a.createdAt != b.createdAt { return a.createdAt > b.createdAt }
                return a.id > b.id
            }
    }

    static func format(_ iso: String, use24Hour: Bool) -> String {
        let trimmed = iso.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let date = parse(trimmed) else { return "" }
        let calendar = Calendar.current
        let dateStr = String(
            format: "%04d-%02d-%02d",
            calendar.component(.year, from: date),
            calendar.component(.month, from: date),
            calendar.component(.day, from: date)
        )
        let timeStr = String(
            format: "%02d:%02d",
            calendar.component(.hour, from: date),
            calendar.component(.minute, from: date)
        )
        return NaturalWhen.formatDetail(date: dateStr, time: timeStr, use24Hour: use24Hour)
    }

    private static func parse(_ iso: String) -> Date? {
        if let date = fractional.date(from: iso) { return date }
        return plain.date(from: iso)
    }

    private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}

private struct EducationCommentsBox: View {
    let entries: [EducationCommentEntry]
    var expandable: Bool = false
    var expanded: Bool = false
    var onToggle: (() -> Void)? = nil
    var use24Hour: Bool = false
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if expandable, let onToggle {
                Button {
                    YLHaptics.tap()
                    onToggle()
                } label: {
                    Text("Comments")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(YLTheme.fg(colorScheme))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(expanded ? "Collapse comments" : "Expand comments")
            } else {
                Text("Comments")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(YLTheme.fg(colorScheme))
            }

            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                    if index > 0 {
                        EducationTodoDaySeparator()
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        if let todo = entry.todo {
                            NavigationLink(value: EducationRoute.todoDetail(todo)) {
                                EducationTodoTitle(todo: todo, font: .subheadline.weight(.semibold))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.plain)
                            .ylHapticNavigation()
                        }
                        let when = EducationCommentWhen.format(entry.createdAt, use24Hour: use24Hour)
                        if !when.isEmpty {
                            Text(when)
                                .font(.subheadline)
                                .foregroundStyle(YLTheme.muted(colorScheme))
                        }
                        commentText(entry)
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .ylGlassRounded(cornerRadius: 22, interactive: true)
    }

    @ViewBuilder
    private func commentText(_ entry: EducationCommentEntry) -> some View {
        let label = Text(entry.text)
            .font(.body)
            .foregroundStyle(YLTheme.fg(colorScheme))
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        if let url = entry.canvasURL {
            Button {
                CanvasLMS.open(url)
            } label: {
                label
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .ylHapticOnTap()
            .accessibilityLabel("Open in Canvas")
        } else {
            label
        }
    }
}

private struct EducationCitationsBox: View {
    let citations: [EducationCitation]
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.ylPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Citations")
                .font(.title3.weight(.bold))
                .foregroundStyle(YLTheme.fg(colorScheme))
            VStack(alignment: .leading, spacing: 8) {
                ForEach(citations) { cite in
                    if let url = cite.link {
                        Link(destination: url) {
                            Text(cite.displayName)
                                .font(.body)
                                .foregroundStyle(YLTheme.accent(colorScheme, palette: palette))
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(.plain)
                        .ylHapticOnTap()
                        .accessibilityLabel(cite.displayName)
                    } else {
                        Text(cite.displayName)
                            .font(.body)
                            .foregroundStyle(YLTheme.fg(colorScheme))
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .ylGlassRounded(cornerRadius: 22, interactive: true)
    }
}

private struct EducationBriefingCapsule: View {
    let capsule: EducationCapsule
    var todo: EducationTodo? = nil
    var navigates: Bool = false
    let onVote: (String) -> Void
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.ylPalette) private var palette

    private var allowsVote: Bool { capsule.noVote != true }
    private var allowsNavigation: Bool { navigates && allowsVote }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            VStack(alignment: .leading, spacing: 8) {
                titleRow(reserveVoteSpace: allowsVote)
                if allowsNavigation, let todo, !capsule.displayBody.isEmpty {
                    NavigationLink(value: EducationRoute.capsuleDetail(todo, capsule)) {
                        bodyContent
                    }
                    .buttonStyle(.plain)
                    .ylHapticNavigation()
                    .accessibilityLabel(capsule.displayTitle)
                    .accessibilityHint("Opens this news story")
                } else {
                    bodyContent
                }
            }
            .padding(.top, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
            if allowsVote {
                voteRow
                    .padding(.top, 16)
                    .padding(.trailing, 16)
                    .zIndex(1)
            }
        }
        // Glass wraps the vote overlay so the chips ride the card wiggle.
        .ylGlassRounded(cornerRadius: 22, interactive: true)
    }

    private func titleRow(reserveVoteSpace: Bool) -> some View {
        HStack(alignment: .bottom, spacing: 8) {
            Text(capsule.displayTitle)
                .font(.title3.weight(.bold))
                .foregroundStyle(YLTheme.fg(colorScheme))
                .frame(maxWidth: .infinity, alignment: .leading)
            if reserveVoteSpace {
                Color.clear
                    .frame(width: 70, height: 32)
            }
        }
        .padding(.horizontal, 16)
        .accessibilityHidden(allowsNavigation)
    }

    @ViewBuilder
    private var bodyContent: some View {
        if !capsule.displayBody.isEmpty {
            Text(capsule.displayBody)
                .font(.body)
                .foregroundStyle(YLTheme.fg(colorScheme))
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
    }

    private var voteRow: some View {
        HStack(spacing: 6) {
            voteChip("hand.thumbsup.fill", value: "up", label: "Thumbs up, more like this")
            voteChip("hand.thumbsdown.fill", value: "down", label: "Thumbs down, less like this")
        }
    }

    private func voteChip(_ symbol: String, value: String, label: String) -> some View {
        let on = capsule.voteKey == value
        return Button {
            YLHaptics.tap()
            onVote(value)
        } label: {
            Image(systemName: symbol)
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(on ? Color.white : YLTheme.muted(colorScheme))
                .ylSizedGlassCircle(
                    side: 32,
                    tint: on ? EducationFilterChrome.selectedTint(colorScheme, palette: palette) : nil
                )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

private struct CapsuleDetailView: View {
    let todo: EducationTodo
    let capsule: EducationCapsule
    @ObservedObject var store: EducationStore
    @EnvironmentObject private var auth: AuthStore
    @EnvironmentObject private var nav: AppNavigationStore
    @EnvironmentObject private var educationFocus: EducationFocusStore
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    private var isWide: Bool {
        AdaptiveLayout.isWideLayout(
            horizontalSizeClass: horizontalSizeClass,
            verticalSizeClass: verticalSizeClass
        )
    }

    private var liveTodo: EducationTodo {
        EducationTodoHelpers.todo(id: todo.id, from: store.tree) ?? todo
    }

    private var liveCapsule: EducationCapsule {
        (liveTodo.capsules ?? []).first(where: { $0.id == capsule.id }) ?? capsule
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text(liveCapsule.displayTitle)
                    .font(.largeTitle.weight(.bold))
                    .foregroundStyle(YLTheme.fg(colorScheme))
                    .frame(maxWidth: .infinity, alignment: .leading)

                EducationBriefingCapsule(
                    capsule: liveCapsule,
                    navigates: false,
                    onVote: { value in
                        toggleCapsuleVote(value)
                    }
                )

                Button {
                    let file = PendingChatAttachment.newsCapsule(todo: liveTodo, capsule: liveCapsule)
                    nav.openPersonalAgent(attaching: [file])
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "chevron.left")
                            .font(.body.weight(.semibold))
                        Text("Clarify with Agent")
                            .font(.body.weight(.semibold))
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(YLTheme.fg(colorScheme))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .ylGlassRounded(cornerRadius: 22, interactive: true)
                }
                .buttonStyle(.plain)
                .ylHapticOnTap()
                .accessibilityLabel("Clarify with Agent")
                .accessibilityHint("Opens Personal Agent with this news attached")

                let cites = liveCapsule.citations
                if !cites.isEmpty {
                    EducationCitationsBox(citations: cites)
                }
            }
            .padding(.horizontal, isWide ? 28 : 16)
            .padding(.vertical, 12)
            .adaptiveReadableWidth(AdaptiveLayout.pageMaxWidth, enabled: isWide)
        }
        .educationTabReselectScroll(isActive: educationFocus.isShowingCapsule(todoId: todo.id, capsuleId: capsule.id))
        .ylPageBackground()
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            guard let token = auth.session?.token else { return }
            await store.load(token: token, live: true)
        }
    }

    private func toggleCapsuleVote(_ value: String) {
        guard let token = auth.session?.token else { return }
        let next: String? = liveCapsule.voteKey == value ? nil : value
        Task {
            await store.setCapsuleVote(
                todoId: liveTodo.todoId,
                capsuleId: liveCapsule.id,
                vote: next,
                classId: liveTodo.classId,
                projectId: liveTodo.projectId,
                token: token
            )
        }
    }
}

private struct EducationTodoRow: View {
    let todo: EducationTodo
    let className: String?
    let use24Hour: Bool
    let onToggleDone: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let when = NaturalWhen.format(
            date: todo.dueDateValue,
            time: todo.dueTimeValue,
            use24Hour: use24Hour
        )
        let hasMeta = className != nil || !when.isEmpty

        HStack(alignment: .top, spacing: 12) {
            EducationTodoCheckbox(done: todo.done == true, action: onToggleDone)
                .padding(.top, 2)

            NavigationLink(value: EducationRoute.todoDetail(todo)) {
                VStack(alignment: .leading, spacing: 4) {
                    EducationTodoTitle(todo: todo, font: .body.weight(.semibold), done: todo.done == true)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    if hasMeta {
                        HStack(spacing: 8) {
                            if let className {
                                Text(className)
                                    .font(.caption)
                                    .foregroundStyle(YLTheme.muted(colorScheme))
                            }
                            if !when.isEmpty {
                                Text(when)
                                    .font(.caption)
                                    .foregroundStyle(YLTheme.muted(colorScheme))
                            }
                        }
                    }
                }
            }
            .buttonStyle(.plain)
            .ylHapticNavigation()

            EducationCanvasScoreButton(
                label: todo.scoreLabel,
                url: todo.canvasURL,
                topPadding: 3
            )
        }
        .padding(.vertical, 8)
    }
}

/// Title with CW/HW/QA/MA in accent at the same size as the name.
private struct EducationTodoTitle: View {
    let todo: EducationTodo
    var font: Font
    var done: Bool = false
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.ylPalette) private var palette

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            if let tag = todo.displayTag {
                Text(tag)
                    .font(font)
                    .foregroundStyle(done ? YLTheme.muted(colorScheme) : YLTheme.accent(colorScheme, palette: palette))
            }
            Text(todo.displayName)
                .font(font)
                .foregroundStyle(YLTheme.fg(colorScheme))
                .strikethrough(done, color: YLTheme.muted(colorScheme))
        }
    }
}

/// Checkbox locked to the title row so class / due meta never vertically shifts it.
private struct EducationTodoCheckbox: View {
    let done: Bool
    let action: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.ylPalette) private var palette

    static let size: CGFloat = 22

    var body: some View {
        Button {
            // Check → haptic; uncheck a done todo stays silent (by design).
            if !done {
                YLHaptics.tap()
            }
            action()
        } label: {
            Image(systemName: done ? "checkmark.circle.fill" : "circle")
                .font(.system(size: Self.size, weight: .medium))
                .foregroundStyle(done ? YLTheme.accent(colorScheme, palette: palette) : YLTheme.muted(colorScheme))
                .frame(width: Self.size, height: Self.size)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .fixedSize()
        .accessibilityLabel(done ? "Mark not done" : "Mark done")
    }
}
