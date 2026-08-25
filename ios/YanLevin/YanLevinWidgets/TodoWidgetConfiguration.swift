import AppIntents
import Foundation

struct EducationClassEntity: AppEntity {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Class")
    static var defaultQuery = EducationClassEntityQuery()

    var id: String
    var name: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }
}

/// Cache-only — never hit the network. Chronod resolves the default widget intent
/// under a short timeout; async fetches cancel and leave the Todo widget blank.
struct EducationClassEntityQuery: EntityQuery {
    func entities(for identifiers: [EducationClassEntity.ID]) async throws -> [EducationClassEntity] {
        Self.cachedClasses().filter { identifiers.contains($0.id) }
    }

    func suggestedEntities() async throws -> [EducationClassEntity] {
        Self.cachedClasses()
    }

    func defaultResult() async -> EducationClassEntity? {
        nil
    }

    static func cachedClasses() -> [EducationClassEntity] {
        let tree = AppGroupStore.loadCachedEducationTree()
        let classes = (tree?.classes ?? []).filter { !$0.isFreePeriod }
        return classes.map {
            EducationClassEntity(id: $0.id, name: $0.contextDisplayName)
        }
        .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }
}

struct TodoWidgetConfigurationIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Todo Filters"
    static var description = IntentDescription("Choose which todos appear in the widget.")

    @Parameter(title: "Show MA", default: true)
    var showMA: Bool

    @Parameter(title: "Show QA", default: true)
    var showQA: Bool

    @Parameter(title: "Show HW", default: true)
    var showHW: Bool

    @Parameter(title: "Show CW", default: true)
    var showCW: Bool

    @Parameter(title: "Show untagged", default: true)
    var showNone: Bool

    @Parameter(title: "Class only")
    var classFilter: EducationClassEntity?

    init() {
        self.showMA = true
        self.showQA = true
        self.showHW = true
        self.showCW = true
        self.showNone = true
        self.classFilter = nil
    }

    init(
        showMA: Bool,
        showQA: Bool,
        showHW: Bool,
        showCW: Bool,
        showNone: Bool,
        classFilter: EducationClassEntity?
    ) {
        self.showMA = showMA
        self.showQA = showQA
        self.showHW = showHW
        self.showCW = showCW
        self.showNone = showNone
        self.classFilter = classFilter
    }

    static var parameterSummary: some ParameterSummary {
        Summary("Filter todos") {
            \.$showMA
            \.$showQA
            \.$showHW
            \.$showCW
            \.$showNone
            \.$classFilter
        }
    }

    var typeFilters: Set<String> {
        var set = Set<String>()
        if showMA { set.insert("MA") }
        if showQA { set.insert("QA") }
        if showHW { set.insert("HW") }
        if showCW { set.insert("CW") }
        if showNone { set.insert("none") }
        return set.isEmpty ? EducationTodoFilter.allTags : set
    }
}
