import Charts
import SwiftUI

struct GymView: View {
    @EnvironmentObject private var auth: AuthStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var store = FitnessStore()
    @State private var selectedMachineId: String = ""
    @State private var browseSelectedId: String = "__overview__"
    @State private var chartRange: FitnessChartRange = FitnessBrowsePrefs.loadRange()
    @State private var overviewVisible: Set<String> = []
    @State private var draft = ""
    @State private var floatChips: [FloatChip] = []
    @State private var selectedGraphIndex: Int? = nil
    @State private var composerFocused = false
    @State private var solidifyTask: Task<Void, Never>? = nil
    /// Interactive machine-title swipe (Music Now Playing style).
    @State private var machineDragX: CGFloat = 0
    @State private var machineTitleWidth: CGFloat = 180
    @State private var machineDragTracking = false
    @State private var machineSwipeSettling = false
    @State private var machineHapticGate = MachineSwipeHapticGate()
    @State private var pendingCache = GymPendingCache()

    /// Matches server `PENDING_SOLIDIFY_MS` — pending chips join the graph after this.
    private static let pendingSolidify: TimeInterval = 2 * 60 * 60
    private static let machineSwipeVelocityCommit: CGFloat = 520
    private static let machineSwipeSpring = Animation.spring(response: 0.42, dampingFraction: 0.78)

    private var isWide: Bool {
        AdaptiveLayout.isWideLayout(
            horizontalSizeClass: horizontalSizeClass,
            verticalSizeClass: verticalSizeClass
        )
    }

    /// iPad only — Plus/Max landscape is `.regular` width but must stay on the logging UI.
    private var isBrowseLayout: Bool {
        AdaptiveLayout.isPad
    }

    /// iPhone landscape: three-column input layout (not the iPad browse canvas).
    private var isPhoneLandscape: Bool {
        AdaptiveLayout.isPhoneLandscape(verticalSizeClass: verticalSizeClass)
    }

    private var machines: [FitnessMachine] {
        store.tree?.machines ?? []
    }

    private var machine: FitnessMachine? {
        machines.first(where: { $0.id == selectedMachineId }) ?? machines.first
    }

    private var sessionMin: Double? {
        machine?.sessionMin
    }

    private var offsets: [Int] { [-5, 0, 5, 10] }

    /// First fetch, before any tree: show the real gym chrome with placeholder values.
    private var isAwaitingFitness: Bool {
        store.tree == nil && store.errorText == nil
    }

    /// Portrait iPhone logging UI is the only layout with a keyboard accessory.
    /// Do not key this off loading / empty machines: swapping this tree cancels
    /// `.task` and aborts `/api/fitness/data` before it can land.
    private var usesInputAccessory: Bool {
        !isBrowseLayout && !isPhoneLandscape
    }

    var body: some View {
        // Accessory attaches OUTSIDE the NavigationStack — same topology as Chat.
        // Hosting it on the ScrollView inside the large-title stack froze the
        // main thread on focus: SwiftUI keyboard avoidance moved the chrome
        // while its Auto Layout pinned to keyboardLayoutGuide, and large-title
        // safe-area churn kept rebuilding constraints — layout never converged.
        // Group keeps `.task` identity stable if accessory attach/detach flips.
        Group {
            if usesInputAccessory {
                navigationRoot
                    .ylKeyboardAccessory {
                        YLHostedFocus(isFocused: $composerFocused) { focus in
                            inputColumn(focus: focus)
                                .padding(.horizontal, AdaptiveLayout.pagePadding(wide: isWide))
                                .padding(.top, 4)
                                .padding(.bottom, 10)
                        }
                    } above: {
                        // Chips ride the accessory's top edge from the parent
                        // hierarchy — never inside the accessory host (focus froze).
                        floatStack
                            .padding(.horizontal, AdaptiveLayout.pagePadding(wide: isWide))
                            .padding(.bottom, 4)
                            .allowsHitTesting(false)
                    }
            } else {
                navigationRoot
            }
        }
        .task(id: auth.session?.token) {
            guard let token = auth.session?.token else { return }
            await store.load(token: token)
            syncAfterLoad()
            await store.runLiveSession(token: token)
        }
    }

    private var navigationRoot: some View {
        NavigationStack {
            Group {
                if let err = store.errorText, machines.isEmpty {
                    ContentUnavailableView(
                        "Fitness unavailable",
                        systemImage: "wifi.exclamationmark",
                        description: Text(err)
                    )
                } else if isAwaitingFitness {
                    gymBody
                        .redacted(reason: .placeholder)
                        .allowsHitTesting(false)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("Loading fitness")
                } else if machines.isEmpty {
                    ContentUnavailableView(
                        "No machines yet",
                        systemImage: "dumbbell",
                        description: Text("Add machines from Cursor or wait for history seed.")
                    )
                } else {
                    gymBody
                }
            }
            .navigationTitle(isPhoneLandscape ? "" : "Fitness")
            .navigationBarTitleDisplayMode(isPhoneLandscape ? .inline : .large)
            .toolbar(isPhoneLandscape ? .hidden : .automatic, for: .navigationBar)
            .ylPageBackground()
            .refreshable {
                guard let token = auth.session?.token else { return }
                await store.load(token: token)
                syncAfterLoad()
            }
            .onChange(of: store.isLoading) { _, loading in
                if !loading { syncAfterLoad() }
            }
            .onDisappear {
                solidifyTask?.cancel()
            }
        }
    }

    private var gymBody: some View {
        Group {
            if isBrowseLayout {
                FitnessBrowseView(
                    machines: machines,
                    selectedId: $browseSelectedId,
                    chartRange: $chartRange,
                    overviewVisible: $overviewVisible,
                    selectedGraphIndex: $selectedGraphIndex
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if isPhoneLandscape {
                YLHostedFocus(isFocused: $composerFocused) { focus in
                    wideGymBody(focus: focus)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        machinePicker
                            // Interactive liquid glass blooms past layout bounds —
                            // keep it above recent/chart so it never clips behind.
                            .zIndex(2)
                        recentRow
                            .zIndex(0)
                        // Keep the chart mounted while composing. Removing it
                        // collapsed scroll content under the large title (overlap)
                        // and jumped the header when offset taps flickered focus.
                        graphCard
                            .zIndex(0)
                    }
                    .padding(.horizontal, AdaptiveLayout.pagePadding(wide: isWide))
                    .padding(.top, 8)
                    .padding(.bottom, 12)
                }
                .scrollClipDisabled()
                .scrollDismissesKeyboard(.interactively)
                // Input column + chips live in the keyboard accessory attached
                // in `body`, outside the NavigationStack (see comment there).
            }
        }
    }

    /// Landscape: recent weights | chart (picker + max above) | offset stack; agent centered above tab bar.
    private func wideGymBody(focus: FocusState<Bool>.Binding) -> some View {
        GeometryReader { geo in
            // Equal inset so top-button↔top and bottom-button↔bottom match.
            let sideInset: CGFloat = 14

            HStack(alignment: .top, spacing: 14) {
                recentColumn
                    .frame(width: 92, height: max(0, geo.size.height - sideInset * 2))
                    .padding(.vertical, sideInset)
                    .zIndex(0)

                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .center, spacing: 12) {
                        machinePicker
                            .frame(maxWidth: 280)
                            // Bloom above recent column / max label / chart.
                            .zIndex(2)
                        allTimeMaxLabel
                            .zIndex(0)
                        Spacer(minLength: 0)
                    }
                    .zIndex(2)

                    graphCard
                        .frame(maxWidth: .infinity)
                        // Leave room for top padding + agent; keep chart from dominating.
                        .frame(maxHeight: max(120, geo.size.height * 0.58))
                        .zIndex(0)

                    Spacer(minLength: 0)

                    if !floatChips.isEmpty {
                        floatStack
                            .frame(maxWidth: .infinity, alignment: .center)
                    }

                    typeBar(focus: focus)
                        .frame(maxWidth: 560)
                        .frame(maxWidth: .infinity)
                }
                .padding(.top, 18)
                .padding(.bottom, 10)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .zIndex(1)

                offsetButtonsVertical
                    .frame(width: 80, height: max(0, geo.size.height - sideInset * 2))
                    .padding(.vertical, sideInset)
                    .zIndex(0)
            }
            .padding(.horizontal, 16)
            .frame(width: geo.size.width, height: geo.size.height)
        }
    }

    private var machinePicker: some View {
        // System Menu (liquid glass). Custom Circle views are stripped from
        // UIMenu — mark pending machines with a plain-text " •" instead.
        // Tap still opens the menu; horizontal swipe slides titles (Music-style).
        Menu {
            ForEach(machines) { m in
                Button {
                    YLHaptics.tap()
                    selectedMachineId = m.id
                    selectedGraphIndex = nil
                    syncFloatsFromPending()
                } label: {
                    if m.id == machine?.id {
                        Label {
                            Text(machineMenuTitle(m))
                        } icon: {
                            Image(systemName: "checkmark")
                        }
                    } else {
                        Text(machineMenuTitle(m))
                    }
                }
            }
        } label: {
            HStack(spacing: 8) {
                machineTitleCarousel
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(YLTheme.muted(colorScheme))
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .ylGlassRounded(cornerRadius: 14, interactive: true)
        }
        .simultaneousGesture(machineSwipeGesture)
        .allowsHitTesting(!machineSwipeSettling)
        // Interactive glass morph expands past the control’s layout box.
        .zIndex(2)
        .accessibilityHint("Swipe left or right to change machine")
    }

    /// Current + adjacent titles in a clipped strip; `machineDragX` drives the slide.
    private var machineTitleCarousel: some View {
        let currentName = machine?.displayName
            ?? (isAwaitingFitness ? "Shoulder Press" : "Machine")
        let prev = adjacentMachine(delta: -1)
        let next = adjacentMachine(delta: 1)
        let w = max(machineTitleWidth, 1)

        return ZStack(alignment: .leading) {
            machineTitleLabel(currentName)
                .offset(x: machineDragX)

            if machineDragX < 0, let next {
                machineTitleLabel(next.displayName)
                    .offset(x: machineDragX + w)
            } else if machineDragX > 0, let prev {
                machineTitleLabel(prev.displayName)
                    .offset(x: machineDragX - w)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 22, alignment: .leading)
        .clipped()
        .background {
            GeometryReader { geo in
                Color.clear
                    .onAppear { machineTitleWidth = max(geo.size.width, 1) }
                    .onChange(of: geo.size.width) { _, newWidth in
                        machineTitleWidth = max(newWidth, 1)
                    }
            }
        }
        // Report animated offset every frame so halfway haptic can fire mid-spring.
        .modifier(
            MachineSwipeProgressMonitor(
                offset: machineDragX,
                width: machineTitleWidth,
                onProgress: { machineHapticGate.handle($0) }
            )
        )
    }

    private func machineTitleLabel(_ name: String) -> some View {
        Text(name)
            .font(.title3.weight(.semibold))
            .foregroundStyle(YLTheme.fg(colorScheme))
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Finger-follows while dragging; spring-completes or snaps back on release.
    private var machineSwipeGesture: some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .local)
            .onChanged { value in
                guard !machineSwipeSettling, machines.count > 1 else { return }
                let dx = value.translation.width
                let dy = value.translation.height

                if !machineDragTracking {
                    guard abs(dx) > 6, abs(dx) > abs(dy) * 1.35 else { return }
                    machineDragTracking = true
                    YLHaptics.prepareMachineSwipe()
                }

                let w = max(machineTitleWidth, 1)
                // Soft rubber past full page so a slow drag still feels alive.
                let limited = rubberBand(dx, limit: w)
                machineDragX = limited
                machineHapticGate.handle(abs(limited) / w)
            }
            .onEnded { value in
                guard machineDragTracking else { return }
                machineDragTracking = false
                settleMachineSwipe(
                    translation: machineDragX,
                    velocity: value.velocity.width
                )
            }
    }

    private func adjacentMachine(delta: Int) -> FitnessMachine? {
        guard machines.count > 1 else { return nil }
        let currentId = machine?.id ?? selectedMachineId
        guard let idx = machines.firstIndex(where: { $0.id == currentId }) else { return nil }
        let next = (idx + delta + machines.count) % machines.count
        return machines[next]
    }

    private func rubberBand(_ x: CGFloat, limit: CGFloat) -> CGFloat {
        let absX = abs(x)
        if absX <= limit { return x }
        let overflow = absX - limit
        let banded = limit + overflow * 0.22
        return x < 0 ? -banded : banded
    }

    private func settleMachineSwipe(translation: CGFloat, velocity: CGFloat) {
        let w = max(machineTitleWidth, 1)
        let progress = abs(translation) / w
        let sameDirection = (velocity < 0) == (translation < 0)
        let flung = abs(velocity) >= Self.machineSwipeVelocityCommit
            && sameDirection
            && abs(translation) > 12
        let pastHalfway = progress >= 0.5
        let shouldCommit = (flung || pastHalfway) && abs(translation) > 8

        machineSwipeSettling = true

        if shouldCommit {
            let delta = translation < 0 ? 1 : -1
            let target = translation < 0 ? -w : w
            withAnimation(Self.machineSwipeSpring) {
                machineDragX = target
            } completion: {
                applyMachineSwipeCommit(delta: delta)
            }
        } else {
            withAnimation(Self.machineSwipeSpring) {
                machineDragX = 0
            } completion: {
                machineSwipeSettling = false
                machineHapticGate.reset()
            }
        }
    }

    private func applyMachineSwipeCommit(delta: Int) {
        guard let next = adjacentMachine(delta: delta) else {
            resetMachineSwipeVisual()
            return
        }
        selectedGraphIndex = nil
        // Swap identity while the incoming title is already fully on-screen, then
        // zero the offset without animation so the strip does not jump.
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            selectedMachineId = next.id
            machineDragX = 0
        }
        machineSwipeSettling = false
        machineHapticGate.reset()
        syncFloatsFromPending()
    }

    private func resetMachineSwipeVisual() {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            machineDragX = 0
        }
        machineSwipeSettling = false
        machineHapticGate.reset()
    }

    /// Prefer an accent-colored bullet; UIMenu may flatten color to label tint.
    private func machineMenuTitle(_ m: FitnessMachine) -> AttributedString {
        var title = AttributedString(m.displayName)
        guard machineHasPending(m) else { return title }
        var bullet = AttributedString(" •")
        bullet.foregroundColor = YLTheme.accent(colorScheme)
        title.append(bullet)
        return title
    }

    private func machineHasPending(_ m: FitnessMachine) -> Bool {
        !(activePending(for: m).isEmpty)
    }

    /// Pending entries still within the 2-hour solidify window.
    private func activePending(for m: FitnessMachine?) -> [FitnessPendingEntry] {
        guard let m else { return [] }
        let cutoff = Date().addingTimeInterval(-Self.pendingSolidify)
        return parsedPending(for: m.id).compactMap { entry, at in
            guard let at else { return entry }
            return at > cutoff ? entry : nil
        }
    }

    /// Machine ids + pending ids/ats — invalidates parse cache when the tree payload changes.
    private func pendingTreeFingerprint() -> String {
        machines.map { m in
            let pending = (m.pending ?? [])
                .map { "\($0.id)\u{1f}\($0.at ?? "")" }
                .joined(separator: ",")
            return "\(m.id)=\(pending)"
        }.joined(separator: "\u{1e}")
    }

    private func parsedPending(for machineId: String) -> [(FitnessPendingEntry, Date?)] {
        let fingerprint = pendingTreeFingerprint()
        if pendingCache.fingerprint != fingerprint {
            var parsed: [String: [(FitnessPendingEntry, Date?)]] = [:]
            parsed.reserveCapacity(machines.count)
            for machine in machines {
                parsed[machine.id] = (machine.pending ?? []).map { ($0, FitnessFormat.date(from: $0.at)) }
            }
            pendingCache.fingerprint = fingerprint
            pendingCache.parsed = parsed
        }
        return pendingCache.parsed[machineId] ?? []
    }

    private var allTimeMaxLabel: some View {
        HStack(spacing: 4) {
            Text("all-time max")
                .font(.caption.weight(.medium))
                .foregroundStyle(YLTheme.muted(colorScheme))
            Text(machine?.allTimeMax.map(formatWeight) ?? (isAwaitingFitness ? "110" : "—"))
                .font(.caption.weight(.bold))
                .foregroundStyle(YLTheme.accent(colorScheme))
                .monospacedDigit()
        }
    }

    private var recentRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            allTimeMaxLabel

            HStack(spacing: 10) {
                let boxes = paddedRecent(machine?.recent)
                ForEach(0..<3, id: \.self) { idx in
                    recentBox(boxes[idx])
                }
            }
        }
    }

    /// Newest at top (API recent is left→right oldest→newest).
    private var recentColumn: some View {
        let boxes = Array(paddedRecent(machine?.recent).reversed())
        return VStack(spacing: 12) {
            ForEach(0..<3, id: \.self) { idx in
                recentBox(boxes[idx], compact: true)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func paddedRecent(_ recent: [FitnessRecentBox?]?) -> [FitnessRecentBox?] {
        var boxes = recent ?? []
        while boxes.count < 3 { boxes.insert(nil, at: 0) }
        if boxes.count > 3 { boxes = Array(boxes.suffix(3)) }
        return boxes
    }

    private func recentBox(_ box: FitnessRecentBox?, compact: Bool = false) -> some View {
        let tone = box?.tone ?? "older"
        return Text(box.flatMap { $0.weight }.map(formatWeight) ?? (isAwaitingFitness ? "105" : "—"))
            .font((compact ? Font.title3 : Font.title2).weight(.bold))
            .fontDesign(.rounded)
            .foregroundStyle(YLTheme.fg(colorScheme))
            .monospacedDigit()
            .frame(maxWidth: .infinity)
            .frame(maxHeight: compact ? .infinity : nil)
            .padding(.vertical, compact ? 0 : 18)
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .ylGlassRounded(
                cornerRadius: 14,
                tint: boxTint(tone: tone),
                interactive: true
            )
    }

    private func boxTint(tone: String) -> Color {
        let accent = YLTheme.accent(colorScheme)
        if tone == "recent" {
            // Last session — stronger accent presence
            return accent.opacity(colorScheme == .dark ? 0.48 : 0.40)
        }
        // Older session — faded: light wash in light mode, darker blue wash in dark mode
        if colorScheme == .dark {
            // Blacken the accent so it reads darker than last-session, but keep blue.
            return accent.mix(with: .black, by: 0.55).opacity(0.52)
        }
        return accent.opacity(0.14)
    }

    private var graphCard: some View {
        let points: [FitnessGraphPoint] = {
            if isAwaitingFitness {
                return (0..<8).map { i in
                    FitnessGraphPoint(
                        id: "placeholder-\(i)",
                        weight: [98, 102, 100, 105, 103, 108, 105, 110][i],
                        at: nil,
                        dateKey: nil
                    )
                }
            }
            return machine?.graph ?? []
        }()
        return Group {
            if points.isEmpty {
                Text("No history yet")
                    .font(.subheadline)
                    .foregroundStyle(YLTheme.muted(colorScheme))
                    .frame(
                        maxWidth: .infinity,
                        minHeight: isPhoneLandscape ? 120 : 160,
                        maxHeight: isPhoneLandscape ? .infinity : nil,
                        alignment: .center
                    )
                    .background {
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(YLTheme.bg0(colorScheme).opacity(colorScheme == .dark ? 0.35 : 0.4))
                    }
                    .overlay {
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .strokeBorder(YLTheme.accent(colorScheme).opacity(0.14), lineWidth: 1)
                    }
            } else {
                Chart {
                    ForEach(Array(points.enumerated()), id: \.element.id) { idx, p in
                        LineMark(
                            x: .value("n", idx),
                            y: .value("lbs", p.weight ?? 0)
                        )
                        .interpolationMethod(.catmullRom)
                        .foregroundStyle(YLTheme.accent(colorScheme))

                        PointMark(
                            x: .value("n", idx),
                            y: .value("lbs", p.weight ?? 0)
                        )
                        .symbolSize(selectedGraphIndex == idx ? 140 : 64)
                        .foregroundStyle(YLTheme.accent(colorScheme))
                    }

                    if let selectedGraphIndex,
                       points.indices.contains(selectedGraphIndex),
                       points[selectedGraphIndex].weight != nil {
                        RuleMark(x: .value("n", selectedGraphIndex))
                            .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
                            .foregroundStyle(YLTheme.muted(colorScheme).opacity(0.45))
                    }
                }
                .chartXSelection(value: $selectedGraphIndex)
                .chartXAxis(.hidden)
                .chartYAxis {
                    AxisMarks(position: .leading)
                }
                .chartOverlay { proxy in
                    // Material callout — Liquid Glass fragments under Chart transforms.
                    GeometryReader { geo in
                        if let selectedGraphIndex,
                           points.indices.contains(selectedGraphIndex),
                           let weight = points[selectedGraphIndex].weight,
                           let plotAnchor = proxy.plotFrame {
                            let plot = geo[plotAnchor]
                            if let x = proxy.position(forX: selectedGraphIndex) {
                                Text(formatWeight(weight))
                                    .font(.caption.weight(.bold))
                                    .fontDesign(.rounded)
                                    .monospacedDigit()
                                    .foregroundStyle(YLTheme.fg(colorScheme))
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 4)
                                    .background(.regularMaterial, in: Capsule())
                                    .overlay(
                                        Capsule()
                                            .strokeBorder(Color.white.opacity(0.28), lineWidth: 0.6)
                                    )
                                    .position(
                                        x: x,
                                        y: plot.minY + min(28, plot.height * 0.2)
                                    )
                                    .allowsHitTesting(false)
                            }
                        }
                    }
                    .allowsHitTesting(false)
                }
                .frame(minHeight: isPhoneLandscape ? 140 : 180)
                .frame(maxHeight: isPhoneLandscape ? .infinity : 180)
                .padding(12)
                // Avoid UIGlassEffect panel — it frosts over the plot and, when the
                // keyboard compresses layout, reads as a slab behind the input row.
                .background {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(YLTheme.bg0(colorScheme).opacity(colorScheme == .dark ? 0.35 : 0.4))
                }
                .overlay {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(YLTheme.accent(colorScheme).opacity(0.14), lineWidth: 1)
                }
            }
        }
    }

    private func inputColumn(focus: FocusState<Bool>.Binding) -> some View {
        // Chips are NOT in here: dynamic transition-animated glass inside the
        // keyboard accessory still froze focus even after the attachment-point
        // fix. They float above the accessory from the main tree (gymBody).
        VStack(alignment: .leading, spacing: 8) {
            offsetButtons
            typeBar(focus: focus)
        }
        .background(Color.clear)
    }

    private var floatStack: some View {
        // No GlassEffectContainer: standalone glassEffect capsules never morph
        // into each other, and containers inside the keyboard accessory wedged
        // the main thread on focus (XCUITest tap hung ~60s with them).
        VStack(alignment: .leading, spacing: 6) {
            ForEach(floatChips) { chip in
                Text(formatWeight(chip.weight))
                    .font(.title3.weight(.bold))
                    .fontDesign(.rounded)
                    .monospacedDigit()
                    .foregroundStyle(YLTheme.fg(colorScheme))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .contentShape(Capsule())
                    // Same interactive Liquid Glass as the top recent rectangles.
                    .ylGlassCapsule(
                        tint: YLTheme.accent(colorScheme)
                            .opacity(colorScheme == .dark ? 0.38 : 0.28),
                        interactive: true
                    )
                    .transition(floatChipTransition)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(floatChips.isEmpty ? "No new weights" : "Newly logged weights")
    }

    /// Soft rise + fade — avoids the hard edge-slide that fights the stack growing from empty.
    private var floatChipTransition: AnyTransition {
        .asymmetric(
            insertion: .opacity
                .combined(with: .scale(scale: 0.92, anchor: .bottomLeading))
                .combined(with: .offset(y: 14)),
            removal: .opacity
                .combined(with: .scale(scale: 0.96, anchor: .leading))
        )
    }

    private var floatChipMotion: Animation {
        .spring(response: 0.48, dampingFraction: 0.86, blendDuration: 0.15)
    }

    private var offsetButtons: some View {
        // No GlassEffectContainer (accessory containers wedged focus; see
        // floatStack). Standalone glassEffect keeps each button discrete.
        HStack(spacing: 10) {
            ForEach(offsets, id: \.self) { offset in
                offsetButton(offset, vertical: false)
            }
        }
    }

    @ViewBuilder
    private var offsetButtonsVertical: some View {
        let column = VStack(spacing: 12) {
            ForEach(offsets.reversed(), id: \.self) { offset in
                offsetButton(offset, vertical: true)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        if #available(iOS 26, *) {
            GlassEffectContainer(spacing: 0) { column }
        } else {
            column
        }
    }

    private func offsetTargetWeight(_ offset: Int) -> Double? {
        guard let min = sessionMin else { return nil }
        return min + Double(offset)
    }

    private func offsetButton(_ offset: Int, vertical: Bool) -> some View {
        // Not a `Button` — SwiftUI focus can hop to the type field after a
        // glass button action and pop the keyboard. Plain tap + interactive
        // glass matches the press shift without becoming a focus target.
        let label: String = {
            if let weight = offsetTargetWeight(offset) {
                return formatWeight(weight)
            }
            return offset <= 0 ? "\(offset)" : "+\(offset)"
        }()
        return Text(label)
            .font(.title3.weight(.semibold))
            .fontDesign(.rounded)
            .monospacedDigit()
            .foregroundStyle(YLTheme.accent(colorScheme))
            .frame(maxWidth: .infinity, maxHeight: vertical ? .infinity : nil)
            .padding(.vertical, vertical ? 0 : 16)
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .ylGlassRounded(cornerRadius: 14, interactive: true)
            .opacity(sessionMin == nil ? 0.45 : 1)
            .onTapGesture {
                guard sessionMin != nil, !store.agentBusy, auth.session?.token != nil else { return }
                Task { await tapOffset(offset) }
            }
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel(label)
            .allowsHitTesting(sessionMin != nil && !store.agentBusy && auth.session?.token != nil)
    }

    private var canSendAgent: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !store.agentBusy
            && auth.session?.token != nil
    }

    private func typeBar(focus: FocusState<Bool>.Binding) -> some View {
        // No GlassEffectContainer (accessory containers wedged focus; see
        // floatStack). Field and send keep their own interactive glass and
        // cannot morph together without a shared container.
        HStack(alignment: .bottom, spacing: 10) {
            TextField("Tell the fitness agent…", text: $draft, axis: .vertical)
                .lineLimit(1...8)
                .fixedSize(horizontal: false, vertical: true)
                .submitLabel(.send)
                .focused(focus)
                .onSubmit { submitTypeDraft() }
                .onKeyPress(keys: [.return], phases: .down) { press in
                    if press.modifiers.contains(.shift) { return .ignored }
                    guard canSendAgent else { return .ignored }
                    submitTypeDraft()
                    return .handled
                }
                .onChange(of: draft) { oldValue, newValue in
                    guard newValue.count == oldValue.count + 1,
                          newValue.hasSuffix("\n") || newValue.hasSuffix("\r"),
                          String(newValue.dropLast()) == oldValue
                    else { return }
                    draft = oldValue
                    submitTypeDraft()
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .ylGlassField()
                .ylInteractiveInput(isFocused: focus)

            Button {
                YLHaptics.tap()
                submitTypeDraft()
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 16, weight: .bold))
                    .frame(width: 40, height: 40)
                    .contentShape(Circle())
            }
            .ylGlassCircleButton(
                tint: YLTheme.chatSend(colorScheme)
                    .opacity(colorScheme == .dark ? 0.4 : 0.42)
            )
            .disabled(!canSendAgent)
            .opacity(canSendAgent ? 1 : 0.45)
            .accessibilityLabel("Send")
        }
    }

    private func syncAfterLoad() {
        if selectedMachineId.isEmpty, let first = store.tree?.machines?.first {
            selectedMachineId = first.id
        }
        let ids = (store.tree?.machines ?? []).map(\.id)
        if overviewVisible.isEmpty {
            overviewVisible = FitnessBrowsePrefs.loadOverviewVisible(machineIds: ids)
        }
        syncFloatsFromPending()
        scheduleSolidifyRefresh()
    }

    /// Reload when the soonest pending entry hits the 2-hour solidify mark.
    private func scheduleSolidifyRefresh() {
        solidifyTask?.cancel()
        guard let token = auth.session?.token else { return }
        let pendingDates = machines
            .flatMap { activePending(for: $0) }
            .compactMap { FitnessFormat.date(from: $0.at) }
        guard let earliest = pendingDates.min() else { return }
        let solidifyAt = earliest.addingTimeInterval(Self.pendingSolidify)
        let delay = solidifyAt.timeIntervalSinceNow
        solidifyTask = Task {
            if delay > 0 {
                let ns = UInt64(delay * 1_000_000_000)
                try? await Task.sleep(nanoseconds: ns)
            }
            guard !Task.isCancelled else { return }
            await store.load(token: token)
            syncAfterLoad()
        }
    }

    private func submitTypeDraft() {
        guard canSendAgent, let token = auth.session?.token else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        draft = ""
        Task {
            await store.sendAgent(
                message: text,
                machineId: machine?.id,
                machineName: machine?.displayName,
                token: token
            )
            syncFloatsFromPending()
            scheduleSolidifyRefresh()
        }
    }

    private func tapOffset(_ offset: Int) async {
        guard let min = sessionMin,
              let machineId = machine?.id,
              let token = auth.session?.token else { return }
        let weight = min + Double(offset)
        YLHaptics.tap()
        // Optimistic insert keeps a stable ForEach id so the later server sync
        // cannot tear the chip down and re-insert it (that was the first-tap hitch).
        withAnimation(floatChipMotion) {
            floatChips.append(FloatChip(weight: weight))
        }
        _ = await store.appendWeights(machineId: machineId, weights: [weight], token: token)
        syncFloatsFromPending(preferExistingIdentity: true)
        scheduleSolidifyRefresh()
    }

    private func syncFloatsFromPending(preferExistingIdentity: Bool = false) {
        let pending = activePending(for: machine)
        let serverChips: [FloatChip] = pending.compactMap { entry in
            guard let w = entry.weight else { return nil }
            return FloatChip(id: entry.id, weight: w)
        }

        // Optimistic chips already match pending — leave them alone so the insert
        // animation can finish without an identity swap.
        if preferExistingIdentity,
           floatChips.map(\.weight) == serverChips.map(\.weight) {
            return
        }

        let next = preferExistingIdentity
            ? mergeFloatChips(existing: floatChips, server: serverChips)
            : serverChips

        let sameVisual = floatChips.map(\.weight) == next.map(\.weight)
        if sameVisual {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                floatChips = next
            }
        } else {
            withAnimation(floatChipMotion) {
                floatChips = next
            }
        }
    }

    /// Reuse on-screen chip ids when pending weights line up, so ForEach does not remount.
    private func mergeFloatChips(existing: [FloatChip], server: [FloatChip]) -> [FloatChip] {
        if existing.count == server.count,
           zip(existing, server).allSatisfy({ $0.weight == $1.weight }) {
            return existing
        }
        var unused = existing
        return server.map { serverChip in
            if let idx = unused.firstIndex(where: { $0.id == serverChip.id }) {
                return unused.remove(at: idx)
            }
            if let idx = unused.firstIndex(where: { $0.weight == serverChip.weight }) {
                return unused.remove(at: idx)
            }
            return serverChip
        }
    }

    private func formatWeight(_ value: Double) -> String {
        FitnessFormat.weight(value)
    }
}

private final class GymPendingCache {
    var fingerprint = ""
    var parsed: [String: [(FitnessPendingEntry, Date?)]] = [:]
}

private struct FloatChip: Identifiable, Equatable {
    let id: String
    let weight: Double

    init(id: String = UUID().uuidString, weight: Double) {
        self.id = id
        self.weight = weight
    }
}

/// Fires machine-swipe halfway haptic on every 50% crossing (either direction).
private final class MachineSwipeHapticGate {
    private var lastProgress: CGFloat?
    private static let threshold: CGFloat = 0.5

    func handle(_ progress: CGFloat) {
        defer { lastProgress = progress }
        guard let last = lastProgress else { return }
        let crossedUp = last < Self.threshold && progress >= Self.threshold
        let crossedDown = last >= Self.threshold && progress < Self.threshold
        guard crossedUp || crossedDown else { return }
        YLHaptics.machineSwipeHalfway()
    }

    func reset() {
        lastProgress = nil
    }
}

/// Animates with `machineDragX` and reports progress every spring frame.
private struct MachineSwipeProgressMonitor: AnimatableModifier {
    var offset: CGFloat
    var width: CGFloat
    var onProgress: (CGFloat) -> Void

    var animatableData: CGFloat {
        get { offset }
        set {
            offset = newValue
            onProgress(abs(newValue) / max(width, 1))
        }
    }

    func body(content: Content) -> some View {
        content
    }
}
