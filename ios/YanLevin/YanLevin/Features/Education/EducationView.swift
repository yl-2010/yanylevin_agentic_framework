import SwiftUI
import UIKit

struct EducationView: View {
    @EnvironmentObject private var auth: AuthStore
    @EnvironmentObject private var educationFocus: EducationFocusStore
    @EnvironmentObject private var nav: AppNavigationStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var store = EducationStore()
    @State private var todoExpanded = false
    @State private var todoTypeFilters: Set<String> = EducationTodoFilter.load()
    @State private var datesExpanded = false
    @State private var dateFilters: Set<String> = EducationDateFilter.load()
    /// Bumped to cancel/restart SSE + polling (same effect as leaving the tab).
    @State private var liveSessionID = 0

    private static let collapsedTodoLimit = 6

    private var liveTaskID: String {
        "\(auth.session?.token ?? "")-\(liveSessionID)"
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
            .navigationTitle("Education")
            .navigationBarTitleDisplayMode(.large)
            .refreshable { await reloadAndRestartLiveSession() }
            .onChange(of: educationFocus.path) { _, path in
                if case .projectDetail(let project) = path.last {
                    Task { await store.markProjectOpened(id: project.id, token: auth.session?.token) }
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
                }
            }
        }
        .task(id: liveTaskID) {
            guard let token = auth.session?.token else { return }
            await store.load(token: token)
            applyEducationTodoHandoff()
            await store.runLiveSession(token: token)
        }
        .onAppear { applyEducationTodoHandoff() }
        .onChange(of: nav.educationTodoHandoff) { _, _ in
            applyEducationTodoHandoff()
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

    @ViewBuilder
    private var educationPanels: some View {
        if store.isLoading && store.tree == nil {
            ProgressView("Loading education…")
                .frame(maxWidth: .infinity, minHeight: 200)
        } else if let err = store.errorText, store.tree == nil {
            ContentUnavailableView("Education unavailable", systemImage: "wifi.exclamationmark", description: Text(err))
        } else if isWide {
            // Website desktop: left = TODO + Completed; right = day1 → Dates → day2 → Projects
            HStack(alignment: .top, spacing: 14) {
                VStack(alignment: .leading, spacing: 14) {
                    todoPanel
                    completedPanel
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)

                VStack(alignment: .leading, spacing: 14) {
                    scheduleAndDatesPanels
                    projectsPanel
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        } else {
            // Website mobile: TODO → day1 → Dates → day2 → Projects → Completed
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

    private var completedPanel: some View {
        eduPanel(title: "Completed", dimmed: true) {
            let done = filteredTodos(done: true)
                .sorted { $0.completedSortKey > $1.completedSortKey }
            if done.isEmpty {
                emptyRow("Nothing here")
            } else {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(done) { todo in
                        todoRow(todo, showClass: true)
                    }
                }
            }
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
            (todo.done == true) == done && todoTypeFilters.contains(todo.filterTagKey)
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
            onToggleDone: toggleDone
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
                        .foregroundStyle(YLTheme.accent(colorScheme))
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
        let row = HStack(spacing: 10) {
            Text(dayClass.period)
                .font(.caption.weight(.bold))
                .foregroundStyle(YLTheme.accent(colorScheme))
                .frame(width: 22, alignment: .leading)
            Text(dayClass.cls.displayName)
                .font(.body.weight(.semibold))
                .foregroundStyle(YLTheme.fg(colorScheme))
            Spacer(minLength: 0)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 8)
        .background {
            if isCurrent {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(YLTheme.accent(colorScheme).opacity(0.12))
            }
        }

        return NavigationLink(value: EducationRoute.classDetail(dayClass.cls)) {
            row
        }
        .buttonStyle(.plain)
        .ylHapticNavigation()
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
        EducationTodoHelpers.flattenTodos(from: store.tree)
    }

    private var todoClassNames: [String: String] {
        var map: [String: String] = [:]
        for cls in store.tree?.classes ?? [] {
            for todo in cls.todos ?? [] {
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
        EducationDateHelpers.visibleItems(
            EducationDateHelpers.collectItems(from: store.tree),
            filters: dateFilters,
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

    private func reload() async {
        guard let token = auth.session?.token else { return }
        await store.load(token: token)
        applyEducationTodoHandoff()
    }

    /// Same as leaving Education and coming back: tear down SSE/polling, reload, restart.
    private func reloadAndRestartLiveSession() async {
        liveSessionID += 1
        await reload()
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

    @State private var todoExpanded = false
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
                        }
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                    }
                } else {
                    todosPanel
                    datesPanel
                    classFilesPanel
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
        .refreshable {
            guard let token = auth.session?.token else { return }
            await store.load(token: token)
        }
    }

    private var classHero: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if let period = liveClass.period, !period.isEmpty {
                    Text(period.uppercased())
                        .font(.largeTitle.weight(.bold))
                        .foregroundStyle(YLTheme.accent(colorScheme))
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
        (liveClass.todos ?? []).map { $0.withClassId(liveClass.id) }
    }

    private func filteredClassTodos(done: Bool) -> [EducationTodo] {
        classTodos.filter { todo in
            (todo.done == true) == done && todoTypeFilters.contains(todo.filterTagKey)
        }
    }

    private var visibleOpenClassTodos: [EducationTodo] {
        let open = filteredClassTodos(done: false)
            .sorted { $0.dueSortKey < $1.dueSortKey }
        if todoExpanded { return open }
        return Array(open.prefix(Self.collapsedTodoLimit))
    }

    private var doneClassTodos: [EducationTodo] {
        filteredClassTodos(done: true)
            .sorted { $0.completedSortKey > $1.completedSortKey }
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
            onToggleDone: toggleDone
        )
    }

    private var completedClassPanel: some View {
        eduPanel(title: "Completed", dimmed: true) {
            if doneClassTodos.isEmpty {
                emptyRow("Nothing here")
            } else {
                ForEach(doneClassTodos) { todo in
                    EducationTodoRow(
                        todo: todo,
                        className: className(for: todo),
                        use24Hour: use24Hour,
                        onToggleDone: { toggleDone(todo) }
                    )
                }
            }
        }
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
            onToggleFilter: toggleDateFilter
        )
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
            await store.load(token: token)
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
            (todo.done == true) == done && todoTypeFilters.contains(todo.filterTagKey)
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
            onToggleDone: toggleDone
        )
    }

    private var completedPanel: some View {
        eduPanel(title: "Completed", dimmed: true) {
            let done = filteredTodos(done: true)
                .sorted { $0.completedSortKey > $1.completedSortKey }
            if done.isEmpty {
                emptyRow("Nothing here")
            } else {
                ForEach(done) { todo in
                    EducationTodoRow(
                        todo: todo,
                        className: nil,
                        use24Hour: use24Hour,
                        onToggleDone: { toggleDone(todo) }
                    )
                }
            }
        }
    }

    private var datesPanel: some View {
        EducationDatesPanel(
            items: visibleProjectDateItems,
            expanded: datesExpanded,
            dateFilters: dateFilters,
            filterKeys: liveProject.id == EducationDateFilter.pathivyProjectId
                ? EducationDateFilter.pathivyKeys
                : EducationDateFilter.projectKeys,
            use24Hour: use24Hour,
            onToggleExpanded: {
                withAnimation(.easeInOut(duration: 0.22)) {
                    datesExpanded.toggle()
                }
            },
            onToggleFilter: toggleDateFilter
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
            dateFilters = Set(
                liveProject.id == EducationDateFilter.pathivyProjectId
                    ? EducationDateFilter.pathivyKeys
                    : EducationDateFilter.projectKeys
            )
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
            await store.load(token: token)
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
                Text(liveTodo.displayName)
                    .font(.largeTitle.weight(.bold))
                    .foregroundStyle(YLTheme.fg(colorScheme))
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

                    if let tag = liveTodo.displayTag {
                        Text(tag)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(YLTheme.accent(colorScheme))
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

                todoFilesPanel
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
                    CanvasToolbarButton(webURL: url)
                }
            }
        }
        .refreshable {
            guard let token = auth.session?.token else { return }
            await store.load(token: token)
        }
    }

    @ViewBuilder
    private var todoFilesPanel: some View {
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
                pairColumns: isWide,
                store: store
            )
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
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Button {
            open()
        } label: {
            Image("CanvasMark")
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .frame(width: 18, height: 18)
                .foregroundStyle(YLTheme.fg(colorScheme))
                .frame(width: 36, height: 36)
                .contentShape(Circle())
                .modifier(CanvasToolbarChrome())
        }
        .buttonStyle(.plain)
        .ylHapticOnTap()
        .accessibilityLabel("Open in Canvas")
    }

    private func open() {
        if let appURL = CanvasLMS.studentAppURL(from: webURL),
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

                if expanded {
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
                    ForEach(todos) { todo in
                        EducationTodoRow(
                            todo: todo,
                            className: showClass ? className(todo) : nil,
                            use24Hour: use24Hour,
                            onToggleDone: { onToggleDone(todo) }
                        )
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .ylGlassRounded(cornerRadius: 22, interactive: true)
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

                if expanded {
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
    }

    private var rowLabel: some View {
        let when = NaturalWhen.format(date: item.date, time: item.time, use24Hour: use24Hour)
        return VStack(alignment: .leading, spacing: 4) {
            Text(item.name)
                .font(.body.weight(.semibold))
                .foregroundStyle(YLTheme.fg(colorScheme))
                .frame(maxWidth: .infinity, alignment: .leading)

            HStack(spacing: 8) {
                if item.isMA {
                    Text("MA")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(YLTheme.accent(colorScheme))
                }
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
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

private struct EducationTodoFilterBar: View {
    let typeFilters: Set<String>
    let onToggle: (String) -> Void
    @Environment(\.colorScheme) private var colorScheme

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
                            tint: on ? EducationFilterChrome.selectedTint(colorScheme) : nil
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
                        } else if key == "pa" {
                            Text("PA")
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
                        tint: on ? EducationFilterChrome.selectedTint(colorScheme) : nil
                    )
                    .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(
                    key == "ma" ? "MA" : key == "pa" ? "PA" : key == "class" ? "class" : "none"
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
    static func selectedTint(_ scheme: ColorScheme) -> Color {
        YLTheme.accent(scheme).opacity(scheme == .dark ? 0.55 : 0.72)
    }
}

private struct EducationCitationsBox: View {
    let citations: [EducationCitation]
    @Environment(\.colorScheme) private var colorScheme

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
                                .foregroundStyle(YLTheme.accent(colorScheme))
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

    private var allowsVote: Bool { capsule.noVote != true }
    private var allowsNavigation: Bool { navigates && allowsVote }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Group {
                if allowsNavigation, let todo {
                    NavigationLink(value: EducationRoute.capsuleDetail(todo, capsule)) {
                        cardContent(reserveVoteSpace: allowsVote)
                    }
                    .buttonStyle(.plain)
                    .ylHapticNavigation()
                    .accessibilityLabel(capsule.displayTitle)
                    .accessibilityHint("Opens this news story")
                } else {
                    cardContent(reserveVoteSpace: allowsVote)
                }
            }
            if allowsVote {
                voteRow
                    .padding(.top, 16)
                    .padding(.trailing, 16)
                    .zIndex(1)
            }
        }
        // Glass wraps the vote overlay so the chips ride the card wiggle.
        .ylGlassRounded(cornerRadius: 22, interactive: true)
        .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private func cardContent(reserveVoteSpace: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
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
            if !capsule.displayBody.isEmpty {
                Text(capsule.displayBody)
                    .font(.body)
                    .foregroundStyle(YLTheme.fg(colorScheme))
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
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
                    tint: on ? EducationFilterChrome.selectedTint(colorScheme) : nil
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
            await store.load(token: token)
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
        let tag = todo.displayTag
        let when = NaturalWhen.format(
            date: todo.dueDateValue,
            time: todo.dueTimeValue,
            use24Hour: use24Hour
        )
        let hasMeta = tag != nil || className != nil || !when.isEmpty

        HStack(alignment: .top, spacing: 12) {
            EducationTodoCheckbox(done: todo.done == true, action: onToggleDone)
                .padding(.top, 2)

            NavigationLink(value: EducationRoute.todoDetail(todo)) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(todo.displayName)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(YLTheme.fg(colorScheme))
                        .strikethrough(todo.done == true, color: YLTheme.muted(colorScheme))
                        .frame(maxWidth: .infinity, alignment: .leading)

                    if hasMeta {
                        HStack(spacing: 8) {
                            if let tag {
                                Text(tag)
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(YLTheme.accent(colorScheme))
                            }
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
        }
        .padding(.vertical, 8)
    }
}

/// Checkbox locked to the title row so class / due meta never vertically shifts it.
private struct EducationTodoCheckbox: View {
    let done: Bool
    let action: () -> Void
    @Environment(\.colorScheme) private var colorScheme

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
                .foregroundStyle(done ? YLTheme.accent(colorScheme) : YLTheme.muted(colorScheme))
                .frame(width: Self.size, height: Self.size)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .fixedSize()
        .accessibilityLabel(done ? "Mark not done" : "Mark done")
    }
}
