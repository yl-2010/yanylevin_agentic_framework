import SwiftUI

extension View {
    /// Track scroll offset for Education tab re-taps: scroll to top if needed,
    /// otherwise the store pops. Only the visible page writes `visiblePageIsAtTop`.
    func educationTabReselectScroll(isActive: Bool) -> some View {
        modifier(EducationTabScrollModifier(isActive: isActive))
    }
}

private struct EducationTabScrollModifier: ViewModifier {
    @EnvironmentObject private var educationFocus: EducationFocusStore
    let isActive: Bool
    @State private var scrollPosition = ScrollPosition(edge: .top)
    @State private var localIsAtTop = true

    private static let topSlop: CGFloat = 24

    func body(content: Content) -> some View {
        content
            .scrollPosition($scrollPosition)
            .onScrollGeometryChange(for: Bool.self) { geo in
                geo.contentOffset.y + geo.contentInsets.top <= Self.topSlop
            } action: { _, atTop in
                localIsAtTop = atTop
                if isActive {
                    educationFocus.visiblePageIsAtTop = atTop
                }
            }
            .onChange(of: isActive) { _, active in
                if active {
                    educationFocus.visiblePageIsAtTop = localIsAtTop
                }
            }
            .onChange(of: educationFocus.scrollToTopGeneration) { _, _ in
                guard isActive else { return }
                withAnimation(.spring(response: 0.38, dampingFraction: 0.86)) {
                    scrollPosition.scrollTo(edge: .top)
                }
            }
            .onAppear {
                if isActive {
                    educationFocus.visiblePageIsAtTop = localIsAtTop
                }
            }
    }
}
