import CoreHaptics
import SwiftUI
import UIKit

/// Shared Taptic helpers — Core Haptics for soft/longer taps + busy bloops;
/// UIKit generators as fallback and for a few discrete ticks.
///
/// Interaction ticks (tap / drag / interrupt) are bound to the key window and
/// fired at the last contact point so Apple Pencil Pro can play the same Heavy /
/// Medium / Soft impacts as a finger on iPhone. iPad also mirrors those ticks
/// through `UICanvasFeedbackGenerator`, which is what actually reaches Pencil.
/// Ongoing “Working” bloops stay device-only and are not mirrored to Pencil.
enum YLHaptics {
    /// Unlocated fallback for the chat “Working” pulse — must not use a view or
    /// point, or iPad would tickle Apple Pencil on every bloop.
    private static let busySoftImpact = UIImpactFeedbackGenerator(style: .soft)

    private static var busyTask: Task<Void, Never>?
    private static var busyGeneration = 0

    /// Attach the window probe so the first Pencil tap already has a location.
    static func prepareSession() {
        HapticHost.shared.attach()
    }

    /// Control tap — system Impact Heavy (HIG).
    static func tap() {
        playImpact(.heavy)
    }

    /// Hold-to-interrupt release — stronger than `tap()` so it is obvious
    /// the live Personal Agent turn was cancelled, not queued.
    static func interrupt() {
        Engine.shared.prepare()
        if Engine.shared.supportsHaptics {
            Engine.shared.play(events: [
                CHHapticEvent(
                    eventType: .hapticTransient,
                    parameters: [
                        CHHapticEventParameter(parameterID: .hapticIntensity, value: 1),
                        CHHapticEventParameter(parameterID: .hapticSharpness, value: 1)
                    ],
                    relativeTime: 0
                ),
                CHHapticEvent(
                    eventType: .hapticTransient,
                    parameters: [
                        CHHapticEventParameter(parameterID: .hapticIntensity, value: 1),
                        CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.45)
                    ],
                    relativeTime: 0.09
                )
            ])
        } else {
            playImpact(.heavy, intensity: 1)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.09) {
                playImpact(.heavy, intensity: 1)
            }
        }
        // iPad with a Taptic-capable engine still needs a Pencil mirror;
        // `playImpact` already covers the no-engine iPad path.
        if Engine.shared.supportsHaptics {
            playCanvasAlignment()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.09) {
                playCanvasAlignment()
            }
        }
    }

    /// Navigation into a detail / submenu — system Impact Medium (HIG).
    static func medium() {
        playImpact(.medium)
    }

    /// Mushy soft thump when a machine-title swipe crosses halfway (titles split).
    static func machineSwipeHalfway() {
        playImpact(.soft, intensity: 0.92)
    }

    /// Warm the soft generator as a machine-title drag begins.
    static func prepareMachineSwipe() {
        HapticHost.shared.attach()
        HapticHost.shared.soft.prepare()
        HapticHost.shared.canvas?.prepare()
        Engine.shared.prepare()
    }

    /// Soft continuous bloops synced to `YLBusyDots` (150% of the original 0.32s step).
    static func startBusyPulse() {
        stopBusyPulse()
        busyGeneration += 1
        let generation = busyGeneration
        let stepNanos = UInt64(YLBusyPulse.step * 1_000_000_000)
        Engine.shared.prepare()
        busySoftImpact.prepare()
        busyTask = Task { @MainActor in
            // Immediate first bloop so waiting feedback is obvious right away.
            Self.busyBloop()
            while !Task.isCancelled, generation == busyGeneration {
                try? await Task.sleep(nanoseconds: stepNanos)
                guard !Task.isCancelled, generation == busyGeneration else { return }
                Self.busyBloop()
            }
        }
    }

    static func stopBusyPulse() {
        busyGeneration += 1
        busyTask?.cancel()
        busyTask = nil
    }

    // MARK: - Swipe-back (interactive pop)

    /// Warm the soft generator as the pop drag begins (same prep as machine-title swipe).
    static func swipeBackBegan() {
        prepareMachineSwipe()
    }

    /// Same mushy soft thump as the fitness machine-title halfway crossing.
    static func swipeBackCrossedThreshold() {
        machineSwipeHalfway()
    }

    // MARK: - Patterns

    private static func busyBloop() {
        if Engine.shared.supportsHaptics {
            Engine.shared.play(events: [
                softContinuous(
                    intensity: 0.58,
                    sharpness: 0.1,
                    duration: 0.09,
                    attack: 0.02,
                    decay: 0.05,
                    release: 0.04
                )
            ])
        } else {
            busySoftImpact.impactOccurred(intensity: 0.65)
            busySoftImpact.prepare()
        }
    }

    private static func playImpact(
        _ style: UIImpactFeedbackGenerator.FeedbackStyle,
        intensity: CGFloat? = nil,
        mirrorCanvas: Bool = true
    ) {
        HapticHost.shared.attach()
        let generator = HapticHost.shared.impact(style)
        let location = HapticHost.shared.location
        if let intensity {
            generator.impactOccurred(intensity: intensity, at: location)
        } else {
            generator.impactOccurred(at: location)
        }
        generator.prepare()
        if mirrorCanvas {
            playCanvasAlignment()
        }
    }

    /// Pencil Pro / Magic Keyboard path. No-op on iPhone. Skipped for busy bloops.
    private static func playCanvasAlignment() {
        guard UIDevice.current.userInterfaceIdiom == .pad else { return }
        HapticHost.shared.attach()
        HapticHost.shared.canvas?.alignmentOccurred(at: HapticHost.shared.location)
        HapticHost.shared.canvas?.prepare()
    }

    private static func softContinuous(
        intensity: Float,
        sharpness: Float,
        duration: TimeInterval,
        attack: Float,
        decay: Float,
        release: Float = 0.04,
        relativeTime: TimeInterval = 0
    ) -> CHHapticEvent {
        CHHapticEvent(
            eventType: .hapticContinuous,
            parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: intensity),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: sharpness),
                CHHapticEventParameter(parameterID: .attackTime, value: attack),
                CHHapticEventParameter(parameterID: .decayTime, value: decay),
                CHHapticEventParameter(parameterID: .releaseTime, value: release)
            ],
            relativeTime: relativeTime,
            duration: duration
        )
    }
}

// MARK: - Window-bound generators (Pencil / trackpad routing)

/// Binds impact + canvas generators to the key window and records the last
/// finger / Pencil / pointer location so `impactOccurred(at:)` can route.
private final class HapticHost {
    static let shared = HapticHost()

    private(set) var heavy = UIImpactFeedbackGenerator(style: .heavy)
    private(set) var medium = UIImpactFeedbackGenerator(style: .medium)
    private(set) var soft = UIImpactFeedbackGenerator(style: .soft)
    private(set) var canvas: UICanvasFeedbackGenerator?
    var location: CGPoint { probe.lastLocation }

    private weak var boundWindow: UIWindow?
    private let probe = InteractionProbe()
    private var sceneObserver: NSObjectProtocol?

    private init() {
        sceneObserver = NotificationCenter.default.addObserver(
            forName: UIScene.didActivateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.attach()
        }
    }

    func impact(_ style: UIImpactFeedbackGenerator.FeedbackStyle) -> UIImpactFeedbackGenerator {
        switch style {
        case .heavy: return heavy
        case .medium: return medium
        case .soft: return soft
        default: return medium
        }
    }

    func attach() {
        guard let window = Self.keyWindow() else { return }
        if boundWindow !== window {
            if let old = boundWindow {
                old.removeGestureRecognizer(probe)
            }
            probe.cancelsTouchesInView = false
            probe.delaysTouchesBegan = false
            probe.delaysTouchesEnded = false
            probe.requiresExclusiveTouchType = false
            window.addGestureRecognizer(probe)
            boundWindow = window
            heavy = UIImpactFeedbackGenerator(style: .heavy, view: window)
            medium = UIImpactFeedbackGenerator(style: .medium, view: window)
            soft = UIImpactFeedbackGenerator(style: .soft, view: window)
            canvas = UICanvasFeedbackGenerator(view: window)
        }
        heavy.prepare()
        medium.prepare()
        soft.prepare()
        canvas?.prepare()
    }

    private static func keyWindow() -> UIWindow? {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
        return windows.first(where: \.isKeyWindow)
            ?? windows.first(where: { !$0.isHidden })
    }
}

/// Records contact points without claiming the touch (Pencil, finger, or pointer).
private final class InteractionProbe: UIGestureRecognizer, UIGestureRecognizerDelegate {
    private(set) var lastLocation: CGPoint = .zero

    init() {
        super.init(target: nil, action: nil)
        delegate = self
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
        requiresExclusiveTouchType = false
        allowedTouchTypes = [
            NSNumber(value: UITouch.TouchType.direct.rawValue),
            NSNumber(value: UITouch.TouchType.indirect.rawValue),
            NSNumber(value: UITouch.TouchType.pencil.rawValue),
            NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)
        ]
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func record(_ touches: Set<UITouch>) {
        guard let view else { return }
        let touch = touches.first(where: { $0.type == .pencil }) ?? touches.first
        guard let touch else { return }
        lastLocation = touch.location(in: view)
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        record(touches)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        record(touches)
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        record(touches)
        if state == .possible { state = .failed }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        if state == .possible { state = .failed }
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        true
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRequireFailureOf otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        false
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        false
    }
}

// MARK: - Core Haptics engine

private final class Engine {
    static let shared = Engine()

    private var engine: CHHapticEngine?
    let supportsHaptics: Bool

    private init() {
        supportsHaptics = CHHapticEngine.capabilitiesForHardware().supportsHaptics
        guard supportsHaptics else { return }
        do {
            let engine = try CHHapticEngine()
            engine.playsHapticsOnly = true
            engine.isAutoShutdownEnabled = true
            engine.resetHandler = { [weak self] in
                try? self?.engine?.start()
            }
            engine.stoppedHandler = { [weak self] reason in
                // Restart after system interruptions so busy/swipe keep working.
                if reason != .engineDestroyed {
                    try? self?.engine?.start()
                }
            }
            try engine.start()
            self.engine = engine
        } catch {
            self.engine = nil
        }
    }

    func prepare() {
        guard supportsHaptics else { return }
        try? engine?.start()
    }

    func play(events: [CHHapticEvent]) {
        guard supportsHaptics, let engine else { return }
        do {
            try engine.start()
            let pattern = try CHHapticPattern(events: events, parameters: [])
            let player = try engine.makePlayer(with: pattern)
            try player.start(atTime: CHHapticTimeImmediate)
        } catch {
            // Engine may be mid-reset; next call retries via prepare/start.
        }
    }
}

// MARK: - View helpers

extension View {
    /// Soft tap haptic for `NavigationLink` / `Link` / non-`Button` controls (Heavy).
    func ylHapticOnTap() -> some View {
        simultaneousGesture(
            TapGesture().onEnded { YLHaptics.tap() }
        )
    }

    /// Medium impact for pushing into an Education detail / submenu.
    func ylHapticNavigation() -> some View {
        simultaneousGesture(
            TapGesture().onEnded { YLHaptics.medium() }
        )
    }

    /// Soft bloops while `active` (public / education chat “Working”).
    func ylBusyHaptics(_ active: Bool) -> some View {
        modifier(YLBusyHapticsModifier(active: active))
    }

    /// Conventional swipe-back haptics. Put on pushed destinations (not the root stack)
    /// so the hosting VC sits under `UINavigationController` and can observe the pop gesture.
    /// On iOS 26+, attaches to `interactiveContentPopGestureRecognizer` (full-screen swipe).
    func ylSwipeBackHaptics() -> some View {
        background(YLSwipeBackHapticsObserver())
    }
}

/// Fires the swipe-back halfway thump on every threshold crossing (either direction),
/// including mid-spring after the finger lifts.
final class YLHalfwayHapticGate {
    private var lastProgress: CGFloat?
    private let threshold: CGFloat

    init(threshold: CGFloat = 0.5) {
        self.threshold = threshold
    }

    func handle(_ progress: CGFloat) {
        defer { lastProgress = progress }
        guard let last = lastProgress else { return }
        let crossedUp = last < threshold && progress >= threshold
        let crossedDown = last >= threshold && progress < threshold
        guard crossedUp || crossedDown else { return }
        YLHaptics.swipeBackCrossedThreshold()
    }

    func reset() {
        lastProgress = nil
    }
}

/// Reports an animated 0…1 progress every frame so halfway haptics can fire mid-spring.
struct YLProgressMonitor: AnimatableModifier {
    var progress: CGFloat
    var onProgress: (CGFloat) -> Void

    var animatableData: CGFloat {
        get { progress }
        set {
            progress = newValue
            onProgress(newValue)
        }
    }

    func body(content: Content) -> some View {
        content
    }
}

private struct YLBusyHapticsModifier: ViewModifier {
    let active: Bool

    func body(content: Content) -> some View {
        content
            .onChange(of: active) { _, isActive in
                if isActive {
                    YLHaptics.startBusyPulse()
                } else {
                    YLHaptics.stopBusyPulse()
                }
            }
            .onAppear {
                if active { YLHaptics.startBusyPulse() }
            }
            .onDisappear {
                YLHaptics.stopBusyPulse()
            }
    }
}

// MARK: - Swipe-back observer (UIViewControllerRepresentable — finds nav reliably)

/// Observes system interactive pop. iOS 26 uses full-content swipe via
/// `interactiveContentPopGestureRecognizer`; earlier OS uses edge-only
/// `interactivePopGestureRecognizer`. We attach to both when available.
private struct YLSwipeBackHapticsObserver: UIViewControllerRepresentable {
    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIViewController(context: Context) -> UIViewController {
        let controller = UIViewController()
        controller.view.isUserInteractionEnabled = false
        controller.view.backgroundColor = .clear
        // Defer until SwiftUI embeds us in the navigation hierarchy.
        DispatchQueue.main.async {
            context.coordinator.attach(from: controller)
        }
        return controller
    }

    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {
        context.coordinator.attach(from: uiViewController)
    }

    final class Coordinator: NSObject {
        private weak var edgeGesture: UIGestureRecognizer?
        private weak var contentGesture: UIGestureRecognizer?
        /// Same bidirectional halfway gate as fitness machine-title swipe.
        private var lastProgress: CGFloat?
        private let commitThreshold: CGFloat = 0.35

        func attach(from controller: UIViewController) {
            guard let nav = Self.findNavigationController(from: controller) else { return }

            let edge = nav.interactivePopGestureRecognizer
            if edge !== edgeGesture {
                edgeGesture?.removeTarget(self, action: #selector(handlePopGesture(_:)))
                edge?.addTarget(self, action: #selector(handlePopGesture(_:)))
                edgeGesture = edge
            }

            if #available(iOS 26, *) {
                let content = nav.interactiveContentPopGestureRecognizer
                if content !== contentGesture {
                    contentGesture?.removeTarget(self, action: #selector(handlePopGesture(_:)))
                    content?.addTarget(self, action: #selector(handlePopGesture(_:)))
                    contentGesture = content
                }
            }
        }

        private static func findNavigationController(from controller: UIViewController) -> UINavigationController? {
            if let nav = controller.navigationController { return nav }
            var parent = controller.parent
            while let current = parent {
                if let nav = current as? UINavigationController { return nav }
                if let nav = current.navigationController { return nav }
                parent = current.parent
            }
            // Walk responder / presented tree from the window as a last resort.
            guard let root = controller.view.window?.rootViewController
                    ?? controller.viewIfLoaded?.window?.rootViewController
            else { return nil }
            return deepestNavigation(from: root)
        }

        private static func deepestNavigation(from root: UIViewController) -> UINavigationController? {
            if let nav = root as? UINavigationController { return nav }
            for child in root.children.reversed() {
                if let found = deepestNavigation(from: child) { return found }
            }
            if let presented = root.presentedViewController {
                return deepestNavigation(from: presented)
            }
            return root.navigationController
        }

        private func gestureProgress(_ gesture: UIGestureRecognizer) -> CGFloat {
            // Prefer translation — reliable for both edge and full-content pop.
            if let pan = gesture as? UIPanGestureRecognizer {
                let view = pan.view
                let width = max(view?.bounds.width ?? UIScreen.main.bounds.width, 1)
                return min(max(pan.translation(in: view).x / width, 0), 1)
            }
            return 0
        }

        @objc func handlePopGesture(_ gesture: UIGestureRecognizer) {
            switch gesture.state {
            case .began:
                lastProgress = nil
                YLHaptics.swipeBackBegan()

            case .changed:
                let progress = gestureProgress(gesture)
                defer { lastProgress = progress }
                guard let last = lastProgress else { return }
                let crossedForward = last < commitThreshold && progress >= commitThreshold
                let crossedBack = last >= commitThreshold && progress < commitThreshold
                guard crossedForward || crossedBack else { return }
                YLHaptics.swipeBackCrossedThreshold()

            case .ended, .cancelled, .failed:
                lastProgress = nil

            default:
                break
            }
        }

        deinit {
            edgeGesture?.removeTarget(self, action: #selector(handlePopGesture(_:)))
            contentGesture?.removeTarget(self, action: #selector(handlePopGesture(_:)))
        }
    }
}
