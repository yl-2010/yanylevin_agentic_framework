import Charts
import SwiftUI

/// iPad fitness canvas — view-only, mirrors `/fitness` (overview, ranges, history).
struct FitnessBrowseView: View {
    @Environment(\.colorScheme) private var colorScheme
    let machines: [FitnessMachine]
    @Binding var selectedId: String
    @Binding var chartRange: FitnessChartRange
    @Binding var overviewVisible: Set<String>
    @Binding var selectedGraphIndex: Int?
    @State private var selectedOverviewDate: Date? = nil

    private static let overviewId = "__overview__"

    private var machineIdsKey: String {
        machines.map(\.id).joined(separator: "\u{1e}")
    }

    private var isOverview: Bool {
        selectedId == Self.overviewId || selectedId.isEmpty
    }

    private var selectedMachine: FitnessMachine? {
        guard !isOverview else { return nil }
        return machines.first(where: { $0.id == selectedId }) ?? machines.first
    }

    var body: some View {
        HStack(alignment: .top, spacing: 20) {
            machineSidebar
                .frame(width: 220, alignment: .top)
                .zIndex(0)

            Group {
                if isOverview {
                    overviewPanel
                } else if let machine = selectedMachine {
                    machinePanel(machine)
                } else {
                    Text("Select a machine.")
                        .foregroundStyle(YLTheme.muted(colorScheme))
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            // Liquid-glass press expansion must draw above the machine sidebar.
            .zIndex(1)
        }
        .padding(.horizontal, 24)
        .padding(.top, 12)
        .padding(.bottom, 16)
        .onAppear {
            if selectedId.isEmpty { selectedId = Self.overviewId }
            if overviewVisible.isEmpty {
                overviewVisible = Set(machines.map(\.id))
            }
        }
        .onChange(of: machineIdsKey) { _, _ in
            let idSet = Set(machines.map(\.id))
            overviewVisible = Set(overviewVisible.filter { idSet.contains($0) })
            if overviewVisible.isEmpty {
                overviewVisible = idSet
            }
            if !isOverview, !idSet.contains(selectedId) {
                selectedId = Self.overviewId
            }
        }
    }

    // MARK: - Sidebar

    private var machineSidebar: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                sidebarButton(
                    id: Self.overviewId,
                    title: "Overview",
                    color: nil,
                    selected: isOverview,
                    emphasized: true
                )

                ForEach(Array(machines.enumerated()), id: \.element.id) { index, machine in
                    sidebarButton(
                        id: machine.id,
                        title: machine.displayName,
                        color: FitnessPalette.color(for: machine, at: index),
                        selected: machine.id == selectedMachine?.id,
                        emphasized: false
                    )
                }
            }
            .padding(.vertical, 4)
        }
    }

    private func sidebarButton(
        id: String,
        title: String,
        color: Color?,
        selected: Bool,
        emphasized: Bool
    ) -> some View {
        Button {
            YLHaptics.tap()
            selectedId = id
            selectedGraphIndex = nil
            selectedOverviewDate = nil
        } label: {
            HStack(spacing: 10) {
                if let color {
                    Circle()
                        .fill(color)
                        .frame(width: 8, height: 8)
                }
                Text(title)
                    .font(.subheadline.weight(emphasized ? .bold : (selected ? .semibold : .medium)))
                    .foregroundStyle(YLTheme.fg(colorScheme))
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .modifier(SidebarSelectionGlass(selected: selected))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    // MARK: - Overview

    private var overviewPanel: some View {
        let series = overviewSeries

        return ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .center, spacing: 12) {
                    Text("Overview")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(YLTheme.fg(colorScheme))
                    Spacer(minLength: 8)
                    overviewFilters
                }

                rangeToolbar

                multiMachineChart(series: series)
                    .frame(minHeight: 280)
                    .padding(14)
                    .glassPanel(cornerRadius: 18)

                if series.allSatisfy(\.points.isEmpty) {
                    Text("No history yet")
                        .font(.subheadline)
                        .foregroundStyle(YLTheme.muted(colorScheme))
                }
            }
            .padding(.bottom, 24)
            // Let glass buttons expand past the scroll bounds (over the sidebar).
            .padding(.leading, 10)
        }
        .scrollClipDisabled()
    }

    private var overviewFilters: some View {
        HStack(spacing: 8) {
            ForEach(Array(machines.enumerated()), id: \.element.id) { index, machine in
                let on = overviewVisible.contains(machine.id)
                let color = FitnessPalette.color(for: machine, at: index)
                Button {
                    YLHaptics.tap()
                    if on {
                        // Keep at least one machine visible.
                        if overviewVisible.count > 1 {
                            overviewVisible.remove(machine.id)
                        }
                    } else {
                        overviewVisible.insert(machine.id)
                    }
                    FitnessBrowsePrefs.saveOverviewVisible(overviewVisible)
                    selectedOverviewDate = nil
                } label: {
                    Text(FitnessPalette.abbrev(machine.displayName))
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundStyle(on ? Color.white : color)
                        .frame(width: 38, height: 38)
                        // UIGlassEffect.tintColor (not SwiftUI .tint) — needed for custom palette colors.
                        .glassCircle(
                            interactive: true,
                            tint: on ? color.opacity(0.78) : color.opacity(0.22)
                        )
                        .overlay {
                            if !on {
                                Circle()
                                    .strokeBorder(color.opacity(0.55), lineWidth: 1.5)
                            }
                        }
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(machine.displayName)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
    }

    private var overviewSeries: [FitnessChartSeries] {
        machines.enumerated().compactMap { index, machine in
            guard overviewVisible.contains(machine.id) else { return nil }
            let points = chartRange.slice(FitnessHistory.points(for: machine))
            return FitnessChartSeries(
                id: machine.id,
                name: machine.displayName,
                color: FitnessPalette.color(for: machine, at: index),
                points: points
            )
        }
    }

    // MARK: - Machine

    private func machinePanel(_ machine: FitnessMachine) -> some View {
        let full = FitnessHistory.points(for: machine)
        let points = chartRange.slice(full)
        let idx = machines.firstIndex(where: { $0.id == machine.id }) ?? 0
        let color = FitnessPalette.color(for: machine, at: idx)
        let pending = machine.pending ?? []

        return ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(machine.displayName)
                    .font(.title2.weight(.bold))
                    .foregroundStyle(YLTheme.fg(colorScheme))

                if !pending.isEmpty {
                    Text("\(pending.count) set\(pending.count == 1 ? "" : "s") still settling — charts update after 2 hours.")
                        .font(.subheadline)
                        .foregroundStyle(YLTheme.muted(colorScheme))
                }

                HStack(spacing: 12) {
                    statCard(label: "Sets", value: "\(machine.historyCount ?? full.count)")
                    statCard(
                        label: "All-time max",
                        value: machine.allTimeMax.map(FitnessFormat.weight) ?? "—"
                    )
                }

                rangeToolbar

                singleMachineChart(points: points, color: color, name: machine.displayName)
                    .frame(minHeight: 260)
                    .padding(14)
                    .glassPanel(cornerRadius: 18)

                historyList(machine: machine)
            }
            .padding(.bottom, 24)
            .padding(.leading, 10)
        }
        .scrollClipDisabled()
    }

    private func statCard(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.caption.weight(.medium))
                .foregroundStyle(YLTheme.muted(colorScheme))
            Text(value)
                .font(.title2.weight(.bold))
                .fontDesign(.rounded)
                .monospacedDigit()
                .foregroundStyle(YLTheme.fg(colorScheme))
        }
        .padding(16)
        .frame(maxWidth: 220, alignment: .leading)
        .glassPanel(cornerRadius: 16)
    }

    // MARK: - Range

    private var rangeToolbar: some View {
        HStack(spacing: 10) {
            HStack(spacing: 6) {
                ForEach(FitnessChartRange.allCases) { range in
                    Button {
                        YLHaptics.tap()
                        chartRange = range
                        FitnessBrowsePrefs.saveRange(range)
                        selectedGraphIndex = nil
                        selectedOverviewDate = nil
                    } label: {
                        Text(range.label)
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                    }
                    .ylGlassButton(
                        shape: .capsule,
                        tint: chartRange == range
                            ? YLTheme.accent(colorScheme).opacity(0.35)
                            : nil
                    )
                    .accessibilityAddTraits(chartRange == range ? .isSelected : [])
                }
            }
            // Glass press morph expands outward — keep it above siblings.
            .zIndex(2)

            Spacer(minLength: 0)
        }
        .zIndex(2)
    }

    // MARK: - Charts

    private func singleMachineChart(
        points: [FitnessGraphPoint],
        color: Color,
        name: String
    ) -> some View {
        Group {
            if points.isEmpty {
                Text("No history yet")
                    .font(.subheadline)
                    .foregroundStyle(YLTheme.muted(colorScheme))
                    .frame(maxWidth: .infinity, minHeight: 200, alignment: .center)
            } else {
                let selectedWeight: Double? = {
                    guard let selectedGraphIndex,
                          points.indices.contains(selectedGraphIndex) else { return nil }
                    return points[selectedGraphIndex].weight
                }()
                Chart {
                    ForEach(Array(points.enumerated()), id: \.element.id) { idx, point in
                        LineMark(
                            x: .value("n", idx),
                            y: .value("lbs", point.weight ?? 0)
                        )
                        .interpolationMethod(.catmullRom)
                        .foregroundStyle(color)

                        PointMark(
                            x: .value("n", idx),
                            y: .value("lbs", point.weight ?? 0)
                        )
                        .symbolSize(selectedGraphIndex == idx ? 120 : 48)
                        .foregroundStyle(color)
                    }

                    if let selectedGraphIndex, points.indices.contains(selectedGraphIndex) {
                        RuleMark(x: .value("n", selectedGraphIndex))
                            .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
                            .foregroundStyle(YLTheme.muted(colorScheme).opacity(0.45))
                    }
                }
                .chartXSelection(value: $selectedGraphIndex)
                .chartXAxis {
                    AxisMarks(values: axisEndpoints(count: points.count)) { value in
                        AxisValueLabel {
                            if let idx = value.as(Int.self), points.indices.contains(idx) {
                                Text(FitnessFormat.day(points[idx].dateKey))
                                    .font(.caption2)
                            }
                        }
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .leading)
                }
                .chartOverlay { proxy in
                    // Glass must live in chartOverlay — Mark annotations corrupt Liquid Glass.
                    GeometryReader { geo in
                        if let selectedGraphIndex,
                           let selectedWeight,
                           let plotAnchor = proxy.plotFrame {
                            let plot = geo[plotAnchor]
                            if let x = proxy.position(forX: selectedGraphIndex) {
                                chartAnnotation(FitnessFormat.weight(selectedWeight))
                                    .position(
                                        x: x,
                                        y: plot.minY + min(36, plot.height * 0.22)
                                    )
                                    .allowsHitTesting(false)
                            }
                        }
                    }
                    .allowsHitTesting(false)
                }
                .accessibilityLabel("\(name) weight history")
            }
        }
    }

    private func multiMachineChart(series: [FitnessChartSeries]) -> some View {
        let active = series.filter { !$0.points.isEmpty }
        let marks = flattenedMarks(from: active)
        return Group {
            if marks.isEmpty {
                Text("No history yet")
                    .font(.subheadline)
                    .foregroundStyle(YLTheme.muted(colorScheme))
                    .frame(maxWidth: .infinity, minHeight: 220, alignment: .center)
            } else {
                overviewChart(marks: marks, seriesNames: active.map(\.name), seriesColors: active.map(\.color))
            }
        }
    }

    private func flattenedMarks(from series: [FitnessChartSeries]) -> [FitnessChartMark] {
        var out: [FitnessChartMark] = []
        for s in series {
            for point in s.points {
                guard let date = FitnessFormat.date(from: point.at) else { continue }
                out.append(
                    FitnessChartMark(
                        id: "\(s.id)-\(point.id)",
                        date: date,
                        weight: point.weight ?? 0,
                        series: s.name,
                        color: s.color
                    )
                )
            }
        }
        return out
    }

    private func overviewChart(
        marks: [FitnessChartMark],
        seriesNames: [String],
        seriesColors: [Color]
    ) -> some View {
        let selection = overviewSelection(in: marks, near: selectedOverviewDate)
        return Chart {
            ForEach(marks) { mark in
                LineMark(
                    x: .value("When", mark.date),
                    y: .value("lbs", mark.weight)
                )
                .interpolationMethod(.catmullRom)
                .foregroundStyle(by: .value("Machine", mark.series))

                PointMark(
                    x: .value("When", mark.date),
                    y: .value("lbs", mark.weight)
                )
                .symbolSize(selection?.markIds.contains(mark.id) == true ? 100 : 36)
                .foregroundStyle(by: .value("Machine", mark.series))
            }

            if let selection {
                RuleMark(x: .value("When", selection.date))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
                    .foregroundStyle(YLTheme.muted(colorScheme).opacity(0.45))
            }
        }
        .chartForegroundStyleScale(domain: seriesNames, range: seriesColors)
        .chartLegend(.hidden)
        .chartXSelection(value: $selectedOverviewDate)
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [3, 3]))
                AxisValueLabel(format: .dateTime.month(.abbreviated).day())
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading)
        }
        .chartOverlay { proxy in
            // Glass must live in chartOverlay — Mark annotations corrupt Liquid Glass.
            GeometryReader { geo in
                if let selection,
                   let plotAnchor = proxy.plotFrame {
                    let plot = geo[plotAnchor]
                    if let x = proxy.position(forX: selection.date) {
                        overviewAnnotation(selection.rows)
                            .position(x: x, y: plot.midY)
                            .allowsHitTesting(false)
                    }
                }
            }
            .allowsHitTesting(false)
        }
        .accessibilityLabel("All machines weight history")
    }

    /// Snap scrub to the nearest point; list every series that logged that Pacific day.
    private func overviewSelection(
        in marks: [FitnessChartMark],
        near raw: Date?
    ) -> (date: Date, rows: [OverviewAnnotationRow], markIds: Set<String>)? {
        guard let raw, !marks.isEmpty else { return nil }
        guard let nearest = marks.min(by: {
            abs($0.date.timeIntervalSince(raw)) < abs($1.date.timeIntervalSince(raw))
        }) else { return nil }

        let snapped = nearest.date
        let day = FitnessFormat.pacificDayKey(snapped)
        let thatDay = marks.filter { FitnessFormat.pacificDayKey($0.date) == day }

        // One row per series — latest set that day.
        let bySeries = Dictionary(grouping: thatDay, by: \.series)
        let picked = bySeries.values.compactMap { seriesMarks -> FitnessChartMark? in
            seriesMarks.max(by: { $0.date < $1.date })
        }
        .sorted { $0.series.localizedCaseInsensitiveCompare($1.series) == .orderedAscending }

        let rows = picked.map {
            OverviewAnnotationRow(
                id: $0.id,
                abbrev: FitnessPalette.abbrev($0.series),
                weight: FitnessFormat.weight($0.weight),
                color: $0.color
            )
        }
        return (snapped, rows, Set(picked.map(\.id)))
    }

    private func overviewAnnotation(_ rows: [OverviewAnnotationRow]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(rows) { row in
                HStack(spacing: 6) {
                    Circle()
                        .fill(row.color)
                        .frame(width: 7, height: 7)
                    Text(row.abbrev)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(YLTheme.muted(colorScheme))
                    Text(row.weight)
                        .font(.caption.weight(.bold))
                        .fontDesign(.rounded)
                        .monospacedDigit()
                        .foregroundStyle(YLTheme.fg(colorScheme))
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        // Charts apply transforms to overlays — real Liquid Glass fragments there.
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(Color.white.opacity(0.28), lineWidth: 0.6)
        )
    }

    private func chartAnnotation(_ text: String) -> some View {
        Text(text)
            .font(.caption.weight(.bold))
            .fontDesign(.rounded)
            .monospacedDigit()
            .foregroundStyle(YLTheme.fg(colorScheme))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            // Charts apply transforms to overlays — real Liquid Glass fragments there.
            .background(.regularMaterial, in: Capsule())
            .overlay(
                Capsule()
                    .strokeBorder(Color.white.opacity(0.28), lineWidth: 0.6)
            )
    }

    private func axisEndpoints(count: Int) -> [Int] {
        guard count > 1 else { return [0] }
        return [0, count - 1]
    }

    // MARK: - History

    private func historyList(machine: FitnessMachine) -> some View {
        let sessions = FitnessHistory.sessions(for: machine)
        let pending = machine.pending ?? []

        return Group {
            if sessions.isEmpty, pending.isEmpty {
                Text("No entries yet. Log sets from the iPhone Fitness tab.")
                    .font(.subheadline)
                    .foregroundStyle(YLTheme.muted(colorScheme))
                    .padding(.top, 4)
            } else {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(sessions) { session in
                        Text(FitnessFormat.day(session.dateKey))
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(YLTheme.muted(colorScheme))
                            .padding(.top, 16)
                            .padding(.bottom, 8)

                        ForEach(session.entries) { entry in
                            historyRow(
                                entry,
                                showWhen: session.dateKey != FitnessHistory.historicalKey
                            )
                        }
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassPanel(cornerRadius: 18)
            }
        }
    }

    private func historyRow(_ entry: FitnessGraphPoint, showWhen: Bool) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(entry.weight.map(FitnessFormat.weight) ?? "—")
                .font(.body.weight(.bold))
                .fontDesign(.rounded)
                .monospacedDigit()
                .foregroundStyle(YLTheme.fg(colorScheme))
            if showWhen {
                Spacer(minLength: 12)
                Text(FitnessFormat.when(entry.at))
                    .font(.subheadline)
                    .foregroundStyle(YLTheme.muted(colorScheme))
            }
        }
        .padding(.vertical, 8)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(YLTheme.fg(colorScheme).opacity(0.06))
                .frame(height: 1)
        }
    }
}

// MARK: - Supporting types

enum FitnessChartRange: String, CaseIterable, Identifiable {
    case ten = "10"
    case twentyFive = "25"
    case fifty = "50"
    case hundred = "100"
    case all = "all"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all: return "All"
        default: return rawValue
        }
    }

    var limit: Int? {
        switch self {
        case .ten: return 10
        case .twentyFive: return 25
        case .fifty: return 50
        case .hundred: return 100
        case .all: return nil
        }
    }

    func slice(_ points: [FitnessGraphPoint]) -> [FitnessGraphPoint] {
        guard let limit, points.count > limit else { return points }
        return Array(points.suffix(limit))
    }
}

struct FitnessChartSeries: Identifiable {
    let id: String
    let name: String
    let color: Color
    let points: [FitnessGraphPoint]
}

struct FitnessChartMark: Identifiable {
    let id: String
    let date: Date
    let weight: Double
    let series: String
    let color: Color
}

private struct OverviewAnnotationRow: Identifiable {
    let id: String
    let abbrev: String
    let weight: String
    let color: Color
}

enum FitnessPalette {
    static let hexColors: [String] = [
        "1B7D8A", "C45C26", "3D6B3D", "8B4D9A",
        "B8860B", "2F5D9F", "A63D4A", "5A6A7A",
    ]

    static func color(for machine: FitnessMachine, at index: Int) -> Color {
        if let raw = machine.color, let parsed = Color(hex: raw) {
            return parsed
        }
        return color(at: index)
    }

    static func color(at index: Int) -> Color {
        let hex = hexColors[index % hexColors.count]
        return Color(hex: hex) ?? YLTheme.accent
    }

    static func abbrev(_ name: String) -> String {
        let cleaned = name
            .replacingOccurrences(of: #"\d+x\d+"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let words = cleaned.split(whereSeparator: \.isWhitespace).map(String.init)
        guard let first = words.first else { return "?" }
        if words.count == 1 {
            return String(first.prefix(2)).uppercased()
        }
        let a = first.first.map(String.init) ?? ""
        let b = words[1].first.map(String.init) ?? ""
        return (a + b).uppercased()
    }
}

enum FitnessHistory {
    /// Pacific date keys before this collapse into one "Historical" session.
    static let historicalBefore = "2026-08-08"
    static let historicalKey = "historical"

    static func points(for machine: FitnessMachine) -> [FitnessGraphPoint] {
        if let history = machine.history, !history.isEmpty { return history }
        return machine.graph ?? []
    }

    static func sessionGroupKey(_ dateKey: String?) -> String {
        let key = dateKey ?? "unknown"
        if key != "unknown", key < historicalBefore {
            return historicalKey
        }
        return key
    }

    static func sessions(for machine: FitnessMachine) -> [FitnessSessionGroup] {
        let points = points(for: machine).reversed()
        var order: [String] = []
        var map: [String: [FitnessGraphPoint]] = [:]
        for point in points {
            let key = sessionGroupKey(point.dateKey)
            if map[key] == nil {
                order.append(key)
                map[key] = []
            }
            map[key, default: []].append(point)
        }
        return order.map { FitnessSessionGroup(dateKey: $0, entries: map[$0] ?? []) }
    }
}

struct FitnessSessionGroup: Identifiable {
    let dateKey: String
    let entries: [FitnessGraphPoint]
    var id: String { dateKey }
}

enum FitnessFormat {
    private static let pacific = TimeZone(identifier: "America/Los_Angeles") ?? .current

    static func weight(_ value: Double) -> String {
        if value.rounded() == value { return String(Int(value)) }
        return String(format: "%g", value)
    }

    static func day(_ key: String?) -> String {
        guard let key, !key.isEmpty else { return "" }
        if key == FitnessHistory.historicalKey { return "Historical" }
        guard let date = pacificDayKeyFormatter.date(from: key) ?? iso8601.date(from: key) else {
            return key
        }
        return dayFormatter.string(from: date)
    }

    static func when(_ iso: String?) -> String {
        guard let iso, let date = date(from: iso) else { return iso ?? "" }
        return whenFormatter.string(from: date)
    }

    static func date(from iso: String?) -> Date? {
        guard let iso, !iso.isEmpty else { return nil }
        if let d = iso8601Fractional.date(from: iso) { return d }
        return iso8601.date(from: iso)
    }

    static func pacificDayKey(_ date: Date) -> String {
        pacificDayKeyFormatter.string(from: date)
    }

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.timeZone = pacific
        f.dateFormat = "EEE, MMM d, yyyy"
        return f
    }()

    private static let whenFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.timeZone = pacific
        f.dateFormat = "MMM d, yyyy, h:mm a"
        return f
    }()

    private static let pacificDayKeyFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = pacific
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static let iso8601Fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}

enum FitnessBrowsePrefs {
    private static let rangeKey = "yl-fit-chart-range"
    private static let overviewKey = "yl-fit-overview-machines"

    static func loadRange() -> FitnessChartRange {
        if let raw = UserDefaults.standard.string(forKey: rangeKey),
           let range = FitnessChartRange(rawValue: raw) {
            return range
        }
        return .fifty
    }

    static func saveRange(_ range: FitnessChartRange) {
        UserDefaults.standard.set(range.rawValue, forKey: rangeKey)
    }

    static func loadOverviewVisible(machineIds: [String]) -> Set<String> {
        let ids = Set(machineIds)
        if let data = UserDefaults.standard.data(forKey: overviewKey),
           let arr = try? JSONDecoder().decode([String].self, from: data) {
            let kept = Set(arr.filter { ids.contains($0) })
            if !kept.isEmpty { return kept }
        }
        return ids
    }

    static func saveOverviewVisible(_ set: Set<String>) {
        if let data = try? JSONEncoder().encode(Array(set)) {
            UserDefaults.standard.set(data, forKey: overviewKey)
        }
    }
}

private struct SidebarSelectionGlass: ViewModifier {
    let selected: Bool

    func body(content: Content) -> some View {
        if selected {
            content.glassPanel(cornerRadius: 14)
        } else {
            content
        }
    }
}

private extension Color {
    init?(hex: String) {
        var cleaned = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.hasPrefix("#") { cleaned.removeFirst() }
        guard cleaned.count == 6, let value = UInt64(cleaned, radix: 16) else { return nil }
        let r = Double((value >> 16) & 0xFF) / 255
        let g = Double((value >> 8) & 0xFF) / 255
        let b = Double(value & 0xFF) / 255
        self = Color(red: r, green: g, blue: b)
    }
}
