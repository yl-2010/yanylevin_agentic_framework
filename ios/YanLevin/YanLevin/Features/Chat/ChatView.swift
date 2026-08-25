import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

private enum ChatBackend: Equatable {
    case publicChat
    case educationAgent
}

/// iMessage iOS 26 composer metrics, measured off a Messages screenshot
/// (393pt-wide iPhone, 1.201 px/pt).
private enum IMessageComposer {
    /// Plus circle and single-line field share this height (measured 43px ≈ 36pt).
    static let height: CGFloat = 36
    /// In-field send: wider-than-tall capsule with continuous corners
    /// (measured 40×30px ≈ 34×26pt) — not a circle, square, or plain oval.
    static let sendWidth: CGFloat = 34
    static let sendHeight: CGFloat = 26
    /// Equal inset from the field’s top / bottom / trailing (measured ~6.5px ≈ 5pt).
    static let sendInset: CGFloat = 5
    /// Gap between plus and field at rest (measured 12px ≈ 10pt).
    static let spacing: CGFloat = 10
    /// Screen-edge inset.
    static let horizontalPadding: CGFloat = 16
    /// Single-line field is a capsule (radius = height / 2). Fixed radius keeps
    /// side padding stable when the field grows multi-line.
    static let fieldRadius: CGFloat = 18
    static let fieldLeading: CGFloat = 16
    /// Glass merge threshold — must stay BELOW the rest gap (`spacing`) or the
    /// shapes bleed together at rest. Finger-drag warp closes the distance,
    /// crossing this threshold and melting them (Messages behavior).
    static let meltSpacing: CGFloat = 6
}

struct ChatView: View {
    @EnvironmentObject private var auth: AuthStore
    @EnvironmentObject private var educationFocus: EducationFocusStore
    @EnvironmentObject private var nav: AppNavigationStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.ylKeyboardReservedBottom) private var keyboardReservedBottom
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @StateObject private var visitorStore = VisitorChatStore()
    @StateObject private var educationStore = EducationStore()
    @State private var draft = ""
    @State private var backend: ChatBackend = .publicChat
    @State private var didChooseBackend = false
    @State private var pendingAttachments: [PendingChatAttachment] = []
    @State private var showFileImporter = false
    @State private var showPhotoPicker = false
    @State private var composerFocused = false
    /// Live height of the glass field — the vertical-axis TextField's real
    /// single-line height can drift a point above the nominal 36, which made
    /// the bottom-anchored send capsule sit visibly low.
    @State private var composerFieldHeight: CGFloat = IMessageComposer.height
    /// Glass field in window space, snapshotted on send as the flight origin.
    @State private var composerFieldGlobalFrame: CGRect = .zero
    @State private var pendingSendFlights: [ChatSendFlightPending] = []
    @State private var sendFlight: ChatSendFlightState?
    @State private var sendFlightGeneration = 0
    /// Bumped to cancel/restart SSE + polling (same as Education tab).
    @State private var liveSessionID = 0
    /// Long-press Copy pill target — message stays put (no context-menu lift).
    @State private var copyMenuMessageID: UUID?
    /// 0 = closed, 1 = open. Tracks the finger while dragging.
    @State private var historyReveal: CGFloat = 0
    @State private var historyDragging = false
    /// True from latch through the settle spring when this open swipe also hides the keyboard.
    @State private var historyScrubbingKeyboard = false
    @State private var historyDragOrigin: CGFloat = 0
    @State private var historyMeasuredWidth: CGFloat = 280
    @State private var historyChromeTop: CGFloat = 0
    @State private var historyHapticGate = YLHalfwayHapticGate()
    @State private var historySwipeBlocks = ChatHistorySwipeBlocks()
    /// Stays true until the close slide finishes so SwiftUI does not fade the
    /// panel out (default `if` removal) while it is still on screen.
    @State private var historyPanelMounted = false
    /// One-shot off-screen mount at idle so the first swipe does not pay the
    /// panel's first-time view construction / Liquid Glass setup mid-gesture.
    @State private var historyPanelWarming = false
    @State private var didWarmHistoryPanel = false
    @State private var chatRowsMemo = ChatRowsMemo()
    /// Vertical inset so body text + padding lands on iMessage’s 36pt single-line height.
    @State private var composerFieldVerticalPadding = ChatView.composerFieldVerticalPaddingValue()
    @State private var sendHoldArmed = false

    private static let historySwipeVelocityCommit: CGFloat = 520
    private static let historySwipeSpring = Animation.spring(response: 0.42, dampingFraction: 0.86)
    private static let historyHideExtra: CGFloat = 64
    /// Past the last bubble + composer clearance so `scrollTo` can hit true bottom.
    private static let chatScrollEndID = "chat-scroll-end"

    private var liveTaskID: String {
        "\(auth.session?.token ?? "")-\(liveSessionID)-\(usesEducation)"
    }

    private var isWide: Bool {
        AdaptiveLayout.isWideLayout(
            horizontalSizeClass: horizontalSizeClass,
            verticalSizeClass: verticalSizeClass
        )
    }

    private var chatPagePadding: CGFloat {
        isWide ? 24 : 16
    }

    private var usesEducation: Bool {
        auth.hasFullAccess && backend == .educationAgent
    }

    private var messages: [ChatMessage] {
        usesEducation ? educationStore.agentMessages : visitorStore.messages
    }

    private var isBusy: Bool {
        usesEducation ? educationStore.agentBusy : visitorStore.isSending
    }

    /// iMessage shows the send button only when there is content to send;
    /// `canSend` separately gates whether tapping it works (busy / queue full).
    private var composerHasContent: Bool {
        let hasText = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return hasText || (usesEducation && !pendingAttachments.isEmpty)
    }

    private var canSend: Bool {
        let hasText = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let hasFiles = usesEducation && !pendingAttachments.isEmpty
        guard hasText || hasFiles else { return false }
        if usesEducation {
            // Queue-full still allows hold-to-interrupt (not a queue slot).
            return true
        }
        return !isBusy
    }

    /// Same tint Fitness uses on `.ylGlassCircleButton` (colors the glyph, not the glass).
    private var composerControlTint: Color {
        YLTheme.chatSend(colorScheme)
            .opacity(colorScheme == .dark ? 0.4 : 0.42)
    }

    private static func composerFieldVerticalPaddingValue() -> CGFloat {
        let line = UIFont.preferredFont(forTextStyle: .body).lineHeight
        return max(0, (IMessageComposer.height - line) / 2)
    }

    /// Cheap stand-in for `messages.map(\.queued)` so animation does not allocate.
    private var queuedAnimationSignature: Int {
        var hash = 5381
        for msg in messages {
            hash = ((hash << 5) &+ hash) &+ (msg.queued ? 1 : 0)
        }
        return hash
    }

    /// While the field is one line tall, center the send capsule on the
    /// field’s *measured* height (bottom-anchoring on a fixed inset left it
    /// ~1pt low whenever the TextField ran taller than nominal). Once the
    /// field grows multi-line, fall back to iMessage’s fixed bottom anchor.
    private var composerSendBottomInset: CGFloat {
        let singleLineCutoff = IMessageComposer.height + 12
        guard composerFieldHeight < singleLineCutoff else {
            return IMessageComposer.sendInset
        }
        return max(0, (composerFieldHeight - IMessageComposer.sendHeight) / 2)
    }

    private var canAttach: Bool {
        // Attachments stay allowed while the education agent is busy (queued turns).
        let busyBlocks = usesEducation ? false : isBusy
        return !busyBlocks && pendingAttachments.count < 16
    }

    /// Message list rows with Working inserted before queued bubbles.
    private var chatRows: [ChatRow] {
        chatRowsMemo.rows(
            messages: messages,
            isBusy: isBusy,
            usesEducation: usesEducation,
            workingLabel: usesEducation ? educationStore.agentWorkingLabel : "Working"
        )
    }

    /// Opening user bubble sits under the nav chrome, so Copy must drop below.
    private var firstUserMessageID: UUID? {
        messages.first(where: { $0.role == "user" })?.id
    }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            if messages.isEmpty {
                                ChatEmptyState(
                                    usesEducation: usesEducation,
                                    colorScheme: colorScheme
                                )
                                .equatable()
                            }
                            ForEach(chatRows) { row in
                                switch row {
                                case .message(let msg):
                                    chatBubbleRow(
                                        msg: msg,
                                        flying: sendFlight?.messageID == msg.id
                                    )
                                    .id(msg.id)
                                    // Later LazyVStack rows paint on top; lift the open Copy row
                                    // so the pill is not covered by the next bubble.
                                    .zIndex(copyMenuMessageID == msg.id ? 10 : 0)
                                case .working(let label):
                                    ChatWorkingBubble(
                                        label: label,
                                        isWide: isWide,
                                        colorScheme: colorScheme
                                    )
                                    .equatable()
                                    .id("working-indicator")
                                }
                            }
                        }
                        .padding(.horizontal, chatPagePadding)
                        .padding(.top, isWide ? 24 : 16)
                        // Extra bottom clearance so the last bubble can scroll fully
                        // above the floating composer (safeAreaPadding alone is tight).
                        .padding(.bottom, isWide ? 72 : 64)
                        .adaptiveReadableWidth(AdaptiveLayout.chatMaxWidth)
                        .animation(.spring(response: 0.38, dampingFraction: 0.86), value: isBusy)
                        .animation(.spring(response: 0.38, dampingFraction: 0.86), value: educationStore.agentWorkingLabel)
                        .animation(.spring(response: 0.38, dampingFraction: 0.86), value: queuedAnimationSignature)

                        Color.clear
                            .frame(height: 1)
                            .id(Self.chatScrollEndID)
                            .accessibilityHidden(true)
                    }
                }
                .scrollClipDisabled()
                .scrollDismissesKeyboard(
                    (historyDragging || historyScrubbingKeyboard) ? .never : .interactively
                )
                // Blocks are tracked per view via `onGeometryChange` into a plain
                // class (no preference tree, no SwiftUI invalidation) so scrolling
                // does not recompute a bound preference on every frame.
                .environment(\.chatHistorySwipeBlocks, historySwipeBlocks)
                .simultaneousGesture(historyOpenDragGesture)
                .onGeometryChange(for: CGFloat.self) { proxy in
                    proxy.frame(in: .global).minY
                } action: { y in
                    guard abs(y - historyChromeTop) > 0.5 else { return }
                    historyChromeTop = y
                }
                .refreshable {
                    if usesEducation {
                        await reloadAndRestartLiveSession()
                    }
                }
                .onChange(of: messages.count) { _, _ in
                    dismissCopyMenu()
                    bindSendFlightIfNeeded()
                    if let id = sendFlight?.messageID,
                       !messages.contains(where: { $0.id == id })
                    {
                        finishSendFlight()
                    }
                    scrollChatToEnd(proxy: proxy)
                }
                .onChange(of: isBusy) { wasBusy, busy in
                    scrollChatToEnd(proxy: proxy)
                    guard usesEducation, wasBusy, !busy else { return }
                    guard historyReveal < 0.5 else { return }
                    guard let sid = educationStore.agentSessionId,
                          let token = auth.session?.token else { return }
                    Task { await educationStore.markChatRead(sessionId: sid, token: token) }
                }
                .onChange(of: educationStore.queuedMessageCount) { _, _ in
                    scrollChatToEnd(proxy: proxy)
                }
                .onChange(of: nav.tabReselectGeneration) { _, _ in
                    handleChatTabReselect(proxy: proxy)
                }
                .onScrollPhaseChange { _, newPhase in
                    if newPhase != .idle { dismissCopyMenu() }
                }
            }
            .ylPageBackground()
            .ylBusyHaptics(isBusy)
            .navigationTitle(usesEducation ? "Personal Agent" : "Chat about Yan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if auth.hasFullAccess {
                    ToolbarItem(placement: .topBarTrailing) {
                        backendToggle
                    }
                }
            }
            .onAppear {
                // Convert a lock-screen pending flag into a handoff BEFORE the
                // default backend entry, or cold launch would start two chats.
                nav.consumePendingNewChatIfNeeded()
                applyDefaultBackendIfNeeded()
                consumeChatHandoff()
            }
            .onChange(of: dynamicTypeSize) { _, _ in
                composerFieldVerticalPadding = Self.composerFieldVerticalPaddingValue()
            }
            .onChange(of: auth.hasFullAccess) { _, _ in
                nav.consumePendingNewChatIfNeeded()
                didChooseBackend = false
                applyDefaultBackendIfNeeded()
                consumeChatHandoff()
            }
            .onChange(of: auth.session?.token) { _, _ in
                consumeChatHandoff()
            }
            .onChange(of: nav.chatHandoffID) { _, _ in
                consumeChatHandoff()
            }
            .onChange(of: usesEducation) { _, edu in
                dismissCopyMenu()
                if !edu {
                    pendingAttachments = []
                    closeChatHistory(animated: false)
                }
            }
            .onChange(of: composerFocused) { _, focused in
                if focused { closeChatHistory() }
            }
            .fileImporter(
                isPresented: $showFileImporter,
                allowedContentTypes: [.item, .image, .pdf, .data],
                allowsMultipleSelection: true
            ) { result in
                switch result {
                case .success(let urls):
                    Task { await ingestFileURLs(urls) }
                case .failure:
                    break
                }
            }
            // Photos presentation lives HERE — inside the NavigationStack,
            // the same stable hierarchy that makes fileImporter reliable —
            // never in the accessory host or an extra UIWindow.
            .background {
                ChatPhotoPickerHost(
                    isPresented: $showPhotoPicker,
                    maxSelection: max(1, 16 - pendingAttachments.count)
                ) { results in
                    Task { await ingestPickerResults(results) }
                }
                .allowsHitTesting(false)
            }
        }
        .task(id: liveTaskID) {
            guard usesEducation, let token = auth.session?.token else { return }
            consumeChatHandoff()
            if !educationStore.isStartingNewChat, !nav.chatHandoffStartNew {
                await educationStore.resumeAgentChat(
                    email: auth.session?.email,
                    token: token
                )
            }
            // Same live path as Education tab: SSE instant updates + 20s poll fallback.
            await educationStore.runLiveSession(token: token)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                consumeChatHandoff()
            }
            guard phase == .active, usesEducation else { return }
            if educationStore.isStartingNewChat || nav.chatHandoffStartNew { return }
            Task { await reloadAndRestartLiveSession() }
        }
        // Outside NavigationStack so Liquid Glass finger-stretch on attach/send
        // isn’t clipped under the page / nav content slab.
        .ylKeyboardAccessory {
            YLHostedFocus(isFocused: $composerFocused) { focus in
                composer(focus: focus)
            }
        }
        .overlay {
            ZStack {
                if let flight = sendFlight {
                    ChatSendFlightOverlay(flight: flight, colorScheme: colorScheme)
                }
                if usesEducation {
                    chatHistoryOverlay
                }
            }
        }
    }

    @ViewBuilder
    private func chatBubbleRow(msg: ChatMessage, flying: Bool) -> some View {
        ChatBubbleView(
            msg: msg,
            usesEducation: usesEducation,
            isWide: isWide,
            chatPagePadding: chatPagePadding,
            showCopyMenu: copyMenuMessageID == msg.id,
            copyMenuBelow: msg.id == firstUserMessageID,
            colorScheme: colorScheme,
            reportsBubbleFrame: flying,
            onShowCopyMenu: {
                YLHaptics.medium()
                withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
                    copyMenuMessageID = msg.id
                }
            },
            onDismissCopyMenu: dismissCopyMenu,
            onBubbleFrame: { frame in
                updateSendFlightDest(frame)
            }
        )
        .equatable()
        .opacity(flying ? 0 : 1)
        .animation(nil, value: flying)
    }

    private func scrollChatToEnd(proxy: ScrollViewProxy) {
        withAnimation(.spring(response: 0.38, dampingFraction: 0.86)) {
            proxy.scrollTo(Self.chatScrollEndID, anchor: .bottom)
        }
    }

    private func handleChatTabReselect(proxy: ScrollViewProxy) {
        guard nav.selectedTab == .chat else { return }
        if usesEducation && (historyReveal > 0.5 || historyPanelMounted) {
            closeChatHistory()
            return
        }
        scrollChatToEnd(proxy: proxy)
    }

    /// Same as Education tab: tear down SSE/polling, reload agent+tree, restart live path.
    private func reloadAndRestartLiveSession() async {
        guard let token = auth.session?.token else { return }
        liveSessionID += 1
        await educationStore.load(token: token)
        await educationStore.resumeAgentChat(
            email: auth.session?.email,
            token: token
        )
    }

    private var backendToggle: some View {
        Button {
            YLHaptics.tap()
            toggleBackend()
        } label: {
            Group {
                if backend == .educationAgent {
                    Image(systemName: "person.fill")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(YLTheme.fg(colorScheme))
                } else {
                    YLMarkIcon()
                        .frame(width: 22, height: 22)
                }
            }
            .frame(width: 36, height: 36)
            .contentShape(Circle())
            .modifier(BackendToggleChrome())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(backend == .educationAgent ? "Personal Agent" : "Public chat")
        .accessibilityHint(
            "Switch between Personal Agent and public chat. Opening the Personal Agent starts a new chat."
        )
    }

    private func dismissCopyMenu() {
        guard copyMenuMessageID != nil else { return }
        withAnimation(.spring(response: 0.28, dampingFraction: 0.9)) {
            copyMenuMessageID = nil
        }
    }

    private func historyPanelWidth(_ containerWidth: CGFloat) -> CGFloat {
        if AdaptiveLayout.isPad {
            return min(360, max(320, containerWidth * 0.34))
        }
        if AdaptiveLayout.isPhoneLandscape(verticalSizeClass: verticalSizeClass) {
            return min(300, containerWidth * 0.40)
        }
        // Portrait: 1.33× the previous 0.52 fraction so titles fit.
        return containerWidth * 0.69
    }

    /// Finger-follow drawer. Closed: swipe the page background (not a bubble
    /// or widget). Open: swipe anywhere (same gradual + halfway haptic as
    /// Education swipe-back).
    private var historyOpenDragGesture: some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .global)
            .onChanged { value in
                handleHistoryDragChanged(value)
            }
            .onEnded { value in
                handleHistoryDragEnded(value)
            }
    }

    /// Overlay is outside the scroll named-space, so closing uses local coords.
    private var historyCloseDragGesture: some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .local)
            .onChanged { value in
                handleHistoryDragChanged(value)
            }
            .onEnded { value in
                handleHistoryDragEnded(value)
            }
    }

    private var chatHistoryOverlay: some View {
        GeometryReader { geo in
            let width = historyPanelWidth(geo.size.width)
            let hideTravel = width + Self.historyHideExtra
            let x = (historyReveal - 1) * hideTravel
            let overlayTop = geo.frame(in: .global).minY
            let topPad = max(6, historyChromeTop - overlayTop)
            let bottomPad = max(keyboardReservedBottom, IMessageComposer.height + 24) + 10
            let showPanel = historyDragging || historyPanelMounted
            // Warm-up renders the panel at its resting off-screen offset
            // (fully outside the clipped overlay) — never visible.
            let mountPanel = showPanel || historyPanelWarming

            VStack(spacing: 0) {
                Color.clear
                    .frame(height: topPad)
                    .allowsHitTesting(false)

                ZStack(alignment: .topLeading) {
                    Color.clear
                        .contentShape(Rectangle())
                        .onTapGesture { closeChatHistory() }
                        .accessibilityLabel("Dismiss past chats")
                        .accessibilityAddTraits(.isButton)

                    if mountPanel {
                        ChatHistoryPanel(
                            sections: ChatHistoryGrouping.sections(from: educationStore.chatHistory),
                            isLoading: educationStore.chatHistoryLoading,
                            width: width,
                            onSelect: selectHistoryChat
                        )
                        .padding(.leading, 8)
                        .padding(.bottom, bottomPad)
                        .offset(x: x)
                        .accessibilityHidden(!showPanel)
                        .transition(.identity)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .onAppear {
                historyMeasuredWidth = width
                warmUpHistoryPanelIfNeeded()
            }
            .onChange(of: width) { _, newWidth in
                historyMeasuredWidth = newWidth
            }
        }
        .clipped()
        .modifier(
            YLProgressMonitor(progress: historyReveal) { progress in
                historyHapticGate.handle(progress)
                if historyScrubbingKeyboard {
                    YLKeyboardScrub.setProgress(min(max(progress, 0), 1))
                }
            }
        )
        .simultaneousGesture(historyCloseDragGesture)
        .allowsHitTesting(historyOverlayHits)
    }

    /// Opening stays on the chat scroll gesture so the overlay cannot steal the
    /// finger mid-drag. Closing (and the open resting state) use the overlay so
    /// a swipe from anywhere on the screen, including over the composer, works.
    private var historyOverlayHits: Bool {
        if historyDragging {
            return historyDragOrigin >= 0.5
        }
        return historyReveal > 0.5
    }

    /// Build the panel once off-screen shortly after the overlay appears, then
    /// drop it again. First-time SwiftUI/Liquid Glass construction is the
    /// multi-second hitch on a cold debug session; doing it at idle keeps the
    /// first real swipe smooth without changing what is on screen.
    private func warmUpHistoryPanelIfNeeded() {
        guard !didWarmHistoryPanel else { return }
        didWarmHistoryPanel = true
        historyPanelWarming = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            historyPanelWarming = false
        }
    }

    private func historySwipeStartsOnChrome(_ point: CGPoint) -> Bool {
        historySwipeBlocks.frames.values.contains { $0.contains(point) }
    }

    private func handleHistoryDragChanged(_ value: DragGesture.Value) {
        guard usesEducation else { return }
        let dx = value.translation.width
        let dy = value.translation.height

        if !historyDragging {
            guard abs(dx) > 8, abs(dx) > abs(dy) * 1.15 else { return }
            let opening = historyReveal < 0.5
            if opening {
                guard dx > 0 else { return }
                guard !historySwipeStartsOnChrome(value.startLocation) else { return }
            }
            historyDragging = true
            historyPanelMounted = true
            historyDragOrigin = min(max(historyReveal, 0), 1)
            historyHapticGate.reset()
            YLHaptics.swipeBackBegan()
            historyHapticGate.handle(historyDragOrigin)
            if opening {
                loadHistoryIfNeeded()
                if composerFocused || YLKeyboardScrub.canBegin {
                    historyScrubbingKeyboard = true
                    YLKeyboardScrub.begin()
                    YLKeyboardScrub.setProgress(min(max(historyDragOrigin, 0), 1))
                }
            }
        }

        let w = max(historyMeasuredWidth, 1)
        let raw = historyDragOrigin + dx / w
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            historyReveal = rubberBandReveal(raw)
        }
        historyHapticGate.handle(min(max(historyReveal, 0), 1))
        if historyScrubbingKeyboard {
            YLKeyboardScrub.setProgress(min(max(historyReveal, 0), 1))
        }
    }

    private func handleHistoryDragEnded(_ value: DragGesture.Value) {
        guard historyDragging else { return }
        historyDragging = false
        let vx = value.velocity.width
        let flungOpen = vx >= Self.historySwipeVelocityCommit && historyReveal > 0.08
        let flungClose = vx <= -Self.historySwipeVelocityCommit && historyReveal < 0.92
        let open: Bool
        if flungOpen {
            open = true
        } else if flungClose {
            open = false
        } else {
            open = historyReveal >= 0.5
        }
        settleHistory(open: open)
    }

    private func rubberBandReveal(_ raw: CGFloat) -> CGFloat {
        if raw >= 0, raw <= 1 { return raw }
        if raw > 1 {
            return 1 + (raw - 1) * 0.22
        }
        return raw * 0.22
    }

    private func loadHistoryIfNeeded() {
        guard let token = auth.session?.token else { return }
        Task { await educationStore.loadChatList(token: token) }
    }

    private func settleHistory(open: Bool, animated: Bool = true, markVisibleRead: Bool = true) {
        guard usesEducation || !open else { return }
        if open {
            loadHistoryIfNeeded()
            historyPanelMounted = true
        } else if markVisibleRead {
            markVisibleChatReadIfIdle()
        }
        let apply = {
            historyReveal = open ? 1 : 0
        }
        if animated {
            withAnimation(Self.historySwipeSpring) {
                apply()
            } completion: {
                if !open, !historyDragging, historyReveal < 0.01 {
                    historyPanelMounted = false
                }
                historyHapticGate.reset()
                finishHistoryKeyboardScrub()
            }
        } else {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction, apply)
            historyPanelMounted = open
            historyHapticGate.reset()
            finishHistoryKeyboardScrub()
        }
    }

    /// After the drawer spring finishes, commit or restore the keyboard that
    /// was tracking `historyReveal`. Uses the live reveal so an interrupted
    /// settle (close while still springing open) does not resign by mistake.
    private func finishHistoryKeyboardScrub() {
        guard historyScrubbingKeyboard, !historyDragging else { return }
        if historyReveal >= 0.99 {
            historyScrubbingKeyboard = false
            YLKeyboardScrub.setProgress(1)
            YLKeyboardScrub.commitHide()
            composerFocused = false
        } else if historyReveal <= 0.01 {
            historyScrubbingKeyboard = false
            YLKeyboardScrub.setProgress(0)
            YLKeyboardScrub.cancel()
        }
    }

    private func closeChatHistory(animated: Bool = true, markVisibleRead: Bool = true) {
        guard historyDragging || historyReveal > 0.001 else { return }
        historyDragging = false
        settleHistory(open: false, animated: animated, markVisibleRead: markVisibleRead)
    }

    private func markVisibleChatReadIfIdle() {
        guard usesEducation, !educationStore.agentBusy else { return }
        guard let sid = educationStore.agentSessionId,
              let token = auth.session?.token else { return }
        Task { await educationStore.markChatRead(sessionId: sid, token: token) }
    }

    private func selectHistoryChat(_ chat: AgentChatListItem) {
        YLHaptics.tap()
        let sameThread = chat.sessionId == educationStore.agentSessionId
        closeChatHistory(markVisibleRead: sameThread)
        guard let token = auth.session?.token else { return }
        Task { await educationStore.markChatRead(sessionId: chat.sessionId, token: token) }
        if sameThread {
            return
        }
        Task { await educationStore.resumePersistedChat(sessionId: chat.sessionId, token: token) }
    }

    /// Entering the Personal Agent (public → personal toggle, cold launch,
    /// sign-in) always lands on a fresh, empty thread. Runs BEFORE the backend
    /// flips so the restarted live task sees `isStartingNewChat` and cannot
    /// resume the previous thread. The lock-screen / URL handoff path does its
    /// own force-new in `consumeChatHandoff`, so skip when one is pending.
    private func startFreshPersonalChat() {
        guard !nav.chatHandoffStartNew else { return }
        guard let token = auth.session?.token else { return }
        closeChatHistory(animated: false, markVisibleRead: false)
        // Blank immediately so an in-flight `/agent/active` resume cannot
        // paint the previous thread back over the new one.
        educationStore.prepareNewChat()
        Task { await educationStore.startNewChat(token: token) }
    }

    private func composer(focus: FocusState<Bool>.Binding) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if usesEducation, !pendingAttachments.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(pendingAttachments) { item in
                        HStack(alignment: .top, spacing: 8) {
                            Text(item.displayName)
                                .font(.body.weight(.semibold))
                                .multilineTextAlignment(.leading)
                                .lineLimit(nil)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .layoutPriority(1)
                            Button {
                                YLHaptics.tap()
                                pendingAttachments.removeAll { $0.id == item.id }
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 18))
                                    .symbolRenderingMode(.hierarchical)
                                    .foregroundStyle(YLTheme.muted(colorScheme))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Remove \(item.displayName)")
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                        .foregroundStyle(YLTheme.fg(colorScheme))
                        .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                        .ylGlassRounded(cornerRadius: 22, interactive: true)
                    }
                }
                .padding(.horizontal, IMessageComposer.horizontalPadding)
                .frame(maxWidth: AdaptiveLayout.chatMaxWidth)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            // iMessage: [attach circle] 10pt [matching-height capsule + in-bar capsule send].
            // GlassEffectContainer melts attach ↔ field only when interactive
            // glass warp drags them within `meltSpacing` — never at rest.
            YLGlassEffectContainer(spacing: IMessageComposer.meltSpacing) {
                HStack(alignment: .bottom, spacing: IMessageComposer.spacing) {
                    if usesEducation {
                        composerAttachButton
                    }
                    composerField(focus: focus)
                }
            }
            .padding(.horizontal, IMessageComposer.horizontalPadding)
            .padding(.vertical, 8)
            .frame(maxWidth: AdaptiveLayout.chatMaxWidth)
            .frame(maxWidth: .infinity)
            .zIndex(10)
        }
    }

    /// UIKit `UIButton` + `UIMenu`, not SwiftUI `Menu`. On iOS 26+/27 the
    /// SwiftUI menu's first row morphs open right over the composer, and taps
    /// on its TEXT region are lost (only the leading icon hit-tests — known
    /// Liquid Glass Menu hit-testing/touch-through bugs, aggravated by the
    /// accessory chrome's custom hitTest). UIKit menus own their row
    /// hit-testing end-to-end inside their own container (the Mail/Messages
    /// attach pattern) and an open one is untouched by SSE accessory rebuilds.
    private var composerAttachButton: some View {
        Image(systemName: "paperclip")
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(composerControlTint)
            .ylSizedGlassCircle(side: IMessageComposer.height)
            .accessibilityHidden(true)
            .overlay {
                ChatAttachMenuButton(
                    enabled: canAttach,
                    onPhotoLibrary: {
                        // Same pipeline as Files (the one attach path that
                        // never failed): flip a bool, ChatPhotoPickerHost on
                        // the NavigationStack owns the actual presentation.
                        showPhotoPicker = true
                    },
                    onFiles: {
                        showFileImporter = true
                    }
                )
            }
            .opacity(canAttach ? 1 : 0.45)
            .zIndex(2)
    }

    private func composerField(focus: FocusState<Bool>.Binding) -> some View {
        HStack(alignment: .bottom, spacing: 0) {
            TextField(
                usesEducation ? "Ask your personal agent…" : "Message…",
                text: $draft,
                axis: .vertical
            )
            .textFieldStyle(.plain)
            .font(.body)
            .lineLimit(1...8)
            .fixedSize(horizontal: false, vertical: true)
            // Return inserts a newline (never sends) — the send
            // button is the only send path. Fitness keeps Return-to-send.
            .submitLabel(.return)
            .focused(focus)
            // Send-button insert/remove animation on the parent HStack must not
            // apply to the field — that is what leaves typed text on screen
            // after `draft = ""` while the field is still first responder.
            .transaction { $0.animation = nil }
            .padding(.leading, IMessageComposer.fieldLeading)
            .padding(.trailing, 4)
            .padding(.vertical, composerFieldVerticalPadding)
            .frame(minHeight: IMessageComposer.height)

            // iMessage: send appears only once there is something to send.
            if composerHasContent {
                composerSendButton
                    .padding(.trailing, IMessageComposer.sendInset)
                    .padding(.bottom, composerSendBottomInset)
                    .transition(.scale(scale: 0.4).combined(with: .opacity))
            }
        }
        .onGeometryChange(for: CGRect.self) { proxy in
            proxy.frame(in: .global)
        } action: { frame in
            composerFieldGlobalFrame = frame
            composerFieldHeight = frame.height
        }
        .animation(
            .spring(response: 0.3, dampingFraction: 0.8),
            value: composerHasContent
        )
        .ylGlassField(cornerRadius: IMessageComposer.fieldRadius)
        .ylInteractiveInput(isFocused: focus)
        .zIndex(1)
    }

    /// iMessage send: opaque orange, wider-than-tall continuous-corner capsule
    /// inside the field (radius = half height, `.continuous` smoothing gives
    /// Messages’ subtly-flattened squircle arcs — not a circle or plain oval).
    /// Hold ≥ 2s while the Personal Agent is busy, then release, to interrupt
    /// instead of queueing.
    private var composerSendButton: some View {
        let shape = RoundedRectangle(
            cornerRadius: IMessageComposer.sendHeight / 2,
            style: .continuous
        )
        return Button {
            let interrupt = sendHoldArmed && usesEducation && isBusy
            sendHoldArmed = false
            if interrupt {
                YLHaptics.interrupt()
            } else {
                YLHaptics.tap()
            }
            submitComposer(interrupt: interrupt)
        } label: {
            Image(systemName: "arrow.up")
                .font(.system(size: 15, weight: .bold))
                .symbolRenderingMode(.monochrome)
                .foregroundStyle(.white)
                .frame(
                    width: IMessageComposer.sendWidth,
                    height: IMessageComposer.sendHeight
                )
                .background(YLTheme.chatSend(colorScheme), in: shape)
                .contentShape(shape)
                .scaleEffect(sendHoldArmed ? 1.12 : 1)
                .animation(.spring(response: 0.28, dampingFraction: 0.72), value: sendHoldArmed)
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
        .opacity(canSend ? 1 : 0.45)
        .accessibilityLabel("Send")
        .accessibilityHint(
            usesEducation
                ? "Send. Hold two seconds while working to interrupt instead of queueing."
                : "Send"
        )
        .accessibilityAction(named: "Interrupt and send") {
            guard canSend, usesEducation, isBusy else { return }
            YLHaptics.interrupt()
            submitComposer(interrupt: true)
        }
        .simultaneousGesture(
            LongPressGesture(minimumDuration: 2)
                .onEnded { _ in
                    guard canSend, usesEducation, isBusy else { return }
                    sendHoldArmed = true
                    YLHaptics.medium()
                }
        )
    }

    private func submitComposer(interrupt: Bool = false) {
        guard canSend else { return }
        if usesEducation, !interrupt, educationStore.isQueueFull { return }
        let text = draft
        let files = pendingAttachments
        prepareSendFlight(text: text)
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            draft = ""
            pendingAttachments = []
        }
        YLComposerInput.clearFocusedText()
        Task { @MainActor in
            if draft.isEmpty {
                YLComposerInput.clearFocusedText()
            }
        }
        let generation = sendFlightGeneration
        Task {
            await send(text, attachments: files, interrupt: interrupt)
            clearPendingSendFlightIfOrphaned(generation: generation)
        }
    }

    private func prepareSendFlight(text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        sendFlightGeneration += 1
        let generation = sendFlightGeneration
        if sendFlight != nil {
            finishSendFlight()
        }
        guard !reduceMotion,
              !trimmed.isEmpty,
              historyReveal < 0.5,
              composerFieldGlobalFrame.width > 1,
              composerFieldGlobalFrame.height > 1
        else { return }
        pendingSendFlights.append(
            ChatSendFlightPending(
                generation: generation,
                origin: composerFieldGlobalFrame
            )
        )
    }

    private func bindSendFlightIfNeeded() {
        guard !pendingSendFlights.isEmpty else { return }
        guard let last = messages.last, last.role == "user" else { return }
        let pending = pendingSendFlights.removeFirst()
        if sendFlight != nil {
            finishSendFlight()
        }
        sendFlight = ChatSendFlightState(
            generation: pending.generation,
            messageID: last.id,
            text: last.content,
            origin: pending.origin,
            dest: nil,
            progress: 0
        )
        scheduleSendFlightTimeout(generation: pending.generation)
    }

    private func updateSendFlightDest(_ frame: CGRect) {
        guard sendFlight != nil, frame.width > 1, frame.height > 1 else { return }
        let first = sendFlight?.dest == nil
        if sendFlight?.dest != frame {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                sendFlight?.dest = frame
            }
        }
        if first {
            Task { @MainActor in
                launchSendFlight()
            }
        }
    }

    private func launchSendFlight() {
        guard sendFlight?.dest != nil, sendFlight?.progress == 0 else { return }
        withAnimation(ChatSendFlightMotion.spring) {
            sendFlight?.progress = 1
        } completion: {
            finishSendFlight()
        }
    }

    private func finishSendFlight() {
        sendFlight = nil
    }

    private func clearPendingSendFlightIfOrphaned(generation: Int) {
        pendingSendFlights.removeAll { $0.generation == generation }
    }

    private func scheduleSendFlightTimeout(generation: Int) {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: ChatSendFlightMotion.timeoutNanoseconds)
            guard sendFlight?.generation == generation else { return }
            finishSendFlight()
        }
    }

    private func applyDefaultBackendIfNeeded() {
        guard !didChooseBackend else { return }
        didChooseBackend = true
        backend = auth.hasFullAccess ? .educationAgent : .publicChat
        if backend == .educationAgent {
            // Cold launch / sign-in: opening the Personal Agent starts fresh.
            // A warm app never re-enters here (didChooseBackend stays true),
            // so returning to a running app picks up where it left off.
            startFreshPersonalChat()
        }
    }

    private func consumeChatHandoff() {
        nav.consumePendingNewChatIfNeeded()
        let files = nav.chatHandoffAttachments
        let preferPersonal = nav.chatHandoffPreferPersonalAgent
        let startNew = nav.chatHandoffStartNew
        guard preferPersonal || startNew || !files.isEmpty else { return }
        if preferPersonal {
            didChooseBackend = true
            if backend != .educationAgent {
                withAnimation(.spring(response: 0.35, dampingFraction: 0.82)) {
                    backend = .educationAgent
                }
            }
        }
        if startNew {
            closeChatHistory(animated: false, markVisibleRead: false)
            draft = ""
            pendingAttachments = []
            let token = auth.session?.token ?? AppGroupStore.token
            let fullAccess = auth.hasFullAccess || AppGroupStore.hasFullAccess
            if fullAccess {
                // Session restore is async (Keychain + /session). Keep the
                // handoff until a token exists so we don't fall through to
                // visitor chat and drop the new-chat request.
                guard let token, !token.isEmpty else { return }
                educationStore.prepareNewChat()
                nav.chatHandoffAttachments = []
                nav.chatHandoffPreferPersonalAgent = false
                nav.chatHandoffStartNew = false
                Task { await educationStore.startNewChat(token: token, force: true) }
                return
            }
            if auth.session == nil, AppGroupStore.token != nil {
                return
            }
            visitorStore.messages = []
        } else {
            for att in files {
                guard pendingAttachments.count < 16 else { break }
                if pendingAttachments.contains(where: { $0.name == att.name && $0.data == att.data }) {
                    continue
                }
                pendingAttachments.append(att)
            }
        }
        nav.chatHandoffAttachments = []
        nav.chatHandoffPreferPersonalAgent = false
        nav.chatHandoffStartNew = false
    }

    private func toggleBackend() {
        let next: ChatBackend = backend == .educationAgent ? .publicChat : .educationAgent
        didChooseBackend = true
        if next == .educationAgent, auth.hasFullAccess {
            startFreshPersonalChat()
        }
        withAnimation(.spring(response: 0.35, dampingFraction: 0.82)) {
            backend = next
        }
    }

    private func send(_ text: String, attachments: [PendingChatAttachment] = [], interrupt: Bool = false) async {
        if usesEducation {
            guard let token = auth.session?.token else { return }
            // Prefetch schedule tree so nowContext stays warm; server still
            // recomputes active class on every agent turn.
            if educationStore.tree == nil {
                await educationStore.load(token: token)
            }
            // Match web: education tab open screen is the default edit target.
            // Schedule "in class now" still comes from server-side nowContext.
            let ui = educationFocus.agentUiContext(tree: educationStore.tree)
            var withLoc = ui
            if AdaptiveLayout.isPhone {
                withLoc.phoneLocation = PhoneLocationReporter.shared.snapshot
                PhoneLocationReporter.shared.refresh()
            }
            await educationStore.sendAgent(
                text,
                attachments: attachments,
                uiContext: withLoc,
                interrupt: interrupt,
                token: token
            )
        } else {
            await visitorStore.send(text)
        }
    }

    private func ingestPickerResults(_ results: [PHPickerResult]) async {
        for result in results {
            guard pendingAttachments.count < 16 else { break }
            guard let data = await Self.loadImageData(from: result.itemProvider), !data.isEmpty else {
                continue
            }
            let compressed = Self.compressImageDataIfNeeded(data) ?? data
            // Match Mac personal-agent MAX_ATTACHMENT_BYTES (12MB).
            guard compressed.count <= 12_000_000 else { continue }
            let name = "photo-\(pendingAttachments.count + 1).jpg"
            pendingAttachments.append(
                PendingChatAttachment(name: name, mimeType: "image/jpeg", data: compressed)
            )
        }
    }

    private static func loadImageData(from provider: NSItemProvider) async -> Data? {
        let types = [
            UTType.image.identifier,
            UTType.jpeg.identifier,
            UTType.heic.identifier,
            UTType.png.identifier,
            UTType.webP.identifier,
        ]
        for type in types where provider.hasItemConformingToTypeIdentifier(type) {
            let data: Data? = await withCheckedContinuation { continuation in
                provider.loadDataRepresentation(forTypeIdentifier: type) { data, _ in
                    continuation.resume(returning: data)
                }
            }
            if let data, !data.isEmpty { return data }
        }
        if provider.canLoadObject(ofClass: UIImage.self) {
            let image: UIImage? = await withCheckedContinuation { continuation in
                provider.loadObject(ofClass: UIImage.self) { object, _ in
                    continuation.resume(returning: object as? UIImage)
                }
            }
            if let image, let data = image.jpegData(compressionQuality: 0.82), !data.isEmpty {
                return data
            }
        }
        return nil
    }

    private func ingestFileURLs(_ urls: [URL]) async {
        for url in urls {
            guard pendingAttachments.count < 16 else { break }
            let accessed = url.startAccessingSecurityScopedResource()
            defer {
                if accessed { url.stopAccessingSecurityScopedResource() }
            }
            guard let data = try? Data(contentsOf: url), !data.isEmpty else { continue }
            let finalData: Data
            let mime: String
            let name = url.lastPathComponent
            if let imageData = Self.compressImageDataIfNeeded(data) {
                finalData = imageData
                mime = "image/jpeg"
            } else {
                finalData = data
                mime = Self.mimeType(for: url) ?? "application/octet-stream"
            }
            guard finalData.count <= 12_000_000 else { continue }
            pendingAttachments.append(
                PendingChatAttachment(name: name, mimeType: mime, data: finalData)
            )
        }
    }

    private static func compressImageDataIfNeeded(_ data: Data) -> Data? {
        guard let image = UIImage(data: data) else { return nil }
        var quality: CGFloat = 0.82
        var out = image.jpegData(compressionQuality: quality)
        // Soft target under the 12MB hard cap (JSON+base64 to Mac API).
        while let bytes = out, bytes.count > 11_000_000, quality > 0.35 {
            quality -= 0.12
            out = image.jpegData(compressionQuality: quality)
        }
        return out
    }

    private static func mimeType(for url: URL) -> String? {
        let ext = url.pathExtension.lowercased()
        switch ext {
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "pdf": return "application/pdf"
        case "txt": return "text/plain"
        case "md": return "text/markdown"
        case "doc": return "application/msword"
        case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        default:
            if let type = UTType(filenameExtension: ext)?.preferredMIMEType {
                return type
            }
            return nil
        }
    }
}

private final class ChatRowsMemo {
    private var messages: [ChatMessage] = []
    private var isBusy = false
    private var usesEducation = false
    private var workingLabel = "Working"
    private var cached: [ChatRow] = []

    func rows(
        messages: [ChatMessage],
        isBusy: Bool,
        usesEducation: Bool,
        workingLabel: String
    ) -> [ChatRow] {
        if messages == self.messages,
           isBusy == self.isBusy,
           usesEducation == self.usesEducation,
           workingLabel == self.workingLabel
        {
            return cached
        }
        self.messages = messages
        self.isBusy = isBusy
        self.usesEducation = usesEducation
        self.workingLabel = workingLabel
        var rows: [ChatRow] = []
        var insertedWorking = false
        for msg in messages {
            if usesEducation, isBusy, !insertedWorking, msg.queued {
                rows.append(.working(workingLabel))
                insertedWorking = true
            }
            rows.append(.message(msg))
        }
        if isBusy, !insertedWorking {
            rows.append(.working(workingLabel))
        }
        cached = rows
        return rows
    }
}

/// Global-space frames of chrome (bubbles / widgets) a history-open swipe must
/// not start on. Plain class so per-frame writes never invalidate SwiftUI —
/// the old PreferenceKey version re-reduced every visible frame while
/// scrolling ("Bound preference tried to update multiple times per frame").
private final class ChatHistorySwipeBlocks {
    var frames: [UUID: CGRect] = [:]
}

private struct ChatHistorySwipeBlocksEnvironmentKey: EnvironmentKey {
    static let defaultValue: ChatHistorySwipeBlocks? = nil
}

private extension EnvironmentValues {
    var chatHistorySwipeBlocks: ChatHistorySwipeBlocks? {
        get { self[ChatHistorySwipeBlocksEnvironmentKey.self] }
        set { self[ChatHistorySwipeBlocksEnvironmentKey.self] = newValue }
    }
}

private struct ChatHistorySwipeBlockModifier: ViewModifier {
    @Environment(\.chatHistorySwipeBlocks) private var blocks
    @State private var blockID = UUID()

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGRect.self) { proxy in
                proxy.frame(in: .global)
            } action: { frame in
                blocks?.frames[blockID] = frame
            }
            .onDisappear {
                blocks?.frames.removeValue(forKey: blockID)
            }
    }
}

private extension View {
    /// Frames are tracked unconditionally; whether a swipe may start on chrome
    /// is decided at drag start (same `usesEducation` / reveal / focus gates
    /// the old per-view `enabled` flag encoded).
    func chatHistorySwipeBlock() -> some View {
        modifier(ChatHistorySwipeBlockModifier())
    }
}

private struct ChatEmptyState: View, Equatable {
    let usesEducation: Bool
    let colorScheme: ColorScheme

    var body: some View {
        Text(
            usesEducation
                ? "Ask your personal agent about classes, todos, schedule, or news."
                : "Ask about Yan’s work, math, ExampleCo, or school."
        )
        .font(.headline)
        .foregroundStyle(YLTheme.fg(colorScheme))
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .ylGlassRounded(cornerRadius: 18, interactive: true)
        .chatHistorySwipeBlock()
    }
}

private struct ChatWorkingBubble: View, Equatable {
    let label: String
    let isWide: Bool
    let colorScheme: ColorScheme

    var body: some View {
        HStack {
            HStack(alignment: .center, spacing: 6) {
                Text(label)
                    .font(.body)
                YLBusyDots()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .foregroundStyle(YLTheme.muted(colorScheme))
            .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            // Same interactive Liquid Glass as fitness recent boxes / composer field.
            .ylGlassRounded(cornerRadius: 22, interactive: true)
            .chatHistorySwipeBlock()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label)

            Spacer(minLength: isWide ? 120 : 40)
        }
        .transition(
            .asymmetric(
                insertion: .opacity.combined(with: .move(edge: .bottom)),
                removal: .opacity
            )
        )
    }
}

private struct ChatBubbleView: View, Equatable {
    let msg: ChatMessage
    let usesEducation: Bool
    let isWide: Bool
    let chatPagePadding: CGFloat
    let showCopyMenu: Bool
    let copyMenuBelow: Bool
    let colorScheme: ColorScheme
    var reportsBubbleFrame: Bool = false
    var onShowCopyMenu: () -> Void
    var onDismissCopyMenu: () -> Void
    var onBubbleFrame: ((CGRect) -> Void)?

    static func == (lhs: ChatBubbleView, rhs: ChatBubbleView) -> Bool {
        lhs.msg == rhs.msg
            && lhs.usesEducation == rhs.usesEducation
            && lhs.isWide == rhs.isWide
            && lhs.chatPagePadding == rhs.chatPagePadding
            && lhs.showCopyMenu == rhs.showCopyMenu
            && lhs.copyMenuBelow == rhs.copyMenuBelow
            && lhs.colorScheme == rhs.colorScheme
            && lhs.reportsBubbleFrame == rhs.reportsBubbleFrame
    }

    var body: some View {
        let isUser = msg.role == "user"
        let sendTint = YLTheme.chatSend(colorScheme)
            .opacity(colorScheme == .dark ? 0.26 : 0.16)
        let copyable = !msg.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let showWidgets = usesEducation && !isUser && !msg.widgets.isEmpty
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                if isUser { Spacer(minLength: isWide ? 120 : 40) }
                if copyable {
                    Group {
                        if usesEducation && !isUser {
                            YLMarkdownText(source: msg.content, scheme: colorScheme)
                                .equatable()
                        } else {
                            Text(msg.content)
                                .foregroundStyle(YLTheme.fg(colorScheme))
                        }
                    }
                    .padding(12)
                    .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .ylGlassRounded(
                        cornerRadius: 22,
                        tint: isUser ? sendTint : nil,
                        interactive: true
                    )
                    .chatHistorySwipeBlock()
                    .background {
                        if reportsBubbleFrame {
                            Color.clear
                                .onGeometryChange(for: CGRect.self) { proxy in
                                    proxy.frame(in: .global)
                                } action: { frame in
                                    onBubbleFrame?(frame)
                                }
                        }
                    }
                    .opacity(msg.queued ? 0.42 : 1)
                    .overlay {
                        if showCopyMenu {
                            Color.clear
                                .contentShape(Rectangle())
                                .onTapGesture { onDismissCopyMenu() }
                        }
                    }
                    .overlay(alignment: copyMenuBelow ? .bottom : .top) {
                        if showCopyMenu {
                            copyMessagePill {
                                UIPasteboard.general.string = msg.content
                                YLHaptics.tap()
                                onDismissCopyMenu()
                            }
                            .offset(y: copyMenuBelow ? 40 : -40)
                            .transition(
                                .opacity.combined(
                                    with: .scale(
                                        scale: 0.92,
                                        anchor: copyMenuBelow ? .top : .bottom
                                    )
                                )
                            )
                        }
                    }
                    .simultaneousGesture(
                        LongPressGesture(minimumDuration: 0.35)
                            .onEnded { _ in
                                guard copyable else { return }
                                onShowCopyMenu()
                            }
                    )
                    .simultaneousGesture(
                        TapGesture().onEnded {
                            if !showCopyMenu {
                                onDismissCopyMenu()
                            }
                        }
                    )
                    .accessibilityAction(named: "Copy") {
                        guard copyable else { return }
                        UIPasteboard.general.string = msg.content
                        YLHaptics.tap()
                    }
                }
                if !isUser { Spacer(minLength: isWide ? 120 : 40) }
            }
            .zIndex(showCopyMenu ? 2 : 0)

            if showWidgets {
                ChatWidgetCarousel(
                    widgets: msg.widgets,
                    queued: msg.queued,
                    leadingInset: chatPagePadding
                )
                .frame(maxWidth: .infinity)
                .chatHistorySwipeBlock()
                // Cancel list padding so the carousel is screen-edge to screen-edge.
                .padding(.horizontal, -chatPagePadding)
                // MapKit reloads tiles when it inherits the Working-row spring.
                .transaction { $0.animation = nil }
                .zIndex(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func copyMessagePill(action: @escaping () -> Void) -> some View {
        Text("Copy")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(YLTheme.fg(colorScheme))
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .ylGlassCapsule(interactive: true)
            .fixedSize()
            .highPriorityGesture(
                TapGesture().onEnded { action() }
            )
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel("Copy")
    }
}

/// Rows for education chat: messages plus an optional Working indicator
/// inserted before faded queued bubbles.
private enum ChatRow: Identifiable, Equatable {
    case message(ChatMessage)
    case working(String)

    var id: String {
        switch self {
        case .message(let msg): return msg.id.uuidString
        case .working: return "working-indicator"
        }
    }
}

/// iOS 26 toolbar already draws one glass circle — don't nest another.
private struct BackendToggleChrome: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content
        } else {
            content.glassCircle(interactive: true)
        }
    }
}

/// Invisible UIKit button filling the paperclip glass circle. Shows the attach
/// menu as a native `UIMenu` (`showsMenuAsPrimaryAction`), replacing the
/// SwiftUI `Menu` whose rows lost taps on their text region on iOS 26+/27
/// (only the leading icon hit-tested). UIKit menu rows are hit-tested by the
/// context-menu container itself, independent of the accessory hosting view.
private struct ChatAttachMenuButton: UIViewRepresentable {
    var enabled: Bool
    var onPhotoLibrary: () -> Void
    var onFiles: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onPhotoLibrary: onPhotoLibrary, onFiles: onFiles)
    }

    func makeUIView(context: Context) -> UIButton {
        let button = UIButton(type: .custom)
        button.backgroundColor = .clear
        button.showsMenuAsPrimaryAction = true
        button.menu = context.coordinator.buildMenu()
        button.accessibilityLabel = "Attach file"
        // Parity with the old .ylHapticOnTap() on the SwiftUI Menu.
        button.addAction(
            UIAction { _ in YLHaptics.tap() },
            for: .menuActionTriggered
        )
        return button
    }

    func updateUIView(_ button: UIButton, context: Context) {
        // Never reassign button.menu here — SSE rootView updates run this many
        // times a second while Working, and swapping the menu would dismiss an
        // open one. The UIActions read the live closures via the coordinator.
        context.coordinator.onPhotoLibrary = onPhotoLibrary
        context.coordinator.onFiles = onFiles
        button.isEnabled = enabled
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: UIButton,
        context: Context
    ) -> CGSize? {
        // Fill the glass circle exactly; never fall back to UIButton's tiny
        // intrinsic size for an empty button.
        CGSize(
            width: proposal.width ?? IMessageComposer.height,
            height: proposal.height ?? IMessageComposer.height
        )
    }

    @MainActor
    final class Coordinator {
        var onPhotoLibrary: () -> Void
        var onFiles: () -> Void

        init(onPhotoLibrary: @escaping () -> Void, onFiles: @escaping () -> Void) {
            self.onPhotoLibrary = onPhotoLibrary
            self.onFiles = onFiles
        }

        func buildMenu() -> UIMenu {
            UIMenu(children: [
                UIAction(
                    title: "Photo Library",
                    image: UIImage(systemName: "photo.on.rectangle")
                ) { [weak self] _ in
                    self?.onPhotoLibrary()
                },
                UIAction(
                    title: "Files",
                    image: UIImage(systemName: "folder")
                ) { [weak self] _ in
                    self?.onFiles()
                },
            ])
        }
    }
}

/// Always-mounted UIKit anchor inside the chat NavigationStack that presents
/// `PHPickerViewController` directly.
///
/// History (all failed): `.photosPicker(isPresented:)` on the NavigationStack
/// was torn down by SSE body rebuilds while the agent was Working; presenting
/// from the key window's top VC raced the attach Menu's dismissal; a dedicated
/// alert-level `UIWindow` fought the Menu/keyboard windows for key status.
/// Meanwhile `fileImporter` — Menu flips a bool, a stable NavigationStack
/// citizen presents — never failed once. This mirrors that pipeline exactly,
/// but keeps the presentation in UIKit: once `present` is accepted, SwiftUI
/// invalidation cannot cancel it, and `updateUIViewController` re-entry during
/// SSE ticks is absorbed by the idempotent coordinator.
private struct ChatPhotoPickerHost: UIViewControllerRepresentable {
    @Binding var isPresented: Bool
    var maxSelection: Int
    var onPick: ([PHPickerResult]) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIViewController(context: Context) -> UIViewController {
        let anchor = UIViewController()
        anchor.view.backgroundColor = .clear
        anchor.view.isUserInteractionEnabled = false
        context.coordinator.anchor = anchor
        return anchor
    }

    func updateUIViewController(_ anchor: UIViewController, context: Context) {
        context.coordinator.parent = self
        context.coordinator.anchor = anchor
        if isPresented {
            context.coordinator.presentIfNeeded()
        }
    }

    @MainActor
    final class Coordinator: NSObject, PHPickerViewControllerDelegate,
        UIAdaptivePresentationControllerDelegate
    {
        var parent: ChatPhotoPickerHost
        weak var anchor: UIViewController?
        private weak var activePicker: PHPickerViewController?
        /// Bumped on every new request / teardown so stale retry closures
        /// scheduled by an older cycle become no-ops.
        private var presentCycle = 0
        private var presenting = false

        init(_ parent: ChatPhotoPickerHost) {
            self.parent = parent
        }

        /// Idempotent — SSE re-renders call `updateUIViewController` many
        /// times a second while Working; only the first call per request
        /// starts a present cycle.
        func presentIfNeeded() {
            guard !presenting, activePicker == nil else { return }
            presenting = true
            presentCycle += 1
            attemptPresent(cycle: presentCycle, attempt: 0)
        }

        private func attemptPresent(cycle: Int, attempt: Int) {
            guard cycle == presentCycle, presenting else { return }
            guard parent.isPresented else {
                presenting = false
                return
            }
            // ~2s of retries outlives the Menu dismissal and any in-flight
            // sheet/keyboard transition. On expiry, clear the flag so the
            // next tap starts a fresh cycle instead of a dead button.
            guard attempt <= 16 else {
                presenting = false
                parent.isPresented = false
                return
            }
            guard let anchor,
                  anchor.view.window != nil,
                  anchor.presentedViewController == nil
            else {
                scheduleRetry(cycle: cycle, attempt: attempt)
                return
            }

            var config = PHPickerConfiguration(photoLibrary: .shared())
            config.filter = .any(of: [.images, .screenshots])
            config.selectionLimit = max(1, min(parent.maxSelection, 16))
            config.preferredAssetRepresentationMode = .current

            let picker = PHPickerViewController(configuration: config)
            picker.delegate = self
            picker.presentationController?.delegate = self
            anchor.present(picker, animated: true)

            // UIKit refuses `present` silently when the presenting ancestor
            // is mid-transition (e.g. the attach Menu is still going away).
            // Accepted presentations set `presentingViewController` at once;
            // if it is still nil shortly after, retry with a fresh picker.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in
                guard let self, cycle == self.presentCycle, self.presenting else { return }
                if picker.presentingViewController != nil {
                    self.activePicker = picker
                    self.presenting = false
                } else {
                    self.attemptPresent(cycle: cycle, attempt: attempt + 1)
                }
            }
        }

        private func scheduleRetry(cycle: Int, attempt: Int) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
                self?.attemptPresent(cycle: cycle, attempt: attempt + 1)
            }
        }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            clearRequest()
            if picker.presentingViewController != nil {
                picker.dismiss(animated: true)
            }
            if !results.isEmpty {
                parent.onPick(results)
            }
        }

        /// Swipe-down dismissal can skip `didFinishPicking`; without this the
        /// stale `activePicker`/`isPresented` state would eat the next tap.
        func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
            clearRequest()
        }

        private func clearRequest() {
            presentCycle += 1
            presenting = false
            activePicker = nil
            if parent.isPresented {
                parent.isPresented = false
            }
        }
    }
}
