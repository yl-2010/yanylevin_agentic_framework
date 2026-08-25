import SwiftUI
import UIKit

// MARK: - Keyboard reserved height (composer + lift)

private struct YLKeyboardReservedBottomKey: EnvironmentKey {
    static let defaultValue: CGFloat = 0
}

extension EnvironmentValues {
    /// Height reserved for `ylKeyboardAccessory` (composer bar + keyboard lift).
    var ylKeyboardReservedBottom: CGFloat {
        get { self[YLKeyboardReservedBottomKey.self] }
        set { self[YLKeyboardReservedBottomKey.self] = newValue }
    }
}

// MARK: - Public API

/// SwiftUI `TextField` (especially `axis: .vertical`) keeps a UIKit editing
/// session while focused. Assigning the bound string to `""` updates SwiftUI
/// state, but the on-screen field can keep the old text — the usual failure
/// when queueing a chat turn with the keyboard still up.
enum YLComposerInput {
    @MainActor
    static func clearFocusedText() {
        guard let responder = firstResponderView() else { return }
        if clearText(in: responder) { return }
        var ancestor: UIView? = responder.superview
        while let view = ancestor {
            if clearText(in: view) { return }
            ancestor = view.superview
        }
        _ = clearTextInDescendants(of: responder)
    }

    private static func firstResponderView() -> UIView? {
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            for window in windowScene.windows {
                if let found = findFirstResponder(in: window) { return found }
            }
        }
        return nil
    }

    private static func findFirstResponder(in view: UIView) -> UIView? {
        if view.isFirstResponder { return view }
        for sub in view.subviews {
            if let found = findFirstResponder(in: sub) { return found }
        }
        return nil
    }

    @discardableResult
    private static func clearText(in view: UIView) -> Bool {
        if let textView = view as? UITextView {
            guard !textView.text.isEmpty else { return true }
            textView.text = ""
            textView.delegate?.textViewDidChange?(textView)
            return true
        }
        if let field = view as? UITextField {
            guard !(field.text ?? "").isEmpty else { return true }
            field.text = ""
            field.sendActions(for: .editingChanged)
            return true
        }
        guard let input = view as? any UITextInput,
              let range = input.textRange(
                from: input.beginningOfDocument,
                to: input.endOfDocument
              )
        else { return false }
        guard !(input.text(in: range) ?? "").isEmpty else { return true }
        input.replace(range, withText: "")
        return true
    }

    @discardableResult
    private static func clearTextInDescendants(of view: UIView) -> Bool {
        for sub in view.subviews {
            if clearText(in: sub) || clearTextInDescendants(of: sub) { return true }
        }
        return false
    }
}

extension View {
    /// Pins `accessory` to the keyboard via UIKit `keyboardLayoutGuide`.
    /// Position is owned by Auto Layout (tracks interactive dismiss). The
    /// accessory must own `@FocusState` inside its tree (`YLHostedFocus`).
    func ylKeyboardAccessory<Accessory: View>(
        @ViewBuilder accessory: @escaping () -> Accessory
    ) -> some View {
        modifier(YLKeyboardAccessoryModifier(accessory: accessory, above: { EmptyView() }))
    }

    /// Same, plus `above`: a view riding directly on the accessory's top edge.
    /// It is hosted in its OWN hosting controller pinned to the bar with rigid
    /// Auto Layout (bottom == bar.top) — never inside the accessory's hosting
    /// controller, and never positioned from per-frame SwiftUI state. Both of
    /// those couplings wedged the main thread on focus (Fitness chips).
    func ylKeyboardAccessory<Accessory: View, Above: View>(
        @ViewBuilder accessory: @escaping () -> Accessory,
        @ViewBuilder above: @escaping () -> Above
    ) -> some View {
        modifier(YLKeyboardAccessoryModifier(accessory: accessory, above: above))
    }
}

// MARK: - Modifier

private struct YLKeyboardAccessoryModifier: ViewModifier {
    private let accessoryBuilder: () -> AnyView
    /// nil when `Above == EmptyView` (Chat's single-argument call) — the
    /// representable and chrome then skip every above-host code path, so that
    /// configuration is behaviorally identical to the original modifier.
    private let aboveBuilder: (() -> AnyView)?
    @State private var reservedBottom: CGFloat = 0

    init<Accessory: View, Above: View>(
        @ViewBuilder accessory: @escaping () -> Accessory,
        @ViewBuilder above: @escaping () -> Above
    ) {
        accessoryBuilder = { AnyView(accessory()) }
        aboveBuilder = Above.self == EmptyView.self ? nil : { AnyView(above()) }
    }

    func body(content: Content) -> some View {
        // No fill here — parent `.ylPageBackground()` (or tab wash) must show
        // through so floating glass controls aren't sitting on a second slab.
        ZStack(alignment: .bottom) {
            content
                .safeAreaPadding(.bottom, reservedBottom)
                .ignoresSafeArea(.keyboard, edges: .bottom)
                .zIndex(0)

            YLKeyboardAccessoryRepresentable(
                accessory: accessoryBuilder,
                above: aboveBuilder,
                onReservedBottomChange: { next in
                    if abs(next - reservedBottom) > 1 {
                        reservedBottom = next
                    }
                }
            )
            // Keep the composer (and Liquid Glass finger warp) above the
            // scroll/page slab so stretch isn't clipped under a solid block.
            .zIndex(1_000)
        }
        .environment(\.ylKeyboardReservedBottom, reservedBottom)
    }
}

// MARK: - Size reporting (ground truth for multi-line TextField)

private struct AccessoryHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// Reports the laid-out SwiftUI height so UIKit can match it. Without this, a
/// vertical `TextField` + `fixedSize` draws taller than the host and spills
/// under the keyboard once it passes ~3–4 lines.
struct SizeReportingAccessory: View {
    var onHeight: (CGFloat) -> Void
    var content: AnyView

    var body: some View {
        content
            .fixedSize(horizontal: false, vertical: true)
            .background {
                GeometryReader { geo in
                    Color.clear.preference(key: AccessoryHeightKey.self, value: geo.size.height)
                }
            }
            .onPreferenceChange(AccessoryHeightKey.self, perform: onHeight)
    }
}

// MARK: - Representable

private struct YLKeyboardAccessoryRepresentable: UIViewRepresentable {
    var accessory: () -> AnyView
    var above: (() -> AnyView)?
    var onReservedBottomChange: (CGFloat) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onReservedBottomChange: onReservedBottomChange)
    }

    func makeUIView(context: Context) -> YLKeyboardAccessoryChrome {
        let chrome = YLKeyboardAccessoryChrome()
        chrome.isOpaque = false
        chrome.backgroundColor = .clear
        chrome.clipsToBounds = false
        chrome.layer.masksToBounds = false

        let host = UIHostingController(rootView: sizedRoot(chrome: chrome))
        host.view.isOpaque = false
        host.view.backgroundColor = .clear
        host.view.clipsToBounds = false
        host.view.layer.masksToBounds = false
        host.safeAreaRegions = []
        // Still enable intrinsic updates as a fallback; explicit height comes
        // from SizeReportingAccessory → applyContentHeight.
        host.sizingOptions = .intrinsicContentSize
        context.coordinator.host = host
        chrome.install(host: host)

        if let above {
            // Own hosting controller pinned above the bar — its SwiftUI layout
            // can never dirty the focused field's tree, and its position is
            // owned by Auto Layout (no per-frame SwiftUI state).
            let aboveHost = UIHostingController(rootView: above())
            aboveHost.view.isOpaque = false
            aboveHost.view.backgroundColor = .clear
            aboveHost.view.clipsToBounds = false
            aboveHost.view.layer.masksToBounds = false
            aboveHost.safeAreaRegions = []
            aboveHost.sizingOptions = .intrinsicContentSize
            context.coordinator.aboveHost = aboveHost
            chrome.installAbove(host: aboveHost)
        }

        chrome.onReservedBottomChange = { [weak coordinator = context.coordinator] value in
            coordinator?.onReservedBottomChange(value)
        }
        return chrome
    }

    func updateUIView(_ uiView: YLKeyboardAccessoryChrome, context: Context) {
        context.coordinator.onReservedBottomChange = onReservedBottomChange
        uiView.onReservedBottomChange = { [weak coordinator = context.coordinator] value in
            coordinator?.onReservedBottomChange(value)
        }
        context.coordinator.host?.rootView = sizedRoot(chrome: uiView)
        // UIHostingController can re-enable clipping when the root view updates.
        if let bar = context.coordinator.host?.view {
            bar.clipsToBounds = false
            bar.layer.masksToBounds = false
        }
        if let above, let aboveHost = context.coordinator.aboveHost {
            aboveHost.rootView = above()
            aboveHost.view.clipsToBounds = false
            aboveHost.view.layer.masksToBounds = false
        }
        uiView.clipsToBounds = false
        uiView.layer.masksToBounds = false
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: YLKeyboardAccessoryChrome,
        context: Context
    ) -> CGSize? {
        let width = proposal.width ?? UIScreen.main.bounds.width
        // Fill the ZStack so keyboardLayoutGuide shares screen coordinates and
        // hit-testing can reach a bar that floats above the keyboard. Never
        // invent a taller-than-parent size — that extends under the tab bar.
        if let h = proposal.height, h.isFinite, h > 1 {
            return CGSize(width: width, height: h)
        }
        let fallback = uiView.bounds.height
        return CGSize(width: width, height: fallback > 1 ? fallback : 1)
    }

    private func sizedRoot(chrome: YLKeyboardAccessoryChrome) -> SizeReportingAccessory {
        SizeReportingAccessory(
            onHeight: { [weak chrome] height in
                chrome?.applyContentHeight(height)
            },
            content: accessory()
        )
    }

    final class Coordinator {
        var onReservedBottomChange: (CGFloat) -> Void
        var host: UIHostingController<SizeReportingAccessory>?
        var aboveHost: UIHostingController<AnyView>?

        init(onReservedBottomChange: @escaping (CGFloat) -> Void) {
            self.onReservedBottomChange = onReservedBottomChange
        }
    }
}

// MARK: - Chrome (UIKit pin)

/// Pins the hosted accessory bottom to `keyboardLayoutGuide.top` — this is what
/// makes interactive dismiss track the finger. SwiftUI never owns vertical motion.
final class YLKeyboardAccessoryChrome: UIView {
    var onReservedBottomChange: ((CGFloat) -> Void)?

    private var host: UIHostingController<SizeReportingAccessory>?
    private var aboveHost: UIHostingController<AnyView>?
    private var aboveConstraints: [NSLayoutConstraint] = []
    private var widthConstraints: [NSLayoutConstraint] = []
    private var verticalConstraints: [NSLayoutConstraint] = []
    private var heightConstraint: NSLayoutConstraint?
    private var keyboardPin: NSLayoutConstraint?
    private var restEqual: NSLayoutConstraint?
    private var restFloor: NSLayoutConstraint?
    private var tokens: [NSObjectProtocol] = []
    private var displayLink: CADisplayLink?
    private var foregroundDisplayLink: CADisplayLink?
    private var foregroundRepinUntil: TimeInterval = 0
    private weak var cachedTabBar: UIView?
    private var restGap: CGFloat = 0
    private var restingGap: CGFloat = 0
    private var notificationCoverage: CGFloat = 0
    private var lastReserved: CGFloat = -1
    private var contentHeight: CGFloat = 56
    private var isScrubbing = false
    private var scrubLift: CGFloat = 0
    private var scrubProgress: CGFloat = 0
    private var scrubReservedFull: CGFloat = 0
    private var scrubReservedRest: CGFloat = 0
    private var lastKeyboardScreenFrame: CGRect = .zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        clipsToBounds = false
        layer.masksToBounds = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    deinit {
        displayLink?.invalidate()
        foregroundDisplayLink?.invalidate()
        tokens.forEach(NotificationCenter.default.removeObserver)
        detachHost()
    }

    func install(host: UIHostingController<SizeReportingAccessory>) {
        detachHost()
        self.host?.view.removeFromSuperview()
        self.host = host

        let bar = host.view!
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.isOpaque = false
        bar.backgroundColor = .clear
        // Must stay unclipped: interactive Liquid Glass on attach/send/field
        // stretches outside the control bounds. Height is owned by
        // SizeReportingAccessory → applyContentHeight (no paint spill needed).
        bar.clipsToBounds = false
        bar.layer.masksToBounds = false
        // Keep glass warp above sibling scroll content / page fill.
        bar.layer.zPosition = 1_000
        bar.setContentHuggingPriority(.required, for: .vertical)
        bar.setContentCompressionResistancePriority(.required, for: .vertical)
        addSubview(bar)

        NSLayoutConstraint.deactivate(widthConstraints)
        widthConstraints = [
            bar.leadingAnchor.constraint(equalTo: leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: trailingAnchor),
        ]
        NSLayoutConstraint.activate(widthConstraints)

        let height = bar.heightAnchor.constraint(equalToConstant: contentHeight)
        height.priority = .required
        heightConstraint = height
        height.isActive = true

        attachHostIfPossible()
        installVerticalConstraints()
        publishReserved(animated: false, duration: 0)
    }

    /// Pins `host` directly above the bar: bottom == bar.top, full width.
    /// Rigid Auto Layout — it rides the keyboard exactly like the bar, with
    /// no SwiftUI state feeding its position (that coupling wedged focus).
    func installAbove(host: UIHostingController<AnyView>) {
        aboveHost?.willMove(toParent: nil)
        aboveHost?.removeFromParent()
        aboveHost?.view.removeFromSuperview()
        aboveHost = host
        guard let bar = self.host?.view, let float = host.view else { return }

        float.translatesAutoresizingMaskIntoConstraints = false
        float.isOpaque = false
        float.backgroundColor = .clear
        float.clipsToBounds = false
        float.layer.masksToBounds = false
        // Purely visual (chips) — never intercept touches meant for content.
        float.isUserInteractionEnabled = false
        // Paint above the bar so overlap during insert transitions reads right.
        float.layer.zPosition = 1_001
        addSubview(float)

        NSLayoutConstraint.deactivate(aboveConstraints)
        aboveConstraints = [
            float.leadingAnchor.constraint(equalTo: leadingAnchor),
            float.trailingAnchor.constraint(equalTo: trailingAnchor),
            float.bottomAnchor.constraint(equalTo: bar.topAnchor),
        ]
        NSLayoutConstraint.activate(aboveConstraints)
        attachHostIfPossible()
    }

    /// Called from SwiftUI when the composer’s laid-out height changes.
    func applyContentHeight(_ height: CGFloat) {
        let next = max(height.rounded(.up), 56)
        guard abs(contentHeight - next) > 0.5 else { return }
        contentHeight = next
        if let heightConstraint, abs(heightConstraint.constant - next) > 0.5 {
            heightConstraint.constant = next
        }
        keyboardLayoutGuide.keyboardDismissPadding = next
        // Keep reserved padding in sync so scroll content clears the taller bar.
        publishReserved(animated: false, duration: 0)
        setNeedsLayout()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        attachHostIfPossible()
        installNotifications()
        captureRestingIfNeeded()
        if window != nil {
            YLKeyboardScrub.register(self)
            scheduleForegroundRepin()
        } else {
            YLKeyboardScrub.unregister(self)
            foregroundDisplayLink?.invalidate()
            foregroundDisplayLink = nil
            cachedTabBar = nil
            installVerticalConstraints()
            publishReserved(animated: false, duration: 0)
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        keyboardLayoutGuide.keyboardDismissPadding = max(contentHeight, 56)
        captureRestingIfNeeded()
        updateRestGap()
        if isScrubbing {
            publishReserved(animated: false, duration: 0)
            return
        }
        let barH = max(contentHeight, heightConstraint?.constant ?? 0, 56)
        let lift = keyboardLift()
        let pinGap: CGFloat = lift > 0.5 ? -10 : 0
        let next = barH + lift - pinGap
        guard abs(next - lastReserved) > 1 else { return }
        publishReserved(animated: false, duration: 0)
    }

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        installVerticalConstraints()
        publishReserved(animated: false, duration: 0)
    }

    /// Bar often sits above this view’s bottom (over the keyboard). Accept hits
    /// anywhere on the bar, not only inside the chrome’s layout bounds.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        guard let bar = host?.view else { return false }
        return bar.point(inside: convert(point, to: bar), with: event)
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard let bar = host?.view else { return nil }
        return bar.hitTest(convert(point, to: bar), with: event)
    }

    private func detachHost() {
        host?.willMove(toParent: nil)
        host?.removeFromParent()
        aboveHost?.willMove(toParent: nil)
        aboveHost?.removeFromParent()
    }

    private func attachHostIfPossible() {
        var responder: UIResponder? = self
        while let current = responder {
            if let vc = current as? UIViewController {
                for child in [host as UIViewController?, aboveHost].compactMap({ $0 })
                where child.parent == nil {
                    vc.addChild(child)
                    child.didMove(toParent: vc)
                }
                return
            }
            responder = current.next
        }
    }

    private func installVerticalConstraints() {
        NSLayoutConstraint.deactivate(verticalConstraints)
        verticalConstraints = []
        restEqual = nil
        restFloor = nil
        keyboardPin = nil
        guard let bar = host?.view else { return }

        keyboardLayoutGuide.usesBottomSafeArea = true

        // High, not required: a stale guide (lock-screen Control, passcode
        // keyboard) can sit at the screen bottom. The rest floor below keeps
        // the composer above the tab bar in that case.
        let toKeyboard = bar.bottomAnchor.constraint(
            equalTo: keyboardLayoutGuide.topAnchor,
            constant: 0
        )
        toKeyboard.priority = .defaultHigh
        keyboardPin = toKeyboard

        let gap = measuredRestGap()
        restGap = gap

        let toRest = bar.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -gap)
        toRest.priority = .defaultLow
        restEqual = toRest

        let floorChrome = bar.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor)
        floorChrome.priority = .required

        let floorRest = bar.bottomAnchor.constraint(
            lessThanOrEqualTo: bottomAnchor,
            constant: -gap
        )
        floorRest.priority = .required
        restFloor = floorRest

        var next: [NSLayoutConstraint] = [toKeyboard, toRest, floorChrome, floorRest]
        if let tabTop = tabBarTopAnchor() {
            let floorTab = bar.bottomAnchor.constraint(lessThanOrEqualTo: tabTop, constant: -8)
            floorTab.priority = .required
            next.append(floorTab)
        }
        verticalConstraints = next
        NSLayoutConstraint.activate(verticalConstraints)
    }

    /// Distance the chrome extends below where the composer should rest
    /// (tab-bar top, or a guessed tab bar + home indicator on first layout).
    private func measuredRestGap() -> CGFloat {
        guard let window, bounds.height > 1 else {
            return traitCollection.userInterfaceIdiom == .pad ? CGFloat(0) : 49
        }
        let chromeBottom = convert(CGPoint(x: 0, y: bounds.maxY), to: window).y
        let limitY: CGFloat
        if let tabBar = cachedTabBar, tabBar.window === window, !tabBar.isHidden, tabBar.bounds.height > 8 {
            let top = tabBar.convert(CGPoint(x: 0, y: 0), to: window).y
            limitY = top - 8
        } else if let tab = nearestTabBarController() {
            let bar = tab.tabBar
            if bar.window === window, !bar.isHidden, bar.bounds.height > 8 {
                cachedTabBar = bar
                let top = bar.convert(CGPoint(x: 0, y: 0), to: window).y
                limitY = top - 8
            } else {
                let inset = tab.view.safeAreaInsets.bottom
                if inset > window.safeAreaInsets.bottom + 8 {
                    limitY = window.bounds.maxY - inset
                } else {
                    let guessed: CGFloat = traitCollection.userInterfaceIdiom == .pad ? 0 : 49
                    limitY = window.bounds.maxY - window.safeAreaInsets.bottom - guessed
                }
            }
        } else {
            let guessed: CGFloat = traitCollection.userInterfaceIdiom == .pad ? 0 : 49
            limitY = window.bounds.maxY - window.safeAreaInsets.bottom - guessed
        }
        return max(0, chromeBottom - limitY)
    }

    private func updateRestGap() {
        let gap = measuredRestGap()
        guard abs(gap - restGap) > 0.5 else { return }
        restGap = gap
        restFloor?.constant = -gap
        restEqual?.constant = -gap
    }

    private func tabBarTopAnchor() -> NSLayoutYAxisAnchor? {
        visibleTabBar()?.topAnchor
    }

    /// Only ever returns a tab bar in the SAME window as this chrome.
    /// Constraining against a bar in another window/scene (Lock Screen
    /// Control chat, mid-transition detach) throws "no common ancestor"
    /// and kills the app.
    private func visibleTabBar() -> UIView? {
        guard let window else {
            cachedTabBar = nil
            return nil
        }
        if let cached = cachedTabBar, cached.window === window, !cached.isHidden, cached.bounds.height > 8 {
            return cached
        }
        cachedTabBar = nil
        if let tab = nearestTabBarController() {
            let bar = tab.tabBar
            if bar.window === window, !bar.isHidden, bar.alpha > 0.01, bar.bounds.height > 8 {
                cachedTabBar = bar
                return bar
            }
        }
        if let found = findTabBar(in: window) {
            cachedTabBar = found
            return found
        }
        return nil
    }

    private func findTabBar(in view: UIView) -> UITabBar? {
        if let bar = view as? UITabBar, bar.window != nil, !bar.isHidden, bar.bounds.height > 8 {
            return bar
        }
        for sub in view.subviews {
            if let found = findTabBar(in: sub) { return found }
        }
        return nil
    }

    /// Bottom of the tab content safe area (above the tab bar). Nil on iPad
    /// sidebar layouts or before the UIKit tab controller is in the window.
    private func nearestTabBarController() -> UITabBarController? {
        var responder: UIResponder? = self
        while let current = responder {
            if let tab = current as? UITabBarController { return tab }
            if let vc = current as? UIViewController, let tab = vc.tabBarController {
                return tab
            }
            responder = current.next
        }
        guard let root = window?.rootViewController else { return nil }
        return findTabBarController(from: root)
    }

    private func findTabBarController(from vc: UIViewController) -> UITabBarController? {
        if let tab = vc as? UITabBarController { return tab }
        if let tab = vc.tabBarController { return tab }
        if let presented = vc.presentedViewController,
           let tab = findTabBarController(from: presented)
        {
            return tab
        }
        for child in vc.children {
            if let tab = findTabBarController(from: child) { return tab }
        }
        return nil
    }

    /// Re-pin through the lock-screen unlock animation. Tab bar and safe area
    /// often arrive a beat late; a single delayed pass is not enough.
    private func scheduleForegroundRepin() {
        cachedTabBar = nil
        installVerticalConstraints()
        updateRestGap()
        publishReserved(animated: false, duration: 0)
        foregroundRepinUntil = ProcessInfo.processInfo.systemUptime + 1.25
        if foregroundDisplayLink == nil {
            let link = CADisplayLink(target: self, selector: #selector(foregroundTick))
            link.add(to: .main, forMode: .common)
            foregroundDisplayLink = link
        }
    }

    @objc private func foregroundTick() {
        if cachedTabBar == nil {
            _ = visibleTabBar()
            if cachedTabBar != nil {
                installVerticalConstraints()
            }
        }
        updateRestGap()
        setNeedsLayout()
        publishReserved(animated: false, duration: 0)
        if ProcessInfo.processInfo.systemUptime >= foregroundRepinUntil {
            foregroundDisplayLink?.invalidate()
            foregroundDisplayLink = nil
        }
    }

    private func installNotifications() {
        tokens.forEach(NotificationCenter.default.removeObserver)
        tokens = []
        let center = NotificationCenter.default
        for name in [
            UIResponder.keyboardWillChangeFrameNotification,
            UIResponder.keyboardDidChangeFrameNotification,
            UIResponder.keyboardWillHideNotification,
            UIResponder.keyboardDidHideNotification,
            UIScene.didActivateNotification,
            UIApplication.willEnterForegroundNotification,
            UIApplication.didBecomeActiveNotification,
        ] as [Notification.Name] {
            tokens.append(
                center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                    self?.handle(note)
                }
            )
        }
    }

    private func handle(_ notification: Notification) {
        if isScrubbing { return }
        switch notification.name {
        case UIResponder.keyboardWillHideNotification, UIResponder.keyboardDidHideNotification:
            notificationCoverage = 0
            stopDisplayLink()
            captureRestingIfNeeded()
            installVerticalConstraints()
        case UIScene.didActivateNotification,
             UIApplication.willEnterForegroundNotification,
             UIApplication.didBecomeActiveNotification:
            notificationCoverage = 0
            stopDisplayLink()
            captureRestingIfNeeded()
            scheduleForegroundRepin()
            return
        default:
            updateNotificationCoverage(from: notification)
            if notificationCoverage < 0.5 {
                captureRestingIfNeeded()
                stopDisplayLink()
            } else {
                startDisplayLink()
            }
        }
        let duration = (notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0
        publishReserved(animated: duration > 0.01, duration: duration)
    }

    private func startDisplayLink() {
        guard displayLink == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    private func stopDisplayLink() {
        displayLink?.invalidate()
        displayLink = nil
    }

    @objc private func tick() {
        publishReserved(animated: false, duration: 0)
        if notificationCoverage < 0.5, keyboardLift() < 0.5 {
            stopDisplayLink()
        }
    }

    private func updateNotificationCoverage(from notification: Notification) {
        guard let window else {
            if notification.name == UIResponder.keyboardDidHideNotification {
                notificationCoverage = 0
            }
            return
        }
        if let endFrame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect {
            lastKeyboardScreenFrame = endFrame
            let frame = window.convert(endFrame, from: nil)
            notificationCoverage = frame.minY >= window.bounds.maxY - 0.5
                ? 0
                : max(0, window.bounds.maxY - frame.minY)
            return
        }
        if notification.name == UIResponder.keyboardDidHideNotification {
            notificationCoverage = 0
        }
    }

    private func captureRestingIfNeeded() {
        guard notificationCoverage < 0.5 else { return }
        guard let window else { return }
        let safeBottom = (window.rootViewController?.view ?? window).safeAreaInsets.bottom
        if safeBottom > 0.5, safeBottom < 160 {
            restingGap = safeBottom
            return
        }
        let frame = convert(bounds, to: window)
        let bottomY = max(frame.maxY, frame.minY)
        if bottomY > 1 {
            let gap = max(0, window.bounds.maxY - bottomY)
            if gap > 0.5, gap < 160 {
                restingGap = gap
            }
        }
    }

    private func keyboardLift() -> CGFloat {
        guard let window else { return 0 }
        let guideRect = convert(keyboardLayoutGuide.layoutFrame, to: window)
        let guideCoverage = max(0, window.bounds.maxY - guideRect.minY)
        let coverage = max(guideCoverage, notificationCoverage)
        if coverage < 0.5 { return 0 }
        if notificationCoverage < 0.5, guideCoverage <= restingGap + 1.5 { return 0 }
        let rest = restingGap > 0.5 ? restingGap : 0
        return max(0, coverage - rest)
    }

    func keyboardScrubMetrics() -> (lift: CGFloat, coverage: CGFloat, frame: CGRect)? {
        guard let window else { return nil }
        let lift = keyboardLift()
        let guideRect = convert(keyboardLayoutGuide.layoutFrame, to: window)
        let guideCoverage = max(0, window.bounds.maxY - guideRect.minY)
        let coverage = max(guideCoverage, notificationCoverage)
        // Lift subtracts the rest/home-indicator baseline. Coverage alone is
        // already ~34pt with the keys down, which used to start a history
        // swipe scrub and slide the composer.
        guard lift > 20 else { return nil }
        var frame = lastKeyboardScreenFrame
        if frame.height < 1 {
            frame = convert(keyboardLayoutGuide.layoutFrame, to: nil)
        }
        return (lift, coverage, frame)
    }

    func beginKeyboardScrub(lift: CGFloat) {
        isScrubbing = true
        scrubLift = max(lift, 1)
        scrubProgress = 0
        let barH = max(contentHeight, heightConstraint?.constant ?? 0, 56)
        let pinGap: CGFloat = scrubLift > 0.5 ? -10 : 0
        scrubReservedFull = barH + scrubLift - pinGap
        scrubReservedRest = barH
    }

    func setKeyboardScrubProgress(_ p: CGFloat) {
        guard isScrubbing else { return }
        scrubProgress = min(max(p, 0), 1)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let ty = scrubProgress * scrubLift
        host?.view.transform = CGAffineTransform(translationX: 0, y: ty)
        aboveHost?.view.transform = CGAffineTransform(translationX: 0, y: ty)
        CATransaction.commit()
        publishReserved(animated: false, duration: 0)
    }

    func endKeyboardScrub(resetTransform: Bool, keyboardHidden: Bool = false) {
        isScrubbing = false
        scrubProgress = 0
        if keyboardHidden {
            // Hide notifications were ignored while scrubbing so resign
            // would not fight the transform. Apply the hide side effects now.
            notificationCoverage = 0
            stopDisplayLink()
            captureRestingIfNeeded()
            installVerticalConstraints()
        }
        if resetTransform {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            host?.view.transform = .identity
            aboveHost?.view.transform = .identity
            CATransaction.commit()
        }
        lastReserved = -1
        publishReserved(animated: false, duration: 0)
    }

    private func publishReserved(animated: Bool, duration: Double) {
        let next: CGFloat
        if isScrubbing {
            next = scrubReservedRest + (scrubReservedFull - scrubReservedRest) * (1 - scrubProgress)
        } else {
            let barH = max(contentHeight, heightConstraint?.constant ?? 0, 56)
            let lift = keyboardLift()
            // Breathing room above the autocomplete bar while the keyboard is up.
            let pinGap: CGFloat = lift > 0.5 ? -10 : 0
            if let keyboardPin, abs(keyboardPin.constant - pinGap) > 0.5 {
                keyboardPin.constant = pinGap
            }
            next = barH + lift - pinGap
        }
        guard abs(next - lastReserved) > (isScrubbing ? 0.25 : 1) else { return }
        lastReserved = next
        // This runs from UIKit callbacks — layoutSubviews, keyboard/activation
        // notifications, display-link ticks, even makeUIView — which can fire
        // while SwiftUI is mid-update (unlock transition + rapid backend
        // toggles). Publishing SwiftUI state synchronously from there is an
        // AttributeGraph crash. Always defer to the next runloop turn; the bar
        // position is Auto Layout-owned, this only pads scroll content.
        let apply = { [weak self] in
            guard let self else { return }
            self.onReservedBottomChange?(next)
        }
        DispatchQueue.main.async {
            if animated {
                withAnimation(.easeOut(duration: duration), apply)
            } else {
                var t = Transaction()
                t.disablesAnimations = true
                withTransaction(t, apply)
            }
        }
    }
}
