import SwiftUI
import UIKit

/// Soft pulsing dots used for in-app busy states (chat “Working”, sign-in, etc.).
enum YLBusyPulse {
    /// Original step was 0.32s; 150% speed → 0.32 / 1.5.
    static let step: TimeInterval = 0.32 / 1.5
}

struct YLBusyDots: View {
    var body: some View {
        let stepInterval = YLBusyPulse.step
        TimelineView(.animation(minimumInterval: stepInterval, paused: false)) { context in
            let step = Int(context.date.timeIntervalSinceReferenceDate / stepInterval) % 3
            HStack(spacing: 4) {
                ForEach(0..<3, id: \.self) { index in
                    Circle()
                        .frame(width: 5, height: 5)
                        .opacity(index == step ? 1 : 0.28)
                        .scaleEffect(index == step ? 1.15 : 0.88)
                        .offset(y: index == step ? -1.5 : 0)
                }
            }
            .animation(.easeInOut(duration: stepInterval * 0.875), value: step)
        }
        .frame(width: 22, height: 10)
        .accessibilityHidden(true)
    }
}

/// Swipe-down on a focused field resigns focus / hides the keyboard.
/// Composers sit outside the message `ScrollView`, so `.scrollDismissesKeyboard`
/// alone does not cover drags that start on the text field.
/// Glass finger-warp lives on `ylGlassField` — this modifier does not move the view.
struct YLInteractiveInputModifier: ViewModifier {
    var isFocused: FocusState<Bool>.Binding

    func body(content: Content) -> some View {
        content
            .simultaneousGesture(
                DragGesture(minimumDistance: 24, coordinateSpace: .local)
                    .onEnded { value in
                        let dy = value.translation.height
                        let dx = value.translation.width
                        guard isFocused.wrappedValue,
                              dy > 36,
                              dy > abs(dx) * 1.15
                        else { return }
                        // No spring — let keyboard-frame sync own the motion.
                        isFocused.wrappedValue = false
                    }
            )
            // System keyboard interactive dismiss (or any hide) also leaves the field.
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidHideNotification)) { _ in
                guard isFocused.wrappedValue else { return }
                isFocused.wrappedValue = false
            }
    }
}

extension View {
    /// Swipe-down dismisses the keyboard / focus. Pair with `ylGlassField()` for native warp.
    func ylInteractiveInput(isFocused: FocusState<Bool>.Binding) -> some View {
        modifier(YLInteractiveInputModifier(isFocused: isFocused))
    }
}
